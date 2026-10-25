# Source-Aware Onboarding and Source-Led Maps: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New learners get lessons with real, cited content without hunting for links. They can give their own links or a pasted outline at the start, and the map follows that material.

**Architecture:**
- **One RPC creates a goal with its sources.** `create_goal_with_sources` creates the goal, its sources and the learner's prefs in one transaction.
- **User sources are read early.** They're read in parallel with, or before, map building, and park at `awaiting_map` until the map is `ready`. They're then matched by re-running `ingest_source`, which takes the cached-content path.
- **A new `discover_sources` job adds automatic sources.** It adds Wikipedia articles, plus YouTube videos for Visual / Video learners, as `origin = 'auto'` sources. These skip all source limits and go through the existing pipeline.
- **Stage 2 adds source-led maps.** A `reading_sources` stage and a structure summary (headings, TOC, chapters and outline items) stored on `contents`, which the map prompt follows.

**Tech Stack:**
- **Database:** Supabase Postgres, with migrations and pgTAP.
- **Worker:** Python 3.12, psycopg, pydantic, httpx2, pytest.
- **Web:** Next.js 16 (React 19, server actions), Tailwind v4, Vitest and Playwright.

**Spec:** [docs/superpowers/specs/2026-10-24-source-aware-onboarding-design.md](../specs/2026-10-24-source-aware-onboarding-design.md)

## Global Constraints

**Rollout**
- Stage 1 (Tasks 1–8) must be complete, tested and deployable before any Stage 2 task starts. Task 8 is the Stage 1 deploy checkpoint.

**Sources**
- **Caps per goal:** at most **4** automatic Wikipedia articles and **2** automatic YouTube videos.
- **Limits:** automatic sources (`origin = 'auto'`) never count toward guest or daily source limits or attempt counts. User links and outlines count as today. Guests are limited to 3 sources.
- **User sources on the start form:** at most **3** links, and an outline of 1–20,000 characters.
- **Language:** English only. Wikipedia means `en.wikipedia.org`.
- **YouTube search parameters:** exactly `type=video`, `videoCaption=closedCaption`, `videoDuration=medium`, `relevanceLanguage=en`, `safeSearch=strict` and `maxResults=5`.
- **Wikipedia search:** `srsearch="{topic title} {goal title}"` with `srlimit=5`. A result is used only if its `wordcount` is ≥ 300 and it isn't a disambiguation page.

**Discovery and AI quota**
- **Quota floor:** discovery stops when OpenRouter reports **fewer than 5** free-model requests left today. This applies only when `LLM_PROVIDER=openrouter`.

**Maps**
- **Topic counts:** maps built with the Follow rule have **3–12** top-level topics. Every other map keeps 5–12.
- **Clarifying questions:** never asked when the learner gave sources.

**Reading and shallow material**
- **Shallow:** the user's sources have fewer than **1,500 words** in total, or fewer than **3** top-level structure items. An outline with 3 or more top-level items is never shallow.
- **Reading timeout:** a goal in `reading_sources` for **5 minutes** or more moves to `building_map`.
- **Paywall:** applies to hosts `udemy.com`, `coursera.org`, `edx.org`, `linkedin.com/learning`, `oreilly.com`, `skillshare.com` and `pluralsight.com`, or to a page with a password field, when either has fewer than **300** extracted words.

**Exact copy**

| Where | Text |
|---|---|
| Step 1 label | What do you want to master? |
| Step 2 label | How do you like to learn? |
| Step 2 chips | Visual / Video · Documentation & Reading · Hands-On / Building |
| Step 3 label | Where do you want to learn from? |
| Step 3 helper | Have a specific course, book, or playlist? Paste it here and we'll map it out. Otherwise, leave blank and we'll find the best materials for your style. |
| Step 3 tabs | Links · Paste an outline |
| Step 3 text button | I don't have sources, pick the best ones for me |
| Primary button | Build my learning map |
| Discovery status | Finding sources for your topics… |
| Reading view | Reading your sources… |
| Shallow question | This looks like a single article rather than a full curriculum. Expand this topic with related guides? |
| Shallow buttons | Expand · Keep it small |
| Paywall message | We can't read this page, it needs a login. Paste the course's syllabus or table of contents instead. |
| AI quota message | Our AI is busy right now. Try again later. |

**Grounding is unchanged:** never generate a lesson or quiz without sources.

**Learning styles**

| Chip | `learning_style` | Default format |
|---|---|---|
| Visual / Video | `visual_video` | `visual` |
| Documentation & Reading | `reading` | `text` |
| Hands-On / Building | `hands_on` | `examples` |

The default style is `reading`.

**Ops and conventions**
- **Local Supabase:** ports are 443xx. Never run `supabase db reset` on a developer machine; use stop and start.
- **New migrations:** follow the existing style, named `YYYYMMDD00000N_<name>.sql`, with `security definer set search_path = public` on functions.

## Decisions that refine the spec

- **`discovery_status` gains `waiting`** (spec §3.2 lists `none | running | done`). Discovery must not start while the user's own links are still being matched; otherwise it would add automatic sources to topics those links cover. The note "Finding sources for your topics…" shows for both `waiting` and `running`.
- **Wikipedia disambiguation is detected from the title and snippet**, meaning a `(disambiguation)` title suffix or "may refer to" in the snippet. The spec (§5.1) says `pageprops.disambiguation`, but `list=search` can't return page properties, and `generator=search` can't return `wordcount`. One call keeps the request count down.
- **The paywall rule doesn't count toward attempts** because the job row is deleted on a `PAYWALLED` failure (Task 13). The attempt count is computed from jobs.

## Review Focus

Most likely problems first:

