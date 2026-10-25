-- Sources-first maps: every goal from the app understands the learner's intent, finds or
-- reads sources, checks them, and only then builds its map (shown once its lessons are ready).

-- ------------------------------------------------------------- statuses and columns

-- Goals waiting on the old expand question are built as they are (answer_expand queued this job).
insert into public.jobs (kind, payload)
select 'topic_map', jsonb_build_object('goal_id', id) from public.goals where map_status = 'awaiting_expand';
update public.goals set map_status = 'building_map' where map_status = 'awaiting_expand';
alter table public.goals drop constraint goals_map_status_check;
alter table public.goals add constraint goals_map_status_check check (map_status in (
  'pending', 'understanding', 'finding_sources', 'reading_sources', 'checking_sources',
  'awaiting_source_decision', 'building_map', 'matching_sources', 'clarifying', 'ready', 'failed'));

alter table public.goals
  add column intent text check (char_length(intent) <= 300),
  add column search_subject text check (char_length(search_subject) <= 120),
  add column search_queries jsonb,
  add column search_round int not null default 0,
  add column prep_started_at timestamptz,
  add column gap_deadline timestamptz,
  add column map_note text check (map_note in ('starting_point'));

alter table public.sources
  add column found_for_goal boolean not null default false,
  add column vetted boolean,
  add column vet_reason text check (char_length(vet_reason) <= 160),
  add column search_score real;

-- Tavily credits used per month (worker-only).
create table public.search_usage (
  month date primary key,
  credits int not null default 0,
  warned boolean not null default false
);
alter table public.search_usage enable row level security;
revoke all on public.search_usage from anon, authenticated;

-- ------------------------------------------------------------- new goals start by understanding

-- A goal the learner creates (the /goals page inserts directly) goes sources-first. Goals the
-- worker or tests insert as postgres keep the plain pending path.
create function public.goals_prepare() returns trigger
language plpgsql
as $$
begin
  if current_user = 'authenticated' and new.map_status = 'pending' then
    new.map_status := 'understanding';
    new.prep_started_at := now();
  end if;
  return new;
end;
$$;

create trigger goals_prepare
  before insert on public.goals
  for each row execute function public.goals_prepare();

create or replace function public.enqueue_topic_map() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.map_status = 'understanding' then
    insert into public.jobs (kind, payload) values ('understand_goal', jsonb_build_object('goal_id', new.id));
  elsif new.map_status = 'pending' then
    insert into public.jobs (kind, payload) values ('topic_map', jsonb_build_object('goal_id', new.id));
  end if;
  return new;
end;
$$;

-- As in 20261024000002, but every goal starts by understanding; its sources are read meanwhile.
create or replace function public.create_goal_with_sources(
  p_title text, p_level text, p_learning_style text, p_links text[], p_outline text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  links text[] := coalesce(p_links, '{}');
  outline text := nullif(btrim(coalesce(p_outline, '')), '');
  has_sources boolean;
  link text;
  host text;
  v_goal_id uuid;
begin
  if uid is null then
    raise exception 'not_signed_in';
  end if;
  if cardinality(links) > 3 then
    raise exception 'too_many_links';
  end if;
  foreach link in array links loop
    if btrim(link) = '' then
      raise exception 'invalid_source';
    end if;
  end loop;
  has_sources := cardinality(links) > 0 or outline is not null;

  insert into public.learning_prefs (user_id, level, learning_style, preferred_format)
  values (uid, p_level, p_learning_style, public.style_format(p_learning_style))
  on conflict (user_id) do update set
    level = excluded.level,
    learning_style = excluded.learning_style,
    preferred_format = excluded.preferred_format;

  -- As security definer this runs as postgres, so goals_prepare doesn't fire: set the status here.
  insert into public.goals (user_id, title, map_status, prep_started_at, reading_started_at)
  values (uid, p_title, 'understanding', now(), case when has_sources then now() end)
  returning id into v_goal_id;

  perform set_config('app.creating_goal', v_goal_id::text, true);
  if outline is not null then
    insert into public.sources (goal_id, user_id, type, url_or_file, outline_text)
    values (v_goal_id, uid, 'outline', 'outline', p_outline);
  end if;
  foreach link in array links loop
    link := btrim(link);
    host := lower(substring(link from '^https?://([^/:?#]+)'));
    insert into public.sources (goal_id, user_id, type, url_or_file)
    values (v_goal_id, uid,
            case when host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be')
                 then 'youtube' else 'web' end,
            link);
  end loop;
  perform set_config('app.creating_goal', '', true);

  return v_goal_id;
end;
$$;

-- ------------------------------------------------------------- the learner's decision

drop function public.answer_expand(uuid, boolean);

-- "Some of your sources don't look right": find sources for me, or use mine anyway.
create function public.answer_source_decision(p_goal_id uuid, p_choice text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_choice not in ('find', 'use') then
    raise exception 'invalid_choice';
  end if;
  perform 1 from public.goals
  where id = p_goal_id and user_id = auth.uid() and map_status = 'awaiting_source_decision'
  for update;
  if not found then
    raise exception 'goal_not_awaiting_decision';
  end if;
  if p_choice = 'find' then
    update public.goals set map_status = 'finding_sources' where id = p_goal_id;
    insert into public.jobs (kind, payload) values ('find_sources', jsonb_build_object('goal_id', p_goal_id));
  else
    update public.sources set vetted = true
    where goal_id = p_goal_id and origin = 'user' and status = 'awaiting_map';
    update public.goals set map_status = 'building_map' where id = p_goal_id;
    insert into public.jobs (kind, payload) values ('topic_map', jsonb_build_object('goal_id', p_goal_id));
  end if;
end;
$$;

-- A source added after the map that didn't pass the check: the learner uses it anyway.
create function public.use_source_anyway(p_source_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.sources s set vetted = true, status = 'queued', queued_at = now()
  from public.goals g
  where s.id = p_source_id and s.user_id = auth.uid() and s.vetted = false
    and g.id = s.goal_id and g.map_status = 'ready';
  if not found then
    raise exception 'source_not_unvetted';
  end if;
  insert into public.jobs (kind, payload) values ('ingest_source', jsonb_build_object('source_id', p_source_id));
end;
$$;

revoke execute on function public.answer_source_decision(uuid, text) from public, anon;
grant execute on function public.answer_source_decision(uuid, text) to authenticated;
revoke execute on function public.use_source_anyway(uuid) from public, anon;
grant execute on function public.use_source_anyway(uuid) to authenticated;
