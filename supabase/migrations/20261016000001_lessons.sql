-- Lessons: generated per user, topic and format; feedback; format switches.

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  subtopic_id uuid not null references public.subtopics on delete cascade,
  format text not null check (format in ('visual', 'text', 'examples', 'summary')),
  level text not null check (level in ('beginner', 'intermediate', 'advanced')),
  cache_key text not null,
  status text not null default 'generating' check (status in ('generating', 'ready', 'failed')),
  body jsonb,
  stale boolean not null default false,
  reused boolean not null default false,
  model text,
  created_at timestamptz not null default now()
);
create index lessons_topic_format_idx on public.lessons (subtopic_id, format, created_at desc);
create index lessons_cache_key_idx on public.lessons (cache_key) where status = 'ready';
create index lessons_user_id_idx on public.lessons (user_id, created_at);
-- One generation at a time per topic and format.
create unique index lessons_one_generating on public.lessons (subtopic_id, format) where status = 'generating';

create table public.lesson_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  lesson_id uuid not null references public.lessons on delete cascade,
  rating text check (rating in ('up', 'down')),
  report_text text check (char_length(report_text) between 1 and 2000),
  created_at timestamptz not null default now(),
  check (rating is not null or report_text is not null)
);
create index lesson_feedback_lesson_id_idx on public.lesson_feedback (lesson_id);

create table public.format_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  subtopic_id uuid not null references public.subtopics on delete cascade,
  from_format text not null check (from_format in ('visual', 'text', 'examples', 'summary')),
  to_format text not null check (to_format in ('visual', 'text', 'examples', 'summary')),
  at timestamptz not null default now()
);
create index format_events_user_id_idx on public.format_events (user_id);

-- Set once the learner has picked a format (the start page doesn't ask).
alter table public.learning_prefs add column format_chosen boolean not null default false;

-- ------------------------------------------------------------- functions

create function public.daily_lesson_limit(plan text) returns int
language sql immutable
as $$
  select case plan when 'pro' then 150 else 15 end;
$$;

-- Generations (non-failed, non-reused lessons): guests 5 in total, others per UTC day.
create function public.lessons_enforce_limit() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  user_plan text;
  guest boolean;
  used int;
begin
  if new.reused then
    return new;
  end if;
  select u.plan into user_plan from public.users u where u.id = new.user_id for update;
  select coalesce(a.is_anonymous, false) into guest from auth.users a where a.id = new.user_id;
  if guest then
    select count(*) into used from public.lessons l
    where l.user_id = new.user_id and l.status <> 'failed' and not l.reused;
    if used >= 5 then
      raise exception 'guest_lesson_limit_reached';
    end if;
  else
    select count(*) into used from public.lessons l
    where l.user_id = new.user_id and l.status <> 'failed' and not l.reused
      and l.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
    if used >= public.daily_lesson_limit(user_plan) then
      raise exception 'lesson_limit_reached';
    end if;
  end if;
  return new;
end;
$$;

create trigger lessons_enforce_limit
  before insert on public.lessons
  for each row execute function public.lessons_enforce_limit();

-- New coverage from an on-topic source marks the covered topics' lessons stale.
create function public.mark_lessons_stale(p_source_id uuid) returns void
language sql security definer set search_path = public
as $$
  update public.lessons l set stale = true
  where l.status = 'ready' and not l.stale
    and l.subtopic_id in (
      select c.subtopic_id from public.source_coverage c
      join public.sources s on s.id = c.source_id
      where c.source_id = p_source_id and c.relevance >= 0.40
        and coalesce(s.relevance_label, '') <> 'off_topic'
    );
$$;

revoke execute on function public.mark_lessons_stale(uuid) from public, anon, authenticated;

-- -------------------------------------------------------------- security

alter table public.lessons enable row level security;
alter table public.lesson_feedback enable row level security;
alter table public.format_events enable row level security;

create policy lessons_owner_select on public.lessons
  for select to authenticated using (user_id = auth.uid());

create policy lesson_feedback_owner_select on public.lesson_feedback
  for select to authenticated using (user_id = auth.uid());
create policy lesson_feedback_owner_insert on public.lesson_feedback
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.lessons l where l.id = lesson_id and l.user_id = auth.uid())
  );

create policy format_events_owner_select on public.format_events
  for select to authenticated using (user_id = auth.uid());
create policy format_events_owner_insert on public.format_events
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.subtopics s join public.goals g on g.id = s.goal_id
      where s.id = subtopic_id and g.user_id = auth.uid()
    )
  );

revoke all on public.lessons, public.lesson_feedback, public.format_events from anon;
revoke insert, update, delete on public.lessons from authenticated;
revoke insert, update, delete on public.lesson_feedback, public.format_events from authenticated;
grant insert (lesson_id, user_id, rating, report_text) on public.lesson_feedback to authenticated;
grant insert (user_id, subtopic_id, from_format, to_format) on public.format_events to authenticated;
revoke truncate, trigger, references on public.lessons, public.lesson_feedback, public.format_events
  from authenticated;