1. **Map ends in `clarifying` or `failed` while user links wait at `awaiting_map`.** After the learner answers or retries, the map becomes `ready` and the waiting links get matched. Test in Task 3.
2. **An automatic article duplicates a user link** (same content hash), so the unique index raises `DUPLICATE`. The automatic source is deleted silently and no error is shown. Test in Task 3.
3. **The goal is archived while discovery is running,** so inserting a source raises `goal_archived`. Discovery stops and marks `done` without failing the job. Test in Task 5.
4. **A guest with 3 user sources plus automatic sources adds another link** and gets `guest_source_limit_reached`. A guest with 2 user sources and 4 automatic sources can still add one. Test in Task 1.
5. **Wikipedia or YouTube is down or returns 429.** Discovery records `done` with what it found, and the map and lessons are unaffected. Test in Task 5.
6. **A whitespace-only outline, or one over 20,000 characters.** Whitespace counts as no outline; over the limit is rejected with a message on the form. Test in Task 14.

---

# Stage 1: Onboarding and automatic sources

### Task 1: Database for origins, styles, discovery status and early user links

**Files:**
- Create: `supabase/migrations/20261024000001_source_onboarding.sql`
- Test: `supabase/tests/source_onboarding_test.sql`

**Interfaces:**
- **Produces:**
  - **`sources`:** `origin text not null default 'user' check (origin in ('user','auto'))` and `discovered_for uuid references subtopics on delete set null`. `status` also allows `'awaiting_map'`.
  - **`learning_prefs.learning_style`:** `text not null default 'reading'`, checked against `('visual_video','reading','hands_on')`.
  - **`goals.discovery_status`:** `text not null default 'none'`, checked against `('none','waiting','running','done')`.
  - **`public.create_goal_with_sources(p_title text, p_level text, p_learning_style text, p_links text[]) returns uuid`:** security definer, `auth.uid()` as owner, granted to `authenticated`.
  - **`public.style_format(p_style text) returns text`:** immutable. Maps `visual_video` to `visual`, `reading` to `text` and `hands_on` to `examples`.

- [ ] **Step 1: Write the pgTAP test** `supabase/tests/source_onboarding_test.sql`, following `sources_test.sql`'s setup helpers. It asserts:
  - **Success:** `create_goal_with_sources('Learn SQL','beginner','visual_video', array['https://a.example/x','https://b.example/y'])` returns a goal id with `map_status = 'pending'`, two `sources` rows with `origin='user'` and `status='queued'`, two `ingest_source` jobs, one `topic_map` job, and `learning_prefs` with `learning_style='visual_video'` and `preferred_format='visual'`.
  - **Link validation:** passing 4 links raises `too_many_links`, and a non-http link raises `invalid_source`, with no goal row left behind.
  - **Guest limit with user sources:** a guest with 3 user sources gets `guest_source_limit_reached` on a 4th user insert.
  - **Guest limit with automatic sources:** a guest with 2 user sources and 4 `origin='auto'` sources (inserted as `postgres`) can insert a 3rd user source.
  - **No early inserts outside the RPC:** a direct insert of a user source into a `pending` goal, outside the RPC, still raises `goal_not_ready`.
  - **Automatic sources skip limits:** inserting an `origin='auto'` source for a signed-in user at the daily limit succeeds.

- [ ] **Step 2: Run it.**
  - Run: `npx supabase test db`
  - Expected: FAIL on `create_goal_with_sources` not existing.

- [ ] **Step 3: Write the migration.**
  - **Alter the tables and checks** as in Produces.
  - **`sources_enforce_rules`:**
    - Return early, with no limit or attempt checks, when `new.origin = 'auto'`.
    - Make the guest `used` count and the `attempts` count filter `s.origin = 'user'`.
    - Relax `goal_not_ready` only when `current_setting('app.creating_goal', true) = new.goal_id::text`.
  - **`create_goal_with_sources`:**
    - Validate the links: at most 3, and none blank after trimming.
    - Upsert `learning_prefs (level, learning_style, preferred_format = style_format(style))`.
    - Insert the goal.
    - `set_config('app.creating_goal', goal_id::text, true)`.
    - Insert one `web` or `youtube` source per link. The type is `youtube` when the host is `youtube.com`, `www.youtube.com`, `m.youtube.com` or `youtu.be`, otherwise `web`.
    - Return the goal id.

- [ ] **Step 4: Run it again.**
  - Run: `npx supabase test db`
  - Expected: PASS, with every existing pgTAP file still passing.

- [ ] **Step 5: Commit.**
  ```bash
  git add supabase/migrations/20261024000001_source_onboarding.sql supabase/tests/source_onboarding_test.sql
  git commit -m "feat(db): source origins, learning styles and goal creation with links"
  ```

### Task 2: AI quota-exhausted message

**Files:**
- Modify: `worker/src/worker/jobs.py`, in `fail()` and its final-failure message.
- Test: `worker/tests/test_jobs.py`

**Interfaces:**
- **Produces:** `jobs.AI_BUSY = "Our AI is busy right now. Try again later."`
- **Produces:** `jobs.final_message(error: Exception, default: str) -> str`. It returns `AI_BUSY` when `error` is an `openai.RateLimitError` or an `anthropic.RateLimitError`, and `default` otherwise.

