# Sources-First Maps: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every map is built from vetted learning material, found with Tavily from the learner's intent or given by the learner. The map is shown only once its sources are read, checked and matched, so every topic's lesson works.

**Architecture:**
- **Preparing a new goal** runs through background jobs, all of them in the existing job queue: `understand_goal` (intent and queries), `find_sources` (Tavily or the Wikipedia fallback), the existing `ingest_source`, `check_sources` (batched AI vetting), `topic_map` (from vetted sources only), then matching and a time-boxed `fill_gaps`.
- **All state lives in the database:** `goals.map_status` plus the sources' status, step and vetting. The page polls it.
- **The worker runs N job threads.**

**Tech Stack:** Supabase Postgres (migrations, pgTAP); Python 3.12 worker (psycopg, pydantic, httpx2, pytest); Next.js 16 web (Vitest, Playwright).

**Spec:** [docs/superpowers/specs/2026-10-25-sources-first-maps-design.md](../specs/2026-10-25-sources-first-maps-design.md)

## Global Constraints

**Statuses**
- **`goals.map_status`:** `pending`, `understanding`, `finding_sources`, `reading_sources`, `checking_sources`, `awaiting_source_decision`, `building_map`, `matching_sources`, `clarifying`, `ready` or `failed`.
- **`awaiting_expand` is removed.** Existing rows move to `building_map`.
- **The map is rendered only when `map_status = 'ready'`.**

**Search (Tavily and the Wikipedia fallback)**
- **Tavily request:** `POST https://api.tavily.com/search`, header `Authorization: Bearer <TAVILY_API_KEY>`, body `search_depth=basic` and `max_results=8`.
- **Excluded domains:** `pinterest.com`, `facebook.com`, `instagram.com`, `tiktok.com`, `x.com`, `twitter.com`, `quora.com`, `amazon.com`, `medium.com/tag`. Each call has a 10 s timeout.
- **Candidates:**
  - At most 8 per goal.
  - At most 1 per domain, except YouTube, which can have 2. Visual / Video learners may have up to 3 videos.
  - The top 4 vetted are kept, with up to 2 videos for Visual / Video, and the rest deleted.
  - Fewer than 2 vetted runs **one** more query round. After that, the goal falls back.
- **Gap phase:**
  - **How many queries:** 4 if 60 s or more of the 5-minute preparation budget remains, 2 if less, and 0 under 20 s.
  - **Timing:** the queries run concurrently, and the whole phase has a hard cap of 45 s.
- **Tavily quota:**
  - `TAVILY_MONTHLY_CREDITS` defaults to 1000, and a basic search costs 1 credit.
  - At 80%, a warning is logged once a month: `tavily quota 80% used: <used>/<limit>`.
  - At 100%, the goal falls back to Wikipedia.
  - HTTP 429 or 432 also falls back.

**AI calls**
- **Source check:** fast tier, in batches of at most 4 that run in parallel. A missing or duplicate verdict is asked again once; if still invalid, a found source is not vetted and a user source falls back to relevance.
- **Validation limits:**
  - **Intent call:** `intent` 1–300 characters, `search_subject` 1–80, and 1–3 `queries` of 1–120 each.
  - **Check verdict:** a `reason` of at most 160 characters.

**Worker**
- **Job threads:** `WORKER_CONCURRENCY` defaults to 3. Each thread has its own connection, and claims use the existing `for update skip locked`.
- **Embedding model:** downloaded at image build, into `FASTEMBED_CACHE_PATH=/opt/fastembed`.

**Exact copy**

| Where | Text |
|---|---|
| `understanding` | Understanding your goal… |
| `finding_sources` | Finding learning material for your goal… (then `<n> candidates found`) |
| `reading_sources` | Reading `<i>` of `<n>` sources: `<domain>`… |
| `checking_sources` | Checking `<n>` sources… |
| `building_map` | Designing your map… |
| `matching_sources` | Preparing lessons: `<k>` of `<m>` topics ready |
| Decision heading | Some of your sources don't look right for this goal. |
| Decision buttons | Find sources for me · Use mine anyway |
| An unvetted source | Not used, then its reason |
| A later source that failed | its button: Use it anyway |
| Starting-point notice | We couldn't find good learning material for this goal, so this map is a starting point. Add your own sources to improve it. |
| Lesson whose topic has a source in flight | Sources for this topic are still being read. This takes a minute or two. |
| Lesson whose topic has no source | We couldn't find good material for this topic yet. Add a source if you have one. |

**Removed:** no "Try searching for" chips anywhere (`SearchLinks` and `AddNext` go).

