# Phase 2: Ingestion Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a goal with a ready topic map, a learner adds web links, YouTube videos and PDFs. Each source is read, split into chunks, embedded and matched to the map's subtopics. The goal page then shows each source's relevance (with a reason), each subtopic's coverage (Covered, Thin or Gap) and what to add next.

**Architecture:** Adding a source inserts a `sources` row, and a trigger queues an `ingest_source` job. The Python worker runs these steps: dedupe → extract → clean → chunk → embed → map. It writes shared, content-addressed chunks (`contents`, `source_chunks`, worker-only) and per-user `source_coverage` rows. Embeddings come from a local fastembed model, stored in pgvector. Haiku confirms each vector shortlist and writes the reasons. Coverage is a SQL view over `source_coverage`.

**Tech Stack:** Postgres + pgvector 0.8.2, Supabase Storage; Python worker with `trafilatura`, `playwright` (Chromium), `youtube-transcript-api`, `pymupdf`, `fastembed` (`BAAI/bge-small-en-v1.5`, 384 dims), `httpx`, `pgvector`; Next.js 16.4; Playwright e2e.

**Spec:** [docs/superpowers/specs/2026-10-07-adaptive-learning-platform-design.md](../specs/2026-10-07-adaptive-learning-platform-design.md) §5, §6, §7 and §10, plus decision 12 (guest caps) in [the decision log](../../brainstorm/2026-10-07-adaptive-learning-platform-decisions.md).

**Decisions made with the user (2026-10-15):** embeddings come from the local model (no API key). The headless-browser fallback for JavaScript pages is included, as the spec says. "Add X to the map" suggestions are deferred to a later phase.

## Global Constraints

- **Pipeline:** `add source → dedupe → extract → clean → chunk + embed → map to subtopics → ready`. If chunks already exist for the content hash, skip straight to mapping.
- **Sources can only be added** to an active goal whose map is `ready`.
- **Content hash:** sha256 hex of one of:
  - `"web:" + normalized URL`
  - `"youtube:" + video id`
  - `"pdf:" + sha256(file bytes)`

  Chunks are keyed by this hash and shared across all users.
- **URL normalization:**
  - Lowercase the scheme and host, and drop the default port and the fragment.
  - Remove the query params `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`, `ref_src`, `igshid` and `si`, then sort the remaining params.
  - An empty path becomes `/`.
  - YouTube ids come from `watch?v=`, `youtu.be/<id>`, `/shorts/<id>`, `/embed/<id>` and `/live/<id>` on the hosts `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be` and `youtube-nocookie.com`.
- **Extractors** all return `Extracted{title, segments: [Segment{text, location}]}`, where the location is `{"anchor": first 10 words of the paragraph}` for web, `{"timestamp_start": seconds}` for YouTube and `{"page": n}` (1-based) for PDF.
  - **Web:** `trafilatura`. If it returns fewer than 200 characters of text, render the page in headless Chromium and run trafilatura on the rendered HTML.
  - **YouTube:** `youtube-transcript-api`. Prefer manual English captions over auto-generated ones. The title comes from oEmbed.
  - **PDF:** `PyMuPDF`, run in a child process.
- **Clean:**
  - Collapse whitespace and remove zero-width characters.
  - For transcripts, also drop `[Music]`-style bracket tags and `>>` speaker markers.
  - Auto-generated transcripts get a Haiku punctuation repair, which must keep the words unchanged (Task 4).
- **Chunking:**
  - Token estimate: `max(1, ceil(len(text) / 4))`.
  - Units are sentences. A segment with no sentence punctuation counts as one unit.
  - Target 500–650 tokens per chunk, hard maximum 800. A unit over 800 is split at word boundaries.
  - Overlap: a chunk starts with the previous chunk's last unit when that unit is ≤ 100 tokens.
  - A final remainder under 150 tokens merges into the previous chunk if the result stays ≤ 800.
  - A chunk's location is the location of its first unit.
- **Embeddings:** fastembed `BAAI/bge-small-en-v1.5`, 384 dims. Chunks use `passage_embed`, and subtopics use `query_embed` of `"{title}: {summary}"` (just the title if there is no summary). The model name is stored on `contents.embed_model`.
- **Mapping:**
  - For each subtopic, take the top 3 chunks of this source by cosine similarity. A subtopic is shortlisted when its best similarity is ≥ `embedder.shortlist_min` (bge: 0.50; fake: 0.10; tune later with evals).
  - Haiku (`claude-haiku-4-5`) rates the shortlisted subtopics in batches of ≤ 8 per call. Each result is relevance 0–1 plus a one-line reason (1–160 characters).
  - Subtopics that aren't shortlisted get no row.
- **Relevance thresholds** live in SQL only, in `public.relevance_label(r)`:
  - ≥ 0.70 → `high`, "Highly relevant"
  - ≥ 0.40 → `partial`, "Partly relevant"
  - otherwise → `off_topic`, "Off-topic"

  A source's relevance is its highest coverage relevance (0 if it has no rows). Its reason is the reason on that top row.
- **Coverage per subtopic**, counting only ready sources that aren't off-topic. A strong row has relevance ≥ 0.70 and a weak row 0.40–0.69.
  - `covered`: at least 1 strong row or at least 2 weak rows.
  - `thin`: exactly 1 weak row and no strong rows.
  - `gap`: otherwise.
- **Quotas:** permanent failures never count, and a retry counts again (by `queued_at`).
  - Guests: 3 sources in total.
  - Free: 5 per UTC day.
  - Pro: 50 per UTC day.
- **Length caps by plan** (guests use free), checked against the stored content metrics too:
  - Free: video ≤ 90 min, PDF ≤ 150 pages, text ≤ 60,000 tokens.
  - Pro: 240 min, 600 pages, 250,000 tokens.
- **Hard safety limits, all plans:**
  - URL fetching:
    - Only http and https.
    - Every hop, including each of at most 5 redirects, is resolved and rejected if any address is private, loopback, link-local, multicast, reserved or unspecified.
    - 15 s timeout per request, and the body is capped at 5 MB, streamed.
    - The content type must be `text/html` or `application/xhtml+xml`.
  - Headless browser:
    - The same host check runs on every request through `page.route`.
    - Images, media and fonts are aborted.
    - 20 s navigation timeout.
  - PDFs:
    - 25 MB file limit (enforced by the bucket and by the worker).
    - Parsing runs in a `multiprocessing` spawn child with a 60 s timeout.
  - `FETCH_ALLOW_PRIVATE_HOSTS=true` turns the host check off, for tests only.
