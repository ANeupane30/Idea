begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- Users: A and B free, G a guest (anonymous).
insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-0000000005a0', 'sa@example.com', false),
  ('00000000-0000-0000-0000-0000000005b0', 'sb@example.com', false),
  ('00000000-0000-0000-0000-0000000005c0', null, true);

-- Goals, seeded as postgres (map_status is not user-writable).
insert into public.goals (id, user_id, title, map_status, status) values
  ('10000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a0', 'A ready', 'ready', 'active'),
  ('10000000-0000-0000-0000-0000000005a3', '00000000-0000-0000-0000-0000000005a0', 'A archived', 'ready', 'archived'),
  ('10000000-0000-0000-0000-0000000005a4', '00000000-0000-0000-0000-0000000005a0', 'A second', 'ready', 'active'),
  ('10000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005b0', 'B ready', 'ready', 'active'),
  ('10000000-0000-0000-0000-0000000005b2', '00000000-0000-0000-0000-0000000005b0', 'B pending', 'pending', 'active'),
  ('10000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005c0', 'G ready', 'ready', 'active');

insert into public.subtopics (id, goal_id, title, position) values
  ('20000000-0000-0000-0000-0000000005a1', '10000000-0000-0000-0000-0000000005a1', 'A t1', 0),
  ('20000000-0000-0000-0000-0000000005b1', '10000000-0000-0000-0000-0000000005b1', 'B t1', 0),
  ('20000000-0000-0000-0000-0000000005b2', '10000000-0000-0000-0000-0000000005b1', 'B t2', 1),
  ('20000000-0000-0000-0000-0000000005b3', '10000000-0000-0000-0000-0000000005b1', 'B t3', 2),
  ('20000000-0000-0000-0000-0000000005b4', '10000000-0000-0000-0000-0000000005b1', 'B t4', 3);

-- ------------------------------------------------------------- as A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000005a0"}';

-- insert_queues_job
select lives_ok($$insert into public.sources (id, goal_id, user_id, type, url_or_file) values
  ('30000000-0000-0000-0000-0000000005a1', '10000000-0000-0000-0000-0000000005a1',
   '00000000-0000-0000-0000-0000000005a0', 'web', 'https://example.com/a')$$,
  'insert_queues_job: owner can add a web source to a ready goal');
select lives_ok($$insert into public.sources (id, goal_id, user_id, type, url_or_file) values
  ('30000000-0000-0000-0000-0000000005a2', '10000000-0000-0000-0000-0000000005a4',
   '00000000-0000-0000-0000-0000000005a0', 'youtube', 'https://youtu.be/abc')$$,
  'insert_queues_job: second goal source');
select is((select count(*) from public.sources), 2::bigint, 'owner sees own sources');

-- goal_archived
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000005a3', '00000000-0000-0000-0000-0000000005a0', 'web', 'https://example.com/x')$$,
  'P0001', 'goal_archived', 'goal_archived: archived goal rejects sources');

-- invalid_source
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a0', 'web', 'ftp://x')$$,
  'P0001', 'invalid_source', 'invalid_source: non-http link rejected');
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file, file_name) values
  ('10000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a0', 'pdf',
   '00000000-0000-0000-0000-0000000005b0/x.pdf', 'x.pdf')$$,
  'P0001', 'invalid_source', 'invalid_source: pdf in another user folder rejected');

-- user_cannot_update_source
select throws_ok($$update public.sources set status = 'ready' where id = '30000000-0000-0000-0000-0000000005a1'$$,
  '42501', null, 'user_cannot_update_source: status is not user-writable');
select throws_ok($$delete from public.sources where id = '30000000-0000-0000-0000-0000000005a1'$$,
  '42501', null, 'user_cannot_update_source: users cannot delete sources');

-- shared cache tables are not readable
select throws_ok($$select count(*) from public.source_chunks$$, '42501', null,
  'rls_isolation: authenticated cannot read source_chunks');
select throws_ok($$select count(*) from public.contents$$, '42501', null,
  'rls_isolation: authenticated cannot read contents');