**Unchanged:**
- **Grounding:** no lesson is written from the AI's general knowledge.
- **Ops:** local Supabase uses ports 443xx. Never run `supabase db reset`.

## Review Focus

Most likely problems first:

1. **The learner gives a link and the intent call fails or times out.** The goal must not stay in `understanding`. After the job's retries, it moves on with `search_subject` = the goal title and no queries, and continues to reading. Test in Task 3.
2. **A source finishes reading before `understand_goal` has finished.** `finish_reading` must fire when understanding completes, not only on the last ingest. Test in Task 3.
3. **Every candidate fails to read** (all 8 are behind paywalls or timeouts). The goal must take the fallback, not wait in `reading_sources` for 5 minutes. Test in Task 6.
4. **The learner refreshes during `matching_sources` while gap candidates are in flight.** The same stage shows, and the goal reaches `ready` at the 45 s cap through the sweep, even if the gap job died. Test in Task 8.
5. **Two job threads finish the last two sources of one goal at the same moment.** Exactly one `check_sources` (or gap) job is queued, guarded by the goal row lock. Test in Task 6.
6. **A Tavily result is a YouTube video for a Reading learner.** It counts as a normal candidate, is still capped at 2 per goal, and needs no YouTube key. Test in Task 4.
7. **"Use mine anyway" with a source that could never be read** (HTTP 403 or 404, a timeout, an unparseable PDF). It has no chunks or structure, so `topic_map` must fall back to the starting-point map from the intent. It must not crash or build empty topics. Test in Task 7.
8. **An `ingest_source` job crashes or its worker dies.** The source must still end up `failed`, through the queue's retries and permanent failure, or through reclaiming a stale job. If not, `finish_reading` waits forever; the 5-minute sweep is the backstop. Test in Task 6.
9. **Tavily returns the same page with tracking parameters, a `#fragment` or a trailing slash.** It must take one candidate slot, not several. Test in Task 4.
10. **Every gap search returns nothing or fails vetting.** The goal must go `ready` as soon as nothing is in flight, not wait for the 45 s deadline. The sweep is only a backstop for stalled jobs. Test in Task 8.

---

### Task 1: Database: statuses, vetting, intent and quota

**Files:**
- Create: `supabase/migrations/20261025000001_sources_first.sql`
- Test: `supabase/tests/sources_first_test.sql`
- Modify: `supabase/tests/source_led_maps_test.sql` and `source_onboarding_test.sql`, where they expect `reading_sources` or `pending` and `topic_map` at creation.

**Interfaces (Produces):**
- **`goals.map_status`** takes the values in Global Constraints. `awaiting_expand` rows are updated to `building_map`, and the check constraint is replaced.
- **Goals table:**
  - `goals.intent text`.
  - `goals.search_subject text`.
  - `goals.search_queries jsonb`.
  - `goals.search_round int not null default 0`.
  - `goals.prep_started_at timestamptz`.
  - `goals.gap_deadline timestamptz`.
  - `goals.map_note text`, checked to `('starting_point')` or null.
- **Sources table:**
  - `sources.found_for_goal boolean not null default false`.
  - `sources.vetted boolean` (null until checked).
  - `sources.vet_reason text`, checked to at most 160 characters.
  - `sources.search_score real`.
- **`search_usage(month date primary key, credits int not null default 0, warned boolean not null default false)`:** worker-only, with access revoked from anon and authenticated.
- **New goals from the app start at `understanding`.** One trigger pair decides this, whichever way the goal is created:
  - **The /goals page** inserts directly.
  - **`create_goal_with_sources`** is unchanged in signature. It no longer sets `reading_sources`, and it queues no job itself.
- **The triggers:**
  - **`goals_prepare` (before insert):** when `current_user = 'authenticated'` (the app) and `map_status = 'pending'`, it sets `map_status = 'understanding'` and `prep_started_at = now()`.
  - **`enqueue_topic_map` (after insert):** queues `understand_goal {goal_id}` when the new goal is `understanding`, and `topic_map` when it's `pending`.
  - **What stays `pending`:** goals inserted by `postgres` (the worker and tests), which keep today's goal-only path.
- **The RPC sets the status itself.** It is `security definer`, so its insert runs as `postgres` and `goals_prepare` doesn't fire. It therefore sets `map_status = 'understanding'`, `prep_started_at = now()` and, with sources, `reading_started_at` in its own insert. The after-insert trigger then queues `understand_goal`.
- **`answer_source_decision(p_goal_id uuid, p_choice text) returns void`:**
  - **Who and when:** the owner only, and only while the goal is `awaiting_source_decision`, otherwise `goal_not_awaiting_decision`.
  - **`find`:** sets `finding_sources` and queues `find_sources`.
  - **`use`:** sets `vetted = true` on the goal's user sources that are awaiting a map, then `building_map`, and queues `topic_map`.
