-- Core schema: users, learning prefs, goals, subtopics, jobs, usage events.

-- ---------------------------------------------------------------- tables

create table public.users (
  id uuid primary key references auth.users on delete cascade,
  email text,
  display_name text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  created_at timestamptz not null default now()
);

create table public.learning_prefs (
  user_id uuid primary key references public.users on delete cascade,
  preferred_format text not null default 'text'
    check (preferred_format in ('visual', 'text', 'examples', 'summary')),
  level text not null default 'beginner'
    check (level in ('beginner', 'intermediate', 'advanced')),
  inferred_format text
    check (inferred_format in ('visual', 'text', 'examples', 'summary'))
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text check (char_length(description) <= 2000),
  status text not null default 'active' check (status in ('active', 'archived')),
  map_status text not null default 'pending'
    check (map_status in ('pending', 'clarifying', 'ready', 'failed')),
  map_delayed boolean not null default false,
  clarifying_question text,
  clarification_answer text,
  map_error text,
  created_at timestamptz not null default now()
);
create index goals_user_id_idx on public.goals (user_id);

create table public.subtopics (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals on delete cascade,
  parent_id uuid references public.subtopics on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  summary text,
  position int not null,
  user_edited boolean not null default false
);
create index subtopics_goal_id_idx on public.subtopics (goal_id);
create index subtopics_parent_id_idx on public.subtopics (parent_id);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  step text,
  attempts int not null default 0,
  last_error text,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  created_at timestamptz not null default now()
);
create index jobs_status_run_after_idx on public.jobs (status, run_after);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  kind text not null
    check (kind in ('ingest', 'map', 'topic_map', 'lesson', 'quiz_gen', 'validate')),
  tokens int not null,
  cost_cents numeric(10, 4) not null,
  at timestamptz not null default now()
);
create index usage_events_user_id_idx on public.usage_events (user_id);

-- ------------------------------------------------------------- functions

create function public.active_goal_limit(plan text) returns int
language sql immutable
as $$
  select case plan when 'pro' then 25 else 2 end;
$$;

-- Create the public.users row when someone signs up.
create function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.users (id, email) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Trim titles before the length CHECK is evaluated (BEFORE triggers run first).
create function public.trim_title() returns trigger
language plpgsql
as $$
begin
  new.title := btrim(new.title);
  return new;
end;
$$;

create trigger goals_trim_title
  before insert or update of title on public.goals
  for each row execute function public.trim_title();

create trigger subtopics_trim_title
  before insert or update of title on public.subtopics
  for each row execute function public.trim_title();

-- Enforce the active-goal limit. The row lock on the user serializes
-- concurrent inserts for the same user.
create function public.enforce_goal_limit() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  user_plan text;
  active_count int;
begin
  if new.status <> 'active' then
    return new;
  end if;

  select u.plan into user_plan from public.users u where u.id = new.user_id for update;

  select count(*) into active_count
  from public.goals g
  where g.user_id = new.user_id and g.status = 'active' and g.id <> new.id;

  if active_count >= public.active_goal_limit(user_plan) then
    raise exception 'goal_limit_reached';
  end if;
  return new;
end;
$$;

create trigger goals_enforce_limit
  before insert or update of status on public.goals
  for each row execute function public.enforce_goal_limit();

-- A new goal queues its topic map job.
create function public.enqueue_topic_map() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.jobs (kind, payload)
  values ('topic_map', jsonb_build_object('goal_id', new.id));
  return new;
end;
$$;

create trigger goals_enqueue_topic_map
  after insert on public.goals
  for each row execute function public.enqueue_topic_map();

-- -------------------------------------------------------------- security

alter table public.users enable row level security;
alter table public.learning_prefs enable row level security;
alter table public.goals enable row level security;
alter table public.subtopics enable row level security;
alter table public.jobs enable row level security;
alter table public.usage_events enable row level security;

create policy users_select_self on public.users
  for select to authenticated using (id = auth.uid());
create policy users_update_self on public.users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy learning_prefs_owner on public.learning_prefs
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy goals_owner on public.goals
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy subtopics_owner on public.subtopics
  for all to authenticated
  using (exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()))
  with check (exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()));

-- jobs and usage_events: RLS on with no policies for authenticated (they read
-- zero rows); also revoke writes so they fail on privileges, not just RLS.
revoke all on public.jobs, public.usage_events from anon;
revoke insert, update, delete on public.jobs, public.usage_events from authenticated;

-- Column privileges. Supabase grants table-level privileges by default, and a
-- column-level revoke has no effect on those, so revoke the table-level
-- privilege and grant back only the writable columns.
revoke all on public.users, public.learning_prefs, public.goals, public.subtopics from anon;

revoke insert, update on public.users from authenticated;
grant update (display_name) on public.users to authenticated;

-- Map state (map_status, map_delayed, clarifying_question, clarification_answer,
-- map_error) changes only through the worker or RPCs.
revoke insert, update on public.goals from authenticated;
grant insert (id, user_id, title, description) on public.goals to authenticated;
grant update (title, description, status) on public.goals to authenticated;
