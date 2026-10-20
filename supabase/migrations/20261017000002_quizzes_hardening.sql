-- Quiz hardening (Phase 4 final review).
-- - The half-life resets when the decayed mastery is below 0.5 (spec 9), not only when an
--   answer leaves the score below 0.5.
-- - Out of questions at the generation limit: next_question reports the limit instead of
--   "new ones are on the way".
-- - A failed bank reports its error and topic, so the quiz can show "no sources" or retry it.
-- - Two tabs creating the same bank no longer fail; failed generations don't count.

create or replace function public.jobs_enforce_quiz_limit() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid;
  user_plan text;
  guest boolean;
  used int;
begin
  if new.kind <> 'quiz_bank' then
    return new;
  end if;
  uid := (new.payload ->> 'user_id')::uuid;
  select u.plan into user_plan from public.users u where u.id = uid for update;
  select coalesce(a.is_anonymous, false) into guest from auth.users a where a.id = uid;
  select count(*) into used from public.jobs j
  where j.kind = 'quiz_bank' and j.payload ->> 'user_id' = uid::text and j.status <> 'failed'
    and (guest or j.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc');
  if guest and used >= 5 then
    raise exception 'guest_quiz_limit_reached';
  end if;
  if not guest and used >= public.daily_quiz_limit(user_plan) then
    raise exception 'quiz_limit_reached';
  end if;
  return new;
end;
$$;


create or replace function public.start_quiz(p_goal_id uuid, p_subtopic_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_quiz uuid;
  v_plan uuid[];
  v_bank text;
  v_preparing boolean := false;
begin
  if not exists (select 1 from public.goals g where g.id = p_goal_id and g.user_id = uid) then
    raise exception 'not_found';
  end if;

  if p_subtopic_id is not null then
    if not exists (select 1 from public.subtopics s where s.id = p_subtopic_id and s.goal_id = p_goal_id) then
      raise exception 'not_found';
    end if;
    if not exists (select 1 from public.quiz_questions q where q.subtopic_id = p_subtopic_id and q.status = 'active') then
      select b.status into v_bank from public.quiz_banks b where b.subtopic_id = p_subtopic_id;
      if v_bank is null then
        insert into public.quiz_banks (subtopic_id, user_id) values (p_subtopic_id, uid)
        on conflict (subtopic_id) do nothing;
        if found then
          perform public._quiz_enqueue(p_subtopic_id, uid, null);
        end if;
        v_bank := 'pending';
      end if;
      v_preparing := v_bank = 'pending';
    end if;
    insert into public.quizzes (user_id, goal_id, subtopic_id, kind, size)
    values (uid, p_goal_id, p_subtopic_id, 'subtopic', 5) returning id into v_quiz;
  else
    v_plan := public._review_plan(uid, p_goal_id, 10);
    if cardinality(v_plan) = 0 then
      raise exception 'nothing_to_review';
    end if;
    insert into public.quizzes (user_id, goal_id, kind, size, plan)
    values (uid, p_goal_id, 'review', 10, v_plan) returning id into v_quiz;
  end if;
  return jsonb_build_object('quiz_id', v_quiz, 'preparing', v_preparing);
end;
$$;


create or replace function public.next_question(p_quiz_id uuid) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  q public.quizzes;
  cur record;
  v_answered int;
  v_sub uuid;
  v_diff int;
  v_level text;
  v_pick public.quiz_questions;
  v_bank text;
  v_bank_error text;
  v_limit text;
begin
  select * into q from public.quizzes where id = p_quiz_id and user_id = uid;
  if not found then
    raise exception 'not_found';
  end if;

  -- The current unanswered item (asking again returns the same question).
  select qi.position, qq into cur
  from public.quiz_items qi join public.quiz_questions qq on qq.id = qi.question_id
  where qi.quiz_id = p_quiz_id and not qi.answered
  order by qi.position limit 1;
  if found then
    return public._question_json(cur.qq, cur.position, q.size);
  end if;

  select count(*) into v_answered from public.quiz_items where quiz_id = p_quiz_id;
  if v_answered >= q.size then
    return jsonb_build_object('done', true);
  end if;

  v_sub := case when q.kind = 'subtopic' then q.subtopic_id else q.plan[v_answered + 1] end;
  select m.current_difficulty into v_diff from public.mastery m where m.user_id = uid and m.subtopic_id = v_sub;
  if v_diff is null then
    select lp.level into v_level from public.learning_prefs lp where lp.user_id = uid;
    v_diff := public.initial_difficulty(coalesce(v_level, 'beginner'));
  end if;

  -- Unflagged, not answered in the last 7 days, not already in this quiz; nearest difficulty first.
  select qq.* into v_pick
  from public.quiz_questions qq
  where qq.subtopic_id = v_sub and qq.status = 'active'
    and not exists (select 1 from public.question_flags f where f.user_id = uid and f.question_id = qq.id)
    and not exists (
      select 1 from public.quiz_attempts a
      where a.user_id = uid and a.question_id = qq.id and a.answered_at > now() - interval '7 days'
    )
    and not exists (select 1 from public.quiz_items i where i.quiz_id = p_quiz_id and i.question_id = qq.id)
  order by abs(qq.difficulty - v_diff), random()
  limit 1;

  select b.status, b.error into v_bank, v_bank_error from public.quiz_banks b where b.subtopic_id = v_sub;

  -- Out of unseen questions at the user's level: top up that level (once at a time).
  if (v_pick.id is null or v_pick.difficulty <> v_diff) and v_bank = 'ready'
     and not public._quiz_job_pending(v_sub) then
    begin
      perform public._quiz_enqueue(v_sub, uid, v_diff);
    exception when raise_exception then
      -- At the generation limit: keep serving what exists; say so if nothing is left.
      v_limit := case when sqlerrm like '%guest_quiz_limit_reached%' then 'guest_quiz_limit' else 'quiz_limit' end;
    end;
  end if;

  if v_pick.id is null then
    if v_bank = 'pending' then
      return jsonb_build_object('preparing', true);
    elsif v_bank = 'failed' then
      return jsonb_build_object('failed', true, 'error', coalesce(v_bank_error, 'failed'), 'subtopic_id', v_sub);
    elsif v_limit is not null then
      return jsonb_build_object('limit', v_limit);
    end if;
    return jsonb_build_object('exhausted', true);
  end if;

  insert into public.quiz_items (quiz_id, position, question_id) values (p_quiz_id, v_answered + 1, v_pick.id);
  return public._question_json(v_pick, v_answered + 1, q.size);
end;
$$;


create or replace function public.answer_question(p_quiz_id uuid, p_question_id uuid, p_chosen int) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_item record;
  v_q public.quiz_questions;
  m public.mastery;
  v_before jsonb;
  v_correct boolean;
  v_level text;
  v_decayed numeric := 0;
  v_score numeric;
  v_diff int;
  v_streak int := 0;
  v_half numeric := 3;
begin
  if not exists (select 1 from public.quizzes z where z.id = p_quiz_id and z.user_id = uid) then
    raise exception 'not_found';
  end if;
  select qi.* into v_item from public.quiz_items qi
  where qi.quiz_id = p_quiz_id and not qi.answered
  order by qi.position limit 1
  for update;
  if not found or v_item.question_id <> p_question_id then
    raise exception 'not_current_question';
  end if;
  if p_chosen is null or p_chosen not between 0 and 3 then
    raise exception 'invalid_choice';
  end if;

  select * into v_q from public.quiz_questions where id = p_question_id;
  v_correct := p_chosen = v_q.correct_index;

  select * into m from public.mastery where user_id = uid and subtopic_id = v_q.subtopic_id for update;
  if found then
    v_before := to_jsonb(m);
    v_decayed := public.mastery_decayed(m.score, m.last_practiced_at, m.half_life_days);
    v_diff := m.current_difficulty;
    v_streak := m.correct_streak;
    v_half := m.half_life_days;
  else
    select lp.level into v_level from public.learning_prefs lp where lp.user_id = uid;
    v_diff := public.initial_difficulty(coalesce(v_level, 'beginner'));
  end if;

  v_score := v_decayed + public.mastery_weight(v_q.difficulty) * ((case when v_correct then 1 else 0 end) - v_decayed);
  if v_correct then
    v_streak := v_streak + 1;
    if v_streak >= 2 then
      v_diff := least(3, v_diff + 1);
      v_streak := 0;
    end if;
  else
    v_diff := greatest(1, v_diff - 1);
    v_streak := 0;
  end if;
  if v_decayed < 0.5 or v_score < 0.5 then
    v_half := 3;
  end if;

  insert into public.mastery (user_id, subtopic_id, score, last_practiced_at, current_difficulty, half_life_days, correct_streak)
  values (uid, v_q.subtopic_id, v_score, now(), v_diff, v_half, v_streak)
  on conflict (user_id, subtopic_id) do update set
    score = excluded.score, last_practiced_at = excluded.last_practiced_at,
    current_difficulty = excluded.current_difficulty, half_life_days = excluded.half_life_days,
    correct_streak = excluded.correct_streak;

  insert into public.quiz_attempts (user_id, quiz_id, question_id, chosen_index, correct, before)
  values (uid, p_quiz_id, p_question_id, p_chosen, v_correct, v_before);
  update public.quiz_items set answered = true where quiz_id = p_quiz_id and position = v_item.position;

  return jsonb_build_object(
    'correct', v_correct, 'correct_index', v_q.correct_index, 'explanation', v_q.explanation,
    'citations', v_q.citations,
    'mastery', jsonb_build_object('score', round(v_score, 4), 'label', public.mastery_label(v_score))
  );
end;
$$;

