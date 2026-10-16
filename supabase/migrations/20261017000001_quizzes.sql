-- Quizzes and mastery. Question banks are written by the worker (job quiz_bank);
-- everything a quiz does at answer time is a security-definer function here, so
-- users never read answer keys and the mastery math lives in one tested place.

-- ---------------------------------------------------------------- tables

create table public.quiz_banks (
  subtopic_id uuid primary key references public.subtopics on delete cascade,
  user_id uuid not null references public.users on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  error text,
  updated_at timestamptz not null default now()
);

create table public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  subtopic_id uuid not null references public.subtopics on delete cascade,
  difficulty int not null check (difficulty between 1 and 3),
  stem text not null check (char_length(stem) between 1 and 300),
  options text[] not null check (array_length(options, 1) = 4),
  correct_index int not null check (correct_index between 0 and 3),
  explanation text not null check (char_length(explanation) between 1 and 500),
  source_chunk_ids uuid[] not null default '{}',
  citations jsonb not null default '[]',
  status text not null default 'active' check (status in ('active', 'rejected')),
  created_at timestamptz not null default now()
);
create index quiz_questions_topic_idx on public.quiz_questions (subtopic_id, difficulty) where status = 'active';

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users on delete cascade,
  goal_id uuid not null references public.goals on delete cascade,
  subtopic_id uuid references public.subtopics on delete cascade,
  kind text not null check (kind in ('subtopic', 'review')),
  size int not null check (size between 1 and 20),
  plan uuid[],
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index quizzes_user_id_idx on public.quizzes (user_id);

create table public.quiz_items (
  quiz_id uuid not null references public.quizzes on delete cascade,
  position int not null,
  question_id uuid not null references public.quiz_questions on delete cascade,
  answered boolean not null default false,
  primary key (quiz_id, position)
);

create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  user_id uuid not null references public.users on delete cascade,
  quiz_id uuid references public.quizzes on delete set null,
  question_id uuid not null references public.quiz_questions on delete cascade,
  chosen_index int not null,
  correct boolean not null,
  flagged boolean not null default false,
  excluded boolean not null default false,
  before jsonb,
  answered_at timestamptz not null default now()
);
create index quiz_attempts_user_question_idx on public.quiz_attempts (user_id, question_id, answered_at);

create table public.mastery (
  user_id uuid not null references public.users on delete cascade,
  subtopic_id uuid not null references public.subtopics on delete cascade,
  score numeric not null default 0 check (score between 0 and 1),
  last_practiced_at timestamptz not null default now(),
  current_difficulty int not null default 1 check (current_difficulty between 1 and 3),
  half_life_days numeric not null default 3 check (half_life_days between 3 and 60),
  correct_streak int not null default 0,
  primary key (user_id, subtopic_id)
);

create table public.question_flags (
  user_id uuid not null references public.users on delete cascade,
  question_id uuid not null references public.quiz_questions on delete cascade,
  reason text check (char_length(reason) <= 500),
  at timestamptz not null default now(),
  primary key (user_id, question_id)
);

-- ------------------------------------------------------------ math helpers

create function public.mastery_decayed(
  score numeric, last_practiced_at timestamptz, half_life_days numeric, at timestamptz default now()
) returns numeric
language sql stable
as $$
  select score * exp(-(greatest(extract(epoch from (at - last_practiced_at)), 0) / 86400.0) * ln(2) / half_life_days);
$$;

create function public.mastery_weight(difficulty int) returns numeric
language sql immutable
as $$ select case difficulty when 1 then 0.2 when 2 then 0.3 else 0.4 end; $$;

create function public.mastery_label(decayed numeric) returns text
language sql immutable
as $$ select case when decayed >= 0.8 then 'strong' when decayed < 0.5 then 'weak' else 'developing' end; $$;

create function public.initial_difficulty(level text) returns int
language sql immutable
as $$ select case level when 'beginner' then 1 else 2 end; $$;

