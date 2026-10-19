begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

-- Scratch storage for values carried between roles (rolled back with the test).
create table public._t (k text primary key, v jsonb);
grant all on public._t to authenticated;
create function public._v(k text) returns uuid language sql as $$ select (v #>> '{}')::uuid from public._t where k = $1 $$;
grant execute on function public._v(text) to authenticated;
create function public._goal(sub uuid) returns uuid language sql as $$ select goal_id from public.subtopics where id = sub $$;
grant execute on function public._goal(uuid) to authenticated;

-- A user with prefs, a ready goal and one topic with `per` questions per difficulty (correct answer: index 0).
create function pg_temp.add_q(uid uuid, sid uuid, per int) returns void language sql as $$
  insert into public.quiz_questions (user_id, subtopic_id, difficulty, stem, options, correct_index, explanation, citations)
  select uid, sid, d, 'Question ' || d || '-' || i, array['right', 'wrong a', 'wrong b', 'wrong c'], 0, 'Because.',
         '[{"n": 1, "title": "Src", "type": "web", "href": "https://e.com", "label": ""}]'
  from generate_series(1, 3) d, generate_series(1, per) i;
$$;
create function pg_temp.seed(uid uuid, lvl text, per int, anon boolean default false) returns uuid language plpgsql as $$
declare
  gid uuid := gen_random_uuid();
  sid uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, is_anonymous)
    values (uid, case when anon then null else uid::text || '@example.com' end, anon);
  insert into public.learning_prefs (user_id, level) values (uid, lvl);
  insert into public.goals (id, user_id, title, map_status) values (gid, uid, 'G', 'ready');
  insert into public.subtopics (id, goal_id, title, position) values (sid, gid, 'Topic', 0);
  if per > 0 then
    perform pg_temp.add_q(uid, sid, per);
    insert into public.quiz_banks (subtopic_id, user_id, status) values (sid, uid, 'ready');
  end if;
  return sid;
end;
$$;