- [ ] **Step 1: Write the tests:**
  - **`test_final_message_rate_limit_is_ai_busy`:** builds an `openai.RateLimitError` as `test_llm_openrouter._api_error` does, and asserts `final_message(e, "x") == AI_BUSY`.
  - **`test_job_failing_on_rate_limit_after_retries_reports_ai_busy`:** a handler raising `RateLimitError` on every attempt has its `on_permanent_failure` called with `AI_BUSY` after the last retry.
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest tests/test_jobs.py -q`
  - Expected: FAIL, because `final_message` doesn't exist yet.
- [ ] **Step 3: Implement.** Use `final_message` wherever `fail()` currently passes the generic message for a non-permanent error that has run out of attempts.
- [ ] **Step 4: Run them again.**
  - Run: `uv run pytest tests/test_jobs.py -q`
  - Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(worker): say the AI is busy when rate limits outlast retries"
  ```

### Task 3: Early user links wait for the map, then get matched

**Files:**
- Create: `worker/src/worker/goal_ready.py`
- Modify: `worker/src/worker/ingest/handler.py`
  - `run()`: claim also accepts `awaiting_map`, and there's a new park step before `_map`.
  - `on_permanent_failure()`.
- Modify: `worker/src/worker/topic_map.py`, in `_write()`: call `on_map_ready` after setting `ready`.
- Test: `worker/tests/test_goal_ready.py` and `worker/tests/test_ingest_handler.py`

**Interfaces:**
- **Produces `goal_ready.on_map_ready(conn, goal_id: UUID) -> None`.** It runs inside the caller's transaction:
  1. Enqueues an `ingest_source` job for each source of the goal with `status = 'awaiting_map'`.
  2. Then, if any user source of the goal is still `queued`, `processing` or `awaiting_map`, sets `discovery_status = 'waiting'`. Otherwise it sets it to `running` and enqueues `discover_sources {goal_id}`.
- **Produces `goal_ready.maybe_start_discovery(conn, goal_id: UUID) -> None`.** If `discovery_status = 'waiting'` and no user source is in flight, it sets `running` and enqueues `discover_sources`.
- **Ingest behaviour:**
  - **Park:** after embedding, or after a content-cache hit, if the goal's `map_status <> 'ready'`, set `status = 'awaiting_map', step = null` and return without matching.
  - **Ready or failed:** when a user source becomes `ready` or `failed`, call `maybe_start_discovery`.
- **Automatic source failures:** `on_permanent_failure` for an `origin = 'auto'` source deletes the source row and enqueues nothing, except for a failed `youtube` automatic source with a `discovered_for`. That one enqueues `discover_sources {goal_id, wikipedia_for: discovered_for}`.

- [ ] **Step 1: Write the tests:**
  - **`test_link_added_before_map_parks_at_awaiting_map`:** a goal in `pending` with a queued user web source, run with FakeLLM, fake embedder and fixture transport, ends with source `status='awaiting_map'`, chunks stored and no `source_coverage`.
  - **`test_map_ready_requeues_waiting_sources_then_they_match`:** after `TopicMapHandler.run` writes the map, an `ingest_source` job exists for the waiting source. Running it leaves the source `ready`, with coverage and without re-extraction (assert the transport was not called again).
  - **`test_discovery_waits_for_user_sources`:** while a user source is `awaiting_map`, `on_map_ready` sets `discovery_status='waiting'` and enqueues no `discover_sources`. Once the source is `ready`, `maybe_start_discovery` sets `running` and enqueues one.
  - **`test_clarifying_map_then_answer_matches_waiting_links`** (Review Focus 1): the map goes `clarifying`, then `answer_clarification`, and the next topic map run makes waiting sources get jobs.
  - **`test_failed_auto_source_is_deleted`** and **`test_duplicate_auto_source_is_deleted_silently`** (Review Focus 2): an `origin='auto'` source failing with `DUPLICATE` leaves no row.
  - **`test_failed_auto_video_requests_wikipedia_for_its_topic`:** a failed automatic YouTube source enqueues `discover_sources` with `wikipedia_for`.
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest tests/test_goal_ready.py tests/test_ingest_handler.py -q`
  - Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run the full worker suite.**
  - Run: `uv run pytest -q`
  - Expected: all tests PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(worker): user links read early wait for the map, then match"
  ```

### Task 4: Wikipedia, YouTube and quota clients

**Files:**
- Create: `worker/src/worker/discovery/__init__.py`, `wikipedia.py`, `youtube.py` and `quota.py`
- Modify: `worker/src/worker/config.py`
- Test: `worker/tests/test_discovery_clients.py`, with fixtures in `worker/tests/fixtures/discovery/` (recorded `wiki_search.json`, `youtube_search.json` and `openrouter_key.json`)

**Interfaces:**
- **Config:**
  - `discovery_enabled: bool = True`
  - `wikipedia_api_url: str = "https://en.wikipedia.org/w/api.php"`
  - `wikipedia_article_url: str = "https://en.wikipedia.org/wiki/{title}"`
  - `youtube_api_key: str | None = None`
  - `youtube_api_url: str = "https://www.googleapis.com/youtube/v3/search"`
- **`wikipedia.WikiHit(title: str, wordcount: int, disambiguation: bool)`** and **`wikipedia.search(query: str, *, api_url: str, user_agent: str, transport=None) -> list[WikiHit]`:**
  - Calls `action=query&list=search&srsearch=<query>&srlimit=5&srprop=wordcount|snippet&format=json&formatversion=2`.
  - `disambiguation` is true when the title ends with `(disambiguation)` or the snippet contains `may refer to`.
  - Network errors, non-200 responses and bad JSON return `[]` and log a warning.
- **`wikipedia.article_url(title: str, template: str) -> str`:** replaces spaces with `_`, then percent-encodes with `quote(safe="_()")`.
- **`youtube.search(query: str, *, api_key: str, api_url: str, transport=None) -> list[str]`:** returns video ids, with exactly the parameters in Global Constraints and `part=snippet`. Errors return `[]`.
- **`quota.free_requests_left(api_key: str, *, transport=None) -> int | None`:** `GET https://openrouter.ai/api/v1/key`, reading `data.free_model_daily_requests.remaining`. Anything missing or failing returns `None`, meaning unknown, and discovery proceeds.

