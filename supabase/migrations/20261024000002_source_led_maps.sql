-- Source-aware onboarding, stage 2: maps built from the learner's own sources.
-- A goal created with sources reads them first (reading_sources), may ask whether to
-- expand shallow material (awaiting_expand), then builds its map (building_map).

-- ------------------------------------------------------------- columns

alter table public.goals drop constraint goals_map_status_check;
alter table public.goals add constraint goals_map_status_check
  check (map_status in ('pending', 'reading_sources', 'awaiting_expand', 'building_map', 'clarifying', 'ready', 'failed'));
alter table public.goals
  add column expand boolean,
  add column reading_started_at timestamptz;

-- A pasted syllabus or table of contents: its text is the source; url_or_file is 'outline'.
alter table public.sources drop constraint sources_type_check;
alter table public.sources add constraint sources_type_check check (type in ('web', 'youtube', 'pdf', 'outline'));
alter table public.sources
  add column outline_text text check (char_length(outline_text) between 1 and 20000),
  add constraint sources_outline_text_check2 check ((type = 'outline') = (outline_text is not null));
alter table public.contents drop constraint contents_type_check;
alter table public.contents add constraint contents_type_check check (type in ('web', 'youtube', 'pdf', 'outline'));

-- The source's headings / table of contents / chapters / outline items:
-- [{"id", "title", "level", "first_sentence", "chunk_position"}].
alter table public.contents add column structure jsonb;

-- The chunk that best represents a topic (its chapter, section, page or timestamp).
alter table public.subtopics
  add column primary_ref uuid references public.source_chunks on delete set null;

grant insert (outline_text) on public.sources to authenticated;

-- ------------------------------------------------------------- functions

-- A goal created with sources reads them before its map is built (the worker then queues it).
create or replace function public.enqueue_topic_map() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.map_status = 'pending' then
    insert into public.jobs (kind, payload)
    values ('topic_map', jsonb_build_object('goal_id', new.id));
  end if;
  return new;
end;
$$;

-- As in 20261024000001, plus outline sources: text only, no URL.
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
  elsif new.type = 'outline' then
    if new.url_or_file <> 'outline' or btrim(coalesce(new.outline_text, '')) = '' then
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

-- Replaces the stage 1 version (links only): also takes a pasted outline. A goal with any
-- source starts in reading_sources; the worker builds its map once they are read.
drop function public.create_goal_with_sources(text, text, text, text[]);

create function public.create_goal_with_sources(
  p_title text, p_level text, p_learning_style text, p_links text[], p_outline text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  links text[] := coalesce(p_links, '{}');
  outline text := nullif(btrim(coalesce(p_outline, '')), '');
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

  if cardinality(links) > 0 or outline is not null then
    insert into public.goals (user_id, title, map_status, reading_started_at)
    values (uid, p_title, 'reading_sources', now()) returning id into v_goal_id;
  else
    insert into public.goals (user_id, title) values (uid, p_title) returning id into v_goal_id;
  end if;

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

revoke execute on function public.create_goal_with_sources(text, text, text, text[], text) from public, anon;
grant execute on function public.create_goal_with_sources(text, text, text, text[], text) to authenticated;

-- The learner's answer to "Expand this topic with related guides?".
create function public.answer_expand(p_goal_id uuid, p_expand boolean) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.goals set expand = p_expand, map_status = 'building_map'
  where id = p_goal_id and user_id = auth.uid() and map_status = 'awaiting_expand';
  if not found then
    raise exception 'goal_not_awaiting_expand';
  end if;
  insert into public.jobs (kind, payload) values ('topic_map', jsonb_build_object('goal_id', p_goal_id));
end;
$$;

revoke execute on function public.answer_expand(uuid, boolean) from public, anon;
grant execute on function public.answer_expand(uuid, boolean) to authenticated;