insert into public._t values
  ('a_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009a0', 'beginner', 6))),
  ('b_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009b0', 'beginner', 6))),
  ('c_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009c0', 'beginner', 6))),
  ('d_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009d0', 'beginner', 2))),
  ('e_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009e0', 'beginner', 0))),
  ('f_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009f0', 'beginner', 0))),
  ('g_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009c1', 'beginner', 0, true))),
  ('h_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009d1', 'beginner', 0))),
  ('r_t1', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-0000000009e1', 'beginner', 1)));

-- ------------------------------------------------------------------ math
select ok(abs(public.mastery_decayed(0.9, now() - interval '3 days', 3) - 0.45) < 0.001, 'math: one half-life halves the score');
select is(array[public.mastery_weight(1), public.mastery_weight(2), public.mastery_weight(3)], array[0.2, 0.3, 0.4]::numeric[],
  'math: weights 0.2 / 0.3 / 0.4');
select is(array[public.mastery_label(0.8), public.mastery_label(0.79), public.mastery_label(0.5), public.mastery_label(0.49)],
  array['strong', 'developing', 'developing', 'weak'], 'math: label boundaries');
select is(array[public.initial_difficulty('beginner'), public.initial_difficulty('intermediate'), public.initial_difficulty('advanced')],
  array[1, 2, 2], 'math: initial difficulty from level');

-- ------------------------------------------------------- subtopic quiz flow (A)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009a0"}';
do $$
declare
  quiz uuid;
  nq jsonb;
  diffs int[] := '{}';
  answers int[] := array[0, 0, 1, 0, 0];  -- correct, correct, wrong, correct, correct
begin
  quiz := (public.start_quiz(public._goal(public._v('a_sub')), public._v('a_sub')) ->> 'quiz_id')::uuid;
  for i in 1..5 loop
    nq := public.next_question(quiz);
    diffs := diffs || (nq ->> 'difficulty')::int;
    perform public.answer_question(quiz, (nq ->> 'question_id')::uuid, answers[i]);
  end loop;
  insert into public._t values ('a_quiz', to_jsonb(quiz)), ('a_diffs', to_jsonb(diffs)), ('a_after', public.next_question(quiz));
end;
$$;
select is((select v from public._t where k = 'a_diffs'), '[1, 1, 2, 1, 1]'::jsonb,
  'subtopic_quiz_flow: two correct move up a level, one wrong moves down');
select is((select v from public._t where k = 'a_after'), '{"done": true}'::jsonb, 'subtopic_quiz_flow: done after 5');
insert into public._t values ('a_finish', public.finish_quiz(public._v('a_quiz')));
select is((select v #> '{topics,0,correct}' from public._t where k = 'a_finish'), '4'::jsonb, 'finish: 4 correct');
select is((select v #> '{topics,0,total}' from public._t where k = 'a_finish'), '5'::jsonb, 'finish: of 5');
select is((select jsonb_array_length(v -> 'wrong') from public._t where k = 'a_finish'), 1, 'finish: one wrong answer listed');
select is((select v #>> '{wrong,0,correct_option}' from public._t where k = 'a_finish'), 'right', 'finish: wrong answer shows the right option');
reset role;
-- 0 -> 0.2 -> 0.36 -> 0.252 (wrong, w 0.3) -> 0.4016 -> 0.52128 (no decay within one transaction)
select is((select round(score, 4) from public.mastery where user_id = '00000000-0000-0000-0000-0000000009a0'), 0.5213,
  'subtopic_quiz_flow: mastery follows score <- decayed + w(result - decayed)');
select is((select current_difficulty from public.mastery where user_id = '00000000-0000-0000-0000-0000000009a0'), 2,
  'subtopic_quiz_flow: ends at difficulty 2');

-- ------------------------------------------------------- answer_once_only (B)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009b0"}';
do $$
declare
  quiz uuid;
  nq jsonb;
begin
  quiz := (public.start_quiz(public._goal(public._v('b_sub')), public._v('b_sub')) ->> 'quiz_id')::uuid;
  nq := public.next_question(quiz);
  perform public.answer_question(quiz, (nq ->> 'question_id')::uuid, 0);
  insert into public._t values ('b_quiz', to_jsonb(quiz)), ('b_q', nq -> 'question_id');
end;
$$;
select throws_ok($$select public.answer_question(public._v('b_quiz'), public._v('b_q'), 0)$$,
  'P0001', 'not_current_question', 'answer_once_only: a second answer is rejected');
-- rls (as B, against A)
select throws_ok($$select public.next_question(public._v('a_quiz'))$$, 'P0001', 'not_found', 'rls: B cannot use A quiz');
select throws_ok($$select count(*) from public.quiz_questions$$, '42501', null, 'rls: users cannot read the question bank');
select is((select count(*) from public.mastery where user_id = '00000000-0000-0000-0000-0000000009a0'), 0::bigint,
  'rls: B sees none of A mastery');
select is((select count(*) from public.quizzes where user_id = '00000000-0000-0000-0000-0000000009a0'), 0::bigint,
  'rls: B sees none of A quizzes');
reset role;
select is((select round(score, 4) from public.mastery where user_id = '00000000-0000-0000-0000-0000000009b0'), 0.2000,
  'answer_once_only: mastery updated once');

-- ------------------------------------------------------- flag_restores_mastery (C)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009c0"}';
do $$
declare
  quiz uuid;
  nq jsonb;
  served uuid[] := '{}';
begin
  quiz := (public.start_quiz(public._goal(public._v('c_sub')), public._v('c_sub')) ->> 'quiz_id')::uuid;
  nq := public.next_question(quiz);
  perform public.answer_question(quiz, (nq ->> 'question_id')::uuid, 0);
  perform public.flag_question((nq ->> 'question_id')::uuid, 'The answer is ambiguous');
  insert into public._t values ('c_q', nq -> 'question_id');
  quiz := (public.start_quiz(public._goal(public._v('c_sub')), public._v('c_sub')) ->> 'quiz_id')::uuid;
  for i in 1..5 loop
    nq := public.next_question(quiz);
    served := served || (nq ->> 'question_id')::uuid;
    perform public.answer_question(quiz, (nq ->> 'question_id')::uuid, 1);
  end loop;
  insert into public._t values ('c_served', to_jsonb(served));
end;
$$;
reset role;
select ok(not ((select v from public._t where k = 'c_served') @> jsonb_build_array(public._v('c_q'))),
  'flag_restores_mastery: a flagged question is never served again');
select is((select row(flagged, excluded)::text from public.quiz_attempts where question_id = public._v('c_q')),
  row(true, true)::text, 'flag_restores_mastery: the attempt is flagged and excluded');
select is((select count(*) from public.question_flags where question_id = public._v('c_q')), 1::bigint,
  'flag_restores_mastery: the flag is logged');
-- The flagged correct answer is undone: the later five wrong answers start from no mastery (score 0).
select is((select round(score, 4) from public.mastery where user_id = '00000000-0000-0000-0000-0000000009c0'), 0.0000,
  'flag_restores_mastery: mastery is as if the flagged answer never happened');

-- ------------------------------------------------------- no_repeat_and_fallback (D, 2 per difficulty)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009d0"}';
do $$
declare
  quiz uuid;
  nq jsonb;
begin
  quiz := (public.start_quiz(public._goal(public._v('d_sub')), public._v('d_sub')) ->> 'quiz_id')::uuid;
  for i in 1..2 loop
    nq := public.next_question(quiz);
    perform public.answer_question(quiz, (nq ->> 'question_id')::uuid, 1);
  end loop;
  nq := public.next_question(quiz);
  perform public.next_question(quiz);  -- asking again returns the same item and queues nothing new
  insert into public._t values ('d_third', nq);
end;
$$;
reset role;
select is((select (v ->> 'difficulty')::int from public._t where k = 'd_third'), 2,
  'no_repeat_and_fallback: with no unseen level-1 question, the nearest level is served');
select is((select count(*) from public.jobs where kind = 'quiz_bank'
           and payload ->> 'subtopic_id' = public._v('d_sub')::text and payload ->> 'difficulty' = '1'), 1::bigint,
  'no_repeat_and_fallback: one level-1 top-up is queued');
update public.quiz_attempts set answered_at = now() - interval '8 days'
  where user_id = '00000000-0000-0000-0000-0000000009d0';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009d0"}';
insert into public._t values ('d_after', public.next_question(
  (public.start_quiz(public._goal(public._v('d_sub')), public._v('d_sub')) ->> 'quiz_id')::uuid));
reset role;
select is((select (v ->> 'difficulty')::int from public._t where k = 'd_after'), 1,
  'no_repeat_and_fallback: questions answered over 7 days ago come back');

-- ------------------------------------------------------- start_queues_bank_and_limit (E, G)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009e0"}';
insert into public._t values ('e_start', public.start_quiz(public._goal(public._v('e_sub')), public._v('e_sub')));
reset role;
select is((select v -> 'preparing' from public._t where k = 'e_start'), 'true'::jsonb, 'start_queues_bank: preparing');
select is((select status from public.quiz_banks where subtopic_id = public._v('e_sub')), 'pending', 'start_queues_bank: bank pending');
select is((select count(*) from public.jobs where kind = 'quiz_bank' and payload ->> 'subtopic_id' = public._v('e_sub')::text),
  1::bigint, 'start_queues_bank: one job');
insert into public.jobs (kind, payload)
  select 'quiz_bank', jsonb_build_object('subtopic_id', gen_random_uuid(), 'user_id', '00000000-0000-0000-0000-0000000009e0')
  from generate_series(1, 14);
update public.quiz_banks set status = 'failed' where subtopic_id = public._v('e_sub');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009e0"}';
select throws_ok($$select public.retry_quiz_bank(public._v('e_sub'))$$, 'P0001', 'quiz_limit_reached',
  'limit: a free user with 15 generations today is stopped');
reset role;
insert into public.jobs (kind, payload)
  select 'quiz_bank', jsonb_build_object('subtopic_id', gen_random_uuid(), 'user_id', '00000000-0000-0000-0000-0000000009c1')
  from generate_series(1, 5);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009c1"}';
select throws_ok($$select public.start_quiz(public._goal(public._v('g_sub')), public._v('g_sub'))$$,
  'P0001', 'guest_quiz_limit_reached', 'limit: a guest is stopped after 5 generations');

-- ------------------------------------------------------- failed_bank_can_retry (F)
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009f0"}';
insert into public._t values ('f_quiz', (public.start_quiz(public._goal(public._v('f_sub')), public._v('f_sub')) -> 'quiz_id'));
reset role;
update public.quiz_banks set status = 'failed', error = 'failed' where subtopic_id = public._v('f_sub');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009f0"}';
select is(public.next_question(public._v('f_quiz')) -> 'failed', 'true'::jsonb, 'failed_bank: next_question reports it');
select lives_ok($$select public.retry_quiz_bank(public._v('f_sub'))$$, 'failed_bank: retry is allowed');
select is(public.next_question(public._v('f_quiz')), '{"preparing": true}'::jsonb, 'failed_bank: preparing again');
reset role;
select is((select count(*) from public.jobs where kind = 'quiz_bank' and payload ->> 'subtopic_id' = public._v('f_sub')::text),
  2::bigint, 'failed_bank: retry queued a new job');
update public.quiz_banks set status = 'ready' where subtopic_id = public._v('f_sub');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009f0"}';
select throws_ok($$select public.retry_quiz_bank(public._v('f_sub'))$$, 'P0001', 'not_failed', 'failed_bank: only failed banks retry');

-- ------------------------------------------------------- review_plan_order and half-life (R)
reset role;
insert into public.subtopics (id, goal_id, title, position) values
  ('20000000-0000-0000-0000-0000000009e2', public._goal(public._v('r_t1')), 'T2', 1),
  ('20000000-0000-0000-0000-0000000009e3', public._goal(public._v('r_t1')), 'T3', 2);
select pg_temp.add_q('00000000-0000-0000-0000-0000000009e1', '20000000-0000-0000-0000-0000000009e2', 1);
select pg_temp.add_q('00000000-0000-0000-0000-0000000009e1', '20000000-0000-0000-0000-0000000009e3', 1);
insert into public.mastery (user_id, subtopic_id, score, last_practiced_at, current_difficulty, half_life_days, correct_streak) values
  ('00000000-0000-0000-0000-0000000009e1', public._v('r_t1'), 0.3, now(), 1, 12, 0),
  ('00000000-0000-0000-0000-0000000009e1', '20000000-0000-0000-0000-0000000009e2', 0.55, now(), 1, 3, 0),
  ('00000000-0000-0000-0000-0000000009e1', '20000000-0000-0000-0000-0000000009e3', 0.9, now(), 1, 3, 0);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009e1"}';
insert into public._t values ('r_quiz', public.start_quiz(public._goal(public._v('r_t1'))) -> 'quiz_id');
select is((select plan[1:3] from public.quizzes where id = public._v('r_quiz')),
  array[public._v('r_t1'), '20000000-0000-0000-0000-0000000009e2', '20000000-0000-0000-0000-0000000009e3']::uuid[],
  'review_plan_order: weak, then due, then strong');
select is((select cardinality(plan) from public.quizzes where id = public._v('r_quiz')), 10, 'review_plan_order: 10 positions');
select lives_ok($$select public.finish_quiz(public._v('r_quiz'))$$, 'finish_review: finishes');
reset role;
select is((select half_life_days from public.mastery where subtopic_id = '20000000-0000-0000-0000-0000000009e3'), 6::numeric,
  'finish_review: strong topic half-life doubles 3 -> 6');
update public.mastery set half_life_days = 40 where subtopic_id = '20000000-0000-0000-0000-0000000009e3';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009e1"}';
select public.finish_quiz((public.start_quiz(public._goal(public._v('r_t1'))) ->> 'quiz_id')::uuid);
do $$
declare
  quiz uuid;
  nq jsonb;
begin
  quiz := (public.start_quiz(public._goal(public._v('r_t1')), public._v('r_t1')) ->> 'quiz_id')::uuid;
  nq := public.next_question(quiz);
  perform public.answer_question(quiz, (nq ->> 'question_id')::uuid, 1);  -- wrong: 0.3 -> 0.24
end;
$$;
reset role;
select is((select half_life_days from public.mastery where subtopic_id = '20000000-0000-0000-0000-0000000009e3'), 60::numeric,
  'finish_review: half-life is capped at 60');
select is((select half_life_days from public.mastery where subtopic_id = public._v('r_t1')), 3::numeric,
  'half-life resets to 3 when an answer leaves the score below 0.5');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009b0"}';
select throws_ok($$select public.start_quiz(public._goal(public._v('r_t1')))$$, 'P0001', 'not_found',
  'rls: B cannot start a quiz on another user goal');

-- ------------------------------------------------------- decay_and_due (H)
reset role;
insert into public.mastery (user_id, subtopic_id, score, last_practiced_at, current_difficulty, half_life_days, correct_streak)
  values ('00000000-0000-0000-0000-0000000009d1', public._v('h_sub'), 0.9, now() - interval '30 days', 1, 3, 0);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000009d1"}';
select is((select row(label, due, round(decayed, 4))::text from public.goal_mastery(public._goal(public._v('h_sub')))),
  row('weak', true, 0.0009::numeric)::text, 'decay_and_due: 30 days later the topic is weak and due');
select throws_ok($$select public.start_quiz(public._goal(public._v('h_sub')))$$, 'P0001', 'nothing_to_review',
  'review: nothing to review without questions');

select * from finish();
rollback;
