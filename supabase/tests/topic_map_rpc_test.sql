begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- Fixtures (as postgres). Users A and B; both pro so goal limits never interfere.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
update public.users set plan = 'pro';

-- g1 reorder, g3 nest, gd depth, g2 other goal of A, ge editable scratch,
-- a1/a2/a3 pending/clarifying/failed, b1/b2 clarifying, b3 failed, b4 ready.
-- ar is an archived goal with a ready map.
insert into public.goals (id, user_id, title, status, map_status) values
  ('10000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-00000000000a', 'archived', 'archived', 'ready');
insert into public.goals (id, user_id, title, map_status, map_error, clarifying_question) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'reorder', 'ready', null, null),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'nest', 'ready', null, null),
  ('10000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-00000000000a', 'depth', 'ready', null, null),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'other', 'ready', null, null),
  ('10000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-00000000000a', 'edit', 'ready', null, null),
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'pending', 'pending', null, null),
  ('10000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'clarifying', 'clarifying', null, 'Which area?'),
  ('10000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000000a', 'failed', 'failed', 'boom', null),
  ('10000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000a', 'q1', 'clarifying', null, 'Which area?'),
  ('10000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000a', 'q2', 'clarifying', null, 'Which area?'),
  ('10000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000000a', 'f1', 'failed', 'boom', null),
  ('10000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000000a', 'r1', 'ready', null, null);

insert into public.subtopics (id, goal_id, parent_id, title, position) values
  ('21000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, 'A', 0),
  ('21000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001', null, 'B', 1),
  ('21000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-000000000001', null, 'C', 2),
  ('23000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000003', null, 'A', 0),
  ('23000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000003', null, 'B', 1),
  ('23000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-000000000003', null, 'C', 2),
  ('2d000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-0000000000d0', null, 'A', 0),
  ('2d000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-0000000000d0', null, 'C', 1),
  ('22000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-000000000002', null, 'X', 0),
  ('2e000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e0', null, 'E1', 0),
  ('2a000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000a1', null, 'P', 0),
  ('2a000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-0000000000a2', null, 'C', 0),
  ('2a000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-0000000000a3', null, 'F', 0),
  ('2a000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-0000000000a4', null, 'R', 0),
  ('2e000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-0000000000e0', null, 'E4', 2);
insert into public.subtopics (id, goal_id, parent_id, title, position) values
  ('2d000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000d0', '2d000000-0000-0000-0000-00000000000a', 'A1', 0),
  ('2e000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-0000000000e0', '2e000000-0000-0000-0000-000000000001', 'E1 child', 0);

-- worker_insert_not_edited: rows written as postgres (the worker's role) stay unedited.
select is((select user_edited from public.subtopics where id = '2e000000-0000-0000-0000-000000000004'),
  false, 'worker_insert_not_edited: postgres-role insert is not user_edited');

-- Start with an empty job queue so counts are exact.
delete from public.jobs;

-- move_reorders
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select lives_ok($$select public.move_subtopic('21000000-0000-0000-0000-00000000000c', null, 0)$$,
  'move_reorders: move C to the front');
select results_eq(
  $$select title || position::text from public.subtopics
    where goal_id = '10000000-0000-0000-0000-000000000001' order by position$$,
  $$values ('C0'), ('A1'), ('B2')$$,
  'move_reorders: order C,A,B with positions 0,1,2');
select is((select user_edited from public.subtopics where id = '21000000-0000-0000-0000-00000000000c'),
  true, 'move_reorders: moved row is user_edited');
select is((select user_edited from public.subtopics where id = '21000000-0000-0000-0000-00000000000a'),
  false, 'move_reorders: renumbered sibling is not user_edited');

-- move_nests_and_compacts
select lives_ok($$select public.move_subtopic('23000000-0000-0000-0000-00000000000b', '23000000-0000-0000-0000-00000000000a', 0)$$,
  'move_nests_and_compacts: nest B under A');
select results_eq(
  $$select title || position::text from public.subtopics
    where goal_id = '10000000-0000-0000-0000-000000000003' and parent_id is null order by position$$,
  $$values ('A0'), ('C1')$$,
  'move_nests_and_compacts: top level is A,C at 0,1');
select results_eq(
  $$select title || position::text from public.subtopics
    where parent_id = '23000000-0000-0000-0000-00000000000a'$$,
  $$values ('B0')$$,
  'move_nests_and_compacts: B at position 0 under A');
select lives_ok($$select public.move_subtopic('23000000-0000-0000-0000-00000000000c', '23000000-0000-0000-0000-00000000000a', 99)$$,
  'move_nests_and_compacts: out-of-range position is clamped');
select results_eq(
  $$select title || position::text from public.subtopics
    where parent_id = '23000000-0000-0000-0000-00000000000a' order by position$$,
  $$values ('B0'), ('C1')$$,
  'move_nests_and_compacts: clamped to the end');

-- depth_enforced
select throws_ok($$select public.move_subtopic('2d000000-0000-0000-0000-00000000000a', '2d000000-0000-0000-0000-00000000000c', 0)$$,
  'P0001', 'max_depth_exceeded', 'depth_enforced: node with children cannot get a parent');
select throws_ok($$select public.move_subtopic('2d000000-0000-0000-0000-00000000000c', '2d000000-0000-0000-0000-0000000000a1', 0)$$,
  'P0001', 'max_depth_exceeded', 'depth_enforced: cannot nest under a grandchild');
select throws_ok($$select public.move_subtopic('2d000000-0000-0000-0000-00000000000c', '22000000-0000-0000-0000-0000000000e1', 0)$$,
  'P0001', 'max_depth_exceeded', 'depth_enforced: cannot nest under another goal node');

-- edit_requires_ready (pending, clarifying, failed)
select throws_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-0000000000a1', 'new', 1)$$,
  'P0001', 'map_not_editable', 'edit_requires_ready: insert rejected while pending');
select throws_ok($$select public.move_subtopic('2a000000-0000-0000-0000-000000000001', null, 0)$$,
  'P0001', 'map_not_editable', 'edit_requires_ready: move rejected while pending');
select throws_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-0000000000a2', 'new', 1)$$,
  'P0001', 'map_not_editable', 'edit_requires_ready: insert rejected while clarifying');
select throws_ok($$select public.move_subtopic('2a000000-0000-0000-0000-000000000002', null, 0)$$,
  'P0001', 'map_not_editable', 'edit_requires_ready: move rejected while clarifying');
select throws_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-0000000000a3', 'new', 1)$$,
  'P0001', 'map_not_editable', 'edit_requires_ready: insert rejected while failed');