create function public.daily_quiz_limit(plan text) returns int
language sql immutable
as $$ select case plan when 'pro' then 150 else 15 end; $$;

-- ------------------------------------------------- bank generation limit

create function public.jobs_enforce_quiz_limit() returns trigger
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
  where j.kind = 'quiz_bank' and j.payload ->> 'user_id' = uid::text
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

create trigger jobs_enforce_quiz_limit
  before insert on public.jobs
  for each row execute function public.jobs_enforce_quiz_limit();

-- --------------------------------------------------------- internal helpers

create function public._quiz_enqueue(p_subtopic_id uuid, p_user_id uuid, p_difficulty int) returns void
language sql security definer set search_path = public
as $$
  insert into public.jobs (kind, payload)
  values ('quiz_bank', jsonb_build_object('subtopic_id', p_subtopic_id, 'user_id', p_user_id, 'difficulty', p_difficulty));
$$;

create function public._quiz_job_pending(p_subtopic_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.jobs j
    where j.kind = 'quiz_bank' and j.status in ('queued', 'running') and j.payload ->> 'subtopic_id' = p_subtopic_id::text
  );
$$;

-- Topics of a goal that have active questions: weak first, then due, then lowest
-- decayed mastery (map order breaks ties), repeated round-robin to n positions.
create function public._review_plan(p_user_id uuid, p_goal_id uuid, n int) returns uuid[]
language plpgsql stable security definer set search_path = public
as $$
declare
  ordered uuid[];
  k int;
  plan uuid[] := '{}';
begin
  select array_agg(t.id order by t.bucket, t.decayed, t.map_order, t.position) into ordered
  from (
    select s.id, s.position,
           coalesce(p.position, s.position) * 100 + case when s.parent_id is null then 0 else s.position + 1 end as map_order,
           coalesce(public.mastery_decayed(m.score, m.last_practiced_at, m.half_life_days), 0) as decayed,
           case
             when coalesce(public.mastery_decayed(m.score, m.last_practiced_at, m.half_life_days), 0) < 0.5 then 0
             when public.mastery_decayed(m.score, m.last_practiced_at, m.half_life_days) < 0.6 then 1
             else 2
           end as bucket
    from public.subtopics s
    left join public.subtopics p on p.id = s.parent_id
    left join public.mastery m on m.subtopic_id = s.id and m.user_id = p_user_id
    where s.goal_id = p_goal_id
      and exists (select 1 from public.quiz_questions q where q.subtopic_id = s.id and q.status = 'active')
  ) t;
  k := coalesce(cardinality(ordered), 0);
  if k = 0 then
    return plan;
  end if;
  for i in 1..n loop
    plan := plan || ordered[((i - 1) % k) + 1];
  end loop;
  return plan;
end;
$$;

create function public._question_json(q public.quiz_questions, p_number int, p_total int) returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'question_id', q.id, 'number', p_number, 'total', p_total, 'stem', q.stem, 'options', to_jsonb(q.options),
    'difficulty', q.difficulty, 'subtopic_title', (select s.title from public.subtopics s where s.id = q.subtopic_id)
  );
$$;

revoke execute on function
  public._quiz_enqueue(uuid, uuid, int), public._quiz_job_pending(uuid), public._review_plan(uuid, uuid, int),
  public._question_json(public.quiz_questions, int, int)
from public, anon, authenticated;

-- ------------------------------------------------------------------- RPCs

create function public.start_quiz(p_goal_id uuid, p_subtopic_id uuid default null) returns jsonb
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
        insert into public.quiz_banks (subtopic_id, user_id) values (p_subtopic_id, uid);
        perform public._quiz_enqueue(p_subtopic_id, uid, null);
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

