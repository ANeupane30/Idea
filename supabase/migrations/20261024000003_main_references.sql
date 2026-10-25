-- Each topic's main reference (its chapter, section, page or timestamp) for the goal page.
-- Chunks are worker-only, so the owner reads just the parts needed to label and link it.

create function public.goal_main_references(p_goal_id uuid)
returns table (
  subtopic_id uuid,
  source_title text,
  source_type text,
  url_or_file text,
  page int,
  timestamp_start numeric,
  anchor text
)
language sql stable security definer set search_path = public
as $$
  select distinct on (t.id)
    t.id, coalesce(s.title, s.file_name, s.url_or_file), s.type, s.url_or_file, c.page, c.timestamp_start, c.anchor
  from public.subtopics t
  join public.goals g on g.id = t.goal_id and g.user_id = auth.uid()
  join public.source_chunks c on c.id = t.primary_ref
  join public.sources s on s.goal_id = t.goal_id and s.content_hash = c.content_hash and s.status <> 'failed'
  where t.goal_id = p_goal_id
  order by t.id, s.origin = 'auto', s.created_at;
$$;

revoke execute on function public.goal_main_references(uuid) from public, anon;
grant execute on function public.goal_main_references(uuid) to authenticated;