- **`use_source_anyway(p_source_id uuid) returns void`:**
  - **Who and when:** the owner only, for a source with `vetted = false` on a `ready` goal, otherwise `source_not_unvetted`.
  - **Effect:** sets `vetted = true` and queues `ingest_source`.
- **`answer_expand` is dropped.**

- [ ] **Step 1: Write the pgTAP test** `sources_first_test.sql`. It asserts:
  - **Creation:**
    - A goal created with no sources starts at `understanding` with one `understand_goal` job and no `topic_map` job.
    - The same holds with one link, plus an `ingest_source` job.
    - A plain insert into `goals` (the /goals page) becomes `understanding` with an `understand_goal` job.
  - **`answer_source_decision`:**
    - `find` gives `finding_sources` plus a `find_sources` job.
    - `use` gives `building_map`, user sources with `vetted = true`, and a `topic_map` job.
    - A wrong state, or a non-owner, raises `goal_not_awaiting_decision`.
  - **`use_source_anyway`:** works as specified, including its error.
  - **`search_usage`:** reading it as `authenticated` raises 42501.
  - **Migrated rows:** an `awaiting_expand` row inserted before the migration can't be tested, so instead assert the constraint rejects `awaiting_expand`.
- [ ] **Step 2: Run it.**
  - Run: `npx supabase test db`
  - Expected: FAIL on missing columns.
- [ ] **Step 3: Write the migration.** Update the older test files where creation now gives `understanding`.
- [ ] **Step 4: Run it again.**
  - Run: `npx supabase test db`
  - Expected: all PASS.
- [ ] **Step 5: Commit:** `feat(db): sources-first statuses, vetting, intent and Tavily usage`

### Task 2: Tavily client and quota tracking

**Files:**
- Create: `worker/src/worker/discovery/tavily.py`
- Modify: `worker/src/worker/config.py`: `tavily_api_key: str | None = None`, `tavily_monthly_credits: int = 1000`, `worker_concurrency: int = 3`.
- Test: `worker/tests/test_tavily.py`, with the fixture `worker/tests/fixtures/discovery/tavily_search.json`.

**Interfaces (Produces):**
- **Config:** `tavily_url: str = "https://api.tavily.com/search"`. The e2e tests point it at the fixture server.
- **`TavilyHit(url: str, title: str, score: float, is_video: bool)`.** `is_video` is true when the host is a YouTube host.
- **`class QuotaExhausted(Exception)`.**
- **`search(conn, query: str, *, api_key: str, monthly_credits: int, url: str = TAVILY_URL, transport=None) -> list[TavilyHit]`:**
  - **Before the call:** it reads `search_usage` for the current UTC month. At or over the limit, it raises `QuotaExhausted` without calling Tavily.
  - **The call:** it POSTs with the Global Constraints body and a 10 s timeout.
  - **On HTTP 429 or 432:** it raises `QuotaExhausted`.
  - **On other errors:** it returns `[]` and logs a warning.
  - **After a successful call:** it adds 1 credit to `search_usage` with an upsert, in its own transaction. When the total first reaches 80% of the limit, it sets `warned` and logs the warning.

- [ ] **Step 1: Write the tests:**
  - The request body, headers and URL.
  - Parsing, including `is_video` for `youtube.com/watch?v=` and `youtu.be`.
  - Excluded domains are in the body.
  - `QuotaExhausted` on HTTP 429 and 432.
  - `QuotaExhausted` when the usage row is at the limit, with no request sent.
  - Credits are incremented.
  - The 80% warning is logged once: at 799→800 of 1000 it logs, and at 801 it doesn't log again.
  - A 500 response returns `[]`.
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest -q tests/test_tavily.py`
  - Expected: FAIL on import.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(worker): Tavily search with monthly quota tracking`

### Task 3: `understand_goal`: the intent and search plan

**Files:**
- Create: `worker/src/worker/prep/__init__.py` and `worker/src/worker/prep/understand.py`
- Modify: `worker/src/worker/__main__.py` (register the job), and `worker/src/worker/llm.py` (`FakeLLM` returns a fixed plan for `SearchPlan`).
- Test: `worker/tests/test_understand.py`

**Interfaces (Produces):**
- **`SearchPlan(BaseModel)`:** fields `intent: str`, `search_subject: str` and `queries: list[str]`. `validate_plan(p) -> list[str]` enforces the Global Constraints limits.
- **`build_plan_prompt(goal_title, level, style) -> tuple[str, str]`:**
  - The goal sits inside `<goal>` and is marked as data.
  - The style's query hints come from spec §4.1.
