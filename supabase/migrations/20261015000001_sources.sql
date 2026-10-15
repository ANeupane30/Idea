-- Sources and the ingestion pipeline's data: per-user sources, shared
-- content-addressed chunks with embeddings, coverage, quotas and PDF storage.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------- tables

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  goal_id uuid not null references public.goals on delete cascade,
  type text not null check (type in ('web', 'youtube', 'pdf')),
  url_or_file text not null check (char_length(url_or_file) between 1 and 2000),
  file_name text check (char_length(file_name) <= 255),
  content_hash text,
  title text,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'ready', 'failed')),
  step text check (step in ('extracting', 'chunking', 'embedding', 'mapping')),
  delayed boolean not null default false,
  error text,
  relevance numeric(3, 2) check (relevance between 0 and 1),
  relevance_label text check (relevance_label in ('high', 'partial', 'off_topic')),
  relevance_reason text,
  queued_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index sources_goal_id_idx on public.sources (goal_id);
create index sources_user_id_idx on public.sources (user_id);
-- One live copy of a piece of content per goal; failed attempts don't block it.
create unique index sources_goal_content_uniq on public.sources (goal_id, content_hash)
  where status <> 'failed' and content_hash is not null;

-- Shared cache: extracted content, keyed by content hash, written by the worker only.
create table public.contents (
  content_hash text primary key,
  type text not null check (type in ('web', 'youtube', 'pdf')),
  title text,
  token_count int not null,
  duration_s int,
  page_count int,
  embed_model text not null,
  created_at timestamptz not null default now()
);

create table public.source_chunks (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null references public.contents on delete cascade,
  position int not null,
  text text not null,
  token_count int not null,
  embedding extensions.vector(384) not null,
  timestamp_start numeric,
  page int,
  anchor text,
  unique (content_hash, position)
);
create index source_chunks_content_hash_idx on public.source_chunks (content_hash);

create table public.subtopic_embeddings (
  subtopic_id uuid primary key references public.subtopics on delete cascade,
  embed_model text not null,
  embedding extensions.vector(384) not null
);

create table public.source_coverage (
  source_id uuid not null references public.sources on delete cascade,
  subtopic_id uuid not null references public.subtopics on delete cascade,
  relevance numeric(3, 2) not null check (relevance between 0 and 1),
  reason text not null check (char_length(reason) between 1 and 200),
  primary key (source_id, subtopic_id)
);
create index source_coverage_subtopic_id_idx on public.source_coverage (subtopic_id);

-- ------------------------------------------------------------- functions

-- The only place the relevance thresholds live.
create function public.relevance_label(r numeric) returns text
language sql immutable
as $$
  select case when r >= 0.70 then 'high' when r >= 0.40 then 'partial' else 'off_topic' end;
$$;

create function public.daily_source_limit(plan text) returns int
language sql immutable
as $$
  select case plan when 'pro' then 50 else 5 end;
$$;

-- Goal state, link/path shape and quotas. Runs on insert and when a failed
-- source is queued again (retry). Permanent failures never count.
create function public.sources_enforce_rules() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  goal_row record;
  user_plan text;
  guest boolean;
  used int;
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
    if auth.uid() is not null and not starts_with(new.url_or_file, auth.uid()::text || '/') then
      raise exception 'invalid_source';
    end if;
  elsif not (new.url_or_file like 'http://%' or new.url_or_file like 'https://%') then
    raise exception 'invalid_source';
  end if;

  -- The row lock serializes concurrent adds for the same user.
  select u.plan into user_plan from public.users u where u.id = new.user_id for update;
  select coalesce(a.is_anonymous, false) into guest from auth.users a where a.id = new.user_id;

  if guest then
    select count(*) into used from public.sources s
    where s.user_id = new.user_id and s.status <> 'failed' and s.id <> new.id;
    if used >= 3 then
      raise exception 'guest_source_limit_reached';
    end if;
  else
    select count(*) into used from public.sources s
    where s.user_id = new.user_id and s.status <> 'failed' and s.id <> new.id
      and s.queued_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
    if used >= public.daily_source_limit(user_plan) then
      raise exception 'source_limit_reached';
    end if;
  end if;
  return new;
end;
$$;

create trigger sources_enforce_rules
  before insert or update of status on public.sources
  for each row execute function public.sources_enforce_rules();

create function public.enqueue_ingest() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.jobs (kind, payload)
  values ('ingest_source', jsonb_build_object('source_id', new.id));
  return new;
end;
$$;

create trigger sources_enqueue_ingest
  after insert on public.sources
  for each row execute function public.enqueue_ingest();

create function public.retry_source(p_source_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  select s.status into v_status
  from public.sources s
  where s.id = p_source_id and s.user_id = auth.uid()
  for update;
  if not found then
    raise exception 'source_not_found';
  end if;
  if v_status <> 'failed' then
    raise exception 'not_failed';
  end if;

  -- The quota trigger re-checks this as a new add.
  update public.sources
  set status = 'queued', step = null, error = null, delayed = false, content_hash = null,
      relevance = null, relevance_label = null, relevance_reason = null, queued_at = now()
  where id = p_source_id;
  insert into public.jobs (kind, payload)
  values ('ingest_source', jsonb_build_object('source_id', p_source_id));
end;
$$;

revoke execute on function public.retry_source(uuid) from public, anon;
grant execute on function public.retry_source(uuid) to authenticated;

-- ---------------------------------------------------------------- views

-- Covered: 1+ strong or 2+ weak rows; Thin: exactly 1 weak; Gap: otherwise.
-- Only ready sources that are not off-topic count. security_invoker keeps RLS.
create view public.subtopic_coverage with (security_invoker = true) as
select
  s.id as subtopic_id,
  s.goal_id,
  case
    when x.strong >= 1 or x.weak >= 2 then 'covered'
    when x.weak = 1 then 'thin'
    else 'gap'
  end as state,
  x.strong::int as strong_sources,
  x.weak::int as weak_sources
from public.subtopics s
cross join lateral (
  select
    count(*) filter (where public.relevance_label(c.relevance) = 'high') as strong,
    count(*) filter (where public.relevance_label(c.relevance) = 'partial') as weak
  from public.source_coverage c
  join public.sources src on src.id = c.source_id
  where c.subtopic_id = s.id and src.status = 'ready' and src.relevance_label <> 'off_topic'
) x;

-- -------------------------------------------------------------- security

alter table public.sources enable row level security;
alter table public.contents enable row level security;
alter table public.source_chunks enable row level security;
alter table public.subtopic_embeddings enable row level security;
alter table public.source_coverage enable row level security;

create policy sources_owner_select on public.sources
  for select to authenticated using (user_id = auth.uid());
create policy sources_owner_insert on public.sources
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid())
  );

create policy source_coverage_owner_select on public.source_coverage
  for select to authenticated
  using (exists (select 1 from public.sources s where s.id = source_id and s.user_id = auth.uid()));

-- Shared cache tables: worker only.
revoke all on public.contents, public.source_chunks, public.subtopic_embeddings
  from anon, authenticated;

revoke all on public.sources, public.source_coverage, public.subtopic_coverage from anon;
revoke insert, update, delete on public.sources from authenticated;
grant insert (id, goal_id, user_id, type, url_or_file, file_name) on public.sources to authenticated;
revoke insert, update, delete on public.source_coverage from authenticated;
grant select on public.subtopic_coverage to authenticated;

revoke truncate, trigger, references on public.sources, public.source_coverage from authenticated;

-- --------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sources', 'sources', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;

create policy sources_upload_own_folder on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);
create policy sources_read_own_folder on storage.objects
  for select to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);
