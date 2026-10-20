# Phase 4: Quizzes and Mastery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- After a lesson, a learner takes a 5-question adaptive quiz on the topic. Later they take 10-question review quizzes across the goal.
- Each answer updates a decaying, per-topic mastery score.
- The goal page shows a mastery bar for each topic and "What to study next".

**Architecture:**
- Question banks are generated per topic by a worker job (`quiz_bank`). Sonnet writes the questions from the same chunks as lessons; deterministic checks and Haiku validate them; failed ones are regenerated once, then rejected.
- Everything the quiz does at answer time is a security-definer SQL function: start, next question, answer, flag and finish. Mastery math, difficulty adaptation and the 7-day no-repeat rule live in one tested place. Users never read answer keys directly.
- The web app is a client quiz runner calling those functions through server actions.

**Tech Stack:** Postgres (plpgsql, pgTAP), Python worker (job queue, `anthropic` structured output), Next.js 16, Playwright.

**Spec:** [docs/superpowers/specs/2026-10-07-adaptive-learning-platform-design.md](../specs/2026-10-07-adaptive-learning-platform-design.md) §5 (`quiz_questions`, `quiz_attempts`, `mastery`), §7 (mastery bar per subtopic), §9, §10 (limits, untrusted text), and the decision log.

## Global Constraints

- **Bank:** generated the first time a topic is quizzed, 6 questions per difficulty (1, 2, 3), from the same chunks as lessons (Phase 3 `select_chunks`).
  - Each question: 4 options, exactly one correct, plausible distractors, and an explanation with a citation.
  - A top-up of 6 at one difficulty is queued when the user has no unseen question left at the level they need.
- **Difficulty meaning (in the prompt):**
  - 1: recall a fact or definition.
  - 2: apply or explain an idea.
  - 3: analyse or compare across ideas.
- **Validation:**
  - First, deterministic checks:
    - stem 10–300 characters
    - 4 distinct, non-empty options of at most 200 characters
    - `correct_index` 0–3
    - explanation 1–500 characters
    - at least one valid citation
    - no option matching "all of the above", "none of the above" or "both a and b" (case-insensitive)
  - Then Haiku (`claude-haiku-4-5`) checks each question: exactly one correct answer, answerable from the cited excerpts, no "all of the above", no giveaway wording. It returns `{key, ok, problem}`.
  - Failures are regenerated once in one Sonnet call; those still failing are stored with `status 'rejected'`.
- **Models and usage:** generation uses `claude-sonnet-5-5` (kind `quiz_gen`) and validation `claude-haiku-4-5` (kind `validate`). Every call is billed, including refusals (Phase 2/3 patterns).
- **Quiz types:**
  - Subtopic quiz: 5 questions, offered after a lesson.
  - Review quiz: 10 questions across the goal. Topics are ordered Weak first, then due for review (decayed < 0.6), then lowest decayed mastery, taken round-robin among topics that have active questions.
- **Difficulty:**
  - Start at `mastery.current_difficulty`. A new mastery row starts from the stated level: beginner → 1, intermediate → 2, advanced → 2.
  - Two correct in a row → up one level (maximum 3, streak resets). One wrong → down one level (minimum 1, streak resets).
  - If there's no unseen question at the target difficulty, use the nearest difficulty, then any.
- **No repeats:** never serve a question the user answered in the last 7 days, or one they flagged.
- **Mastery:**
  - Decay on read: `decayed = score × e^(−days_since_last_practice × ln2 / half_life_days)`.
  - Update per answer: `score ← decayed + w × (result − decayed)`, where `result` ∈ {0, 1} and `w` = 0.2 / 0.3 / 0.4 for difficulty 1 / 2 / 3. A new row starts with score 0, `half_life_days` 3 and streak 0.
  - `half_life_days` starts at 3. It doubles (maximum 60) when a review quiz finishes with that topic's decayed mastery ≥ 0.8, and resets to 3 whenever an answer leaves the score below 0.5.