select throws_ok($$select public.move_subtopic('2a000000-0000-0000-0000-000000000003', null, 0)$$,
  'P0001', 'map_not_editable', 'edit_requires_ready: move rejected while failed');
reset role;
set local role service_role;
select lives_ok($$insert into public.subtopics (goal_id, title, position) values ('10000000-0000-0000-0000-0000000000a1', 'worker row', 1)$$,
  'edit_requires_ready: service role can insert while pending');
reset role;
select is((select user_edited from public.subtopics where title = 'worker row'), false,
  'edit_requires_ready: worker insert is not user_edited');

-- rename_marks_edited
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select lives_ok($$insert into public.subtopics (id, goal_id, title, position, user_edited) values ('2e000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-0000000000e0', 'E3', 1, false)$$,
  'rename_marks_edited: user can insert into a ready goal');
select is((select user_edited from public.subtopics where id = '2e000000-0000-0000-0000-000000000003'),
  true, 'user_insert_marks_edited: authenticated insert is user_edited even if false is passed');
update public.subtopics set position = 5 where id = '2e000000-0000-0000-0000-000000000004';
select is((select user_edited from public.subtopics where id = '2e000000-0000-0000-0000-000000000004'),
  false, 'rename_marks_edited: position-only update does not mark edited');
update public.subtopics set title = 'E4 renamed' where id = '2e000000-0000-0000-0000-000000000004';
select is((select user_edited from public.subtopics where id = '2e000000-0000-0000-0000-000000000004'),
  true, 'rename_marks_edited: title update marks edited');
update public.subtopics set user_edited = false where id = '2e000000-0000-0000-0000-000000000004';
select is((select user_edited from public.subtopics where id = '2e000000-0000-0000-0000-000000000004'),
  true, 'edited_is_sticky: authenticated update with user_edited=false keeps it true');
update public.subtopics set user_edited = false, position = 6 where id = '2e000000-0000-0000-0000-000000000003';
select is((select user_edited from public.subtopics where id = '2e000000-0000-0000-0000-000000000003'),
  true, 'edited_is_sticky: clearing the flag alongside a position change keeps it true');
select throws_ok($$update public.subtopics set goal_id = '10000000-0000-0000-0000-000000000002' where id = '2e000000-0000-0000-0000-000000000004'$$,
  'P0001', 'map_not_editable', 'goal_id_immutable: moving a subtopic to another goal is rejected');

-- delete_requires_editable_map
select throws_ok($$delete from public.subtopics where id = '2a000000-0000-0000-0000-000000000004'$$,
  'P0001', 'map_not_editable', 'delete_requires_editable_map: delete from an archived goal rejected');
select throws_ok($$delete from public.subtopics where id = '2a000000-0000-0000-0000-000000000001'$$,
  'P0001', 'map_not_editable', 'delete_requires_editable_map: delete from a pending goal rejected');
select lives_ok($$delete from public.subtopics where id = '2e000000-0000-0000-0000-000000000003'$$,
  'delete_requires_editable_map: delete from a ready, active goal works');
select is((select count(*) from public.subtopics where id = '2e000000-0000-0000-0000-000000000003'),
  0::bigint, 'delete_requires_editable_map: the row is gone');

-- delete_cascades
delete from public.subtopics where id = '2e000000-0000-0000-0000-000000000001';
select is((select count(*) from public.subtopics where goal_id = '10000000-0000-0000-0000-0000000000e0' and title like 'E1%'),
  0::bigint, 'delete_cascades: deleting a parent removes its children');
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
