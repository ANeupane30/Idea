begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-0000000007a0', 'la@example.com', false),
  ('00000000-0000-0000-0000-0000000007b0', 'lb@example.com', false),
  ('00000000-0000-0000-0000-0000000007c0', null, true);
insert into public.goals (id, user_id, title, map_status) values
  ('10000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007a0', 'A', 'ready'),
  ('10000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007b0', 'B', 'ready'),
  ('10000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007c0', 'G', 'ready');
insert into public.subtopics (id, goal_id, title, position) values
  ('20000000-0000-0000-0000-0000000007a1', '10000000-0000-0000-0000-0000000007a1', 'A t1', 0),
  ('20000000-0000-0000-0000-0000000007a2', '10000000-0000-0000-0000-0000000007a1', 'A t2', 1),
  ('20000000-0000-0000-0000-0000000007a3', '10000000-0000-0000-0000-0000000007a1', 'A t3', 2),
  ('20000000-0000-0000-0000-0000000007b1', '10000000-0000-0000-0000-0000000007b1', 'B t1', 0),
  ('20000000-0000-0000-0000-0000000007c1', '10000000-0000-0000-0000-0000000007c1', 'G t1', 0);

-- free_lesson_limit: 15 a day (as postgres, like the worker)
select lives_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status)
  select '00000000-0000-0000-0000-0000000007a0', '20000000-0000-0000-0000-0000000007a1', 'text', 'beginner', 'k' || i, 'ready'
  from generate_series(1, 15) i$$, 'free_lesson_limit: 15 generations today succeed');
select throws_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status) values
  ('00000000-0000-0000-0000-0000000007a0', '20000000-0000-0000-0000-0000000007a1', 'text', 'beginner', 'k16', 'ready')$$,
  'P0001', 'lesson_limit_reached', 'free_lesson_limit: the 16th is rejected');
select lives_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status, reused) values
  ('00000000-0000-0000-0000-0000000007a0', '20000000-0000-0000-0000-0000000007a1', 'text', 'beginner', 'k1', 'ready', true)$$,
  'free_lesson_limit: a reused copy is not a generation');

-- failed_lessons_do_not_count
update public.lessons set status = 'failed'
  where id = (select id from public.lessons where cache_key = 'k15' limit 1);
select lives_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status) values
  ('00000000-0000-0000-0000-0000000007a0', '20000000-0000-0000-0000-0000000007a1', 'text', 'beginner', 'k17', 'ready')$$,
  'failed_lessons_do_not_count: a failed lesson frees a slot');

-- guest_lesson_limit: 5 in total
select lives_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status)
  select '00000000-0000-0000-0000-0000000007c0', '20000000-0000-0000-0000-0000000007c1', 'visual', 'beginner', 'g' || i, 'ready'
  from generate_series(1, 5) i$$, 'guest_lesson_limit: 5 succeed');
select throws_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status) values
  ('00000000-0000-0000-0000-0000000007c0', '20000000-0000-0000-0000-0000000007c1', 'visual', 'beginner', 'g6', 'ready')$$,
  'P0001', 'guest_lesson_limit_reached', 'guest_lesson_limit: the 6th is rejected');

-- one_generating_per_topic_format
insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status, reused) values
  ('00000000-0000-0000-0000-0000000007b0', '20000000-0000-0000-0000-0000000007b1', 'visual', 'beginner', 'b1', 'generating', false);
select throws_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status) values
  ('00000000-0000-0000-0000-0000000007b0', '20000000-0000-0000-0000-0000000007b1', 'visual', 'beginner', 'b2', 'generating')$$,
  '23505', null, 'one_generating_per_topic_format: a second generating row is rejected');
select lives_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status) values
  ('00000000-0000-0000-0000-0000000007b0', '20000000-0000-0000-0000-0000000007b1', 'text', 'beginner', 'b3', 'generating')$$,
  'one_generating_per_topic_format: another format can generate');

-- mark_lessons_stale
insert into public.sources (id, user_id, goal_id, type, url_or_file) values
  ('30000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007a0', '10000000-0000-0000-0000-0000000007a1', 'web', 'https://e.com/1'),
  ('30000000-0000-0000-0000-0000000007a2', '00000000-0000-0000-0000-0000000007a0', '10000000-0000-0000-0000-0000000007a1', 'web', 'https://e.com/2');