-- free_daily_limit: A has 2; three more make 5, the 6th is rejected.
select lives_ok($$insert into public.sources (id, goal_id, user_id, type, url_or_file) values
  ('30000000-0000-0000-0000-0000000005a3', '10000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a0', 'web', 'https://example.com/3'),
  ('30000000-0000-0000-0000-0000000005a4', '10000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a0', 'web', 'https://example.com/4'),
  ('30000000-0000-0000-0000-0000000005a5', '10000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a0', 'web', 'https://example.com/5')$$,
  'free_daily_limit: sources 3 to 5 succeed');
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a0', 'web', 'https://example.com/6')$$,
  'P0001', 'source_limit_reached', 'free_daily_limit: 6th source today is rejected');

-- failed_sources_do_not_count
reset role;
update public.sources set status = 'failed' where id = '30000000-0000-0000-0000-0000000005a5';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000005a0"}';
select lives_ok($$insert into public.sources (id, goal_id, user_id, type, url_or_file) values
  ('30000000-0000-0000-0000-0000000005a6', '10000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005a0', 'web', 'https://example.com/6')$$,
  'failed_sources_do_not_count: a failed source frees a slot');

-- retry_respects_quota: 5 non-failed + 1 failed.
select throws_ok($$select public.retry_source('30000000-0000-0000-0000-0000000005a5')$$,
  'P0001', 'source_limit_reached', 'retry_respects_quota: retry is rejected when the quota is used up');
reset role;
update public.sources set status = 'failed', error = 'boom' where id = '30000000-0000-0000-0000-0000000005a4';
update public.sources set content_hash = 'h-old', step = 'mapping', delayed = true, error = 'boom',
  relevance = 0.5, relevance_label = 'partial', relevance_reason = 'r'
  where id = '30000000-0000-0000-0000-0000000005a5';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000005a0"}';
select lives_ok($$select public.retry_source('30000000-0000-0000-0000-0000000005a5')$$,
  'retry_respects_quota: retry succeeds once a slot frees');
select is(
  (select row(status, step, delayed, error, content_hash, relevance, relevance_label, relevance_reason)::text
   from public.sources where id = '30000000-0000-0000-0000-0000000005a5'),
  row('queued', null::text, false, null::text, null::text, null::numeric, null::text, null::text)::text,
  'retry_respects_quota: retry resets the source');

-- retry_not_failed
select throws_ok($$select public.retry_source('30000000-0000-0000-0000-0000000005a1')$$,
  'P0001', 'not_failed', 'retry_not_failed: only failed sources can be retried');

-- ------------------------------------------------------------- as postgres
reset role;
select is((select count(*) from public.jobs
  where kind = 'ingest_source' and payload->>'source_id' = '30000000-0000-0000-0000-0000000005a1'),
  1::bigint, 'insert_queues_job: one ingest_source job for the new source');
select is((select count(*) from public.jobs
  where kind = 'ingest_source' and payload->>'source_id' = '30000000-0000-0000-0000-0000000005a5'),
  2::bigint, 'retry_respects_quota: retry queues another job');

-- duplicate_content_in_goal
update public.sources set content_hash = 'h1' where id = '30000000-0000-0000-0000-0000000005a1';
select throws_ok($$update public.sources set content_hash = 'h1' where id = '30000000-0000-0000-0000-0000000005a3'$$,
  '23505', null, 'duplicate_content_in_goal: same content twice in one goal is rejected');
select lives_ok($$update public.sources set content_hash = 'h1' where id = '30000000-0000-0000-0000-0000000005a2'$$,
  'duplicate_content_in_goal: same content in another goal is allowed');
select lives_ok($$update public.sources set content_hash = 'h1' where id = '30000000-0000-0000-0000-0000000005a4'$$,
  'duplicate_content_in_goal: a failed source does not block the hash');

-- relevance_label
select is(public.relevance_label(0.70), 'high', 'relevance_label: 0.70 is high');
select is(public.relevance_label(0.69), 'partial', 'relevance_label: 0.69 is partial');
select is(public.relevance_label(0.40), 'partial', 'relevance_label: 0.40 is partial');
select is(public.relevance_label(0.39), 'off_topic', 'relevance_label: 0.39 is off_topic');

-- ------------------------------------------------------------- as B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000005b0"}';

-- goal_not_ready
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000005b2', '00000000-0000-0000-0000-0000000005b0', 'web', 'https://example.com/b')$$,
  'P0001', 'goal_not_ready', 'goal_not_ready: a goal without a ready map rejects sources');