create function public.next_question(p_quiz_id uuid) returns jsonb
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

  select b.status into v_bank from public.quiz_banks b where b.subtopic_id = v_sub;

  -- Out of unseen questions at the user's level: top up that level (once at a time).
  if (v_pick.id is null or v_pick.difficulty <> v_diff) and v_bank = 'ready'
     and not public._quiz_job_pending(v_sub) then
    begin
      perform public._quiz_enqueue(v_sub, uid, v_diff);
    exception when raise_exception then
      null;  -- at the generation limit: keep serving what exists
    end;
  end if;

  if v_pick.id is null then
    if v_bank = 'pending' then
      return jsonb_build_object('preparing', true);
    elsif v_bank = 'failed' then
      return jsonb_build_object('failed', true);
    end if;
    return jsonb_build_object('exhausted', true);
  end if;

  insert into public.quiz_items (quiz_id, position, question_id) values (p_quiz_id, v_answered + 1, v_pick.id);
  return public._question_json(v_pick, v_answered + 1, q.size);
end;
$$;

create function public.answer_question(p_quiz_id uuid, p_question_id uuid, p_chosen int) returns jsonb
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
  if v_score < 0.5 then
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

-- A dispute: the question leaves the user's rotation and its answer stops counting.
create function public.flag_question(p_question_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_q public.quiz_questions;
  a public.quiz_attempts;
begin
  select * into v_q from public.quiz_questions where id = p_question_id and user_id = uid;
  if not found then
    raise exception 'not_found';
  end if;
  insert into public.question_flags (user_id, question_id, reason)
  values (uid, p_question_id, left(nullif(btrim(p_reason), ''), 500))
  on conflict (user_id, question_id) do nothing;

  -- Flagged before answering: drop it from any open quiz so the next question replaces it.
  delete from public.quiz_items qi using public.quizzes z
  where qi.quiz_id = z.id and z.user_id = uid and qi.question_id = p_question_id and not qi.answered;

  select * into a from public.quiz_attempts
  where user_id = uid and question_id = p_question_id and not excluded
  order by seq desc limit 1;
  if not found then
    return;
  end if;
  update public.quiz_attempts set flagged = true, excluded = true where id = a.id;

  -- Undo its mastery change only if nothing for this topic has been counted since.
  if not exists (
    select 1 from public.quiz_attempts a2 join public.quiz_questions q2 on q2.id = a2.question_id
    where a2.user_id = uid and q2.subtopic_id = v_q.subtopic_id and not a2.excluded and a2.seq > a.seq
  ) then
    if a.before is null then
      delete from public.mastery where user_id = uid and subtopic_id = v_q.subtopic_id;
    else
      update public.mastery set
        score = (a.before ->> 'score')::numeric,
        last_practiced_at = (a.before ->> 'last_practiced_at')::timestamptz,
        current_difficulty = (a.before ->> 'current_difficulty')::int,
        half_life_days = (a.before ->> 'half_life_days')::numeric,
        correct_streak = (a.before ->> 'correct_streak')::int
      where user_id = uid and subtopic_id = v_q.subtopic_id;
    end if;
  end if;
end;
$$;

create function public.finish_quiz(p_quiz_id uuid) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  q public.quizzes;
  v_topics jsonb;
  v_wrong jsonb;
begin
  select * into q from public.quizzes where id = p_quiz_id and user_id = uid for update;
  if not found then
    raise exception 'not_found';
  end if;
  if q.finished_at is null then
    update public.quizzes set finished_at = now() where id = p_quiz_id;
    if q.kind = 'review' then
      update public.mastery m set half_life_days = least(60, m.half_life_days * 2)
      where m.user_id = uid and m.subtopic_id = any (q.plan)
        and public.mastery_decayed(m.score, m.last_practiced_at, m.half_life_days) >= 0.8;
    end if;
  end if;

  select coalesce(jsonb_agg(t order by t.title), '[]') into v_topics
  from (
    select s.id as subtopic_id, s.title,
           count(*) filter (where a.correct) as correct, count(a.id) as total,
           round(coalesce(public.mastery_decayed(m.score, m.last_practiced_at, m.half_life_days), 0), 4) as score,
           public.mastery_label(coalesce(public.mastery_decayed(m.score, m.last_practiced_at, m.half_life_days), 0)) as label
    from public.quiz_attempts a
    join public.quiz_questions qq on qq.id = a.question_id
    join public.subtopics s on s.id = qq.subtopic_id
    left join public.mastery m on m.user_id = uid and m.subtopic_id = s.id
    where a.quiz_id = p_quiz_id and a.user_id = uid and not a.excluded
    group by s.id, s.title, m.score, m.last_practiced_at, m.half_life_days
  ) t;

  select coalesce(jsonb_agg(w order by w.seq), '[]') into v_wrong
  from (
    select a.seq, qq.subtopic_id, qq.stem, qq.options[qq.correct_index + 1] as correct_option,
           qq.explanation, qq.citations
    from public.quiz_attempts a join public.quiz_questions qq on qq.id = a.question_id
    where a.quiz_id = p_quiz_id and a.user_id = uid and not a.excluded and not a.correct
  ) w;

  return jsonb_build_object('topics', v_topics, 'wrong', (
    select coalesce(jsonb_agg(e - 'seq'), '[]') from jsonb_array_elements(v_wrong) e
  ));
end;
$$;

create function public.retry_quiz_bank(p_subtopic_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_status text;
begin
  select b.status into v_status from public.quiz_banks b
  join public.subtopics s on s.id = b.subtopic_id join public.goals g on g.id = s.goal_id
  where b.subtopic_id = p_subtopic_id and g.user_id = uid
  for update of b;
  if not found then
    raise exception 'not_found';
  end if;
  if v_status <> 'failed' then
    raise exception 'not_failed';
  end if;
  update public.quiz_banks set status = 'pending', error = null, updated_at = now() where subtopic_id = p_subtopic_id;
  perform public._quiz_enqueue(p_subtopic_id, uid, null);
end;
$$;

create function public.goal_mastery(p_goal_id uuid)
returns table (subtopic_id uuid, decayed numeric, label text, due boolean)
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if not exists (select 1 from public.goals g where g.id = p_goal_id and g.user_id = uid) then
    raise exception 'not_found';
  end if;
  return query
    select m.subtopic_id, d.v, public.mastery_label(d.v), d.v < 0.6
    from public.mastery m
    join public.subtopics s on s.id = m.subtopic_id
    cross join lateral (select public.mastery_decayed(m.score, m.last_practiced_at, m.half_life_days) as v) d
    where m.user_id = uid and s.goal_id = p_goal_id;
end;
$$;

revoke execute on function
  public.start_quiz(uuid, uuid), public.next_question(uuid), public.answer_question(uuid, uuid, int),
  public.flag_question(uuid, text), public.finish_quiz(uuid), public.retry_quiz_bank(uuid), public.goal_mastery(uuid)
from public, anon;
grant execute on function
  public.start_quiz(uuid, uuid), public.next_question(uuid), public.answer_question(uuid, uuid, int),
  public.flag_question(uuid, text), public.finish_quiz(uuid), public.retry_quiz_bank(uuid), public.goal_mastery(uuid)
to authenticated;

-- -------------------------------------------------------------- security

alter table public.quiz_banks enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quizzes enable row level security;
alter table public.quiz_items enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.mastery enable row level security;
alter table public.question_flags enable row level security;

create policy quizzes_owner_select on public.quizzes for select to authenticated using (user_id = auth.uid());
create policy mastery_owner_select on public.mastery for select to authenticated using (user_id = auth.uid());

revoke all on public.quiz_banks, public.quiz_questions, public.quizzes, public.quiz_items, public.quiz_attempts,
  public.mastery, public.question_flags from anon, authenticated;
grant select on public.quizzes, public.mastery to authenticated;