- [ ] **Step 1: Write the tests,** using `httpx2.MockTransport` that serves the fixtures:
  - The query parameters sent, including `srsearch` text, `srlimit=5`, and every YouTube parameter value.
  - Parsing.
  - Disambiguation detection.
  - `article_url("Emergency fund", default) == "https://en.wikipedia.org/wiki/Emergency_fund"`.
  - 429 and 500 responses return `[]` or `None`.
  - The User-Agent header equals the configured one.
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest tests/test_discovery_clients.py -q`
  - Expected: FAIL on import.
- [ ] **Step 3: Implement** with `httpx2.Client(timeout=15, transport=transport)`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add worker/src/worker/discovery worker/tests/test_discovery_clients.py worker/tests/fixtures/discovery worker/src/worker/config.py
  git commit -m "feat(worker): Wikipedia, YouTube and OpenRouter quota clients"
  ```

### Task 5: The `discover_sources` job

**Files:**
- Create: `worker/src/worker/discovery/handler.py`
- Modify: `worker/src/worker/__main__.py`, in `build_handlers()`, to register `"discover_sources"`.
- Test: `worker/tests/test_discover_handler.py`

**Interfaces:**
- **Consumes:**
  - Task 4 clients.
  - `goal_ready` (Task 3).
  - The `sources` columns (Task 1).
- **Produces `DiscoverHandler(settings: Settings, *, wiki_search=wikipedia.search, yt_search=youtube.search, quota_left=quota.free_requests_left)`,** implementing the `Handler` protocol. `run(conn, job)` does the following:
  1. **Loads the goal.** It returns with `discovery_status='done'` if `discovery_enabled` is false, or if the goal isn't `active` and `ready`.
  2. **Finds uncovered topics:** top-level subtopics, in `position` order, for which neither the subtopic nor any of its children has a `source_coverage` row with relevance ≥ 0.40 from a non-failed source. With payload `wikipedia_for`, it uses only that subtopic's top-level ancestor.
  3. **Counts existing automatic sources** for the goal, by type, against the caps of 4 articles and 2 videos.
  4. **YouTube:** if `learning_style='visual_video'`, `youtube_api_key` is set and there's no `wikipedia_for`, it searches for the first 2 uncovered topics. It inserts the first result whose `https://www.youtube.com/watch?v=<id>` isn't already a `url_or_file` of the goal, as `type='youtube', origin='auto', discovered_for=<topic>`.
  5. **Wikipedia:** for each uncovered topic not given a video, it takes the first hit with `wordcount >= 300`, no disambiguation, and whose `article_url` isn't already a source URL of the goal. It inserts that as `type='web', origin='auto', discovered_for=<topic>`.
  6. **Quota check:** before each insert, when `llm_provider == 'openrouter'`, it stops early if `quota_left(...)` returns a value below 5.
  7. **Archived goal:** an insert raising `goal_archived` (`psycopg.errors.RaiseException`) stops the loop.
  8. **Finishes** with `discovery_status = 'done'`.
- **`on_retry` and `on_permanent_failure`:** both set `discovery_status='done'`, so discovery never shows as running forever.

- [ ] **Step 1: Write the tests,** with stub search functions recording their calls:
  - **`test_adds_one_article_per_uncovered_topic_up_to_four`:** 6 uncovered topics give 4 web sources, `origin='auto'`, in map order, and `discovery_status='done'`.
  - **`test_skips_covered_topics_including_via_children`.**
  - **`test_skips_disambiguation_short_and_duplicate_hits`.**
  - **`test_visual_learner_gets_two_videos_then_articles`:** 2 youtube sources for the first two topics, then articles for the next ones.
  - **`test_no_youtube_key_means_no_videos`.**
  - **`test_wikipedia_for_payload_only_searches_that_topic`.**
  - **`test_stops_when_quota_below_floor`:** `quota_left` returning 4 gives 0 inserts, and `done`.
  - **`test_archived_goal_stops_quietly`** (Review Focus 3).
  - **`test_search_errors_finish_done`** (Review Focus 5): the stubs return `[]`, giving 0 inserts and `done` with no exception.
  - **`test_auto_sources_skip_guest_limit`:** a guest with 3 user sources still gets automatic sources.
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest tests/test_discover_handler.py -q`
  - Expected: FAIL.
- [ ] **Step 3: Implement,** and register the handler in `build_handlers` with `DiscoverHandler(settings)`.
- [ ] **Step 4: Run the full worker suite.**
  - Run: `uv run pytest -q`
  - Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(worker): discover_sources adds Wikipedia articles and YouTube videos"
  ```

### Task 6: Start form, styles and goal page status

**Files:**
- Modify: `web/components/start-form.tsx`
- Modify: `web/app/start-actions.ts`
- Modify: `web/lib/validation.ts`, adding `startSchema`.
- Modify: the onboarding page that renders `components/preferences-form.tsx` in sign-up onboarding: drop its format question there and keep level.
- Modify: `web/app/goals/[id]/page.tsx` and `Workspace.tsx`, for the discovery status note.
- Modify: `web/app/goals/[id]/topics/[subtopicId]/LessonView.tsx`, for the `no_sources` state: add an "Add a source" button (it opens the dialog through `useAddSource`) and the topic's suggested-search chips (`SearchLinks` from `Coverage.tsx`).
- Test: `web/tests/unit/start-form.test.tsx` and `web/tests/unit/validation.test.ts`

