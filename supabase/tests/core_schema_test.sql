begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

-- Fixtures: three auth users (A, B free; P made pro below).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com'),
  ('00000000-0000-0000-0000-0000000000f0', 'pro@example.com');

-- users_row_created
select is((select plan from public.users where id = '00000000-0000-0000-0000-00000000000a'),
  'free', 'users_row_created: sign-up creates public.users row with plan free');
select is((select email from public.users where id = '00000000-0000-0000-0000-00000000000a'),
  'a@example.com', 'users_row_created: email copied from auth.users');

update public.users set plan = 'pro' where id = '00000000-0000-0000-0000-0000000000f0';

-- plan_not_user_writable
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select throws_ok($$update public.users set plan = 'pro' where id = '00000000-0000-0000-0000-00000000000a'$$,
  '42501', null, 'plan_not_user_writable: users cannot update plan');
select lives_ok($$update public.users set display_name = 'Ann' where id = '00000000-0000-0000-0000-00000000000a'$$,
  'plan_not_user_writable: users can update display_name');
select is((select display_name from public.users where id = '00000000-0000-0000-0000-00000000000a'),
  'Ann', 'plan_not_user_writable: display_name updated');

-- Seed A's data (still as A).
insert into public.goals (id, user_id, title)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'A goal');
insert into public.subtopics (goal_id, title, position)
  values ('10000000-0000-0000-0000-00000000000a', 'A subtopic', 0);
insert into public.learning_prefs (user_id, preferred_format, level)
  values ('00000000-0000-0000-0000-00000000000a', 'visual', 'beginner');

-- rls_isolation
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
select is((select count(*) from public.goals), 0::bigint, 'rls_isolation: B sees none of A goals');
select is((select count(*) from public.subtopics), 0::bigint, 'rls_isolation: B sees none of A subtopics');
select is((select count(*) from public.learning_prefs), 0::bigint, 'rls_isolation: B sees none of A learning_prefs');
select throws_ok($$insert into public.goals (user_id, title) values ('00000000-0000-0000-0000-00000000000a', 'sneaky')$$,
  '42501', null, 'rls_isolation: B cannot insert a goal for A');
select throws_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-00000000000a', 'sneaky', 1)$$,
  '42501', null, 'rls_isolation: B cannot insert a subtopic into A goal');

-- jobs_not_visible (A's goal insert enqueued a job; A must not see it)
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select is((select count(*) from public.jobs), 0::bigint, 'jobs_not_visible: authenticated sees no jobs');
select throws_ok($$insert into public.jobs (kind, payload) values ('topic_map', '{}')$$,
  '42501', null, 'jobs_not_visible: authenticated cannot insert jobs');
select throws_ok($$insert into public.usage_events (user_id, kind, tokens, cost_cents) values ('00000000-0000-0000-0000-00000000000a', 'map', 1, 0.1)$$,
  '42501', null, 'jobs_not_visible: authenticated cannot insert usage_events');
select throws_ok($$update public.goals set map_status = 'ready' where id = '10000000-0000-0000-0000-00000000000a'$$,
  '42501', null, 'map_status is not user-writable');

-- goal_enqueues_job
reset role;
select is((select count(*) from public.jobs where kind = 'topic_map'
    and payload->>'goal_id' = '10000000-0000-0000-0000-00000000000a'), 1::bigint,
  'goal_enqueues_job: exactly one topic_map job for the goal');
select is((select map_status from public.goals where id = '10000000-0000-0000-0000-00000000000a'),
  'pending', 'goal_enqueues_job: map_status is pending');

-- goal_limit (free user A has 1 active goal)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
insert into public.goals (id, user_id, title)
  values ('10000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'A goal 2');
select throws_ok($$insert into public.goals (user_id, title) values ('00000000-0000-0000-0000-00000000000a', 'A goal 3')$$,
  'P0001', 'goal_limit_reached', 'goal_limit: free user 3rd active goal rejected');
update public.goals set status = 'archived' where id = '10000000-0000-0000-0000-00000000000a';
select lives_ok($$insert into public.goals (user_id, title) values ('00000000-0000-0000-0000-00000000000a', 'A goal 3')$$,
  'goal_limit: insert succeeds after archiving one');
select throws_ok($$update public.goals set status = 'active' where id = '10000000-0000-0000-0000-00000000000a'$$,
  'P0001', 'goal_limit_reached', 'goal_limit: unarchiving at the limit rejected');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f0"}';
select lives_ok($$insert into public.goals (user_id, title)
  select '00000000-0000-0000-0000-0000000000f0', 'P goal ' || g from generate_series(1, 3) g$$,
  'goal_limit: pro user can insert 3');

-- title_constraints
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
select throws_ok($$insert into public.goals (user_id, title) values ('00000000-0000-0000-0000-00000000000b', '   ')$$,
  '23514', null, 'title_constraints: whitespace-only goal title rejected');
select throws_ok($$insert into public.goals (user_id, title) values ('00000000-0000-0000-0000-00000000000b', repeat('x', 121))$$,
  '23514', null, 'title_constraints: 121-char goal title rejected');
insert into public.goals (id, user_id, title)
  values ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', '  Learn 日本語 🎌  ');
select is((select title from public.goals where id = '10000000-0000-0000-0000-00000000000b'),
  'Learn 日本語 🎌', 'title_constraints: goal title trimmed and unicode preserved');
select throws_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-00000000000b', '   ', 0)$$,
  '23514', null, 'title_constraints: whitespace-only subtopic title rejected');
select throws_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-00000000000b', repeat('x', 121), 0)$$,
  '23514', null, 'title_constraints: 121-char subtopic title rejected');

-- prefs_enums
select throws_ok($$insert into public.learning_prefs (user_id, preferred_format, level) values ('00000000-0000-0000-0000-00000000000b', 'audio', 'beginner')$$,
  '23514', null, 'prefs_enums: preferred_format audio rejected');

select * from finish();
rollback;
