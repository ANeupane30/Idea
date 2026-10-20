begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Guests are anonymous auth users with a null email.
insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-0000000000a1', null, true),
  ('00000000-0000-0000-0000-0000000000a2', null, true),
  ('00000000-0000-0000-0000-0000000000a3', null, true);

-- guest_row_created
select is((select plan from public.users where id = '00000000-0000-0000-0000-0000000000a1'),
  'free', 'guest_row_created: guest gets a free public.users row');
select is((select email from public.users where id = '00000000-0000-0000-0000-0000000000a1'),
  null, 'guest row has a null email');

-- guest_one_goal
select lives_ok($$insert into public.goals (id, user_id, title) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'First')$$,
  'guest_one_goal: first active goal succeeds');
select throws_ok($$insert into public.goals (user_id, title) values
  ('00000000-0000-0000-0000-0000000000a1', 'Second')$$,
  'P0001', 'guest_goal_limit_reached', 'guest_one_goal: second active goal is rejected');

-- converted_guest_gets_free_limit
insert into public.goals (id, user_id, title) values
  ('10000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2', 'First');
update auth.users set is_anonymous = false, email = 'x@example.com'
  where id = '00000000-0000-0000-0000-0000000000a2';
select is((select email from public.users where id = '00000000-0000-0000-0000-0000000000a2'),
  'x@example.com', 'converted_guest_gets_free_limit: email synced to public.users');
select lives_ok($$insert into public.goals (user_id, title) values
  ('00000000-0000-0000-0000-0000000000a2', 'Second')$$,
  'converted guest can add a second goal');
select throws_ok($$insert into public.goals (user_id, title) values
  ('00000000-0000-0000-0000-0000000000a2', 'Third')$$,
  'P0001', 'goal_limit_reached', 'converted guest is limited to 2 (goal_limit_reached)');

-- guest_unarchive_limit
insert into public.goals (id, user_id, title, status) values
  ('10000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a3', 'Old', 'archived');
insert into public.goals (id, user_id, title) values
  ('10000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a3', 'Current');
select throws_ok($$update public.goals set status = 'active'
  where id = '10000000-0000-0000-0000-0000000000a3'$$,
  'P0001', 'guest_goal_limit_reached', 'guest_unarchive_limit: guest cannot unarchive past one active goal');

select is((select count(*)::int from public.goals where user_id = '00000000-0000-0000-0000-0000000000a3' and status = 'active'),
  1, 'guest still has exactly one active goal');

select * from finish();
rollback;
