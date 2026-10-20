-- Lesson limits (Phase 3 final review): what counts as a generation.
-- - A lesson that streamed any content counts even if it then failed (closing the
--   stream early must not give free lessons).
-- - A generation still in progress counts, but one left 'generating' for over 10
--   minutes (a crashed server) does not.

alter table public.lessons add column delivered boolean not null default false;

create or replace function public.lessons_enforce_limit() returns trigger
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

  select count(*) into used from public.lessons l
  where l.user_id = new.user_id and not l.reused
    and (l.status = 'ready' or l.delivered
         or (l.status = 'generating' and l.created_at > now() - interval '10 minutes'))
    and (guest or l.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc');

  if guest and used >= 5 then
    raise exception 'guest_lesson_limit_reached';
  end if;
  if not guest and used >= public.daily_lesson_limit(user_plan) then
    raise exception 'lesson_limit_reached';
  end if;
  return new;
end;
$$;