**Interfaces:**
- **Consumes:** `create_goal_with_sources` (Task 1). Map its errors with `dbErrorToMessage`, adding `too_many_links` with the message "Add up to 3 links."
- **Produces:** `startSchema` (zod) over `{ title, level, learning_style, links: string[] }`.
  - `links` is filtered to non-blank entries and capped at 3, and each entry passes the existing link validation used by `addLinkSource`.
  - When the submitter is the "pick for me" button (`formData.get("intent") === "pick"`), `links` is `[]`.

- [ ] **Step 1: Write the tests:**
  - **Unit:**
    - The form renders the three step labels and the three style chips in the exact copy, with "Documentation & Reading" checked by default.
    - Step 3 is collapsed, with the disclosure button's `aria-expanded="false"` and no link inputs in the document.
    - Expanding it shows the Links tab with 3 URL inputs and the "I don't have sources, pick the best ones for me" button, which has `name="intent" value="pick"`.
  - **`startSchema`:**
    - Blank links are dropped.
    - 4 links give "Add up to 3 links."
    - `intent=pick` ignores links.
    - An invalid link gives the existing link error.
- [ ] **Step 2: Run them.**
  - Run: `npx vitest run tests/unit/start-form.test.tsx tests/unit/validation.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **The form:**
    - Style chips use `FilterChip` with `type="radio" name="learning_style"`.
    - Step 3 is a disclosure button controlling a region.
    - The Links tab is the only tab in Stage 1. The outline tab arrives in Task 14.
  - **`startLearning`:** calls `supabase.rpc("create_goal_with_sources", {...})` instead of the goal insert, then redirects.
  - **Goal page:**
    - Load `discovery_status`.
    - Show the "Finding sources for your topics…" status line, `role="status"`, in the Sources column while it's `waiting` or `running`.
    - The existing source polling already shows new rows. Also poll `goals.discovery_status` in the same interval, and hide the line when it's `done`.
- [ ] **Step 4: Run all web checks.**
  - Run: `npx vitest run && npx tsc --noEmit && npx eslint .`
  - Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(web): three-step start form with learning styles and links"
  ```

### Task 7: End-to-end tests for Stage 1

**Files:**
- Create: `web/tests/e2e/fixtures/server.py`. It replaces `python -m http.server` for the fixture site, serving `site/` statically plus a dynamic `/w/api.php`.
- Create: `web/tests/e2e/fixtures/site/wiki/Fixture_SQL_joins.html`, a copy of `sql-article.html` with its title changed.
- Modify: `web/playwright.config.ts`:
  - The fixture server command becomes `uv run --directory ../worker python ../web/tests/e2e/fixtures/server.py`.
  - The worker env gets `WIKIPEDIA_API_URL=http://127.0.0.1:8765/w/api.php` and `WIKIPEDIA_ARTICLE_URL=http://127.0.0.1:8765/wiki/{title}.html`.
- Create: `web/tests/e2e/onboarding.spec.ts`
- Modify: `web/tests/e2e/helpers.ts`. `startGoal` keeps working, because Step 3 is collapsed by default.

**Interfaces:**
- **Fixture `/w/api.php` behaviour:**
  - When `srsearch` contains `Discoverme`, it returns one hit, `{"title": "Fixture SQL joins", "wordcount": 900, "snippet": "Joins combine rows"}`.
  - Otherwise it returns no hits, so existing specs see no automatic sources.

- [ ] **Step 1: Write the specs in `onboarding.spec.ts`:**
  - **`pick for me adds a source and the first lesson has content`:**
    1. Set the goal to "Discoverme SQL joins", expand Step 3 and click "I don't have sources, pick the best ones for me".
    2. The map appears, then a source titled "Fixture SQL joins" reaches Ready.
    3. Open the lesson for a covered topic. It shows a section, not the `no_sources` text.
  - **`links on the start form are read and matched`:**
    1. Expand Step 3, enter `FIXTURE_ARTICLE` and submit.
    2. The source list shows the article reaching Ready with a relevance chip.
  - **`guest with 3 links on the form has used their limit`:**
    1. Create a goal with 3 fixture links.
    2. Open Add source and add a 4th. It shows the guest-limit message.
- [ ] **Step 2: Run them.**
  - Run: `npx playwright test tests/e2e/onboarding.spec.ts`
  - Expected: FAIL before Tasks 1–6 are wired, PASS once they are.
- [ ] **Step 3: Run the whole e2e suite.**
  - Run: `npx playwright test`
  - Expected: all PASS, with the existing specs unchanged.
- [ ] **Step 4: Commit.**
  ```bash
  git commit -am "test(e2e): onboarding with discovered and user sources"
  ```

### Task 8: Stage 1 deploy checkpoint

- [ ] **Step 1:** Open a PR from the feature branch into `dev`, and merge it once CI is green.
- [ ] **Step 2: Ask the user** to create a YouTube Data API key and set it on both Fly apps:
  ```
  fly secrets set --stage --app <app> YOUTUBE_API_KEY=...
  ```
- [ ] **Step 3: With the user's OK,** merge the `dev` → `staging` promotion PR, and watch the deploy.
- [ ] **Step 4: Live check on staging.**
  - **Reading goal:** a guest "pick for me" goal with style Reading gets Wikipedia sources, and its first lesson has cited content.
  - **Visual / Video goal:** gets 1–2 YouTube sources, or a Wikipedia fallback if transcripts are blocked.
  - **Record the result** in `docs/qa/` for the Tokyo transcript question (spec §8).

---

# Stage 2: Source-led maps

### Task 9: Database for reading stages, outlines, structure and main references

