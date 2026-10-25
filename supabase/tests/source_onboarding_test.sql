begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- Users: N new (signed in, no goals), D signed in at the daily source limit,
-- G a guest with 3 user sources, H a guest with 2 user and 4 automatic sources.
insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-0000000006a0', 'on@example.com', false),
  ('00000000-0000-0000-0000-0000000006d0', 'od@example.com', false),
  ('00000000-0000-0000-0000-0000000006c0', null, true),
  ('00000000-0000-0000-0000-0000000006e0', null, true);

insert into public.goals (id, user_id, title, map_status, status) values
  ('10000000-0000-0000-0000-0000000006d1', '00000000-0000-0000-0000-0000000006d0', 'D ready', 'ready', 'active'),
  ('10000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006c0', 'G ready', 'ready', 'active'),
  ('10000000-0000-0000-0000-0000000006e1', '00000000-0000-0000-0000-0000000006e0', 'H ready', 'ready', 'active');

-- Seeded as postgres: the same limits apply, and automatic sources skip them.
insert into public.sources (goal_id, user_id, type, url_or_file)
select '10000000-0000-0000-0000-0000000006d1', '00000000-0000-0000-0000-0000000006d0', 'web', 'https://d.example/' || n
from generate_series(1, 5) n;
insert into public.sources (goal_id, user_id, type, url_or_file)
select '10000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006c0', 'web', 'https://g.example/' || n
from generate_series(1, 3) n;
insert into public.sources (goal_id, user_id, type, url_or_file)
select '10000000-0000-0000-0000-0000000006e1', '00000000-0000-0000-0000-0000000006e0', 'web', 'https://h.example/' || n
from generate_series(1, 2) n;
insert into public.sources (goal_id, user_id, type, url_or_file, origin)
select '10000000-0000-0000-0000-0000000006e1', '00000000-0000-0000-0000-0000000006e0', 'web', 'https://h.example/auto' || n, 'auto'
from generate_series(1, 4) n;

-- style_format
select is(
  array[public.style_format('visual_video'), public.style_format('reading'), public.style_format('hands_on')],
  array['visual', 'text', 'examples'],
  'style_format: styles map to lesson formats');

-- ------------------------------------------------------------- as N
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000006a0"}';

select lives_ok($$select public.create_goal_with_sources('Learn SQL', 'beginner', 'visual_video',
    array['https://a.example/x', 'https://youtu.be/abc'])$$,
  'create_goal_with_sources: goal with two links');
select throws_ok($$select public.create_goal_with_sources('Four', 'beginner', 'reading',
    array['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4'])$$,
  'P0001', 'too_many_links', 'too_many_links: more than 3 links rejected');
select throws_ok($$select public.create_goal_with_sources('Bad', 'beginner', 'reading', array['ftp://x'])$$,
  'P0001', 'invalid_source', 'invalid_source: non-http link rejected');
select throws_ok($$select public.create_goal_with_sources('Blank', 'beginner', 'reading', array['https://a.example/1', '   '])$$,
  'P0001', 'invalid_source', 'invalid_source: blank link rejected');
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file)
    select id, user_id, 'web', 'https://a.example/late' from public.goals where title = 'Learn SQL' and user_id = '00000000-0000-0000-0000-0000000006a0'$$,
  'P0001', 'goal_not_ready', 'goal_not_ready: direct insert into a pending goal still rejected');
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file, origin)
    select id, user_id, 'web', 'https://a.example/auto', 'auto' from public.goals where title = 'Learn SQL' and user_id = '00000000-0000-0000-0000-0000000006a0'$$,
  '42501', null, 'origin is not user-writable');

reset role;
select is((select map_status from public.goals where title = 'Learn SQL' and user_id = '00000000-0000-0000-0000-0000000006a0'), 'understanding', 'a goal with links starts by understanding (sources first)');
select is((select count(*) from public.goals where user_id = '00000000-0000-0000-0000-0000000006a0'),
  1::bigint, 'failed calls leave no goal behind');
select is(
  (select array_agg(s.type || ':' || s.origin || ':' || s.status order by s.type) from public.sources s
   join public.goals g on g.id = s.goal_id where g.title = 'Learn SQL' and g.user_id = '00000000-0000-0000-0000-0000000006a0'),
  array['web:user:queued', 'youtube:user:queued'], 'two user sources, queued, typed by host');
select is(
  (select count(*) from public.jobs j join public.sources s on s.id::text = j.payload->>'source_id'
   join public.goals g on g.id = s.goal_id where g.title = 'Learn SQL' and g.user_id = '00000000-0000-0000-0000-0000000006a0' and j.kind = 'ingest_source'),
  2::bigint, 'an ingest job per link');
select is(
  (select count(*) from public.jobs j join public.goals g on g.id::text = j.payload->>'goal_id'
   where g.title = 'Learn SQL' and g.user_id = '00000000-0000-0000-0000-0000000006a0' and j.kind = 'topic_map'),
  0::bigint, 'no topic_map job until the links are read (stage 2)');
select is(
  (select learning_style || ':' || preferred_format || ':' || level from public.learning_prefs
   where user_id = '00000000-0000-0000-0000-0000000006a0'),
  'visual_video:visual:beginner', 'prefs saved with the style''s format');
select is((select discovery_status from public.goals where title = 'Learn SQL' and user_id = '00000000-0000-0000-0000-0000000006a0'), 'none', 'discovery starts as none');

-- ------------------------------------------------------------- guests
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000006c0"}';
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006c0', 'web', 'https://g.example/4')$$,
  'P0001', 'guest_source_limit_reached', 'guest with 3 user sources is at the limit');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000006e0"}';
select lives_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000006e1', '00000000-0000-0000-0000-0000000006e0', 'web', 'https://h.example/3')$$,
  'automatic sources do not count toward the guest limit');

-- ------------------------------------------------------------- daily limit
reset role;
select lives_ok($$insert into public.sources (goal_id, user_id, type, url_or_file, origin) values
  ('10000000-0000-0000-0000-0000000006d1', '00000000-0000-0000-0000-0000000006d0', 'web', 'https://d.example/auto', 'auto')$$,
  'automatic source skips the daily limit');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000006d0"}';
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000006d1', '00000000-0000-0000-0000-0000000006d0', 'web', 'https://d.example/6')$$,
  'P0001', 'source_limit_reached', 'the user''s own source is still limited');

-- ------------------------------------------------------------- columns
reset role;
select ok(
  exists (select 1 from information_schema.columns where table_name = 'sources' and column_name = 'discovered_for'),
  'sources.discovered_for exists');
select lives_ok($$update public.sources set status = 'awaiting_map' where url_or_file = 'https://d.example/1'$$,
  'awaiting_map is a valid status');

select * from finish();
rollback;
