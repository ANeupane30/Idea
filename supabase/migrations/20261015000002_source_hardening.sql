-- Source hardening (Phase 2 final review):
-- - PDF sources must be <user id>/<uuid>.pdf, so a path can't climb into another
--   user's folder (the worker downloads with the service key).
-- - A daily cap on add/retry attempts, since failed attempts don't use quota but do
--   spend fetches and LLM calls.
-- - Uploads only while the user can still add a source, and users can delete their
--   own uploads (the web app removes uploads whose source couldn't be added).

create function public.daily_source_attempt_limit(plan text) returns int
language sql immutable
as $$
  select 3 * public.daily_source_limit(plan);
$$;

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
    if goal_row.map_status <> 'ready' then
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

  -- The row lock serializes concurrent adds for the same user.
  select u.plan into user_plan from public.users u where u.id = new.user_id for update;
  select coalesce(a.is_anonymous, false) into guest from auth.users a where a.id = new.user_id;

  -- Attempts (adds and retries) so far: each one queued an ingest job.
  select count(*) into attempts
  from public.jobs j
  join public.sources s on s.id::text = j.payload->>'source_id'
  where j.kind = 'ingest_source' and s.user_id = new.user_id
    and (guest or j.created_at >= today);

  if guest then
    select count(*) into used from public.sources s
    where s.user_id = new.user_id and s.status <> 'failed' and s.id <> new.id;
    if used >= 3 or attempts >= 10 then
      raise exception 'guest_source_limit_reached';
    end if;
  else
    if attempts >= public.daily_source_attempt_limit(user_plan) then
      raise exception 'source_attempt_limit_reached';
    end if;
    select count(*) into used from public.sources s
    where s.user_id = new.user_id and s.status <> 'failed' and s.id <> new.id
      and s.queued_at >= today;
    if used >= public.daily_source_limit(user_plan) then
      raise exception 'source_limit_reached';
    end if;
  end if;
  return new;
end;
$$;

-- Whether the current user may upload another PDF: they must be able to add a source,
-- and uploads are capped (guests 10 in total; others 3x the daily source limit per day).
create function public.can_upload_source() returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  user_plan text;
  guest boolean;
  used int;
  uploads int;
  today timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  if uid is null then
    return false;
  end if;
  select u.plan into user_plan from public.users u where u.id = uid;
  select coalesce(a.is_anonymous, false) into guest from auth.users a where a.id = uid;

  if guest then
    select count(*) into used from public.sources s where s.user_id = uid and s.status <> 'failed';
    select count(*) into uploads from storage.objects o
    where o.bucket_id = 'sources' and o.name like uid::text || '/%';
    return used < 3 and uploads < 10;
  end if;

  select count(*) into used from public.sources s
  where s.user_id = uid and s.status <> 'failed' and s.queued_at >= today;
  select count(*) into uploads from storage.objects o
  where o.bucket_id = 'sources' and o.name like uid::text || '/%' and o.created_at >= today;
  return used < public.daily_source_limit(user_plan)
    and uploads < public.daily_source_attempt_limit(user_plan);
end;
$$;

revoke execute on function public.can_upload_source() from public, anon;
grant execute on function public.can_upload_source() to authenticated;

drop policy sources_upload_own_folder on storage.objects;
create policy sources_upload_own_folder on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'sources'
    and name ~ ('^' || auth.uid()::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$')
    and public.can_upload_source()
  );

create policy sources_delete_own_folder on storage.objects
  for delete to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);