- **`UnderstandHandler(llm)`, implementing `Handler`. Its `run`:**
  1. **Precondition:** returns unless the goal is in `understanding`.
  2. **The plan:** asks for a `SearchPlan` on the fast tier (`claude-haiku-4-5`), with one repair if it's invalid.
  3. **Writing it:** under the goal lock, stores `intent`, `search_subject` and `search_queries`.
  4. **Moving on:**
     - **With user sources:** sets `reading_sources` and calls `goal_ready.finish_reading(conn, goal_id)`, which acts only if every source is already read.
     - **Without:** sets `finding_sources` and queues `find_sources`.
- **`on_permanent_failure`:** same as the success path, with `intent` = the goal title, `search_subject` = the goal title, and `search_queries` = `[goal_title]`, so the goal never gets stuck (Review Focus 1).

- [ ] **Step 1: Write the tests:**
  - **Plan validation:** all limits, plus a prompt that escapes the goal and contains `<goal>`.
  - **Without sources:** the goal ends at `finding_sources` with a `find_sources` job and stored fields.
  - **With a link already read** (`awaiting_map`): the goal goes to `reading_sources`, then straight to `checking_sources` (Review Focus 2; uses Task 6's `finish_reading`, so this test is marked `xfail` until Task 6 and turned on there).
  - **A permanent failure** still moves the goal on, with the fallback fields.
  - **Sources read in parallel with understanding:** the learner's links are already being ingested while the goal is `understanding`. If the last one finishes first, its `finish_reading` call is a no-op, because the goal isn't `reading_sources` yet. When `UnderstandHandler` then sets `reading_sources`, it calls `finish_reading`, which moves the goal on. Test this order, and the opposite one.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the full worker suite.**
  - Run: `uv run pytest -q tests/test_understand.py`, then `uv run pytest -q`
  - Expected: PASS.
- [ ] **Step 5: Commit:** `feat(worker): understand the goal's intent and plan searches`

### Task 4: `find_sources`: candidates, and the Wikipedia fallback

**Files:**
- Create: `worker/src/worker/prep/find.py`
- Modify: `worker/src/worker/__main__.py`
- Test: `worker/tests/test_find_sources.py`

**Interfaces (Produces):**
- **`pick_candidates(hits: list[TavilyHit], *, style: str, limit: int = 8) -> list[TavilyHit]`:**
  - Normalised-URL de-duplication.
  - At most 1 per domain, 2 for YouTube.
  - At most 3 videos for `visual_video`, and at most 2 for any other style (Review Focus 6).
  - Sorted by score, descending.
- **`FindSourcesHandler(settings, *, tavily_search=tavily.search, wiki_search=wikipedia.search)`. Its `run`:**
  1. **Precondition:** returns unless the goal is in `finding_sources`.
  2. **Search:** runs the stored queries concurrently (a thread pool, 10 s each), and merges and picks.
  3. **On `QuotaExhausted`, no key, or no hits:** the Wikipedia fallback, with `wiki_search("<search_subject>")`. The top 4 of at least 300 words that aren't disambiguation pages become candidates, and `search fallback: <reason>` is logged.
  4. **Adding them:** each candidate is inserted as `origin='auto'` and `found_for_goal=true`, with its `search_score`. The goal moves to `reading_sources`, and `reading_started_at` is set if empty.
  5. **No candidates at all:** the goal goes to `building_map` with `map_note='starting_point'` and `expand=true`, and `topic_map` is queued.

- [ ] **Step 1: Write the tests:**
  - **`pick_candidates`:** domain caps, video caps by style, and the order.
  - **Duplicates (Review Focus 9):** `https://a.example/x?utm_source=t&utm_medium=m#intro`, `https://a.example/x/` and `https://A.example/x` are one candidate.
    - De-duplicate with `ingest.urls.normalize_url`, which already drops tracking parameters and fragments, then strip a trailing `/` from non-root paths.
    - This also applies to the URLs already stored for the goal.
  - **The handler:** with a stub Tavily returning 12 hits across domains, there are 8 candidates, `found_for_goal`, `reading_sources`, and the scores stored.
  - **The fallback:** each of `QuotaExhausted`, no key, and `[]` takes the Wikipedia path with the log line.
  - **Nothing anywhere:** gives `building_map` with `starting_point` and a `topic_map` job.
  - **Concurrency:** the queries run concurrently (a stub that sleeps 0.3 s per query; 3 queries finish in under 0.8 s).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(worker): find candidate learning material with Tavily`

### Task 5: The source check (vetting)

**Files:**
- Create: `worker/src/worker/prep/vet.py`
- Modify: `worker/src/worker/llm.py`: `FakeLLM` returns a `VerdictBatch`. A source is vetted unless its title or URL contains `offtopic` or `sign-in`, so fixtures can fail on purpose.
- Test: `worker/tests/test_vet.py`

**Interfaces (Produces):**
- **`Verdict(id: str, on_topic: bool, credible: bool, substantial: bool, reason: str)`** and **`VerdictBatch(verdicts: list[Verdict])`.**
- **`SourceForCheck(id: str, title: str, url: str, type: str, headings: list[str], text: str)`.** `text` is at most 1,500 characters.
- **`vet(llm, intent: str, sources: list[SourceForCheck]) -> dict[str, Verdict | None]`:**
  - **Batching:** batches of at most 4, in parallel (a thread pool).
  - **Each batch:** asks once, re-asks once for missing or duplicate ids, then gives `None` for any still missing.
  - **Validation:** `reason` is trimmed to 160 characters.
  - **The prompt** states the three criteria from spec §5, and marks every source as untrusted data inside `<source id=…>`.
- **`load_for_check(conn, source_ids) -> list[SourceForCheck]`:** builds each source from its chunks (in position order, up to 1,500 characters) and its `contents.structure` titles.

- [ ] **Step 1: Write the tests:**
  - **Batching:** 8 sources make 2 calls.
  - **Repair:** a stub missing one id gets one re-ask containing just that id.
  - **Still missing:** gives `None`.
  - **Prompt safety:** escapes text, and contains the three criteria.
  - **`load_for_check`:** truncates text.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(worker): vet sources (on topic, credible, substantial)`

### Task 6: From reading to the map: checking, the decision, and picking

**Files:**
- Modify: `worker/src/worker/goal_ready.py`. `finish_reading` is rewritten, and `is_shallow` and the shallow logic go.
- Create: `worker/src/worker/prep/check.py` (`CheckSourcesHandler`).
- Modify: `worker/src/worker/__main__.py` and `worker/src/worker/ingest/handler.py` (the `finish_reading` call sites stay).
- Test: `worker/tests/test_prep_check.py`. Update `worker/tests/test_goal_ready.py`: remove the shallow and expand tests, and switch the remaining ones to the new statuses.

**Interfaces:**
- **Consumes:**
  - `vet` and `load_for_check` (Task 5).
  - `find_sources` (Task 4), for the second round.
- **Produces `finish_reading(conn, goal_id, *, force=False) -> bool`:**
  - **When it acts:** under the goal lock, and only for a goal in `reading_sources` with no source still `queued` or `processing`, unless `force`.
  - **What it does:** moves the goal to `checking_sources` and queues `check_sources`.
  - **Exactly once:** the status change under the lock makes a second call a no-op (Review Focus 5).
  - **If nothing was read** (every source failed): a goal with found sources goes to `finding_sources` for round 2, if `search_round < 1`, otherwise to the fallback. A goal with only user sources goes to `awaiting_source_decision` (Review Focus 3).
- **Produces `CheckSourcesHandler(llm)`. Its `run`:**
  1. **Vets** every source of the goal that's waiting for its map and has `vetted is null`. It writes `vetted` and `vet_reason`, treating a `None` verdict as unvetted for found sources and as `vetted = null` for user sources.
  2. **Unvetted found sources** are deleted.
  3. **Vetted found sources:** the best 4 by `search_score` are kept, with videos capped by style, and the rest deleted.
  4. **Then, in this order:**
     - **Any user source unvetted:** `awaiting_source_decision`.
     - **Otherwise, fewer than 2 vetted sources in total, with `search_round = 0` and found sources involved:** `search_round = 1`, and the goal goes back to `finding_sources` with new queries from `understand.round_two_queries(intent, subject)`. That's one fast-tier call, with the plain fallback `["<subject> tutorial", "<subject> course"]`.
     - **Otherwise, still fewer than 1 vetted:** the fallback from Task 4.
     - **Otherwise:** `building_map`, with `topic_map` queued.
- **`sweep_reading_timeouts`** now forces `finish_reading` on goals `reading_sources` for 5 minutes or more. It's unchanged otherwise.

- [ ] **Step 1: Write the tests:**
  - **Check outcomes:**
    - All vetted gives `building_map`, with 4 kept by score.
    - An unvetted found source is deleted.
    - An unvetted user source gives `awaiting_source_decision`, and the source keeps its `vet_reason`.
    - 1 vetted found source on round 0 gives round 2. After round 1, it falls back.
  - **Review Focus:**
    - All sources failed to read (Review Focus 3).
    - **Two `finish_reading` calls queue one `check_sources`** (Review Focus 5). Use two real connections: the second blocks on the goal lock, then sees `checking_sources` inside the lock and does nothing. The status is re-read after `for update`, never trusted from before it.
    - **A crashed ingest (Review Focus 8):**
      - An `ingest_source` handler that raises an unexpected error on every attempt ends with the source `failed` after `MAX_ATTEMPTS`, and the goal moves on.
      - A job left `running` by a dead worker is reclaimed after the stale timeout, and ends the same way.
  - Turn on Task 3's xfail test.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full worker suite.**
  - Run: `uv run pytest -q`
  - Expected: PASS.
- [ ] **Step 5: Commit:** `feat(worker): check sources before the map; the learner's decision`

### Task 7: The map from vetted sources

**Files:**
- Modify: `worker/src/worker/topic_map.py`
- Test: `worker/tests/test_topic_map.py`, updated where stage 2 assumed `reading_sources`, the expand logic or `ready`.

**Interfaces:**
- **Consumes:** `goals.intent` and `sources.vetted` (Task 1).
- **Changes:**
  - **When it runs:** for goals in `building_map`, or `pending` (legacy).
  - **Structure:** from the goal's sources waiting for a map with `vetted = true`.
  - **Rule:**
    - **Follow** when every structure source is the learner's own (`origin='user'`) and `expand` isn't true.
    - **Expand** otherwise.
  - **Prompt:**
    - It gets `<intent>` (data) and drops the raw goal sentence when an intent exists.
    - Both rules add "Every topic must be taught by at least one of the sources."
    - With no structure and `map_note='starting_point'`, the prompt is the goal-only one.
  - **When the map is written:** the status is `matching_sources`, not `ready`. `on_map_ready` is renamed `on_map_written`: it re-queues the waiting sources, which are vetted, or all of them under "use mine anyway". Discovery is no longer queued here.
  - **Logging:** after matching, `map coverage: <covered>/<top-level>` is logged (Task 8).

- [ ] **Step 1: Write the tests:**
  - **The prompt:** contains `<intent>` and the new rule, and doesn't contain the raw goal.
  - **Expand versus Follow:** Expand with found sources, Follow with only user vetted sources.
  - **Structure:** comes only from vetted sources (an unvetted user source is left out).
  - **The write:** the status is `matching_sources`, and the vetted sources are re-queued.
  - **Starting point:** with no structure, the goal-only prompt is used.
  - **"Use mine anyway" with nothing readable (Review Focus 7):** structure counts only sources that have chunks. With none, the goal gets `map_note='starting_point'` and the intent-only map, with no empty topics and no error.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full worker suite.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(worker): maps from vetted sources, shown only after matching`

### Task 8: Matching, the gap phase, and ready

**Files:**
- Modify: `worker/src/worker/goal_ready.py`: `finish_matching`, `start_gap_phase` and `sweep_matching_deadlines`.
- Modify: `worker/src/worker/discovery/handler.py`. It becomes `FillGapsHandler` (job `fill_gaps`): Tavily first, Wikipedia when there's no key or the quota is out, with the time budget.
- Modify: `worker/src/worker/ingest/handler.py`:
  - After matching, call `finish_matching`.
  - A source arriving while the goal is `ready` or `matching_sources`, with `vetted is null`, gets a single-source `vet` before matching. If it's unvetted, delete it if it's automatic. If it's the learner's, mark it ready with no coverage ("Not used").
- Modify: `worker/src/worker/__main__.py`: the sweep calls both sweeps.
- Test: `worker/tests/test_gaps.py`. Update `worker/tests/test_discover_handler.py`.

**Interfaces (Produces):**
- **`finish_matching(conn, goal_id) -> None`:**
  - **When it acts:** under the goal lock, and only for a goal in `matching_sources` with no source `queued`, `processing` or `awaiting_map`.
  - **Coverage:** logs `map coverage`.
  - **If no gap phase has started yet** (`gap_deadline is null`): uncovered top-level topics start the gap phase. Otherwise, or with none uncovered, the goal goes `ready`.
  - **If a gap phase has started:** the goal goes `ready`.
- **`start_gap_phase(conn, goal_id, uncovered: int) -> None`:**
  - The budget is `remaining = 300 s - (now - prep_started_at)`.
  - Queries are 4, 2 or 0 by the Global Constraints. With 0, the goal goes `ready`.
  - Otherwise it sets `gap_deadline = now + 45 s` and queues `fill_gaps {goal_id, queries: n}`.
- **`FillGapsHandler`:**
  - **Searches** the first n uncovered topics concurrently, with `"<topic> <search_subject> <style word>"`. The style word is "tutorial", "video lesson" or "example".
  - **Inserts** the best candidate per topic as `origin='auto'`, `found_for_goal=false`, `discovered_for=<topic>`.
  - **Caps:** 4 web pages and 2 videos per goal in total, counting the found sources.
- **`sweep_matching_deadlines(conn) -> int`:** goals in `matching_sources` with `gap_deadline <= now()` go `ready` (Review Focus 4). It returns the count.
- **After `ready`:** a gap source that matches later updates coverage as usual (nothing new is needed).

- [ ] **Step 1: Write the tests:**
  - **The budget:** 4, 2 or 0 queries.
  - **Ready conditions:**
    - The goal is `ready` when matching ends with nothing uncovered.
    - The gap phase starts with uncovered topics.
    - The goal is `ready` when the gap sources finish.
  - **The sweep:** a deadline in the past gives `ready` (Review Focus 4).
  - **Gaps that produce nothing (Review Focus 10):**
    - `FillGapsHandler` that inserts no candidate calls `finish_matching` itself, and the goal is `ready` at once.
    - When every gap source fails or is deleted by vetting, the last one's ingest calls `finish_matching`, and the goal is `ready` before `gap_deadline`.
  - **Vetting late sources:**
    - A late automatic source that fails vetting is deleted.
    - A late user source that fails stays ready with no coverage.
    - `use_source_anyway` then matches it.
  - **Concurrency:** the gap searches run concurrently.
  - **Logging:** the `map coverage` line.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full worker suite.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(worker): time-boxed gap phase before the map is shown`

### Task 9: Parallel job threads, and the embedding model in the image

**Files:**
- Modify: `worker/src/worker/__main__.py`. `main()` starts `worker_concurrency` threads, each running `serve` with its own connection. Only thread 0 passes the sweeps. Handlers are built once and shared, so one embedder serves all threads.
- Modify: `worker/src/worker/ingest/embed.py`. `FastEmbedder` loads lazily under a lock and caches at class level, so one model serves the process.
- Modify: `deploy/worker.Dockerfile`. A build step runs `python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5', cache_dir='/opt/fastembed')"`, with `ENV FASTEMBED_CACHE_PATH=/opt/fastembed`, and the embedder passes `cache_dir` from that variable.
- Test: `worker/tests/test_main.py` and `worker/tests/test_embed.py`.

- [ ] **Step 1: Write the tests:**
  - **Threads:** `main` starts N threads, and only one has the sweeps (patch `serve`).
  - **One model:** two `FastEmbedder` instances share one loaded model (patch `TextEmbedding` and count its constructions).
  - **No double claims:** two connections calling `jobs.claim` on one queued job claim it once.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement,** and build the image locally with `docker build -f deploy/worker.Dockerfile .`.
- [ ] **Step 4: Run them, and smoke-test the image** with `docker run --rm <image> python -c "from worker.ingest.embed import FastEmbedder; FastEmbedder().embed_passages(['x'])"`. Expected: no download in the output.
- [ ] **Step 5: Commit:** `perf(worker): parallel job threads; embedding model built into the image`

### Task 10: Web: stages, the decision, "Not used", and no chips

**Files:**
- Modify: `web/app/goals/[id]/MapStatus.tsx`.
  - A stage view for every non-ready status, with the copy and counts from Global Constraints.
  - The domain comes from `new URL(url).hostname`.
  - The decision screen for `awaiting_source_decision`.
  - The expand question goes.
  - Polling covers every status except `ready`, `failed` and `clarifying`.
- Modify: `web/app/goals/actions.ts`: `answerSourceDecision(goalId, "find" | "use")`. `answerExpand` goes.
- Modify: `web/app/goals/[id]/source-actions.ts`: `useSourceAnyway(goalId, sourceId)`.
- Modify: `web/app/goals/[id]/SourceList.tsx`: a source with `vetted === false` shows "Not used: <vet_reason>" and, if the goal is ready, a "Use it anyway" button. `SOURCE_COLUMNS` adds `vetted` and `vet_reason`.
- Modify: `web/app/goals/[id]/page.tsx`:
  - The starting-point notice when `map_note = 'starting_point'`.
  - The list of sources for the stage views.
  - `AddNext` and the "Every topic is covered" text go.
- Delete: `web/app/goals/[id]/AddNext.tsx`, and `SearchLinks` in `Coverage.tsx`.
- Modify: `LessonView.tsx`, for a topic with no sources:
  - **A goal source still in flight:** "Sources for this topic are still being read. This takes a minute or two.", polling every 5 s with `router.refresh()`.
  - **Otherwise:** "We couldn't find good material for this topic yet. Add a source if you have one." with the "Add a source" link.
  - Remove `SearchLinks`.
- Modify: `web/lib/sources.ts`: `SourceRow` gains `vetted: boolean | null` and `vet_reason: string | null`. `searchQuery`, `goalTopic` and `addNextItems` go if unused.
- Test: `web/tests/unit/prep.test.tsx` (new). Update `source-led.test.tsx`, `dialogs.test.tsx` and `sources.test.ts`.

- [ ] **Step 1: Write the tests:**
  - **Each stage renders its copy,** for example `reading_sources` with 4 sources, 1 of them ready, gives "Reading 2 of 4 sources: realpython.com…".
  - **The decision screen:**
    - It lists the failing sources with their reasons.
    - Its buttons call `answerSourceDecision(goalId, "find")` and `"use"`.
  - **The source list:** "Not used", and "Use it anyway" calls `useSourceAnyway`.
  - **The lesson,** for both no-source messages.
  - **Counts in "Reading <i> of <n>":**
    - `n` is the goal's non-failed sources.
    - `i = min(done + 1, n)`, where `done` is the sources at `awaiting_map` or later. 0 of 4 done shows "1 of 4", 3 done shows "4 of 4", and 4 done shows "4 of 4".
    - The domain shown is the first source still in flight.
  - **`understanding` with sources:** it shows "Understanding your goal…" **and** the list of the learner's sources with their steppers, so parallel reading is visible.
  - **"Use it anyway":**
    - Clicking it disables the button at once, which stays pending until the action returns.
    - After a refresh, the source is `queued` or `processing`, so it shows its stepper and no button. There's no double submit.
  - **No chips:** no `link` named `/^Search the web for/` is rendered anywhere in the goal page components.
- [ ] **Step 2: Run them.**
  - Run: `npx vitest run`
  - Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all web checks.**
  - Run: `npx vitest run && npx tsc --noEmit && npx eslint .`
  - Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): preparation stages, source decision, not-used sources; no search chips`

### Task 11: Browser tests with a fake Tavily

**Files:**
- Modify: `web/tests/e2e/fixtures/server.py`. `POST /tavily/search` returns fixture hits:
  - **For a query containing `Discoverme`:** two fixture articles under `/learn/` (copies of `sql-article.html` with distinct titles), plus one `offtopic` page.
  - **Otherwise:** no hits.
- Modify: `web/playwright.config.ts`. The worker env gets `TAVILY_API_KEY=test`, `TAVILY_URL=http://127.0.0.1:8765/tavily/search` (the Task 2 config) and `WORKER_CONCURRENCY=3`.
- Modify or replace: `web/tests/e2e/onboarding.spec.ts` and `source-led.spec.ts`. The shallow and expand specs become decision specs. Specs that waited for the map now also see the stage messages.
- Add new fixture pages as needed.

