begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000009a0', 'fa@example.com'),
  ('00000000-0000-0000-0000-0000000009b0', 'fb@example.com');
update public.users set plan = 'pro' where id = '00000000-0000-0000-0000-0000000009a0';

-- A goal waiting for the learner's decision, and a ready goal with an unvetted source (seeded as postgres).
insert into public.goals (id, user_id, title, map_status) values
  ('10000000-0000-0000-0000-0000000009d1', '00000000-0000-0000-0000-0000000009a0', 'Decide', 'awaiting_source_decision'),
  ('10000000-0000-0000-0000-0000000009d2', '00000000-0000-0000-0000-0000000009a0', 'Decide 2', 'awaiting_source_decision'),
  ('10000000-0000-0000-0000-0000000009d3', '00000000-0000-0000-0000-0000000009a0', 'Ready', 'ready');
select set_config('app.creating_goal', '10000000-0000-0000-0000-0000000009d1', true);
insert into public.sources (id, goal_id, user_id, type, url_or_file, status, vetted, vet_reason) values
  ('30000000-0000-0000-0000-0000000009d1', '10000000-0000-0000-0000-0000000009d1', '00000000-0000-0000-0000-0000000009a0',
   'web', 'https://a.example/signup', 'awaiting_map', false, 'A sign-up page, not course content.');
select set_config('app.creating_goal', '', true);
insert into public.sources (id, goal_id, user_id, type, url_or_file, status, vetted, vet_reason) values
  ('30000000-0000-0000-0000-0000000009d3', '10000000-0000-0000-0000-0000000009d3', '00000000-0000-0000-0000-0000000009a0',
   'web', 'https://a.example/late', 'ready', false, 'Off-topic.'),
  ('30000000-0000-0000-0000-0000000009d4', '10000000-0000-0000-0000-0000000009d3', '00000000-0000-0000-0000-0000000009a0',
   'web', 'https://a.example/fine', 'ready', null, null);
delete from public.jobs;

-- ------------------------------------------------------------- creating goals (as the learner)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009a0"}';
select lives_ok($$select public.create_goal_with_sources('No sources', 'beginner', 'reading', '{}', null)$$, 'goal without sources');
select lives_ok($$select public.create_goal_with_sources('One link', 'beginner', 'reading', array['https://a.example/x'], null)$$,
  'goal with a link');
select lives_ok($$insert into public.goals (user_id, title) values ('00000000-0000-0000-0000-0000000009a0', 'From goals page')$$,
  'goal from the goals page');
reset role;

create temp view j as
  select g.title, j.kind from public.jobs j join public.goals g on g.id::text = j.payload->>'goal_id';

select is((select map_status || ':' || (prep_started_at is not null)::text from public.goals where title = 'No sources'),
  'understanding:true', 'a new goal starts by understanding the goal');
select is((select array_agg(kind order by kind) from j where title = 'No sources'), array['understand_goal'],
  'and queues understand_goal, not topic_map');
select is((select map_status || ':' || (reading_started_at is not null)::text from public.goals where title = 'One link'),
  'understanding:true', 'a goal with a link also starts by understanding (its link is read meanwhile)');
select is((select array_agg(kind order by kind) from j where title = 'One link'), array['understand_goal'],
  'one understand_goal job for it');
select is((select count(*) from public.jobs jj join public.sources s on s.id::text = jj.payload->>'source_id'
           join public.goals g on g.id = s.goal_id where g.title = 'One link' and jj.kind = 'ingest_source'),
  1::bigint, 'and its link is queued for reading');
select is((select map_status from public.goals where title = 'From goals page'), 'understanding',
  'a goal from the goals page goes sources-first too');
select is((select array_agg(kind) from j where title = 'From goals page'), array['understand_goal'], 'with its job');

insert into public.goals (id, user_id, title) values
  ('10000000-0000-0000-0000-0000000009e1', '00000000-0000-0000-0000-0000000009b0', 'Worker goal');
select is((select map_status from public.goals where title = 'Worker goal'), 'pending',
  'a goal inserted by the worker (or tests) stays pending');
select is((select array_agg(kind) from j where title = 'Worker goal'), array['topic_map'], 'and keeps the topic_map job');

-- ------------------------------------------------------------- the learner's decision
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009b0"}';
select throws_ok($$select public.answer_source_decision('10000000-0000-0000-0000-0000000009d1', 'use')$$,
  'P0001', 'goal_not_awaiting_decision', 'another user cannot decide');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009a0"}';
select throws_ok($$select public.answer_source_decision('10000000-0000-0000-0000-0000000009d1', 'maybe')$$,
  'P0001', 'invalid_choice', 'only find or use');
select lives_ok($$select public.answer_source_decision('10000000-0000-0000-0000-0000000009d1', 'use')$$, 'use mine anyway');
select lives_ok($$select public.answer_source_decision('10000000-0000-0000-0000-0000000009d2', 'find')$$, 'find sources for me');
select throws_ok($$select public.answer_source_decision('10000000-0000-0000-0000-0000000009d1', 'find')$$,
  'P0001', 'goal_not_awaiting_decision', 'a second answer is rejected');
reset role;
select is((select g.map_status || ':' || s.vetted::text from public.goals g join public.sources s on s.goal_id = g.id
           where g.id = '10000000-0000-0000-0000-0000000009d1'),
  'building_map:true', 'use: the learner''s sources count as vetted and the map is built');
select is((select (select array_agg(kind) from j where title = 'Decide') || (select array_agg(kind) from j where title = 'Decide 2')),
  array['topic_map', 'find_sources'], 'use queues the map; find queues the search');

-- ------------------------------------------------------------- use it anyway, quota table, statuses
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009a0"}';
select throws_ok($$select public.use_source_anyway('30000000-0000-0000-0000-0000000009d4')$$,
  'P0001', 'source_not_unvetted', 'only an unvetted source can be used anyway');
select lives_ok($$select public.use_source_anyway('30000000-0000-0000-0000-0000000009d3')$$, 'use it anyway');
select throws_ok($$select * from public.search_usage$$, '42501', null, 'search usage is worker-only');
reset role;
-- (vetted is set and the source is queued again; awaiting_expand no longer exists)
select throws_ok($$update public.goals set map_status = 'awaiting_expand' where title = 'Ready'$$,
  '23514', null, 'awaiting_expand is gone');

select * from finish();
rollback;