**Files:**
- Create: `supabase/migrations/20261024000002_source_led_maps.sql`
- Test: `supabase/tests/source_led_maps_test.sql`

**Interfaces:**
- **Produces:**
  - **`goals.map_status`** also allows `'reading_sources'`, `'awaiting_expand'` and `'building_map'`.
  - **`goals.expand boolean`** and **`goals.reading_started_at timestamptz`.**
  - **`sources.type` and `contents.type`** also allow `'outline'`.
  - **`sources.outline_text text`,** checked: `char_length` 1–20,000, and required exactly when `type='outline'`.
  - **For outlines, `url_or_file = 'outline'`.**
  - **`contents.structure jsonb`,** a list of `{"id", "title", "level", "first_sentence", "chunk_position"}`.
  - **`subtopics.primary_ref uuid references source_chunks on delete set null`.**
- **`create_goal_with_sources`** gains `p_outline text default null`, via `create or replace`.
  - **With any user source:** the goal is created with `map_status='reading_sources'` and `reading_started_at=now()`.
  - **With an outline:** a whitespace-only outline is treated as null, and a non-null one inserts an `outline` source.
- **`enqueue_topic_map`** enqueues only when the new goal's `map_status = 'pending'`.
- **`public.answer_expand(p_goal_id uuid, p_expand boolean) returns void`:**
  - **Allowed:** only for the goal's owner, and only while it's `awaiting_expand`.
  - **Effect:** sets `expand` and `map_status='building_map'`, and enqueues `topic_map`.
  - **Errors:** otherwise raises `goal_not_awaiting_expand`.
- **`sources_enforce_rules`** validates `outline` (`outline_text` required) and lets an outline be added to a `ready` goal by its owner, subject to the normal limits.

- [ ] **Step 1: Write the pgTAP test:**
  - **Reading stage:** goal creation with one link sets `reading_sources` and enqueues no `topic_map`. With no sources, it stays `pending` and enqueues one.
  - **Outlines:**
    - A blank outline gives no outline source.
    - A 20,001-character outline raises a check violation.
    - An outline counts toward a guest's 3.
  - **`answer_expand`:** the transition, the enqueue, the wrong-state error, and a non-owner error.
  - **Main references:** deleting a chunk nulls `primary_ref`.
- [ ] **Step 2: Run it.**
  - Run: `npx supabase test db`
  - Expected: FAIL.
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run it again.**
  - Run: `npx supabase test db`
  - Expected: all PASS, including Task 1's file, which must be updated where it expected `pending` for goals with links.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(db): reading stages, outlines, structure and main references"
  ```

### Task 10: Structure extraction and summary

**Files:**
- Modify: `worker/src/worker/ingest/types.py`, adding `Heading(title: str, level: int, first_sentence: str)` and `Extracted.headings: list[Heading]` (default empty).
- Modify: `worker/src/worker/ingest/extract_web.py`:
  - Collect H1–H3 from the HTML with lxml, in order, each with the first sentence of the next paragraph.
  - Drop headings whose casefolded text is in `{"contents", "references", "see also", "external links", "further reading", "notes", "navigation menu"}`.
- Modify: `extract_pdf.py`, using `doc.get_toc()` levels 1–2, with the first sentence of that page's text.
- Modify: `extract_youtube.py`, for chapters: parse `^\s*(\d{1,2}:)?\d{1,2}:\d{2}\s+(.+)$` lines from the video description. Fetch the description with the YouTube Data API `videos.list?part=snippet` only when `youtube_api_key` is set; otherwise there are no headings.
- Create: `worker/src/worker/ingest/extract_outline.py`, `extract_outline(text: str) -> Extracted`.
  - Each non-blank line becomes a segment with `{"anchor": first words}`.
  - **Top-level headings:** lines that aren't indented and match `^(\d+[.)]|[-*•]|#{1,2}\s|[A-Z][^a-z]{0,3}\s)` or are Title-like (short and not ending in a period), at level 1. Indented ones are level 2.
- Create: `worker/src/worker/structure.py`:
  - `build_structure(headings: list[Heading], chunks: list[Chunk], prefix: str) -> list[dict]`. `chunk_position` is the first chunk whose text contains `first_sentence`, otherwise the nearest preceding match, otherwise 0. Ids are `{prefix}H{n}`, or `O{n}` for outlines.
  - `structure_summary(sources: list[tuple[str, str | None, list[dict]]], max_chars: int = 32000) -> tuple[str, dict[str, tuple[str, int]]]`. Each source tuple is `(type, title, structure)`. It returns the delimited summary text and `ref -> (content_hash, chunk_position)`. Sources are numbered `S1…` in the order given, and outline items keep `O{n}`.
- Modify: `worker/src/worker/ingest/handler.py`:
  - `_identify` and `_extract` handle `outline` (key = the text, no fetch).
  - `_ingest` stores `contents.structure = build_structure(...)`.
- Test: `worker/tests/test_structure.py`, plus cases added to `test_extract_web.py`, `test_extract_pdf.py`, `test_extract_youtube.py` and `test_extract_outline.py`.

- [ ] **Step 1: Write the tests:**
  - **Web:** the fixture HTML with `<h2>Inner joins</h2><p>An inner join keeps matching rows. More.</p>` yields `Heading("Inner joins", 2, "An inner join keeps matching rows.")`. A "References" heading is dropped.
  - **PDF:** `sql_basics.pdf`'s TOC entries come through as headings, or the test asserts none when the fixture has no TOC.
  - **YouTube:** a description with "0:00 Intro\n2:15 Joins" gives 2 headings. With no key, there are none.
  - **Outline:** "1. Basics\n  - Tables\n2. Joins\n3. Indexes" gives 3 level-1 items and 1 level-2 item.
  - **Structure:**
    - `chunk_position` resolution.
    - The summary's ids, order and truncation at `max_chars`, with the last item dropped whole.
    - The returned ref map.
  - **Ingest:** an outline source ingests with no HTTP call and stores `contents.structure`.
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest tests/test_structure.py tests/test_extract_outline.py -q`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full worker suite.**
  - Run: `uv run pytest -q`
  - Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(worker): source structure (headings, TOC, chapters, outlines)"
  ```

