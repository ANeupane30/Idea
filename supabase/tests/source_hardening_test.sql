begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- A free user, a guest, and a ready goal for each.
insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-0000000006a0', 'ha@example.com', false),
  ('00000000-0000-0000-0000-0000000006c0', null, true);
insert into public.goals (id, user_id, title, map_status) values
  ('10000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-0000000006a0', 'A', 'ready'),
  ('10000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006c0', 'G', 'ready');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000006a0"}';

-- pdf_path_shape: only <user id>/<uuid>.pdf
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file, file_name) values
  ('10000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-0000000006a0', 'pdf',
   '00000000-0000-0000-0000-0000000006a0/../00000000-0000-0000-0000-0000000006c0/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf', 'x.pdf')$$,
  'P0001', 'invalid_source', 'pdf_path_shape: dot segments are rejected');
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file, file_name) values
  ('10000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-0000000006a0', 'pdf',
   '00000000-0000-0000-0000-0000000006a0/notes.pdf', 'x.pdf')$$,
  'P0001', 'invalid_source', 'pdf_path_shape: a non-uuid file name is rejected');
select lives_ok($$insert into public.sources (goal_id, user_id, type, url_or_file, file_name) values
  ('10000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-0000000006a0', 'pdf',
   '00000000-0000-0000-0000-0000000006a0/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf', 'x.pdf')$$,
  'pdf_path_shape: <user id>/<uuid>.pdf is accepted');

-- upload_policy: own folder, uuid name, while the quota has room
select lives_ok($$insert into storage.objects (bucket_id, name) values
  ('sources', '00000000-0000-0000-0000-0000000006a0/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.pdf')$$,
  'upload_policy: a user can upload to their own folder');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('sources', '00000000-0000-0000-0000-0000000006a0/notes.pdf')$$,
  '42501', null, 'upload_policy: a non-uuid object name is rejected');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('sources', '00000000-0000-0000-0000-0000000006c0/cccccccc-cccc-4ccc-8ccc-cccccccccccc.pdf')$$,
  '42501', null, 'upload_policy: another user folder is rejected');

-- attempt_cap: retries count as attempts (3x the daily source limit for free users = 15)
reset role;
update public.sources set status = 'failed' where user_id = '00000000-0000-0000-0000-0000000006a0';
insert into public.jobs (kind, payload)
  select 'ingest_source', jsonb_build_object('source_id', s.id)
  from public.sources s, generate_series(1, 14) where s.user_id = '00000000-0000-0000-0000-0000000006a0';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000006a0"}';
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-0000000006a0', 'web', 'https://example.com/again')$$,
  'P0001', 'source_attempt_limit_reached', 'attempt_cap: 15 attempts today block another add');

-- guest upload cap: no uploads once 3 live sources exist
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000006c0"}';
select lives_ok($$insert into storage.objects (bucket_id, name) values
  ('sources', '00000000-0000-0000-0000-0000000006c0/dddddddd-dddd-4ddd-8ddd-dddddddddddd.pdf')$$,
  'guest_upload: a guest with quota left can upload');
insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006c0', 'web', 'https://example.com/g1'),
  ('10000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006c0', 'web', 'https://example.com/g2'),
  ('10000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006c0', 'web', 'https://example.com/g3');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('sources', '00000000-0000-0000-0000-0000000006c0/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.pdf')$$,
  '42501', null, 'guest_upload: no uploads once the guest source limit is used');

-- delete_own_upload: users can remove their own orphaned uploads
select is(
  (select count(*)::int from storage.objects where bucket_id = 'sources'
   and name = '00000000-0000-0000-0000-0000000006c0/dddddddd-dddd-4ddd-8ddd-dddddddddddd.pdf'),
  1, 'delete_own_upload: the guest sees their own upload');
select ok(
  exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'sources_delete_own_folder' and cmd = 'DELETE'),
  'delete_own_upload: a delete policy for the own folder exists');

select * from finish();
rollback;
