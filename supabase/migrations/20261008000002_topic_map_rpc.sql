-- Topic map editing guard and lifecycle RPCs.

-- Runs for every role: enforces the two-level depth rule. When the caller is
-- an end user (role authenticated) it also requires an editable map and marks
-- edited rows. Security invoker on purpose: current_user must be the caller,
-- and RLS hides other users' rows (a hidden parent falls through to the FK).
create function public.subtopics_guard() returns trigger
language plpgsql
as $$
declare
  goal_row record;
  parent_row record;
begin
  if current_user = 'authenticated' then
    -- A subtopic never moves between goals.
    if tg_op = 'UPDATE' and new.goal_id <> old.goal_id then
      raise exception 'map_not_editable';
    end if;
    select g.map_status, g.status into goal_row
    from public.goals g where g.id = new.goal_id;
    -- Goal not visible: leave it to RLS to reject the write.
    if found and (goal_row.map_status <> 'ready' or goal_row.status <> 'active') then
      raise exception 'map_not_editable';
    end if;
  end if;

  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'max_depth_exceeded';
    end if;
    select s.goal_id, s.parent_id into parent_row
    from public.subtopics s where s.id = new.parent_id;
    if found and (parent_row.goal_id <> new.goal_id or parent_row.parent_id is not null) then
      raise exception 'max_depth_exceeded';
    end if;
    if tg_op = 'UPDATE' and exists (
      select 1 from public.subtopics c where c.parent_id = new.id
    ) then
      raise exception 'max_depth_exceeded';
    end if;
  end if;

  -- user_edited is monotonic for end users: anything they add is theirs, a
  -- content change marks the row, and they can never clear the flag.
  -- Position-only renumbering leaves it alone (move_subtopic marks the moved row).
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.user_edited := true;
    else
      new.user_edited := old.user_edited
        or new.user_edited
        or btrim(new.title) is distinct from old.title
        or new.summary is distinct from old.summary
        or new.parent_id is distinct from old.parent_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger subtopics_guard
  before insert or update on public.subtopics
  for each row execute function public.subtopics_guard();

-- End users may delete only from a ready map of an active goal. FK cascades
-- (deleting a parent or a goal) run as the table owner, so they pass.
create function public.subtopics_delete_guard() returns trigger
language plpgsql
as $$
declare
  goal_row record;
begin
  if current_user = 'authenticated' then
    select g.map_status, g.status into goal_row
    from public.goals g where g.id = old.goal_id;
    if found and (goal_row.map_status <> 'ready' or goal_row.status <> 'active') then
      raise exception 'map_not_editable';
    end if;
  end if;
  return old;
end;
$$;

create trigger subtopics_delete_guard
  before delete on public.subtopics
  for each row execute function public.subtopics_delete_guard();

-- Move a node under p_parent_id (null = top level) at p_position (0-based,
-- clamped), renumbering siblings in the old and new parent to 0..n-1.
create function public.move_subtopic(p_id uuid, p_parent_id uuid, p_position int)
returns void
language plpgsql
as $$
declare
  v_goal uuid;
  v_old_parent uuid;
  v_count int;
  v_pos int;
begin
  select s.goal_id, s.parent_id into v_goal, v_old_parent
  from public.subtopics s where s.id = p_id;
  if not found then
    raise exception 'subtopic_not_found';
  end if;

  -- Serialize concurrent moves within the goal.
  perform 1 from public.subtopics s where s.goal_id = v_goal order by s.id for update;

  -- Re-read: the parent may have changed while waiting for the lock.
  select s.parent_id into v_old_parent from public.subtopics s where s.id = p_id;

  select count(*) into v_count
  from public.subtopics s
  where s.goal_id = v_goal and s.parent_id is not distinct from p_parent_id and s.id <> p_id;
  v_pos := least(greatest(coalesce(p_position, 0), 0), v_count);

  -- The guard validates editability and depth here.
  update public.subtopics
  set parent_id = p_parent_id, position = v_pos, user_edited = true
  where id = p_id;

  -- Siblings in the new parent: close the gap around the moved row.
  update public.subtopics s
  set position = o.rn + case when o.rn >= v_pos then 1 else 0 end
  from (
    select x.id, (row_number() over (order by x.position, x.id) - 1)::int as rn
    from public.subtopics x
    where x.goal_id = v_goal and x.parent_id is not distinct from p_parent_id and x.id <> p_id
  ) o
  where s.id = o.id and s.position <> o.rn + case when o.rn >= v_pos then 1 else 0 end;

  -- Old parent: compact.
  if v_old_parent is distinct from p_parent_id then
    update public.subtopics s
    set position = o.rn
    from (
      select x.id, (row_number() over (order by x.position, x.id) - 1)::int as rn
      from public.subtopics x
      where x.goal_id = v_goal and x.parent_id is not distinct from v_old_parent
    ) o
    where s.id = o.id and s.position <> o.rn;
  end if;
end;
$$;

create function public.answer_clarification(p_goal_id uuid, p_answer text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
  v_answer text := btrim(p_answer);
begin
  select g.map_status into v_status
  from public.goals g
  where g.id = p_goal_id and g.user_id = auth.uid()
  for update;
  if not found then
    raise exception 'goal_not_found';
  end if;
  if v_status <> 'clarifying' then
    raise exception 'not_clarifying';
  end if;
  if v_answer is null or char_length(v_answer) not between 1 and 1000 then
    raise exception 'invalid_answer';
  end if;

  update public.goals
  set clarification_answer = v_answer, map_status = 'pending'
  where id = p_goal_id;
  insert into public.jobs (kind, payload)
  values ('topic_map', jsonb_build_object('goal_id', p_goal_id));
end;
$$;

create function public.retry_topic_map(p_goal_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  select g.map_status into v_status
  from public.goals g
  where g.id = p_goal_id and g.user_id = auth.uid()
  for update;
  if not found then
    raise exception 'goal_not_found';
  end if;
  if v_status <> 'failed' then
    raise exception 'not_failed';
  end if;

  update public.goals
  set map_status = 'pending', map_error = null
  where id = p_goal_id;
  insert into public.jobs (kind, payload)
  values ('topic_map', jsonb_build_object('goal_id', p_goal_id));
end;
$$;

revoke execute on function
  public.move_subtopic(uuid, uuid, int),
  public.answer_clarification(uuid, text),
  public.retry_topic_map(uuid)
from public, anon;
grant execute on function
  public.move_subtopic(uuid, uuid, int),
  public.answer_clarification(uuid, text),
  public.retry_topic_map(uuid)
to authenticated;