**Specs to write:**
- **`pick for me finds, checks and prepares before the map appears`:**
  1. The stage messages appear in order, including "Reading … of … sources".
  2. The map appears, and the `offtopic` page isn't in the source list.
  3. The first lesson has content.
  4. No "Try searching for" text appears.
- **`a sign-in-wall link asks before searching`:**
  1. The decision screen lists the link with its reason.
  2. "Find sources for me" leads to a ready map with the fixture sources, and the link is marked "Not used".
- **`use mine anyway builds from the learner's source`:** a short user link that fails vetting (fixture title contains `offtopic`), then "Use mine anyway", gives a ready map.
- **`reloading mid-preparation keeps the stage`:** reload during "Reading…", and the same stage shows, then the map.
- **The existing specs** still pass with the new flow. Their goals use no `Discoverme`, so they take the fallback (the fixture Wikipedia returns nothing) and end on a starting-point map. Update any assertions this changes.

**Steps:**
- [ ] **Step 1: Write and update the specs.**
- [ ] **Step 2: Run the full suite.**
  - Run: `npx playwright test`
  - Expected: all PASS.
- [ ] **Step 3: Run the full checks:** pgTAP, pytest, and Vitest with `tsc` and `eslint`. Expected: all PASS.
- [ ] **Step 4: Commit:** `test(e2e): sources-first preparation with a fake Tavily`

### Task 12: Deploy and live check

- [ ] **Step 1: Ship to staging.** Open a PR into `dev`. After CI is green, merge it, let `dev` CI pass, and merge the staging promotion (the user approved "test on dev, then push to staging").
- [ ] **Step 2: Live check on staging,** with the real Tavily and OpenRouter:
  - **"I would like to learn about simulating a growing plant from seed to big."** should give a map about simulation and modelling, credible on-topic sources, and working lessons.
  - **One reading goal and one video goal.**
  - **Record each goal's map coverage line** from the worker log.
- [ ] **Step 3: Report** the coverage, the times to a ready map, and any weak results to the user.