### Task 11: Finishing reading, the shallow check and the reading timeout

**Files:**
- Modify: `worker/src/worker/goal_ready.py`
- Modify: `worker/src/worker/ingest/handler.py`, to call `finish_reading` when a user source of a `reading_sources` goal parks or fails.
- Modify: `worker/src/worker/__main__.py`. `serve` calls `sweep_reading_timeouts(conn)` before each `run`, wrapped so its errors are logged and never stop the loop.
- Test: `worker/tests/test_goal_ready.py`

**Interfaces:**
- **Produces `is_shallow(total_words: int, top_level_items: int, outline_top_items: int) -> bool`.** It's true when `outline_top_items < 3` and either `total_words < 1500` or `top_level_items < 3`.
- **Produces `finish_reading(conn, goal_id: UUID) -> None`:**
  - **When it acts:** under the goal lock, and only if the goal is `reading_sources` with no user source still `queued` or `processing`.
  - **No source read:** if no user source is `awaiting_map`, meaning all failed, it sets `building_map, expand=true` and enqueues `topic_map`.
  - **Shallow:** if `is_shallow(...)` holds (computed from `contents.token_count`, an approximation of words, and the `contents.structure` level-1 counts), it sets `awaiting_expand`.
  - **Otherwise:** it sets `building_map` and enqueues `topic_map`.
- **Produces `sweep_reading_timeouts(conn) -> int`.** Goals in `reading_sources` with `reading_started_at <= now() - interval '5 minutes'` go through the same decision as `finish_reading`, with sources still in flight left alone. It returns the number of goals moved.

- [ ] **Step 1: Write the tests:**
  - `is_shallow` truth table: (1499, 5, 0) is True, (5000, 2, 0) is True, (5000, 3, 0) is False, and (100, 1, 3) is False.
  - `finish_reading` waits while a source is `processing`. With two sources, where one is `awaiting_map` and one `failed`, it gives `building_map` plus one `topic_map` job. With all sources failed, it gives `building_map` and `expand=true`. One short article gives `awaiting_expand`.
  - **Sweep:** moves a goal started 6 minutes ago, ignores one started 4 minutes ago, and returns the count.
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest tests/test_goal_ready.py -q`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full worker suite.**
  - Run: `uv run pytest -q`
  - Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(worker): finish reading, shallow check and reading timeout"
  ```

### Task 12: Building the map from sources, and main references

**Files:**
- Modify: `worker/src/worker/topic_map.py`:
  - `ChildDraft` and `SubtopicDraft` gain `ref: str | None = None`.
  - `build_prompt` gains `structure: str | None` and `follow: bool`.
  - `validate_topic_map` gains `min_top: int`.
  - `run()` accepts `building_map` as well as `pending`.
  - `_write()` sets `primary_ref`.
- Modify: `worker/src/worker/ingest/handler.py`, in `_map`. After writing coverage, for each subtopic rated ≥ 0.40 whose `primary_ref` is null, set it to that subtopic's top shortlisted chunk id. `_shortlist` must return chunk ids with their texts.
- Modify: `worker/tests/fixtures/fake_llm/`. Add `topic_map_follow.json`, chosen by FakeLLM when the user message contains `<structure>`. It has 3 top-level topics with refs `O1`, `O2` and `O3`.
- Test: `worker/tests/test_topic_map.py`

**Interfaces:**
- **Consumes:** `structure_summary` (Task 10), and `goals.expand` (Task 9).
- **Behaviour:**
  1. **Structure:** when the goal has user sources at `awaiting_map`, the handler loads their `(type, title, contents.structure)` in creation order and builds the summary.
  2. **Rule:** `follow = not goal.expand`.
  3. **Prompt:** the summary is wrapped in `<structure>…</structure>`, with the rule text for Follow or Expand from spec §4.2.
  4. **No clarifying:** `allow_clarify=False` when a structure is present.
  5. **Validation:** `min_top=3` when `follow`, otherwise 5.
  6. **References:** unknown `ref` values are ignored. Known ones set `subtopics.primary_ref` to the chunk at `(content_hash, chunk_position)`.

- [ ] **Step 1: Write the tests:**
  - **`test_follow_prompt_includes_structure_and_rule`.**
  - **`test_follow_map_with_three_topics_is_valid`,** while the same map without `follow` fails validation (fewer than 5).
  - **`test_no_clarify_when_structure_present`.**
  - **`test_refs_set_primary_ref_and_unknown_refs_are_ignored`.**
  - **`test_goal_only_map_gets_primary_ref_after_matching`:** via `IngestHandler._map`.
  - **`test_building_map_goal_is_processed`.**
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest tests/test_topic_map.py -q`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full worker suite.**
  - Run: `uv run pytest -q`
  - Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(worker): maps follow the learner's sources; main references"
  ```

### Task 13: Paywall and login detection

**Files:**
- Modify: `worker/src/worker/ingest/extract_web.py`
- Modify: `worker/src/worker/ingest/messages.py`, adding `PAYWALLED`, the exact spec copy.
- Modify: `worker/src/worker/ingest/handler.py`. A `PAYWALLED` failure doesn't count toward attempts.
  - In practice, the failed status already excludes the source from `used`. For attempts, the Task 1 rule counts jobs, so the job row is deleted on a `PAYWALLED` permanent failure.