- **Labels:**
  - Strong: decayed ≥ 0.8
  - Weak: decayed < 0.5
  - Developing: otherwise
  - Due: decayed < 0.6
  - "What to study next" lists Weak topics, then due ones.
- **Disputes:**
  - "Flag this question" removes it from the user's rotation and logs it in `question_flags`.
  - If it was answered, that answer is excluded from mastery: mastery is restored from the attempt's before-snapshot. That only works when it's the latest counted attempt for the topic; otherwise the attempt is just marked excluded.
- **Limits** (ruling; the spec has quizzes "unlimited from already-generated questions" and is silent on generation): bank generations (initial or top-up) count per user.
  - Guests: 5 in total (`guest_quiz_limit_reached`).
  - Free: 15 per UTC day (`quiz_limit_reached`).
  - Pro: 150 per UTC day.
  - Answering questions is unlimited.
- **No covering source** (Phase 3 rule): no bank. The quiz shows `no_sources`.
- **Copy:**
  - Entry points:
    - Lesson page: link "Quiz me on this".
    - Goal page: "What to study next" heading and the button "Start a review quiz".
    - Map nodes: a mastery bar with `aria-label` "Mastery: Strong|Developing|Weak".
  - While preparing: "Preparing your questions…".
  - Each question:
    - Header: "Question {n} of {total}".
    - Options are radio buttons. Buttons: "Check answer", then "Next question" (or "See results" after the last one).
    - Correct: "Correct!".
    - Wrong: "Not quite. The answer is: {option}". The explanation follows, then "Source: [n] {title}" (a link when there's an href).
    - "Flag this question" → "Thanks. This question won't be shown to you again."
  - Results:
    - Heading "Your results".
    - Per topic: the label and `{correct} of {total}`.
    - For each wrong answer: the stem, the correct option, the explanation and a link "Review the lesson".
  - Errors:

    | Code | Message |
    |---|---|
    | `no_sources` | "Add a source that covers this topic to get questions." |
    | `exhausted` | "You've seen all the questions for now. New ones are on the way. Try again in a minute." |
    | `quiz_limit` | "You've reached today's limit for new questions. Try again tomorrow." |
    | `guest_quiz_limit` | "Sign up free to get more questions." |
    | `nothing_to_review` | "Take a topic quiz first, then come back for a review." |
    | `failed` | "We couldn't prepare questions for this topic. Please try again." (button "Try again") |

## Review Focus

1. **A double-click on "Check answer", or answering a question that isn't this quiz's current one.** Expected: answered once, mastery updated once; anything else raises `not_current_question`. *Test: Task 1 pgTAP `answer_once_only`.*
2. **Flagging a question after answering it.** Expected: mastery goes back to exactly what it was before that answer, and the question never returns. *Test: Task 1 `flag_restores_mastery`.*
3. **Running out of unseen questions at the user's difficulty within 7 days.** Expected: the nearest difficulty is served and a top-up is queued; nothing answered in the last 7 days repeats. *Test: Task 1 `no_repeat_and_fallback`.*
4. **Bank generation fails** (model down or every question rejected). Expected: the bank is `failed`, the quiz shows "Try again", and a retry queues a new job; a failed bank never blocks. *Tests: Task 3 `test_all_rejected_marks_failed`; Task 1 `failed_bank_can_retry`.*
5. **Returning after 30 days.** Expected: mastery has decayed (e.g. 0.9 with a 3-day half-life → about 0.0009), it shows Weak, and the topic leads "What to study next" and the review quiz. *Test: Task 1 `decay_and_due`.*

---

### Task 1: Database: questions, quizzes, attempts, mastery and the quiz functions

**Files:**
- Create: `supabase/migrations/20261017000001_quizzes.sql`, `supabase/tests/quizzes_test.sql`

**Interfaces:**
- Produces tables:

  | Table | Columns |
  |---|---|
  | `quiz_banks` | `subtopic_id` pk → subtopics (cascade), `user_id`, `status` (`pending\|ready\|failed`), `error` text, `updated_at` |
  | `quiz_questions` | `id`; `user_id`; `subtopic_id` → subtopics (cascade); `difficulty` 1–3; `stem`; `options text[]` (length 4); `correct_index` 0–3; `explanation`; `source_chunk_ids uuid[]`; `citations jsonb` (`[{n, title, type, href, label}]`); `status` (`active\|rejected`, default active); `created_at` |
  | `quizzes` | `id`, `user_id`, `goal_id` → goals (cascade), `subtopic_id` null (null = review), `kind` (`subtopic\|review`), `size` int (5 or 10), `plan uuid[]` (review only: the topic for each position), `created_at`, `finished_at` null |
  | `quiz_items` | `quiz_id` → quizzes (cascade), `position` int (1..size), `question_id` → quiz_questions, `answered` bool default false, pk `(quiz_id, position)` |
  | `quiz_attempts` | `id`, `user_id`, `quiz_id`, `question_id`, `chosen_index`, `correct`, `flagged` bool default false, `excluded` bool default false, `before` jsonb (the mastery row before this answer, or null), `answered_at` |
  | `mastery` | `user_id`, `subtopic_id` → subtopics (cascade), `score numeric`, `last_practiced_at`, `current_difficulty` int, `half_life_days numeric`, `correct_streak` int, pk `(user_id, subtopic_id)` |
  | `question_flags` | `user_id`, `question_id`, `reason` text null (≤ 500), `at`, pk `(user_id, question_id)` |

  RLS is on for every table. Users can select only `quizzes` and `mastery`, owner only. Every write goes through the functions below, and nobody but the worker can read `quiz_questions`.
- Produces functions:
  - Math helpers (immutable or stable):
    - `mastery_decayed(score numeric, last_practiced_at timestamptz, half_life_days numeric, at timestamptz default now()) returns numeric`
    - `mastery_weight(difficulty int) returns numeric`
    - `mastery_label(decayed numeric) returns text` (`strong|developing|weak`)
    - `initial_difficulty(level text) returns int`
    - `daily_quiz_limit(plan text) returns int` (pro 150, otherwise 15)
  - A trigger on `jobs` inserts of kind `quiz_bank` enforces the generation limit.
  - Every RPC below is security definer, checks `auth.uid()` owns the goal, quiz or question, and raises `not_found` otherwise:
    - **`start_quiz(p_goal_id uuid, p_subtopic_id uuid default null) returns jsonb`** → `{quiz_id, preparing: bool}`.
      - Subtopic quiz: if the topic has no active questions and no pending bank, upsert `quiz_banks` to pending and insert a job `('quiz_bank', {subtopic_id, user_id, difficulty: null})`. Limit errors propagate (`quiz_limit_reached`, `guest_quiz_limit_reached`).
      - Review quiz: build `plan` (Global Constraints ordering, length 10). No topic with active questions → `nothing_to_review`.
    - **`next_question(p_quiz_id uuid) returns jsonb`**, returning one of:
      - `{done: true}` once all positions are answered.
      - The current unanswered item again: `{question_id, number, total, stem, options, difficulty, subtopic_title}`.
      - A newly picked item, in the same shape: target difficulty per Global Constraints; unflagged, not answered by the user in 7 days, not already in this quiz. When the target difficulty has none unseen, it queues a top-up (`difficulty: d`) unless a bank job is pending.
      - `{preparing: true}` while the topic's bank is pending and nothing is servable.
      - `{failed: true}` if the bank is failed.
      - `{exhausted: true}` otherwise.
    - **`answer_question(p_quiz_id uuid, p_question_id uuid, p_chosen int) returns jsonb`**. The question must be the quiz's current unanswered item, else `not_current_question`.
      - Records the attempt with the `before` snapshot.
      - Updates mastery per Global Constraints.
      - Returns `{correct, correct_index, explanation, citations, mastery: {score, label}}`.
    - **`flag_question(p_question_id uuid, p_reason text default null) returns void`**: the Disputes rule.
    - **`finish_quiz(p_quiz_id uuid) returns jsonb`**:
      - Sets `finished_at` (once). For review quizzes it applies the half-life doubling.
      - Returns `{topics: [{subtopic_id, title, correct, total, score, label}], wrong: [{subtopic_id, stem, correct_option, explanation, citations}]}`. Flagged attempts are excluded.
    - **`retry_quiz_bank(p_subtopic_id uuid) returns void`**: only for a failed bank; sets it pending and queues a job (the limit applies).
    - **`goal_mastery(p_goal_id uuid) returns table(subtopic_id uuid, decayed numeric, label text, due boolean)`**: only topics that have a mastery row.
  - Revoke execute on all of these from public and anon, and grant it to authenticated.

- [ ] **Step 1: Write the failing pgTAP tests** (seed questions as postgres; switch role and claims as in earlier tests):
  - `math`:
    - `mastery_decayed(0.9, now() - interval '3 days', 3)` ≈ 0.45 (within 0.001)
    - `mastery_weight` gives 0.2, 0.3 and 0.4
    - `mastery_label` boundaries: 0.8 → strong, 0.79 → developing, 0.5 → developing, 0.49 → weak
    - `initial_difficulty`: beginner 1, intermediate 2, advanced 2
  - `subtopic_quiz_flow`: a topic with 6 active questions per difficulty and a beginner user.
    - `start_quiz` returns `preparing false`.
    - Five `next_question` / `answer_question` rounds: the first question has difficulty 1. Two correct answers move to difficulty 2, and a wrong one drops back to 1.
    - The sixth `next_question` → `{done: true}`.
    - Mastery after the answers matches the formula applied step by step (computed in the test with `mastery_weight`).
  - `answer_once_only`: answering the same item twice → `not_current_question`, and mastery equals a single update.
  - `flag_restores_mastery`: answer correctly (score rises), flag → mastery equals the `before` snapshot, the attempt is `flagged` and `excluded`, and a new quiz never serves that question.
  - `no_repeat_and_fallback`: all difficulty-1 questions answered within 7 days → the next question is difficulty 2, and one `quiz_bank` job with `difficulty: 1` is queued (only one, even after a second call). With `answered_at` moved back 8 days, difficulty-1 questions are served again.
  - `start_queues_bank_and_limit`: a topic with no questions → `preparing true`, a pending bank and one job. A free user with 15 `quiz_bank` jobs today → `quiz_limit_reached`. A guest with 5 → `guest_quiz_limit_reached`.
  - `failed_bank_can_retry`: a failed bank → `next_question` returns `{failed: true}`, and `retry_quiz_bank` sets it pending and queues a job. `retry_quiz_bank` on a ready bank → `not_failed`.
  - `review_plan_order`: three topics with mastery 0.3 (weak), 0.55 (due) and 0.9 (strong), all with questions → `plan[1]` is the weak topic, `plan[2]` the due one, `plan[3]` the strong one, and the plan has length 10.
  - `finish_review_doubles_half_life`: a review quiz where a topic ends with decayed ≥ 0.8 → `half_life_days` goes from 3 to 6, and 40 → 60 (capped). An answer leaving the score at 0.4 sets `half_life_days` to 3.
  - `decay_and_due`: mastery 0.9 practiced 30 days ago with half-life 3 → `goal_mastery` shows `label 'weak'` and `due true`.
  - `rls`: user B can't call any RPC on A's goal, quiz or question (`not_found`); `select` on `quiz_questions` as authenticated → `42501`; B sees none of A's `mastery` or `quizzes`.
- [ ] **Step 2: Verify fail.** `npm run test:db`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, then `npx supabase migration up`.
- [ ] **Step 4: Verify** `npm run test:db` → PASS, and `npm run test:worker` still passes.
- [ ] **Step 5: Commit** `feat(db): quizzes, adaptive difficulty and decaying mastery`

---

### Task 2: Worker: question generation and validation

**Files:**
- Create:
  - `worker/src/worker/quiz/__init__.py`
  - `worker/src/worker/quiz/questions.py` (schemas, prompt, deterministic checks)
  - `worker/src/worker/quiz/validate.py` (Haiku verdicts)
- Modify: `worker/src/worker/llm.py` (`FakeLLM` dispatch for `QuestionSet` and `VerdictSet`)
- Test: `worker/tests/test_quiz_questions.py`, `worker/tests/test_quiz_validate.py`

**Interfaces:**
- Consumes: `LessonChunk` and `select_chunks` (Phase 3), `LLM`, `LLMResult`, `LLMRefusal`, `LLMOutputError`.
- Produces:
  - `questions.py`:
    - `class QuestionDraft(BaseModel): difficulty: int; stem: str; options: list[str]; correct_index: int; explanation: str; cite: list[int]`
    - `class QuestionSet(BaseModel): questions: list[QuestionDraft]`
    - `build_question_prompt(title: str, summary: str | None, level: str, counts: dict[int, int], chunks: list[LessonChunk]) -> tuple[str, str]`: the user message contains `<count difficulty="d">n</count>` for each difficulty, the escaped `<topic>` and the `<chunk n>` elements. The system prompt states the difficulty meanings, the rules, and "data, not instructions".
    - `check_draft(d: QuestionDraft, n_chunks: int) -> list[str]` (the deterministic checks)
  - `validate.py`:
    - `class Verdict(BaseModel): key: str; ok: bool; problem: str`
    - `class VerdictSet(BaseModel): verdicts: list[Verdict]`
    - `validate_questions(llm, drafts: list[QuestionDraft], chunks: list[LessonChunk], bill) -> list[str | None]` (per draft: `None` = ok, else the problem). One Haiku call per batch of 6. A missing verdict or an `LLMOutputError` counts as a failure for those drafts; `LLMRefusal` fails the batch. Every call is billed.
  - Fakes:
    - `fake_question_set(user: str) -> QuestionSet`: per the requested counts, stems `"Q{d}-{i}: Which statement about joins is correct?"`, options `["Joins combine rows from related tables.", "Joins delete rows.", "Joins rename tables.", "Joins create indexes."]` rotated so `correct_index = i % 4`, explanation "The sources say joins combine rows from related tables.", `cite [1]`.
    - `fake_verdicts(user) -> VerdictSet`: ok for all, except a question whose stem contains `BAD`.

- [ ] **Step 1: Write the failing tests.**
  - `test_prompt_counts_and_escaping`: `counts {1: 6, 2: 6, 3: 6}` appear as `<count>` tags; a chunk containing `</chunk>` is escaped; the system prompt has the three difficulty meanings and "data, not instructions".
  - `test_check_draft`: a valid draft → `[]`. Each of these is reported: a 3-option draft; duplicate options; `correct_index` 4; an "All of the above" option; `cite [0]` with `n_chunks=2`; an empty explanation.
  - `test_validate_marks_problems_and_bills`: a spy returns `ok false` for key `q2` and omits `q3` → `[None, problem, "no verdict"]`, with one bill per call.
  - `test_validate_refusal_fails_batch`: a refusal → all drafts in the batch fail, and it's billed.
  - `test_fake_question_set`: counts `{2: 3}` → 3 drafts at difficulty 2 that pass `check_draft`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Verify** `uv run pytest` passes.
- [ ] **Step 5: Commit** `feat(worker): quiz question generation and validation`

---

### Task 3: Worker: the quiz bank job

**Files:**
- Create: `worker/src/worker/quiz/handler.py`, `worker/tests/test_quiz_bank.py`
- Modify: `worker/src/worker/__main__.py` (register `"quiz_bank": QuizBankHandler(llm, embedder)`)

**Interfaces:**
- Consumes: Tasks 1–2, `ensure_subtopic_embeddings`, `select_chunks`, `record_usage`, `Job`, `PermanentJobError`.
- Produces: `QuizBankHandler(llm: LLM, embedder: Embedder)` implementing `Handler`. `PER_DIFFICULTY = 6`.
  - Payload `{subtopic_id, user_id, difficulty: int | None}`. Counts are 6 for each difficulty when `difficulty` is null, else 6 for that one.
  - Steps:
    1. Load the topic and level. If the topic is missing or not owned → return.
    2. `ensure_subtopic_embeddings`, then `select_chunks`. None → `PermanentJobError("no_sources")`.
    3. Generate with Sonnet (repair once on `LLMOutputError`), run `check_draft` and `validate_questions`.
    4. Regenerate the failures once (one Sonnet call with exactly the failed counts per difficulty) and validate those.
    5. In one transaction: insert passing drafts as `active` and still-failing ones as `rejected`, with `source_chunk_ids` and `citations` built from this user's chunks (as `_source_json` does in Phase 3); set `quiz_banks.status 'ready'`.
  - Failure handling:
    - If no draft passed for an initial bank → `PermanentJobError("failed")`.
    - For a top-up, partial success is fine.
    - `on_permanent_failure` sets `quiz_banks.status 'failed'` with `error` = the message code; `on_retry` leaves it pending.
  - No transaction is held across LLM calls.

- [ ] **Step 1: Write the failing tests** (ready goal with the Phase 2 article ingested, FakeLLM):
  - `test_initial_bank`: 18 active questions (6 per difficulty) whose `citations[0].href` starts with the article URL; bank `ready`; usage rows of kinds `quiz_gen` and `validate`.
  - `test_top_up_one_difficulty`: payload difficulty 2 → 6 more difficulty-2 questions.
  - `test_failed_validation_regenerates_then_rejects`: a spy whose first set contains 2 `BAD` stems and whose regeneration still contains 1 → the bank has 1 `rejected` question and the rest active (18 in total).
  - `test_all_rejected_marks_failed`: every draft is `BAD` → through `run_once` the bank is `failed` with error `failed`, and no active questions.
  - `test_no_sources`: a topic without covering sources → the bank is `failed` with error `no_sources`.
  - `test_main_registers_quiz_bank`: `build_handlers` includes `quiz_bank`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** the handler above.
- [ ] **Step 4: Verify** `uv run pytest` and `npm run test:db`.
- [ ] **Step 5: Commit** `feat(worker): quiz bank job with validation, regeneration and top-ups`

---

### Task 4: Web: the topic quiz

**Files:**
- Create:
  - `web/app/goals/[id]/quiz-actions.ts`: `startQuiz`, `nextQuestion`, `answerQuestion`, `flagQuestion`, `finishQuiz`, `retryQuizBank`, each calling its RPC and mapping errors to codes.
  - `web/components/quiz-runner.tsx` (client)
  - `web/app/goals/[id]/topics/[subtopicId]/quiz/page.tsx`
  - `web/lib/quiz.ts`: types, `QUIZ_ERROR_TEXT` and `LABEL_TEXT` (Strong, Developing, Weak)
  - `web/tests/unit/quiz.test.ts`, `web/tests/e2e/quiz.spec.ts`
- Modify:
  - `web/app/goals/[id]/topics/[subtopicId]/LessonView.tsx`: the "Quiz me on this" link under a shown lesson
  - `web/tests/e2e/helpers.ts`: add `mapWithArticle` (moved from `lessons.spec.ts`) and `openLesson`

**Interfaces:**
- Consumes: the Task 1 RPCs and the Phase 3 lesson page.
- Produces:
  - `QuizRunner({ goalId, subtopicId: string | null, mode: "subtopic" | "review" })`.
  - It calls `startQuiz`, then loops `nextQuestion` → render → `answerQuestion` → feedback → next, and finally `finishQuiz` → results.
  - It polls `nextQuestion` every 2 s while `{preparing: true}`.
  - `failed` shows "Try again", which calls `retryQuizBank` and then polls.
  - `ActionResult<T>` variants return `{ok: true, data}` or `{ok: false, code}`.

- [ ] **Step 1: Write the failing tests.**
  - Unit: `QUIZ_ERROR_TEXT` has the exact copy for every code, and the RPC error mapping covers `quiz_limit_reached` → `quiz_limit`, `guest_quiz_limit_reached` → `guest_quiz_limit`, `no_sources`, `nothing_to_review` and `not_current_question` → `failed`.
  - E2e (guest, article ready, a Visual lesson opened for "Joining tables"):
    - `topic quiz`: click "Quiz me on this" → "Preparing your questions…" → "Question 1 of 5". For five rounds, choose the option "Joins combine rows from related tables." (always correct with the fake), "Check answer" → "Correct!", then "Next question" (or "See results" at the end). "Your results" then shows "Joining tables", "Developing" or "Strong", and "5 of 5".
    - `wrong answer shows the explanation and source`: choose "Joins delete rows." → "Not quite. The answer is: Joins combine rows from related tables.", the explanation, and a "Source: [1]" link whose href starts with the article URL.
    - `flag`: "Flag this question" → "Thanks. This question won't be shown to you again."
    - `double click answers once`: double-click "Check answer" → one result, and the question counter advances by exactly one.
    - `topic without sources`: the quiz for "Indexes and query performance" → "Add a source that covers this topic to get questions."
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Verify** `npm run test:web`, `npx playwright test quiz`, tsc and eslint.
- [ ] **Step 5: Commit** `feat(web): adaptive topic quiz with feedback, sources and flags`

---

### Task 5: Web: review quizzes, mastery bars and what to study next

**Files:**
- Create: `web/app/goals/[id]/review/page.tsx` and `web/app/goals/[id]/StudyNext.tsx`
- Modify:
  - `web/app/goals/[id]/page.tsx`: load `goal_mastery` and pass it to `TopicMap` and `StudyNext`
  - `web/app/goals/[id]/TopicMap.tsx`: an optional `mastery?: Record<string, {decayed: number; label: string}>`. Nodes with mastery show a thin bar (width = decayed × 100%, coloured by label) with `aria-label` "Mastery: {Label}".
- Test: `web/tests/e2e/review.spec.ts`, plus `topic-map-visual` layout checks with bars at 375, 1024 and 1440 widths (reuse the overlap helper from `coverage.spec.ts`)

**Interfaces:**
- Consumes: `goal_mastery`, `QuizRunner` with `mode "review"`, `LABEL_TEXT`.
- Produces: `StudyNext({ goalId, rows })`. It lists Weak topics, then due ones (map order within each group), each linking to its lesson page, plus the "Start a review quiz" button linking to `/goals/<id>/review`. It's hidden when there are no mastery rows.

- [ ] **Step 1: Write the failing tests** (e2e, guest):
  - `mastery bar after a quiz`: finish the topic quiz with 2 wrong answers out of 5. The goal page then shows "Joining tables" with a bar labelled "Mastery: Weak" or "Developing", and "What to study next" lists it.
  - `review quiz`: "Start a review quiz" → "Question 1 of 10" → answer all 10 → "Your results".
  - `review without practice`: a fresh goal at `/goals/<id>/review` → "Take a topic quiz first, then come back for a review."
  - Layout: with mastery bars, nodes don't overlap and the page doesn't scroll sideways at 375, 1024 and 1440.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** the behavior above.
- [ ] **Step 4: Verify** all the suites (`test:db`, `test:worker`, `test:web`, `test:e2e`), tsc and eslint. Take screenshots of a quiz question and its results at 1440×900 dark and 375×812, and look at them.
- [ ] **Step 5: Commit** `feat(web): review quizzes, mastery bars and what to study next`

---

## After the tasks

- Decision log: mark Phase 4 done, add the spec amendments below, and set the next step: production readiness (follow-ups) and evals.
- Follow-ups:
  - Format inference from `format_events` and per-format quiz results (spec §12, item 1).
  - Question quality evals (§11: validator pass rate).
  - A cleanup of rejected questions.

**Spec amendments this plan introduces:**
- `quiz_questions` gains `user_id`, `citations`, and `options` as an array of 4.
- New tables `quiz_banks`, `quizzes`, `quiz_items` and `question_flags`.
- `quiz_attempts` gains `quiz_id`, `excluded` and `before`.
- All quiz actions are SQL functions.
- Bank generation limits: guests 5 in total; free 15 and Pro 150 a day.
