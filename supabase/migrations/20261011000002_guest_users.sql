-- Guest users: anonymous auth users get one active goal until they sign up.

-- Replaces the core-schema version. Same row lock on the user (it serializes
-- concurrent inserts); anonymous users get a limit of 1 with their own error.
create or replace function public.enforce_goal_limit() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  user_plan text;
  guest boolean;
  active_count int;
begin
  if new.status <> 'active' then
    return new;
  end if;

  select u.plan into user_plan from public.users u where u.id = new.user_id for update;

  select coalesce(a.is_anonymous, false) into guest
  from auth.users a where a.id = new.user_id;

  select count(*) into active_count
  from public.goals g
  where g.user_id = new.user_id and g.status = 'active' and g.id <> new.id;

  if guest and active_count >= 1 then
    raise exception 'guest_goal_limit_reached';
  end if;

  if active_count >= public.active_goal_limit(user_plan) then
    raise exception 'goal_limit_reached';
  end if;
  return new;
end;
$$;

-- Keep public.users.email in step with auth.users.email (guest conversion
-- sets the email on the same user id).
create function public.sync_auth_user_email() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.users set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.sync_auth_user_email();