- Test: `worker/tests/test_extract_web.py`

**Interfaces:**
- **Produces `extract_web.looks_gated(url: str, html: str, text: str) -> bool`,** using the Global Constraints host list (matched on the host suffix, plus the `/learning` path for linkedin.com), the `<input type="password"` check and the 300-word threshold.
- **Behaviour:** `extract_web` raises `PermanentJobError(PAYWALLED)` when `looks_gated` holds, and checks this before `NO_TEXT`.

- [ ] **Step 1: Write the tests:**
  - A short page on `www.udemy.com/course/x` is gated.
  - A long Coursera article is not gated.
  - A short page with a password field on any host is gated.
  - `linkedin.com/in/someone` is not gated by host.
  - An e2e-style ingest of a gated page leaves the source failed with `PAYWALLED`, and the user's attempt count unchanged.
- [ ] **Step 2: Run them.**
  - Run: `uv run pytest tests/test_extract_web.py -q`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full worker suite.**
  - Run: `uv run pytest -q`
  - Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(worker): detect paywalled and login pages"
  ```

### Task 14: Web pages for Stage 2

**Files:**
- Modify: `web/components/start-form.tsx` and `web/lib/validation.ts`. Add the "Paste an outline" tab, a `textarea name="outline"`, with `maxLength` 20,000 and a character count.
- Modify: `web/app/start-actions.ts`, to pass `p_outline`.
- Modify: `web/app/goals/[id]/MapStatus.tsx`:
  - The `reading_sources` view shows "Reading your sources…" with the per-source stepper. Reuse the `AddSourceDialog` stepper by extracting it to `web/app/goals/[id]/SourceStepper.tsx`.
  - The `awaiting_expand` view shows the shallow question, and buttons that call a new `answerExpand(goalId, expand)` server action, which calls the `answer_expand` RPC.
  - `building_map` reuses the `pending` view.
  - Polling continues while the status is `pending`, `reading_sources` or `building_map`.
- Modify: `web/app/goals/[id]/AddSourceDialog.tsx`. Add a "Paste an outline" tab, using a new `addOutlineSource(goalId, text)` in `source-actions.ts`.
- Modify: `web/app/goals/[id]/SourceList.tsx`. When a failed source's error equals the paywall message, render a "Paste an outline" link that opens the dialog on the outline tab, via `useAddSource().open({ tab: "outline" })`. Extend the context with an optional `tab`.
- Modify: `web/app/goals/[id]/TopicMap.tsx`. The detail panel shows "Main reference: {source title}, {label}" linking to `citation_href`, when `primary_ref` is set. The page query joins `subtopics.primary_ref` to its chunk, content and the goal's source carrying that `content_hash`.
- Modify: `web/lib/sources.ts`, so `outline` sources show "Outline" as their type label.
- Test: `web/tests/unit/start-form.test.tsx`, `web/tests/unit/validation.test.ts` and `web/tests/unit/dialogs.test.tsx`

- [ ] **Step 1: Write the unit tests:**
  - **Outline tab:** shows a textarea and a counter.
  - **`startSchema` outline rules** (Review Focus 6): a whitespace-only outline becomes `null`, and 20,001 characters give "Outlines can be up to 20,000 characters."
  - **`MapStatus`:**
    - `reading_sources` renders "Reading your sources…" and a stepper per source.
    - `awaiting_expand` renders the exact question and both buttons, and clicking Expand calls `answerExpand(goalId, true)`.
  - **Dialog:** opening it with `tab: "outline"` selects the outline tab.
- [ ] **Step 2: Run them.**
  - Run: `npx vitest run`
  - Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all web checks.**
  - Run: `npx vitest run && npx tsc --noEmit && npx eslint .`
  - Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -am "feat(web): outline input, reading view, expand question, main references"
  ```

### Task 15: End-to-end tests for Stage 2, and the final check

**Files:**
- Create: `web/tests/e2e/fixtures/site/short-article.html` (about 200 words, one heading) and `web/tests/e2e/fixtures/site/sign-in-wall.html` (under 300 words, with a `<form>` holding an `<input type="password">`). The password-field rule in `looks_gated` applies on any host, so no production code needs a test hook.
- Modify: `web/tests/e2e/onboarding.spec.ts`

**Specs to write:**
- **`pasted outline gives a map that follows it`:** an outline "1. Tables\n2. Joins\n3. Indexes" gives a map whose top-level topics are, in order, the FakeLLM follow fixture's 3 titles, and a "Main reference" in the first topic's detail panel.
- **`one short link asks to expand, and both answers work`:**
  1. The short article shows the exact question.
  2. Keep it small gives a map.
  3. A second goal answering Expand gives a map.
- **`a paywalled link shows the paste-outline message`:**
  1. The source fails with the exact message.
  2. "Paste an outline" opens the dialog on the outline tab.
- **`one of two links fails and the map is still built`:** the sign-in-wall link fails, the fixture article goes Ready, and the map appears.

**Steps:**
- [ ] **Step 1: Write the specs.**
- [ ] **Step 2: Run the whole e2e suite.**
  - Run: `npx playwright test`
  - Expected: all PASS.
- [ ] **Step 3: Run the full checks.**
  - Run: `npx supabase test db`, `uv run pytest -q`, and `npx vitest run && npx tsc --noEmit && npx eslint .`
  - Expected: all PASS.
- [ ] **Step 4: Commit,** then open the PR into `dev`. After CI is green and the user gives their OK, promote to staging and repeat the Task 8 live check for an outline goal and a shallow-link goal.
