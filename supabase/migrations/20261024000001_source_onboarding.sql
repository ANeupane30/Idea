-- Source-aware onboarding, stage 1: learning styles, automatic sources found for the
-- learner, discovery status, and goal creation with the learner's own links.

-- ------------------------------------------------------------- columns

alter table public.sources
  add column origin text not null default 'user' check (origin in ('user', 'auto')),
  add column discovered_for uuid references public.subtopics on delete set null;

-- awaiting_map: read and embedded before the goal's map existed; matched once it is ready.
alter table public.sources drop constraint sources_status_check;
alter table public.sources add constraint sources_status_check
  check (status in ('queued', 'processing', 'awaiting_map', 'ready', 'failed'));

alter table public.learning_prefs
  add column learning_style text not null default 'reading'
    check (learning_style in ('visual_video', 'reading', 'hands_on'));

-- waiting: the map is ready but the learner's own sources are still being matched.
alter table public.goals
  add column discovery_status text not null default 'none'
    check (discovery_status in ('none', 'waiting', 'running', 'done'));

-- ------------------------------------------------------------- functions

create function public.style_format(p_style text) returns text
language sql immutable
as $$
  select case p_style when 'visual_video' then 'visual' when 'hands_on' then 'examples' else 'text' end;
$$;

-- As before, plus: automatic sources skip every limit and are not counted, and the
-- learner's own links may join a goal that has no map yet, but only from
-- create_goal_with_sources (which sets app.creating_goal for its transaction).
create or replace function public.sources_enforce_rules() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  goal_row record;
  user_plan text;
  guest boolean;
  used int;
  attempts int;
  today timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  if tg_op = 'UPDATE' and not (old.status = 'failed' and new.status = 'queued') then
    return new;
  end if;

  select g.status, g.map_status into goal_row from public.goals g where g.id = new.goal_id;
  if found then
    if goal_row.status <> 'active' then
      raise exception 'goal_archived';
    end if;
    if goal_row.map_status <> 'ready'
        and coalesce(current_setting('app.creating_goal', true), '') <> new.goal_id::text then
      raise exception 'goal_not_ready';
    end if;
  end if;

  if new.type = 'pdf' then
    if new.url_or_file !~ ('^' || new.user_id::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$') then
      raise exception 'invalid_source';
    end if;
  elsif not (new.url_or_file like 'http://%' or new.url_or_file like 'https://%') then
    raise exception 'invalid_source';
  end if;

  if new.origin = 'auto' then
    return new;
  end if;

  -- The row lock serializes concurrent adds for the same user.
  select u.plan into user_plan from public.users u where u.id = new.user_id for update;
  select coalesce(a.is_anonymous, false) into guest from auth.users a where a.id = new.user_id;

  -- Attempts (adds and retries) so far: each one queued an ingest job.
  select count(*) into attempts
  from public.jobs j
  join public.sources s on s.id::text = j.payload->>'source_id'
  where j.kind = 'ingest_source' and s.user_id = new.user_id and s.origin = 'user'
    and (guest or j.created_at >= today);

  if guest then
    select count(*) into used from public.sources s
    where s.user_id = new.user_id and s.origin = 'user' and s.status <> 'failed' and s.id <> new.id;
    if used >= 3 or attempts >= 10 then
      raise exception 'guest_source_limit_reached';
    end if;
  else
    if attempts >= public.daily_source_attempt_limit(user_plan) then
      raise exception 'source_attempt_limit_reached';
    end if;
    select count(*) into used from public.sources s
    where s.user_id = new.user_id and s.origin = 'user' and s.status <> 'failed' and s.id <> new.id
      and s.queued_at >= today;
    if used >= public.daily_source_limit(user_plan) then
      raise exception 'source_limit_reached';
    end if;
  end if;
  return new;
end;
$$;

-- The start form: saves the learner's level and style, creates the goal and adds up to
-- three links, in one transaction. The goal's map is built as usual (topic_map job);
-- the links are read meanwhile and matched once the map is ready.
create function public.create_goal_with_sources(
  p_title text, p_level text, p_learning_style text, p_links text[]
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  links text[] := coalesce(p_links, '{}');
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

  insert into public.learning_prefs (user_id, level, learning_style, preferred_format)
  values (uid, p_level, p_learning_style, public.style_format(p_learning_style))
  on conflict (user_id) do update set
    level = excluded.level,
    learning_style = excluded.learning_style,
    preferred_format = excluded.preferred_format;

  insert into public.goals (user_id, title) values (uid, p_title) returning id into v_goal_id;

  perform set_config('app.creating_goal', v_goal_id::text, true);
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

revoke execute on function public.create_goal_with_sources(text, text, text, text[]) from public, anon;
grant execute on function public.create_goal_with_sources(text, text, text, text[]) to authenticated;
