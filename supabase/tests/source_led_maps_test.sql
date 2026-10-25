begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

-- Users: A and B signed in, G a guest.
insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-0000000007a0', 'la@example.com', false),
  ('00000000-0000-0000-0000-0000000007b0', 'lb@example.com', false),
  ('00000000-0000-0000-0000-0000000007c0', null, true);

-- A is on Pro so this file can create more than 2 goals.
update public.users set plan = 'pro' where id = '00000000-0000-0000-0000-0000000007a0';

-- ------------------------------------------------------------- as A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007a0"}';

select lives_ok($$select public.create_goal_with_sources('With link', 'beginner', 'reading',
    array['https://a.example/x'], null)$$, 'goal with a link');
select lives_ok($$select public.create_goal_with_sources('No sources', 'beginner', 'reading', '{}', null)$$,
  'goal without sources');
select lives_ok($$select public.create_goal_with_sources('Blank outline', 'beginner', 'reading', '{}', '   ')$$,
  'goal with a blank outline');

select lives_ok($$select public.create_goal_with_sources('Outline', 'beginner', 'reading', '{}',
    E'1. Tables\n2. Joins\n3. Indexes')$$, 'goal with an outline');
select throws_ok($$select public.create_goal_with_sources('Too long', 'beginner', 'reading', '{}', repeat('x', 20001))$$,
  '23514', null, 'an outline over 20,000 characters is rejected');

reset role;
select is((select map_status || ':' || (reading_started_at is not null)::text from public.goals
           where title = 'With link' and user_id = '00000000-0000-0000-0000-0000000007a0'),
  'understanding:true', 'a goal with sources starts by understanding (its sources are read meanwhile)');
select is((select count(*) from public.jobs j join public.goals g on g.id::text = j.payload->>'goal_id'
           where g.title = 'With link' and g.user_id = '00000000-0000-0000-0000-0000000007a0' and j.kind = 'topic_map'),
  0::bigint, 'no topic_map job until the sources are read and checked');
select is((select map_status from public.goals where title = 'No sources' and user_id = '00000000-0000-0000-0000-0000000007a0'),
  'understanding', 'a goal without sources starts by understanding too');
select is((select count(*) from public.jobs j join public.goals g on g.id::text = j.payload->>'goal_id'
           where g.title = 'No sources' and g.user_id = '00000000-0000-0000-0000-0000000007a0' and j.kind = 'topic_map'),
  0::bigint, 'and gets no topic_map job (sources come first)');
select is((select count(*) from public.sources s join public.goals g on g.id = s.goal_id
           where g.title = 'Blank outline' and g.user_id = '00000000-0000-0000-0000-0000000007a0'),
  0::bigint, 'a blank outline adds no source');
select is((select map_status from public.goals where title = 'Blank outline' and user_id = '00000000-0000-0000-0000-0000000007a0'),
  'understanding', 'a blank outline counts as no sources');
select is((select s.type || ':' || s.url_or_file || ':' || left(s.outline_text, 9) from public.sources s
           join public.goals g on g.id = s.goal_id
           where g.title = 'Outline' and g.user_id = '00000000-0000-0000-0000-0000000007a0'),
  'outline:outline:1. Tables', 'an outline becomes an outline source');

-- (answer_expand was replaced by answer_source_decision: see sources_first_test.sql.)

-- An outline counts toward a guest's 3 sources.
insert into public.goals (id, user_id, title, map_status) values
  ('10000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007c0', 'G ready', 'ready');
insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007c0', 'web', 'https://g.example/1'),
  ('10000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007c0', 'web', 'https://g.example/2');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000007c0"}';
select lives_ok($$insert into public.sources (goal_id, user_id, type, url_or_file, outline_text) values
  ('10000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007c0', 'outline', 'outline', E'1. A
2. B')$$,
  'a guest can add an outline to a ready goal');
select throws_ok($$insert into public.sources (goal_id, user_id, type, url_or_file) values
  ('10000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007c0', 'web', 'https://g.example/3')$$,
  'P0001', 'guest_source_limit_reached', 'the outline counted toward the guest limit');
reset role;

-- primary_ref is cleared when its chunk goes.
insert into public.contents (content_hash, type, token_count, embed_model) values ('h-led', 'web', 10, 'fake');
insert into public.source_chunks (id, content_hash, position, text, token_count, embedding)
values ('40000000-0000-0000-0000-0000000007c1', 'h-led', 0, 'x', 1, array_fill(0, array[384])::extensions.vector);
insert into public.subtopics (id, goal_id, title, position, primary_ref) values
  ('20000000-0000-0000-0000-0000000007c1', '10000000-0000-0000-0000-0000000007c1', 'T', 0,
   '40000000-0000-0000-0000-0000000007c1');
delete from public.contents where content_hash = 'h-led';
select is((select primary_ref from public.subtopics where id = '20000000-0000-0000-0000-0000000007c1'), null,
  'deleting the chunk clears primary_ref');

select * from finish();
rollback;