- **Untrusted text:** source text goes inside `<chunk>` and `<s>` tags with HTML escaping, and the system prompts say it is data, not instructions. Output is structured only.
- **Copy, worker errors** (stored on `sources.error`):

  | Case | Message |
  |---|---|
  | Already in this goal | "You've already added this source to this goal." |
  | Blocked host or scheme | "We can't open this link." |
  | HTTP error, DNS failure, timeout | "We couldn't open this page. Check the link and try again." |
  | Link is a PDF | "This link is a PDF. Download it and upload the file instead." |
  | Other non-HTML | "This link isn't a web page we can read." |
  | Body over 5 MB | "This page is too large to read." |
  | No text after the fallback | "We couldn't find readable text on this page." |
  | Not a video link | "This YouTube link doesn't point to a video." |
  | No transcript | "This video has no English transcript, so we can't read it." |
  | Video too long | "This video is longer than your plan's {n}-minute limit." |
  | Bad or corrupt PDF | "We couldn't open this file as a PDF." |
  | Encrypted PDF | "This PDF is password-protected. Upload a copy without a password." |
  | Too many pages | "This PDF has more than {n} pages, your plan's limit." |
  | No text layer | "This PDF has no selectable text (it may be scanned), so we can't read it." |
  | Too long | "This source is longer than your plan allows." |
  | Mapping failed | "We couldn't match this source to your topics. Please try again." |

- **Copy, database errors** (shown by the web app):
  - `guest_source_limit_reached` → "Sign up free to add more sources."
  - `source_limit_reached` → "You've reached today's limit for new sources. Try again tomorrow."
  - `goal_not_ready` → "Wait for your topic map to finish before adding sources."
  - `goal_archived` → "Unarchive this goal to add sources."
  - `invalid_source` → "That link or file can't be added."
- **Copy, UI:**
  - Section heading "Sources". Link field label "Add a link", placeholder "Paste a web page or YouTube link". Button "Add link". File input label "Upload a PDF" (up to 25 MB, shown as the hint "PDF, up to 25 MB").
  - Steps:
    - `queued` "Waiting to start…"
    - `extracting` "Reading the source…"
    - `chunking` "Splitting into sections…"
    - `embedding` "Indexing…"
    - `mapping` "Matching to your topics…"
  - Delayed: "Processing is delayed. We'll keep trying."
  - Failed: the stored error, plus a "Try again" button.
  - Off-topic note: "Off-topic sources stay in your library but aren't used for lessons or quizzes."
  - Empty state, shown before any source is ready: "Add a link, video or PDF to see which topics it covers."
  - Coverage badges: "Covered", "Thin", "Gap".
  - "What to add next": gaps first, then thin subtopics, in map order (each main topic, then its children), at most 5. Each item shows "Try searching for: {query}" with links "Search the web" (`https://www.google.com/search?q=`) and "Search YouTube" (`https://www.youtube.com/results?search_query=`).
    - `query` = `"{subtopic title} {goal topic}"`. The goal topic is the goal title with any leading "learn the basics of ", "learn about ", "learn ", "how to ", "understand " or "master " removed (case-insensitive).
  - Coverage badges and "What to add next" appear only once the goal has at least one ready source.

## Review Focus

