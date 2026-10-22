begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

create table public._t (k text primary key, v jsonb);
grant all on public._t to authenticated;
create function public._v(k text) returns uuid language sql as $$ select (v #>> '{}')::uuid from public._t where k = $1 $$;
grant execute on function public._v(text) to authenticated;
create function public._goal(sub uuid) returns uuid language sql as $$ select goal_id from public.subtopics where id = sub $$;
grant execute on function public._goal(uuid) to authenticated;

create function pg_temp.seed(uid uuid, per int, anon boolean default false) returns uuid language plpgsql as $$
declare
  gid uuid := gen_random_uuid();
  sid uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, is_anonymous) values (uid, case when anon then null else uid::text || '@example.com' end, anon);
  insert into public.learning_prefs (user_id, level) values (uid, 'beginner');
  insert into public.goals (id, user_id, title, map_status) values (gid, uid, 'G', 'ready');
  insert into public.subtopics (id, goal_id, title, position) values (sid, gid, 'Topic', 0);
  if per > 0 then
    insert into public.quiz_questions (user_id, subtopic_id, difficulty, stem, options, correct_index, explanation)
    select uid, sid, d, 'Question ' || d || '-' || i, array['right', 'wrong a', 'wrong b', 'wrong c'], 0, 'Because.'
    from generate_series(1, 3) d, generate_series(1, per) i;
    insert into public.quiz_banks (subtopic_id, user_id, status) values (sid, uid, 'ready');
  end if;
  return sid;
end;
$$;

insert into public._t values
  ('a_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-00000000aaa0', 2))),
  ('b_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-00000000bbb0', 1))),
  ('c_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-00000000ccc0', 0))),
  ('g_sub', to_jsonb(pg_temp.seed('00000000-0000-0000-0000-00000000ccc1', 0, true)));

-- I1: the half-life resets when the decayed mastery (before the answer) is below 0.5, even if the
-- answer lifts the score above 0.5. 0.85 thirty days ago at half-life 24 decays to about 0.357.
insert into public.mastery (user_id, subtopic_id, score, last_practiced_at, current_difficulty, half_life_days, correct_streak)
  values ('00000000-0000-0000-0000-00000000aaa0', public._v('a_sub'), 0.85, now() - interval '30 days', 3, 24, 0);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000aaa0"}';
do $$
declare
  quiz uuid;
  nq jsonb;
begin
  quiz := (public.start_quiz(public._goal(public._v('a_sub')), public._v('a_sub')) ->> 'quiz_id')::uuid;
  nq := public.next_question(quiz);
  perform public.answer_question(quiz, (nq ->> 'question_id')::uuid, 0);  -- correct at difficulty 3
end;
$$;
reset role;
select is((select row(round(score, 2), half_life_days)::text from public.mastery where user_id = '00000000-0000-0000-0000-00000000aaa0'),
  row(0.61, 3::numeric)::text, 'I1: a forgotten topic resets its half-life even after a correct answer');

-- I2: out of questions and at the generation limit: the limit is reported, not "new ones are on the way".
update public.quiz_attempts set answered_at = now() where user_id = '00000000-0000-0000-0000-00000000bbb0';
insert into public.quiz_attempts (user_id, question_id, chosen_index, correct)
  select '00000000-0000-0000-0000-00000000bbb0', id, 0, true from public.quiz_questions where subtopic_id = public._v('b_sub');
insert into public.jobs (kind, payload, status)
  select 'quiz_bank', jsonb_build_object('subtopic_id', gen_random_uuid(), 'user_id', '00000000-0000-0000-0000-00000000bbb0'), 'done'
  from generate_series(1, 15);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000bbb0"}';
select is(public.next_question((public.start_quiz(public._goal(public._v('b_sub')), public._v('b_sub')) ->> 'quiz_id')::uuid),
  '{"limit": "quiz_limit"}'::jsonb, 'I2: no questions left and no generations left reports the limit');

-- M7 / I3: a failed bank reports its topic and its error, so the runner can show the right copy and retry it.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ccc0"}';
insert into public._t values ('c_quiz', public.start_quiz(public._goal(public._v('c_sub')), public._v('c_sub')) -> 'quiz_id');
reset role;
update public.quiz_banks set status = 'failed', error = 'no_sources' where subtopic_id = public._v('c_sub');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ccc0"}';
select is(public.next_question(public._v('c_quiz')),
  jsonb_build_object('failed', true, 'error', 'no_sources', 'subtopic_id', public._v('c_sub')),
  'M7: a failed bank says why, and which topic');

-- I4: starting again when the bank row already exists (another tab got there first) queues nothing new.
select lives_ok($$select public.start_quiz(public._goal(public._v('c_sub')), public._v('c_sub'))$$,
  'I4: start_quiz with an existing bank row works');
reset role;
select is((select count(*) from public.jobs where kind = 'quiz_bank' and payload ->> 'subtopic_id' = public._v('c_sub')::text),
  1::bigint, 'I4: still only one bank job');

-- M3: failed generations don't use up the limit (a guest losing quota to an outage).
insert into public.jobs (kind, payload, status)
  select 'quiz_bank', jsonb_build_object('subtopic_id', gen_random_uuid(), 'user_id', '00000000-0000-0000-0000-00000000ccc1'), 'failed'
  from generate_series(1, 5);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000ccc1"}';
select lives_ok($$select public.start_quiz(public._goal(public._v('g_sub')), public._v('g_sub'))$$,
  'M3: five failed generations leave the guest quota intact');

select * from finish();
rollback;
