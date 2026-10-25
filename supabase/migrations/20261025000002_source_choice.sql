-- The learner's answer on the source decision screen is kept, so the screen is shown once.

alter table public.goals add column source_choice text check (source_choice in ('find', 'use'));

create or replace function public.answer_source_decision(p_goal_id uuid, p_choice text) returns void
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
    -- The learner's sources that didn't pass stay in their list as "Not used".
    update public.sources set status = 'ready', step = null
    where goal_id = p_goal_id and origin = 'user' and status = 'awaiting_map' and vetted = false;
    -- A new reading phase gets its own timer (set when the found sources are queued).
    update public.goals set map_status = 'finding_sources', source_choice = 'find', reading_started_at = null
    where id = p_goal_id;
    insert into public.jobs (kind, payload) values ('find_sources', jsonb_build_object('goal_id', p_goal_id));
  else
    update public.sources set vetted = true
    where goal_id = p_goal_id and origin = 'user' and status = 'awaiting_map';
    update public.goals set map_status = 'building_map', source_choice = 'use' where id = p_goal_id;
    insert into public.jobs (kind, payload) values ('topic_map', jsonb_build_object('goal_id', p_goal_id));
  end if;
end;
$$;