update public.sources set status = 'ready', relevance_label = 'partial' where id = '30000000-0000-0000-0000-0000000007a1';
update public.sources set status = 'ready', relevance_label = 'off_topic' where id = '30000000-0000-0000-0000-0000000007a2';
insert into public.source_coverage (source_id, subtopic_id, relevance, reason) values
  ('30000000-0000-0000-0000-0000000007a1', '20000000-0000-0000-0000-0000000007a1', 0.50, 'r'),
  ('30000000-0000-0000-0000-0000000007a1', '20000000-0000-0000-0000-0000000007a2', 0.30, 'r'),
  ('30000000-0000-0000-0000-0000000007a2', '20000000-0000-0000-0000-0000000007a3', 0.90, 'r');
insert into public.lessons (id, user_id, subtopic_id, format, level, cache_key, status, reused) values
  ('40000000-0000-0000-0000-0000000007a2', '00000000-0000-0000-0000-0000000007a0', '20000000-0000-0000-0000-0000000007a2', 'text', 'beginner', 's2', 'ready', true),
  ('40000000-0000-0000-0000-0000000007a3', '00000000-0000-0000-0000-0000000007a0', '20000000-0000-0000-0000-0000000007a3', 'text', 'beginner', 's3', 'ready', true);
select public.mark_lessons_stale('30000000-0000-0000-0000-0000000007a1');
select public.mark_lessons_stale('30000000-0000-0000-0000-0000000007a2');
select ok((select bool_and(stale) from public.lessons where subtopic_id = '20000000-0000-0000-0000-0000000007a1' and status = 'ready'),
  'mark_lessons_stale: a topic covered at 0.50 goes stale');
select ok(not (select stale from public.lessons where id = '40000000-0000-0000-0000-0000000007a2'),
  'mark_lessons_stale: coverage below 0.40 leaves the lesson fresh');
select ok(not (select stale from public.lessons where id = '40000000-0000-0000-0000-0000000007a3'),
  'mark_lessons_stale: an off-topic source leaves the lesson fresh');

-- format_chosen_default
insert into public.learning_prefs (user_id) values ('00000000-0000-0000-0000-0000000007b0');
select is((select format_chosen from public.learning_prefs where user_id = '00000000-0000-0000-0000-0000000007b0'),
  false, 'format_chosen_default: false for a new row');

-- rls_lessons
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007b0"}';
select is((select count(*) from public.lessons where user_id = '00000000-0000-0000-0000-0000000007a0'),
  0::bigint, 'rls_lessons: B sees none of A lessons');
select throws_ok($$update public.lessons set status = 'ready' where user_id = '00000000-0000-0000-0000-0000000007b0'$$,
  '42501', null, 'rls_lessons: users cannot update lessons');

-- feedback_owner_only
select throws_ok($$insert into public.lesson_feedback (lesson_id, user_id, rating) values
  ('40000000-0000-0000-0000-0000000007a2', '00000000-0000-0000-0000-0000000007b0', 'up')$$,
  '42501', null, 'feedback_owner_only: B cannot rate A lesson');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007a0"}';
select lives_ok($$insert into public.lesson_feedback (lesson_id, user_id, rating) values
  ('40000000-0000-0000-0000-0000000007a2', '00000000-0000-0000-0000-0000000007a0', 'up')$$,
  'feedback_owner_only: A can rate A lesson');
select throws_ok($$insert into public.lesson_feedback (lesson_id, user_id) values
  ('40000000-0000-0000-0000-0000000007a2', '00000000-0000-0000-0000-0000000007a0')$$,
  '23514', null, 'feedback_owner_only: empty feedback is rejected');

-- format_events_owner_only
select lives_ok($$insert into public.format_events (user_id, subtopic_id, from_format, to_format) values
  ('00000000-0000-0000-0000-0000000007a0', '20000000-0000-0000-0000-0000000007a1', 'visual', 'text')$$,
  'format_events_owner_only: A logs a switch on A topic');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007b0"}';
select throws_ok($$insert into public.format_events (user_id, subtopic_id, from_format, to_format) values
  ('00000000-0000-0000-0000-0000000007b0', '20000000-0000-0000-0000-0000000007a1', 'visual', 'text')$$,
  '42501', null, 'format_events_owner_only: B cannot log on A topic');

select * from finish();
rollback;
