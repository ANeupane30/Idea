begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- Fixtures (as postgres). Users A and B; both pro so goal limits never interfere.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
update public.users set plan = 'pro';

-- gd depth, g2 other goal of A, ge ready+active scratch, a1 pending,
-- ar archived with a ready map, b1/b2 clarifying, b3 failed, b4 ready.
insert into public.goals (id, user_id, title, status, map_status) values
  ('10000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-00000000000a', 'archived', 'archived', 'ready');
insert into public.goals (id, user_id, title, map_status, map_error, clarifying_question) values
  ('10000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-00000000000a', 'depth', 'ready', null, null),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'other', 'ready', null, null),
  ('10000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-00000000000a', 'edit', 'ready', null, null),
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'pending', 'pending', null, null),
  ('10000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000a', 'q1', 'clarifying', null, 'Which area?'),
  ('10000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000a', 'q2', 'clarifying', null, 'Which area?'),
  ('10000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000000a', 'f1', 'failed', 'boom', null),
  ('10000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000000a', 'r1', 'ready', null, null);

insert into public.subtopics (id, goal_id, parent_id, title, position) values
  ('2d000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-0000000000d0', null, 'A', 0),
  ('2d000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-0000000000d0', null, 'C', 1),
  ('22000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-000000000002', null, 'X', 0),
  ('2a000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-0000000000a4', null, 'R', 0),
  ('2e000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-0000000000e0', null, 'E4', 2);
insert into public.subtopics (id, goal_id, parent_id, title, position) values
  ('2d000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000d0', '2d000000-0000-0000-0000-00000000000a', 'A1', 0);

-- worker_insert_not_edited: rows written as postgres (the worker's role) stay unedited.
select is((select user_edited from public.subtopics where id = '2e000000-0000-0000-0000-000000000004'),
  false, 'worker_insert_not_edited: postgres-role insert is not user_edited');

-- move_subtopic_removed
select hasnt_function('public', 'move_subtopic', ARRAY['uuid','uuid','integer'],
  'move_subtopic_removed: the move RPC no longer exists');

-- Start with an empty job queue so counts are exact.
delete from public.jobs;

-- subtopics_not_user_writable: owner of a ready, active goal can read but not write.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select throws_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-0000000000e0', 'new', 5)$$,
  '42501', null, 'subtopics_not_user_writable: insert denied');
select throws_ok($$update public.subtopics set title = 'renamed' where id = '2e000000-0000-0000-0000-000000000004'$$,
  '42501', null, 'subtopics_not_user_writable: update denied');
select throws_ok($$delete from public.subtopics where id = '2e000000-0000-0000-0000-000000000004'$$,
  '42501', null, 'subtopics_not_user_writable: delete denied');
select is((select count(*) from public.subtopics where goal_id = '10000000-0000-0000-0000-0000000000e0'),
  1::bigint, 'subtopics_not_user_writable: owner can still select own subtopics');
reset role;

-- depth_enforced for worker writes (postgres role).
select throws_ok($$insert into public.subtopics (goal_id, parent_id, title, position) values ('10000000-0000-0000-0000-0000000000d0', '2d000000-0000-0000-0000-0000000000a1', 'too deep', 0)$$,
  'P0001', 'max_depth_exceeded', 'depth_enforced: worker cannot insert under a child');
select throws_ok($$insert into public.subtopics (goal_id, parent_id, title, position) values ('10000000-0000-0000-0000-0000000000d0', '22000000-0000-0000-0000-0000000000e1', 'cross', 0)$$,
  'P0001', 'max_depth_exceeded', 'depth_enforced: worker cannot parent under another goal node');
select throws_ok($$update public.subtopics set parent_id = '2d000000-0000-0000-0000-00000000000c' where id = '2d000000-0000-0000-0000-00000000000a'$$,
  'P0001', 'max_depth_exceeded', 'depth_enforced: node with children cannot get a parent');

-- worker (service_role) can write while the map is pending.
set local role service_role;
select lives_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-0000000000a1', 'worker row', 1)$$,
  'worker_writes: service role can insert while pending');
reset role;
select is((select user_edited from public.subtopics where title = 'worker row'), false,
  'worker_writes: worker insert is not user_edited');

-- delete_cascades: users can delete a goal, which removes its subtopics.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select lives_ok($$delete from public.goals where id = '10000000-0000-0000-0000-0000000000a4'$$,
  'delete_cascades: user can delete an archived goal');
reset role;
select is((select count(*) from public.subtopics where goal_id = '10000000-0000-0000-0000-0000000000a4'),
  0::bigint, 'delete_cascades: deleting a goal removes its subtopics');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';

-- answer_clarification_flow
select lives_ok($$select public.answer_clarification('10000000-0000-0000-0000-0000000000b1', '  Web development  ')$$,
  'answer_clarification_flow: answers a clarifying goal');
select is((select clarification_answer from public.goals where id = '10000000-0000-0000-0000-0000000000b1'),
  'Web development', 'answer_clarification_flow: trimmed answer stored');
select is((select map_status from public.goals where id = '10000000-0000-0000-0000-0000000000b1'),
  'pending', 'answer_clarification_flow: status pending');
reset role;
select is((select count(*) from public.jobs where kind = 'topic_map'
    and payload->>'goal_id' = '10000000-0000-0000-0000-0000000000b1'), 1::bigint,
  'answer_clarification_flow: one job enqueued');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select throws_ok($$select public.answer_clarification('10000000-0000-0000-0000-0000000000b4', 'x')$$,
  'P0001', 'not_clarifying', 'answer_clarification_flow: ready goal rejected');
select throws_ok($$select public.answer_clarification('10000000-0000-0000-0000-0000000000b2', '   ')$$,
  'P0001', 'invalid_answer', 'answer_clarification_flow: blank answer rejected');
select throws_ok($$select public.answer_clarification('10000000-0000-0000-0000-0000000000b2', repeat('x', 1001))$$,
  'P0001', 'invalid_answer', 'answer_clarification_flow: 1001-char answer rejected');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
select throws_ok($$select public.answer_clarification('10000000-0000-0000-0000-0000000000b2', 'mine')$$,
  'P0001', 'goal_not_found', 'answer_clarification_flow: other user goal rejected');

-- retry_flow
select throws_ok($$select public.retry_topic_map('10000000-0000-0000-0000-0000000000b3')$$,
  'P0001', 'goal_not_found', 'retry_flow: other user goal rejected');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select lives_ok($$select public.retry_topic_map('10000000-0000-0000-0000-0000000000b3')$$,
  'retry_flow: retries a failed goal');
select is((select map_status from public.goals where id = '10000000-0000-0000-0000-0000000000b3'),
  'pending', 'retry_flow: status pending');
select is((select map_error from public.goals where id = '10000000-0000-0000-0000-0000000000b3'),
  null, 'retry_flow: map_error cleared');
reset role;
select is((select count(*) from public.jobs where kind = 'topic_map'
    and payload->>'goal_id' = '10000000-0000-0000-0000-0000000000b3'), 1::bigint,
  'retry_flow: one job enqueued');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select throws_ok($$select public.retry_topic_map('10000000-0000-0000-0000-0000000000b4')$$,
  'P0001', 'not_failed', 'retry_flow: ready goal rejected');

select * from finish();
rollback;