1. **Shared content that is over this user's caps.** A Pro user ingests a 3-hour video. A free user then adds the same video. Expected: the free user's source fails with the 90-minute message, even though no extraction runs. *Test: Task 5 `test_cached_content_still_checks_plan_caps`.*
2. **SSRF through links.** Links to `http://127.0.0.1`, `http://169.254.169.254`, a public URL that redirects to a private address, or a JS page that fetches a private URL. Expected: blocked with "We can't open this link." (the JS subrequest is aborted and the page's own text still extracts). *Tests: Task 3 `test_blocks_private_hosts`, `test_blocks_redirect_to_private`, `test_renderer_aborts_private_subrequests`.*
3. **The same source twice.** `…?utm_source=x` versus the plain URL, or `youtu.be/ID` versus `watch?v=ID`, added to the same goal. Expected: the second fails with "You've already added this source to this goal." and doesn't use quota. In a different goal, or by another user, it reuses the chunks without extracting again. *Tests: Task 2 `test_normalize_*`; Task 5 `test_duplicate_in_goal_fails`, `test_reuses_chunks_across_users`.*
4. **Retry when the daily quota is used up.** Expected: `retry_source` raises `source_limit_reached`, and failed sources never count. *Test: Task 1 pgTAP `retry_respects_quota`, `failed_sources_do_not_count`.*
5. **Auto-captions with no punctuation.** A 40-minute transcript of short fragments. Expected: the chunks still fall in 500–800 tokens, with timestamps. *Test: Task 2 `test_unpunctuated_transcript_chunks`.*

---

### Task 1: Database: sources, shared chunks, coverage, quotas, storage

**Files:**
- Create: `supabase/migrations/20261015000001_sources.sql`, `supabase/tests/sources_test.sql`

**Interfaces:**
- Produces:
  - `create extension if not exists vector with schema extensions`.
  - `public.sources`:

    | Column | Definition |
    |---|---|
    | `id` | uuid pk |
    | `user_id` | uuid → users, cascade |
    | `goal_id` | uuid → goals, cascade |
    | `type` | text, check `web\|youtube\|pdf` |
    | `url_or_file` | text, not null, ≤ 2000 |
    | `file_name` | text, null, ≤ 255 |
    | `content_hash` | text, null |
    | `title` | text, null |
    | `status` | `queued\|processing\|ready\|failed`, default `queued` |
    | `step` | text, null, check `extracting\|chunking\|embedding\|mapping` |
    | `delayed` | bool, default false |
    | `error` | text, null |
    | `relevance` | numeric(3,2), null |
    | `relevance_label` | text, null, check `high\|partial\|off_topic` |
    | `relevance_reason` | text, null |
    | `queued_at` | timestamptz, default now() |
    | `created_at` | timestamptz, default now() |

    It also has the partial unique index `(goal_id, content_hash) where status <> 'failed' and content_hash is not null`.
  - `public.contents`: `content_hash` text pk, `type`, `title`, `token_count` int, `duration_s` int null, `page_count` int null, `embed_model` text, `created_at`.
  - `public.source_chunks`:
    - Columns: `id` uuid pk, `content_hash` → contents (cascade), `position` int, `text`, `token_count` int, `embedding extensions.vector(384)` not null, `timestamp_start` numeric null, `page` int null, `anchor` text null.
    - Constraints: unique `(content_hash, position)`, and an index on `content_hash`.
  - `public.subtopic_embeddings`: `subtopic_id` pk → subtopics (cascade), `embed_model` text, `embedding vector(384)`.
  - `public.source_coverage`: `source_id` → sources (cascade), `subtopic_id` → subtopics (cascade), `relevance numeric(3,2)` check 0–1, `reason` text (1–200), pk `(source_id, subtopic_id)`.
  - `public.relevance_label(r numeric) returns text`, immutable, using the thresholds in Global Constraints.
  - The view `public.subtopic_coverage (subtopic_id, goal_id, state, strong_sources int, weak_sources int)` with `security_invoker = true`, applying the coverage rule in Global Constraints.
  - `public.daily_source_limit(plan text) returns int`: pro 50, otherwise 5.
  - The trigger `sources_enforce_rules`, before insert, and before update of status when moving `failed → queued`:
    - The goal must be active (`goal_archived`) and its map `ready` (`goal_not_ready`).
    - For pdf, `url_or_file` must start with `auth.uid()::text || '/'` when `auth.uid()` is not null (`invalid_source`).
    - For web and youtube, it must start with `http://` or `https://` (`invalid_source`).
    - Quota: lock the user row. Guests (`auth.users.is_anonymous`): fewer than 3 sources with status not failed, excluding this one, else `guest_source_limit_reached`. Everyone else: fewer than `daily_source_limit(plan)` sources with status not failed and `queued_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`, excluding this one, else `source_limit_reached`.
  - The trigger `sources_enqueue_ingest`, after insert: inserts the job `('ingest_source', {"source_id": id})`.
  - The RPC `public.retry_source(p_source_id uuid) returns void`, security definer, owner only:
    - Raises `source_not_found` or `not_failed` when appropriate.
    - Sets `status 'queued', step null, error null, delayed false, content_hash null, relevance null, relevance_label null, relevance_reason null, queued_at now()`, then inserts an ingest job.
    - The quota trigger re-checks.
  - The storage bucket `sources`: private, `file_size_limit 26214400`, `allowed_mime_types {application/pdf}`, inserted into `storage.buckets` with `on conflict do nothing`. It has insert and select policies for `authenticated` where `bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text`.
  - Privileges:
    - `contents`, `source_chunks` and `subtopic_embeddings`: RLS on, no policies, and revoke all from anon and authenticated.
    - `sources`: owner select policy; insert policy with check `user_id = auth.uid()` and that the goal is owned by the user. Revoke the table-level insert and update, then `grant insert (goal_id, user_id, type, url_or_file, file_name)`. No update or delete for users.
    - `source_coverage`: select only, when the user owns the source.
    - Revoke truncate, trigger and references as in the core schema.

- [ ] **Step 1: Write the failing pgTAP tests** in `sources_test.sql`, setting the role and JWT claims the way `core_schema_test.sql` does for user-scoped checks. Use these test names as the assertion descriptions:
  - `insert_queues_job`: insert a web source on a ready, active goal → one `jobs` row of kind `ingest_source` whose payload has its `source_id`.
  - `goal_not_ready`: a goal with `map_status 'pending'` → throws `P0001` `goal_not_ready`.
  - `goal_archived`: throws `goal_archived`.
  - `invalid_source`: `ftp://x` throws, and a pdf path in another user's folder throws.
  - `free_daily_limit`: 5 sources succeed and the 6th throws `source_limit_reached`.
  - `failed_sources_do_not_count`: with 5 sources, mark one `failed` → a 6th succeeds.
  - `guest_limit`: an anonymous user: 3 succeed, the 4th throws `guest_source_limit_reached`.
  - `retry_respects_quota`: 5 active sources plus 1 failed; `retry_source` on the failed one throws `source_limit_reached`. After one more is marked failed, the retry succeeds, resets the fields and queues a job.
  - `retry_not_failed`: `retry_source` on a queued source throws `not_failed`.
  - `duplicate_content_in_goal`: setting the same `content_hash` on two non-failed sources in the same goal throws `23505`, while the same hash in a different goal succeeds.
  - `relevance_label`: `0.70 → high`, `0.69 → partial`, `0.40 → partial`, `0.39 → off_topic`.
  - `coverage_states`: one subtopic with one strong row → `covered`; one with two weak rows (from two ready, partial sources) → `covered`; one with one weak row → `thin`; one with none → `gap`; a row from an `off_topic` source or a source that isn't ready is ignored.
  - `rls_isolation`: user B sees none of user A's `sources` or `source_coverage`, and `select` on `source_chunks` is denied for authenticated.
  - `user_cannot_update_source`: `update sources set status = 'ready'` as authenticated → privilege error `42501`.
  - `bucket_exists`: `storage.buckets` has `sources`, with the 25 MB limit and the pdf mime type.
- [ ] **Step 2: Run to verify fail.** `npm run test:db`. Expected: FAIL, because the `sources` relation doesn't exist.
- [ ] **Step 3: Implement** the migration described in Interfaces, then `npx supabase migration up`. Never run `db reset`.
- [ ] **Step 4: Verify.** `npm run test:db` → `Result: PASS`, and `npm run test:worker` still passes.
- [ ] **Step 5: Commit** `feat(db): sources, shared chunks with pgvector, coverage view, source quotas`

---

### Task 2: Worker: URL normalization, cleaning and chunking

**Files:**
- Create:
  - `worker/src/worker/ingest/__init__.py`
  - `worker/src/worker/ingest/types.py`
  - `worker/src/worker/ingest/urls.py`
  - `worker/src/worker/ingest/chunking.py`
  - `worker/src/worker/ingest/messages.py`: every worker error message in Global Constraints, as a constant. Later tasks import them from here.
    - `DUPLICATE`, `BLOCKED`, `UNREACHABLE`, `IS_PDF`, `NOT_HTML`, `TOO_LARGE`, `NO_TEXT`, `NOT_A_VIDEO`, `NO_TRANSCRIPT`
    - `VIDEO_TOO_LONG` (with `{n}`), `BAD_PDF`, `ENCRYPTED`, `TOO_MANY_PAGES` (with `{n}`), `SCANNED`, `TOO_LONG`, `MAPPING_FAILED`
- Test:
  - `worker/tests/test_urls.py`
  - `worker/tests/test_chunking.py`

**Interfaces:**
- Produces (`types.py`):
  - `@dataclass Segment(text: str, location: dict)`
  - `@dataclass Extracted(title: str | None, segments: list[Segment], duration_s: int | None = None, page_count: int | None = None, auto_captions: bool = False)`
  - `@dataclass Chunk(position: int, text: str, token_count: int, location: dict)`
- Produces (`urls.py`):
  - `normalize_url(url: str) -> str`
  - `youtube_video_id(url: str) -> str | None`
  - `is_youtube_host(host: str) -> bool`
  - `content_hash(kind: Literal["web", "youtube", "pdf"], key: str) -> str`: sha256 hex of `f"{kind}:{key}"`. For pdf, the caller passes the sha256 hex of the bytes.
- Produces (`chunking.py`):
  - `estimate_tokens(text: str) -> int`
  - `clean_text(text: str) -> str`
  - `clean_transcript_text(text: str) -> str`
  - `chunk_segments(segments: list[Segment]) -> list[Chunk]`
  - Constants `TARGET_MIN = 500`, `TARGET_MAX = 650`, `HARD_MAX = 800`, `OVERLAP_MAX = 100`, `TAIL_MERGE = 150`.

- [ ] **Step 1: Write the failing tests.**
  - `test_normalize_strips_tracking`:
    - `normalize_url("HTTPS://Example.com:443/a?utm_source=x&b=2&a=1#frag") == "https://example.com/a?a=1&b=2"`
    - `normalize_url("http://example.com") == "http://example.com/"`
    - `fbclid`, `gclid` and `si` are removed.
  - `test_normalize_*` (one per rule in Global Constraints), using exact strings.
  - `test_youtube_ids`:
    - `youtube_video_id` returns `"dQw4w9WgXcQ"` for `https://youtu.be/dQw4w9WgXcQ?si=abc`, `https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10`, `https://m.youtube.com/shorts/dQw4w9WgXcQ`, `https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ` and `https://youtube.com/live/dQw4w9WgXcQ`.
    - It returns `None` for `https://www.youtube.com/playlist?list=PL1` and for `https://example.com/watch?v=x`.
  - `test_content_hash_stable`: the same input gives the same 64-character hex, and `web` and `youtube` give different hashes for the same key.
  - `test_clean_text`: `"a​  b\n\n\nc"` → `"a b\n\nc"`.
  - `test_clean_transcript`: `"[Music] >> hello  there"` → `"hello there"`.
  - `test_chunks_within_bounds`: a 6,000-token article of 20-token sentences across segments → every chunk except the last has 500–800 estimated tokens, positions are 0..n-1, and the first chunk's location is the first segment's.
  - `test_chunks_split_on_sentences`: no chunk starts mid-sentence, unless it came from a unit longer than 800.
  - `test_overlap`: chunk k+1 starts with the last sentence of chunk k when that sentence is ≤ 100 tokens.
  - `test_long_unit_split`: one 3,000-token sentence → pieces of ≤ 800, split at spaces.
  - `test_tail_merge`: a remainder under 150 tokens is merged into the previous chunk.
  - `test_unpunctuated_transcript_chunks`: 1,200 segments of 6–10 lowercase words with no punctuation and `timestamp_start` values `i*2.0` → all chunks except the last are 500–800 tokens, and each location has `timestamp_start`.
  - `test_short_document_one_chunk`: 3 sentences → exactly 1 chunk.
- [ ] **Step 2: Run to verify fail.** `cd worker && uv run pytest tests/test_urls.py tests/test_chunking.py`. Expected: import errors.
- [ ] **Step 3: Implement.** Split sentences with `re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])", text)`. Use the greedy accumulation in Global Constraints.
- [ ] **Step 4: Verify** that the tests above pass, and run `uv run pytest`: all pass.
- [ ] **Step 5: Commit** `feat(worker): URL normalization, cleaning and sentence-aligned chunking`

---

### Task 3: Worker: safe fetching and web extraction with a headless fallback

**Files:**
- Modify:
  - `worker/pyproject.toml`: `uv add httpx trafilatura playwright`, then `uv run playwright install chromium`
  - `worker/src/worker/config.py`: add `fetch_allow_private_hosts: bool = False`
- Create:
  - `worker/src/worker/ingest/safe_fetch.py`
  - `worker/src/worker/ingest/extract_web.py`
  - `worker/tests/fixtures/sites/article.html`: about 1,500 words on SQL SELECT, WHERE and JOIN, as paragraphs with an `<h1>`
  - `worker/tests/fixtures/sites/js_only.html`: empty `<body>` plus a script that inserts the same article's paragraphs, and also `fetch("http://10.255.255.1/x")`
- Test: `worker/tests/test_safe_fetch.py`, `worker/tests/test_extract_web.py`

**Interfaces:**
- Consumes: `Extracted` and `Segment` (Task 2), `PermanentJobError` (`worker.jobs`).
- Produces (`safe_fetch.py`), using the messages from `ingest/messages.py` (Task 2):
  - `check_host_allowed(url: str, allow_private: bool) -> None`: raises `PermanentJobError(BLOCKED)`. It resolves with `socket.getaddrinfo` and checks every address with `ipaddress`.
  - `@dataclass FetchedPage(url: str, html: str)`
  - `fetch_html(url: str, *, allow_private: bool, transport: httpx.BaseTransport | None = None) -> FetchedPage`
    - Redirects are followed by hand (`follow_redirects=False`), checking each hop.
    - A 4xx response, a DNS failure or a connect timeout → `PermanentJobError(UNREACHABLE)`. A 5xx response, or a read timeout once connected, → a plain exception, so the job retries.
- Produces (`extract_web.py`):
  - `class Renderer(Protocol): def render(self, url: str) -> str`
  - `PlaywrightRenderer(allow_private: bool)`: one browser launch per call, using `page.route("**/*", …)` with `check_host_allowed`, and aborting resource types `image`, `media` and `font`. Navigation: `wait_until="networkidle"` with a 20 s timeout.
  - `extract_web(url: str, *, allow_private: bool, renderer: Renderer, transport=None) -> Extracted`
    - Runs `trafilatura.extract(html, output_format="txt", include_comments=False, favor_recall=True)`. Segments are paragraphs split on blank lines, with `location={"anchor": first 10 words}`.
    - The title comes from `trafilatura.extract_metadata(html).title`.
    - The renderer fallback runs when the text is under 200 characters. Still under 200 → `PermanentJobError("We couldn't find readable text on this page.")`.

- [ ] **Step 1: Write the failing tests.** Fake transports use `httpx.MockTransport`. Real-browser tests serve the fixtures from a `http.server` thread on `127.0.0.1` with `allow_private=True`.
  - `test_blocks_private_hosts`: `http://127.0.0.1/`, `http://169.254.169.254/latest`, `http://[::1]/`, `http://10.0.0.5/`, `file:///etc/passwd` and `ftp://example.com/` each raise `PermanentJobError` with message `BLOCKED` (`allow_private=False`).
  - `test_blocks_redirect_to_private`: a mock where `https://public.test/` responds 302 to `http://127.0.0.1/`, with `getaddrinfo` monkeypatched so `public.test` resolves to `93.184.216.34` → `BLOCKED`.
  - `test_redirect_limit`: 6 redirects → `UNREACHABLE`.
  - `test_rejects_pdf_and_non_html`: content type `application/pdf` → `IS_PDF`; `image/png` → `NOT_HTML`.
  - `test_body_cap`: a 6 MB streamed body → `TOO_LARGE`.
  - `test_4xx_permanent_5xx_retryable`: 404 → `PermanentJobError(UNREACHABLE)`; 503 → an exception that is not `PermanentJobError`.
  - `test_extract_article`: `article.html` through a mock transport → a title, at least 5 segments, every segment has an `anchor`, and the joined text contains "WHERE".
  - `test_js_page_falls_back_to_renderer`: `js_only.html` with a `SpyRenderer` that returns the rendered HTML → the renderer is called once and the text contains "WHERE".
  - `test_renderer_aborts_private_subrequests` (real Chromium): `PlaywrightRenderer(allow_private=False)` with `check_host_allowed` monkeypatched to allow only `127.0.0.1` and block `10.255.255.1`. Rendering `js_only.html` from the local server returns HTML that contains the article text, and the blocked request is recorded as aborted.
  - `test_no_text`: an empty page, where the renderer also returns an empty body → "We couldn't find readable text on this page."
- [ ] **Step 2: Run to verify fail.** `uv run pytest tests/test_safe_fetch.py tests/test_extract_web.py`. Expected: import errors.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Verify** that the tests pass and that the full `uv run pytest` passes.
- [ ] **Step 5: Commit** `feat(worker): SSRF-safe fetching and web extraction with headless fallback`

---

### Task 4: Worker: YouTube and PDF extraction, storage, embeddings and the LLM steps

**Files:**
- Modify:
  - `worker/pyproject.toml`: `uv add youtube-transcript-api pymupdf fastembed pgvector`
  - `worker/src/worker/config.py`: add `embedder: Literal["fastembed", "fake"] = "fastembed"`, `supabase_url: str = "http://127.0.0.1:56321"` and `supabase_secret_key: str | None = None`
  - `worker/src/worker/llm.py`: `FakeLLM.parse` dispatches on `schema`. `MappingResponse` → `fake_mapping_response(user)`, `PunctuationResponse` → `fake_punctuation_response(user)`, anything else → the existing topic-map fixtures.
- Create:
  - `worker/src/worker/ingest/extract_youtube.py`
  - `worker/src/worker/ingest/extract_pdf.py`
  - `worker/src/worker/ingest/storage.py`
  - `worker/src/worker/ingest/embed.py`
  - `worker/src/worker/ingest/mapping.py`
  - `worker/src/worker/ingest/punctuate.py`
  - Fixtures under `worker/tests/fixtures/`:
    - `sql_basics.pdf`: 3 pages of SQL text. Generate it with PyMuPDF in a small script, committed alongside as `make_pdfs.py`.
    - `scanned.pdf`: 2 pages with an image only.
    - `encrypted.pdf`
- Test:
  - `worker/tests/test_extract_youtube.py`
  - `worker/tests/test_extract_pdf.py`
  - `worker/tests/test_embed.py`
  - `worker/tests/test_mapping.py`
  - `worker/tests/test_punctuate.py`

**Interfaces:**
- Consumes: `Extracted` and `Segment` (Task 2); `LLM`, `LLMResult` and `LLMOutputError` (`worker.llm`).
- Produces (`extract_youtube.py`):
  - `@dataclass Transcript(snippets: list[tuple[str, float, float]], is_generated: bool)` (text, start, duration)
  - `class TranscriptSource(Protocol)` with `fetch(self, video_id: str) -> Transcript | None` and `title(self, video_id: str) -> str | None`
  - `YouTubeTranscriptSource()`: `YouTubeTranscriptApi().list(id)`, then `find_manually_created_transcript(["en"])`, falling back to `find_generated_transcript(["en"])`. No transcript → `None`. The title comes from `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={id}&format=json`, and any failure gives `None`.
  - `extract_youtube(video_id: str, source: TranscriptSource) -> Extracted`: one segment per snippet with `{"timestamp_start": start}`; `duration_s = ceil(last start + duration)`; `auto_captions = is_generated`; `None` → `PermanentJobError(NO_TRANSCRIPT)`.
- Produces (`extract_pdf.py`):
  - `extract_pdf(data: bytes, max_pages: int) -> Extracted`
    - Over 25 MB → `PermanentJobError(BAD_PDF)`.
    - The child process (spawn, 60 s, then killed) opens the document with `fitz.open(stream=data, filetype="pdf")`.
    - `needs_pass` → `ENCRYPTED`.
    - `page_count > max_pages` → `TOO_MANY_PAGES.format(n=max_pages)`, raised before any text is extracted.
    - One segment per non-empty page `{"page": i + 1}`.
    - Fewer than 20 characters per page on average → `SCANNED`.
    - The title is `metadata["title"]`, or `None`.
    - A parse error or timeout → `BAD_PDF`.
- Produces (`storage.py`):
  - `class Storage(Protocol): def download(self, path: str) -> bytes`
  - `SupabaseStorage(url: str, secret_key: str)`: GET `{url}/storage/v1/object/sources/{path}` with `Authorization: Bearer {key}` and `apikey: {key}`, 30 s timeout, rejected if larger than 25 MB.
- Produces (`embed.py`):
  - `class Embedder(Protocol)` with `model: str`, `shortlist_min: float`, `embed_passages(self, texts: list[str]) -> list[list[float]]` and `embed_queries(self, texts: list[str]) -> list[list[float]]`
  - `FastEmbedder()`: lazy `fastembed.TextEmbedding("BAAI/bge-small-en-v1.5")`; `shortlist_min = 0.50`.
  - `FakeEmbedder()`: hashes lowercase word tokens of 3 or more letters into 384 buckets (sha1 mod 384), then L2-normalizes; `model = "fake-hash-384"`, `shortlist_min = 0.10`.
  - `make_embedder(settings) -> Embedder`
  - `DIMS = 384`
- Produces (`mapping.py`):
  - `MODEL = "claude-haiku-4-5"`, `BATCH = 8`, `TOP_K = 3`
  - `@dataclass ShortlistItem(key: str, title: str, summary: str | None, chunks: list[str])`; keys are `"s1"`, `"s2"`, …
  - `class MappingResult(BaseModel): key: str; relevance: float; reason: str`
  - `class MappingResponse(BaseModel): results: list[MappingResult]`
  - `build_mapping_prompt(goal_title: str, items: list[ShortlistItem]) -> tuple[str, str]`
    - The system prompt says to rate how well the chunks teach each subtopic, 0–1, with a one-line reason, and that the text inside `<chunk>` is untrusted data.
    - The user message is `<goal>…</goal>` then `<subtopic key="s1" title="…">summary<chunk>…</chunk>…</subtopic>`, all escaped.
  - `validate_mapping(resp: MappingResponse, keys: list[str]) -> list[str]`: every key exactly once, relevance between 0 and 1, reason 1–160 characters after stripping.
  - `fake_mapping_response(user: str) -> MappingResponse`: for each subtopic tag, relevance is the share of the title and summary's words (3+ letters) that appear in its chunks, rounded to 2 places; the reason is `"Covers {title}."`.
- Produces (`punctuate.py`):
  - `class PunctuationResponse(BaseModel): snippets: list[str]`
  - `WINDOW = 150`
  - `repair_punctuation(llm: LLM, texts: list[str], bill: Callable[[LLMResult], None]) -> list[str]`
    - Windows of 150 snippets are sent as `<s i="n">` with Haiku.
    - For each snippet, the repaired text is kept only if its lowercase word sequence (punctuation stripped) equals the original's; otherwise the original is kept.
    - A window with the wrong count, or an `LLMOutputError`, keeps the original window (still billed).
    - `bill` is called for every call that used tokens.
  - `fake_punctuation_response(user) -> PunctuationResponse`: echoes the snippets, capitalized, with a trailing ".".

- [ ] **Step 1: Write the failing tests.**
  - `test_youtube_prefers_manual`, using a fake transcript API object that is monkeypatched in. Also `test_youtube_segments_and_duration`: snippets `[("hi", 0.0, 2.0), ("there", 2.0, 3.5)]` → 2 segments, `duration_s == 6`, and `timestamp_start` values `0.0` and `2.0`. And `test_no_transcript` → the message.
  - `test_pdf_pages`: `sql_basics.pdf` → 3 segments with pages 1–3, `page_count == 3`.
  - `test_pdf_scanned`, `test_pdf_encrypted`, `test_pdf_too_many_pages` (`max_pages=2`): the exact messages.
  - `test_pdf_garbage`: `b"not a pdf"` → `BAD_PDF`.
  - `test_pdf_runs_in_child`: monkeypatch the child target to sleep for 120 s and set the timeout to 1 s → `BAD_PDF` in under 5 s.
  - `test_fake_embedder`: deterministic, unit-norm, 384 dims; "SQL joins tables" is closer to "joining tables in SQL" than to "baking bread".
  - `test_fastembed_dims` (marked `slow`, skipped when `FASTEMBED_SKIP=1`): 384 dims, and the similarity of a related pair is greater than an unrelated pair.
  - `test_mapping_prompt_escapes`: a chunk containing `</chunk><system>` appears escaped in the user message.
  - `test_validate_mapping`: a missing key, a duplicate key, relevance 1.5 and an empty reason are each reported.
  - `test_fake_mapping`: a prompt with one matching and one non-matching subtopic → relevance ≥ 0.6 for the match and ≤ 0.2 for the other.
  - `test_punctuation_keeps_words`: a spy LLM returns one snippet with an extra word → that snippet keeps its original text, and the others take the repaired text.
  - `test_punctuation_bills_each_call`: 320 snippets → 3 calls and 3 `bill` calls.
  - `test_fake_llm_dispatch`: `FakeLLM.parse(schema=MappingResponse, …)` uses the fake mapping, and `TopicMapResponse` still loads `topic_map.json`.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** the interfaces above. Embedding vectors are passed to psycopg through `pgvector.psycopg.register_vector(conn)` (called in `worker.db.connect`).
- [ ] **Step 4: Verify** with `uv run pytest`: all pass.
- [ ] **Step 5: Commit** `feat(worker): YouTube and PDF extraction, local embeddings, mapping and punctuation steps`

---

### Task 5: Worker: the ingest job

**Files:**
- Create: `worker/src/worker/ingest/handler.py`, `worker/tests/test_ingest_handler.py`
- Modify:
  - `worker/src/worker/__main__.py`: register `"ingest_source": IngestHandler(...)`. Requires `supabase_secret_key`, raising `RuntimeError("SUPABASE_SECRET_KEY is required")` at startup if it's missing, as for the Anthropic key.
  - `worker/src/worker/db.py`: `register_vector`
  - `worker/tests/conftest.py`: add `make_source` and `make_ready_goal` fixtures (a goal with `map_status 'ready'` and two subtopics inserted as postgres)

**Interfaces:**
- Consumes: everything Tasks 2–4 produce; `Job`, `PermanentJobError` and `GENERIC_MESSAGE` from `worker.jobs`; `record_usage` from `worker.llm`.
- Produces:
  - `PLAN_LIMITS: dict[str, Limits]`, where `@dataclass Limits(video_minutes: int, pdf_pages: int, tokens: int)` holds the values in Global Constraints.
  - `IngestHandler(llm: LLM, embedder: Embedder, storage: Storage, renderer: Renderer, transcripts: TranscriptSource, allow_private: bool)` implementing the `Handler` protocol.
- Behavior of `run`: no transaction is open across fetch, extraction, embedding or LLM calls, as in `TopicMapHandler`. Each step is its own short transaction:
  1. Read the source, the user's plan and `is_anonymous`. Missing, or `status` not `queued`/`processing` → return. Set `status 'processing', step 'extracting', delayed false`.
  2. Compute the content hash (pdf: download, then hash the bytes) and `update sources set content_hash`. A `UniqueViolation` → `PermanentJobError(DUPLICATE)`.
  3. If a `contents` row exists, check the plan caps against its `duration_s`, `page_count` and `token_count`, then go to 5.
  4. Extract (YouTube passes the video id; no id → `NOT_A_VIDEO`). For auto-captions, run `repair_punctuation` (billed as `ingest`) and `clean_transcript_text`, otherwise `clean_text`.
     - Check the caps (the video cap before punctuation repair).
     - Set `step 'chunking'` and call `chunk_segments`; set `step 'embedding'` and call `embed_passages`.
     - Then one transaction: `insert into contents … on conflict do nothing`, and insert the chunks only if this transaction inserted the contents row.
  5. Set `step 'mapping'`.
     - Embed any of the goal's subtopics that have no `subtopic_embeddings` row for `embedder.model` (`embed_queries`), and upsert them.
     - Shortlist with SQL `order by embedding <=> %s limit 3` over this content's chunks.
     - For each batch of 8, call Haiku with one repair attempt, billing each call as `map`. Still invalid → `PermanentJobError(MAPPING_FAILED)`.
  6. One transaction with `select … for update` on the source; write only if it still exists and is `processing`:
     - Delete and re-insert its `source_coverage` rows, with relevance rounded to 2 places.
     - Set `relevance = max` (0 if no rows), `relevance_label = relevance_label(relevance)`, `relevance_reason` = the top row's reason, `title = coalesce(extracted title, content title, file_name, url)`, `status 'ready', step null`.
  - A `PermanentJobError` raised after an LLM call carries `pending_writes` for usage that hasn't been billed yet, as the topic map does.
- `on_retry`: `update sources set delayed = true`.
- `on_permanent_failure`: `status 'failed', error = message, step null, delayed false`.

- [ ] **Step 1: Write the failing tests** (FakeEmbedder, FakeLLM or a spy, a fake renderer, fake transcripts and a fake storage; web extraction through `httpx.MockTransport` serving `article.html`):
  - `test_web_source_ready`: the source becomes `ready`, with chunks in `source_chunks`, coverage rows for the SQL subtopics, `relevance_label 'high'`, a title from the article and a non-empty `relevance_reason`.
  - `test_steps_recorded`: a spy on `sources.step` (read inside the fake embedder and the LLM) sees `embedding` and then `mapping`.
  - `test_reuses_chunks_across_users`: user B adds the same URL with tracking params added → no fetch (the mock transport records 0 calls) and the same chunk count, ready.
  - `test_duplicate_in_goal_fails`: the same normalized URL a second time in the same goal → `failed` with the DUPLICATE message, and the first source is untouched.
  - `test_cached_content_still_checks_plan_caps`: a `contents` row with `duration_s = 3 * 3600` already exists; a free user's YouTube source for that id → `failed` with "This video is longer than your plan's 90-minute limit.", and the transcripts fake is never called.
  - `test_video_cap_fresh`: a 100-minute fake transcript for a free user → the same message. The same transcript for a pro user → ready.
  - `test_pdf_source`: fake storage returns `sql_basics.pdf` → ready, with chunk `page` values set.
  - `test_auto_captions_repaired_and_billed`: a generated transcript → the spy LLM gets a `PunctuationResponse` call, and a `usage_events` row of kind `ingest` exists.
  - `test_off_topic_source`: an article about baking → `relevance_label 'off_topic'`, and every subtopic is a `gap` in `subtopic_coverage`.
  - `test_mapping_repair_then_fail`: a spy returns invalid mappings twice → `PermanentJobError(MAPPING_FAILED)`, and both calls are billed as `map` through `jobs.fail` (run with `run_once`).
  - `test_transient_error_marks_delayed`: the renderer raises `TimeoutError` → after `run_once`, the job is `queued` and the source has `delayed = true` and status `processing`.
  - `test_source_deleted_mid_run`: the fake LLM deletes the source during mapping → no exception and no coverage rows.
  - `test_retry_resumes_from_cache`: the first run fails in mapping after the chunks were written; after `retry_source` and a second run, the source is ready without extracting again.
  - `test_main_registers_ingest`: the `__main__` handler map contains `ingest_source`.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** the handler described above.
- [ ] **Step 4: Verify** that `uv run pytest` and `npm run test:db` pass.
- [ ] **Step 5: Commit** `feat(worker): ingest job: dedupe, extract, chunk, embed and map sources`

---

### Task 6: Web: adding sources and the source list

**Files:**
- Create:
  - `web/lib/sources.ts`
  - `web/app/goals/[id]/source-actions.ts`
  - `web/app/goals/[id]/Sources.tsx` (client)
  - `web/tests/unit/sources.test.ts`
  - `web/tests/e2e/sources.spec.ts`
  - `web/tests/e2e/fixtures/site/sql-article.html` (copy of the worker's `article.html`)
  - `web/tests/e2e/fixtures/sql_basics.pdf` (copy of the worker fixture)
- Modify:
  - `web/app/goals/[id]/page.tsx`: render `<Sources>` under the map when `map_status === 'ready'`, passing `goalId`, `userId`, `archived` and the rows selected below.
  - `web/lib/validation.ts`: map the database errors in Global Constraints.
  - `web/components/form-error.tsx`: link any message that starts with "Sign up free" (not only the goal limit).
  - `web/playwright.config.ts`:
    - A 3rd web server: `uv run --directory ../worker python -m http.server 8765 --bind 127.0.0.1 --directory ../web/tests/e2e/fixtures/site`, ready at `http://127.0.0.1:8765/sql-article.html`.
    - Worker env: `EMBEDDER: "fake"`, `FETCH_ALLOW_PRIVATE_HOSTS: "true"`.
  - `README.md`: add `uv run playwright install chromium` and `SUPABASE_SECRET_KEY` (from `npx supabase status`) to the `worker/.env` setup.

**Interfaces:**
- Consumes: Task 1's tables, errors and `retry_source`; the bucket `sources`.
- Produces:
  - `detectLinkType(url: string): "web" | "youtube"`, using the YouTube host list in Global Constraints.
  - `linkSchema`: zod; trimmed, `http:` or `https:` only, ≤ 2000 characters, message "Enter a link that starts with http:// or https://".
  - `STEP_TEXT: Record<"queued" | "extracting" | "chunking" | "embedding" | "mapping", string>`
  - `LABEL_TEXT: Record<"high" | "partial" | "off_topic", string>`
  - `addLinkSource(goalId: string, url: string): Promise<ActionResult>` inserts `{goal_id, user_id, type: detectLinkType(url), url_or_file: url}`.
  - `addPdfSource(goalId: string, path: string, fileName: string): Promise<ActionResult>` rejects a path not under `${user.id}/` or not ending `.pdf` with "That link or file can't be added.".
  - `retrySource(sourceId: string): Promise<ActionResult>`
  - `SourceRow = { id, type, url_or_file, file_name, title, status, step, delayed, error, relevance_label, relevance_reason }`
- The `Sources` component:
  - The link form calls `addLinkSource`. The PDF input (`accept="application/pdf"`) uploads with the browser client `supabase.storage.from("sources").upload(`${userId}/${crypto.randomUUID()}.pdf`, file, { contentType: "application/pdf" })`. Files over 25 MB are rejected before upload with "PDFs can be up to 25 MB." The component then calls `addPdfSource`.
  - The list is newest first. The title shown is `title ?? file_name ?? url_or_file`, with type text "Web page", "YouTube" or "PDF".
  - Status: `STEP_TEXT[step ?? "queued"]` while queued or processing, plus the delayed line. When ready, the label badge, the reason and (for off-topic) the off-topic note. When failed, the error and "Try again".
  - It refreshes every 2 s while any source is queued or processing, as `MapStatus` does. Errors render through `FormError`. The forms are hidden when the goal is archived.

- [ ] **Step 1: Write the failing tests.**
  - Unit tests (`sources.test.ts`): `detectLinkType` for every listed host plus `https://example.com` → `web`. `linkSchema` rejects `javascript:alert(1)`, `ftp://x` and a 2,001-character link. Every new database error maps to its copy.
  - E2e (`sources.spec.ts`; guest flow through `guestBuildsMap` from `guest.spec.ts`, moved to `helpers.ts`):
    - `add a web link`: paste `http://127.0.0.1:8765/sql-article.html` and click "Add link" → the row passes through a step text and reaches "Highly relevant" with a reason, within 30 s.
    - `upload a PDF`: `setInputFiles` with `sql_basics.pdf` → the row shows "PDF" and becomes ready.
    - `failed link can be retried`: `http://127.0.0.1:8765/missing.html` → "We couldn't open this page. Check the link and try again." and a "Try again" button. Clicking it puts the source back in a step state.
    - `duplicate link`: the article URL with `?utm_source=x` → "You've already added this source to this goal."
    - `guest source limit`: after 3 non-failed sources (the article URL with `?n=1`, `?n=2` and `?n=3`, which normalization keeps distinct), the 4th → "Sign up free to add more sources.", with a link to `/sign-up`.
    - `invalid link`: `ftp://x` → the validation message, and no row is added.
- [ ] **Step 2: Run to verify fail.** `npm run test:web` and `npx playwright test sources`.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Verify** with `npm run test:web`, `npm run test:e2e` (the whole suite), `npx eslint` and `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(web): add web, YouTube and PDF sources with live status and relevance`

---

### Task 7: Web: coverage on the map and what to add next

**Files:**
- Modify:
  - `web/app/goals/[id]/TopicMap.tsx`: accepts an optional `coverage?: Record<string, NodeCoverage>`. Each node shows a badge, and the detail panel lists the sources covering the node (title, label and reason). For a gap, the panel shows the search line and links.
  - `web/app/goals/[id]/page.tsx`: when the goal has at least one ready source, select `subtopic_coverage` and `source_coverage` joined to `sources(title, file_name, url_or_file, relevance_label)` for this goal's subtopics, build the `coverage` map and render `<AddNext>`. Otherwise show the empty-state copy.
  - `web/lib/sources.ts`: add `goalTopic(goalTitle: string): string`, `searchQuery(goalTitle: string, subtopicTitle: string): string`, `COVERAGE_TEXT` and `addNextItems(tree: TreeNode[], coverage: Record<string, NodeCoverage>): TreeNode[]`.
- Create: `web/app/goals/[id]/AddNext.tsx`
- Test:
  - `web/tests/unit/sources.test.ts` (extend)
  - `web/tests/e2e/coverage.spec.ts`
  - `web/tests/e2e/topic-map-visual.spec.ts` (extend with badge layout checks at 375, 1024 and 1440 widths)

**Interfaces:**
- Consumes: the `subtopic_coverage` view and `source_coverage` (Task 1), `buildTree` and `TreeNode` (`web/lib/topic-tree.ts`), and `SourceRow` (Task 6).
- Produces: `NodeCoverage = { state: "covered" | "thin" | "gap"; sources: { title: string; label: "high" | "partial" | "off_topic"; reason: string }[] }`.

- [ ] **Step 1: Write the failing tests.**
  - Unit tests:
    - `goalTopic("Learn the basics of personal finance") === "personal finance"`, `goalTopic("How to bake bread") === "bake bread"`, and `goalTopic("SQL") === "SQL"`.
    - `searchQuery("Learn SQL", "Joining tables") === "Joining tables SQL"`.
    - `addNextItems` returns gaps before thin items, in map order (a main topic, then its children), at most 5, and never a covered node.
  - E2e (`coverage.spec.ts`, guest; the fixture article covers SELECT, WHERE and JOIN but not indexes):
    - `no badges before a source is ready`: the map has no "Covered", "Thin" or "Gap" text, and the empty-state copy is visible.
    - `coverage after a source`: after adding the article and waiting for it to be ready, the node "Joining tables" shows "Covered", and "Indexes and query performance" shows "Gap". Selecting "Joining tables" lists the article with "Highly relevant" and its reason.
    - `what to add next`: the list contains "Indexes and query performance", whose "Search the web" link has an `href` that starts with `https://www.google.com/search?q=` and contains `Indexes%20and%20query%20performance` (or `+`-encoded). There are at most 5 items, and "Joining tables" is not among them.
  - `topic-map-visual.spec.ts`: with badges, nodes don't overlap and the page doesn't scroll sideways at 375, 1024 and 1440 widths, using the existing overlap helper.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Verify** all the suites (`test:db`, `test:worker`, `test:web`, `test:e2e`), eslint and tsc. Take screenshots of the goal page with coverage at 1440×900 dark and 375×812 to the path the controller gives you, and look at them.
- [ ] **Step 5: Commit** `feat(web): coverage badges on the topic map and what to add next`

---

## After the tasks

- Update the decision log: mark Phase 2 done, add the spec amendments below, and set the next step to the Phase 3 (lessons) plan.
- Add to the follow-ups:
  - Orphaned PDF uploads, from uploads whose `sources` insert failed.
  - Removing sources (quota-safe).
  - YouTube blocking transcript requests from cloud IPs.
  - Tuning `shortlist_min` and the relevance thresholds with the eval set.
  - DNS-rebinding hardening (pin the resolved IP) for the URL fetcher.

**Spec amendments this plan introduces:**
- `sources` gains `file_name`, `step`, `delayed`, `relevance`, `relevance_label`, `relevance_reason` and `queued_at`.
- New tables `contents` and `subtopic_embeddings`.
- `source_chunks` stores `token_count`.
- Coverage is the view `subtopic_coverage`.