-- B's sources for coverage
insert into public.sources (id, goal_id, user_id, type, url_or_file) values
  ('30000000-0000-0000-0000-0000000005b1', '10000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005b0', 'web', 'https://example.com/b1'),
  ('30000000-0000-0000-0000-0000000005b2', '10000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005b0', 'web', 'https://example.com/b2'),
  ('30000000-0000-0000-0000-0000000005b3', '10000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005b0', 'web', 'https://example.com/b3'),
  ('30000000-0000-0000-0000-0000000005b4', '10000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005b0', 'web', 'https://example.com/b4');

-- rls_isolation
select is((select count(*) from public.sources where user_id = '00000000-0000-0000-0000-0000000005a0'),
  0::bigint, 'rls_isolation: B sees none of A sources');
select throws_ok($$select public.retry_source('30000000-0000-0000-0000-0000000005a4')$$,
  'P0001', 'source_not_found', 'rls_isolation: B cannot retry A source');

reset role;
update public.sources set status = 'ready', relevance_label = 'high' where id = '30000000-0000-0000-0000-0000000005b1';
update public.sources set status = 'ready', relevance_label = 'partial' where id = '30000000-0000-0000-0000-0000000005b2';
update public.sources set status = 'ready', relevance_label = 'off_topic' where id = '30000000-0000-0000-0000-0000000005b3';
update public.sources set status = 'processing' where id = '30000000-0000-0000-0000-0000000005b4';
insert into public.source_coverage (source_id, subtopic_id, relevance, reason) values
  ('30000000-0000-0000-0000-0000000005b1', '20000000-0000-0000-0000-0000000005b1', 0.90, 'strong'),
  ('30000000-0000-0000-0000-0000000005b1', '20000000-0000-0000-0000-0000000005b2', 0.50, 'weak'),
  ('30000000-0000-0000-0000-0000000005b2', '20000000-0000-0000-0000-0000000005b2', 0.45, 'weak'),
  ('30000000-0000-0000-0000-0000000005b2', '20000000-0000-0000-0000-0000000005b3', 0.50, 'weak'),
  ('30000000-0000-0000-0000-0000000005b3', '20000000-0000-0000-0000-0000000005b3', 0.95, 'ignored: off-topic source'),
  ('30000000-0000-0000-0000-0000000005b4', '20000000-0000-0000-0000-0000000005b4', 0.95, 'ignored: not ready');
insert into public.source_coverage (source_id, subtopic_id, relevance, reason) values
  ('30000000-0000-0000-0000-0000000005a1', '20000000-0000-0000-0000-0000000005a1', 0.90, 'A row');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000005b0"}';

-- coverage_states
select is((select state from public.subtopic_coverage where subtopic_id = '20000000-0000-0000-0000-0000000005b1'),
  'covered', 'coverage_states: one strong row is covered');
select is((select state from public.subtopic_coverage where subtopic_id = '20000000-0000-0000-0000-0000000005b2'),
  'covered', 'coverage_states: two weak rows are covered');
select is((select state from public.subtopic_coverage where subtopic_id = '20000000-0000-0000-0000-0000000005b3'),
  'thin', 'coverage_states: one weak row is thin (off-topic source ignored)');
select is((select state from public.subtopic_coverage where subtopic_id = '20000000-0000-0000-0000-0000000005b4'),
  'gap', 'coverage_states: rows from sources that are not ready are ignored');
select is((select count(*) from public.source_coverage where source_id = '30000000-0000-0000-0000-0000000005a1'),
  0::bigint, 'rls_isolation: B sees none of A source_coverage');

-- ------------------------------------------------------------- as the guest
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000005c0"}';
select lives_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005c0', 'web', 'https://example.com/g1'),
  ('10000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005c0', 'web', 'https://example.com/g2'),
  ('10000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005c0', 'web', 'https://example.com/g3')$$,
  'guest_limit: a guest can add 3 sources');
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005c0', 'web', 'https://example.com/g4')$$,
  'P0001', 'guest_source_limit_reached', 'guest_limit: the 4th guest source is rejected');

-- bucket_exists
reset role;
select is((select row(public, file_size_limit, allowed_mime_types)::text from storage.buckets where id = 'sources'),
  row(false, 26214400::bigint, array['application/pdf'])::text, 'bucket_exists: private 25 MB pdf bucket');

select * from finish();
rollback;
