begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000008a0', 'lh@example.com');
insert into public.goals (id, user_id, title, map_status) values
  ('10000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-0000000008a0', 'A', 'ready');
insert into public.subtopics (id, goal_id, title, position) values
  ('20000000-0000-0000-0000-0000000008a1', '10000000-0000-0000-0000-0000000008a1', 'A t1', 0);

-- 14 ready lessons today; one more slot.
insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status)
  select '00000000-0000-0000-0000-0000000008a0', '20000000-0000-0000-0000-0000000008a1', 'text', 'beginner', 'r' || i, 'ready'
  from generate_series(1, 14) i;

-- delivered_failed_counts: a failed lesson that streamed content was still a generation.
insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status, delivered) values
  ('00000000-0000-0000-0000-0000000008a0', '20000000-0000-0000-0000-0000000008a1', 'visual', 'beginner', 'd', 'failed', true);
select throws_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status) values
  ('00000000-0000-0000-0000-0000000008a0', '20000000-0000-0000-0000-0000000008a1', 'summary', 'beginner', 'x', 'ready')$$,
  'P0001', 'lesson_limit_reached', 'delivered_failed_counts: a failed lesson that delivered content counts');

-- undelivered_failed_free: failing before any content does not count.
update public.lessons set delivered = false where cache_key = 'd';
select lives_ok($$insert into public.lessons (id, user_id, subtopic_id, format, level, cache_key, status) values
  ('40000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-0000000008a0', '20000000-0000-0000-0000-0000000008a1', 'summary', 'beginner', 'x', 'generating')$$,
  'undelivered_failed_free: a failed lesson with no content frees its slot');

-- fresh_generating_counts: an in-progress generation holds a slot.
select throws_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status) values
  ('00000000-0000-0000-0000-0000000008a0', '20000000-0000-0000-0000-0000000008a1', 'examples', 'beginner', 'y', 'ready')$$,
  'P0001', 'lesson_limit_reached', 'fresh_generating_counts: a generation in progress counts');

-- stuck_generating_free: one left over from a crash (over 10 minutes old) does not.
update public.lessons set created_at = now() - interval '11 minutes' where id = '40000000-0000-0000-0000-0000000008a1';
select lives_ok($$insert into public.lessons (user_id, subtopic_id, format, level, cache_key, status) values
  ('00000000-0000-0000-0000-0000000008a0', '20000000-0000-0000-0000-0000000008a1', 'examples', 'beginner', 'y', 'ready')$$,
  'stuck_generating_free: a generating row older than 10 minutes frees its slot');

select is((select delivered from public.lessons where cache_key = 'r1'), false, 'delivered defaults to false');

select * from finish();
rollback;
