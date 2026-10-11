# Adaptive Learning Platform: First Release Design

**Date:** 2026-10-07
**Status:** Draft for review
**Decision log:** [../../brainstorm/2026-10-07-adaptive-learning-platform-decisions.md](../../brainstorm/2026-10-07-adaptive-learning-platform-decisions.md)

## 1. Summary

A web platform where anyone can turn learning material they collect (web articles, YouTube videos, PDFs) into lessons in their preferred format, organized around a goal they set, and test themselves with adaptive quizzes that show which areas to study next.

**First-release success:** a user sets a goal, adds a few links or PDFs, sees what each source covers and what's missing, gets lessons in their preferred format with diagrams, and takes quizzes that show which subtopics to revisit.

## 2. Product decisions

| Area | Decision |
|------|----------|
| Audience | General: anyone learning any subject. Every feature must be domain-agnostic. |
| Business model | Freemium (assumed): usage-limited free tier, paid Pro tier. |
| Personalization | Preferred **format**: `visual`, `text`, `examples`, `summary`. Stated at onboarding in v1; data collected to infer it later. |
| Sources (v1) | Websites, YouTube (transcripts only), PDF uploads with a text layer. |
| Visuals | Mermaid diagrams written by the AI and rendered in the browser. No AI-generated images. |
| Relevance | Goal → AI-designed topic map (not user-editable), shown as a visual mind map; sources mapped to subtopics with relevance scores and reasons; gaps shown. |
| Quizzes | Multiple choice, adaptive difficulty, decaying per-subtopic mastery with spaced review. |
| Language | English only. |
| Ownership | Each goal belongs to one user. |

## 3. Out of scope for the first release

- GitHub, books without a PDF, and course platforms (Udemy, Coursera, Educative). Course platforms are paywalled and their terms forbid scraping; future support is limited to user-supplied notes or syllabus metadata.
- Speech-to-text for videos without transcripts; OCR for scanned PDFs.
- AI-generated images; extracting figures or video frames from sources.
- AI-graded short-answer questions.
- Automatic format inference (data is collected; inference is not switched on).
- Automatic web search to fill coverage gaps.
- Shared or team goals; languages other than English; mobile apps.

## 4. Architecture

```
┌──────────────┐   HTTPS    ┌────────────────────────┐
│   Browser    │──────────▶│  Next.js (UI + thin API)│
│ (Mermaid     │◀──────────│                        │
│  rendering)  │  stream    └───────────┬────────────┘
└──────────────┘                        │ enqueue jobs / read state
                                        ▼
                        ┌──────────────────────────────┐
                        │ Supabase                      │
                        │ Postgres + pgvector, Auth,    │
                        │ Storage (PDFs), job queue     │
                        └───────────────┬──────────────┘
                                        │ claim jobs
                                        ▼
                        ┌──────────────────────────────┐
                        │ Python worker                 │
                        │ extract · chunk · embed · map │
                        │ generate lessons & questions  │
                        └───────────────┬──────────────┘
                                        ▼
                               Claude API (Sonnet 5.5, Haiku 4.5)
```

- **Next.js** serves the UI, handles auth via Supabase, writes user actions, enqueues jobs, and streams lesson generation to the browser.
- **Supabase** provides Postgres (with pgvector), auth, file storage for uploaded PDFs, and the job queue table.
- **Python worker** runs all slow or AI-heavy work. It is the only component with write access to shared cache tables.
- **Models:** Sonnet 5.5 for topic maps, lessons, and quiz questions; Haiku 4.5 for relevance confirmation, question validation, and tagging.

**Lesson streaming:** the lesson request goes through Next.js, which calls the worker's generation endpoint and relays the stream to the browser. The worker persists the finished lesson.

## 5. Data model

```
users            id, email, display_name, plan (free|pro), created_at
learning_prefs   user_id, preferred_format (visual|text|examples|summary),
                 level (beginner|intermediate|advanced), inferred_format (null in v1)

goals            id, user_id, title, description, status (active|archived), created_at
subtopics        id, goal_id, title, summary, parent_id (null = top level), position,
                 user_edited (bool)

sources          id, user_id, goal_id, type (web|youtube|pdf), url_or_file,
                 content_hash, title, status (queued|processing|ready|failed), error
source_chunks    id, content_hash, text, position, embedding (pgvector),
                 timestamp_start (youtube) | page (pdf) | anchor (web)
source_coverage  source_id, subtopic_id, relevance (0–1), reason

lessons          id, subtopic_id, format, cache_key, body (json sections),
                 stale (bool), model, created_at
quiz_questions   id, subtopic_id, difficulty (1–3), stem, options[4], correct_index,
                 explanation, source_chunk_ids[], status (active|rejected)
quiz_attempts    id, user_id, question_id, chosen_index, correct, flagged (bool), answered_at
mastery          user_id, subtopic_id, score (0–1), last_practiced_at,
                 current_difficulty (1–3), half_life_days, correct_streak

lesson_feedback  id, user_id, lesson_id, rating (up|down), report_text, created_at
format_events    id, user_id, subtopic_id, from_format, to_format, at
usage_events     user_id, kind (ingest|map|lesson|quiz_gen|validate), tokens, cost_cents, at
jobs             id, kind, payload (json), status, step, attempts, last_error, run_after
```

Rules:
- `source_chunks` are keyed by `content_hash`, not by source, so identical content is extracted, chunked, and embedded once across all users.
- `lessons.cache_key` = hash of (chunk ids used + subtopic summary + format + level). A matching key reuses the lesson.
- Lesson sections and quiz questions keep the chunk ids they came from, so every claim can be traced to its source location.
- Topic maps are at most two levels deep.
- Mastery decay is computed on read: `decayed = score × e^(−days_since_last_practice × ln2 / half_life_days)`.
- `format_events` and per-format quiz results are the data for future format inference.

## 6. Ingestion pipeline

```
add source → dedupe → extract → clean → chunk + embed → map to subtopics → ready
```

1. **Dedupe.** Normalize URLs (strip tracking parameters, expand `youtu.be` links) or hash the uploaded PDF. If chunks already exist for the content hash, skip to step 5.
2. **Extract.** One extractor per type, each returning `{title, segments: [{text, location}]}`:
   - **Web:** fetch and extract main content with `trafilatura`; fall back to a headless browser for pages that only render with JavaScript.
   - **YouTube:** `youtube-transcript-api`, preferring manual captions. No transcript → fail with a clear message.
   - **PDF:** `PyMuPDF`, with page numbers as locations. No text layer → reject as scanned.
3. **Clean.** Remove boilerplate and fix spacing; repair punctuation in transcripts.
4. **Chunk and embed.** 500–800 tokens, small overlap, split only at sentence boundaries, keep location. Store embeddings in pgvector.
5. **Map.** For each subtopic, vector search shortlists chunks; Haiku confirms relevance and writes a one-line reason. Results go to `source_coverage`.

The UI shows live status per step. Free-tier limits cap source length (e.g. video duration, PDF pages) and daily source count. Permanent failures don't count against quota.

## 7. Topic map and relevance

- **Creation:** Sonnet generates the map from the goal text and user level before any sources are added: 5–12 top-level subtopics, optional children, each with a 1–2 sentence summary (also used as the definition for matching), ordered basics-first. If the goal is too vague, Sonnet asks one clarifying question first.
- **No user editing (revised 2026-10-10):** the AI designs the map from the goal and the user's level; learners can't judge a subject's structure, so the map is not user-editable. It is shown as a visual mind map: goal → numbered main topics in learning order → child topics; selecting a topic shows its summary.
- **Suggestions:** if a source has substantial content matching no subtopic, the AI may propose adding *X* to the map; the user only accepts or dismisses the proposal.
- **Per-source label:** Highly relevant / Partly relevant / Off-topic, plus a one-line reason. Off-topic sources stay in the library but are excluded from lessons and quizzes.
- **Per-subtopic coverage:** Covered / Thin (one weak source) / Gap (none). Gaps show suggested search terms.
- **Goal page:** topic map with coverage badge and mastery bar per subtopic; source list with relevance labels; "what to add next" from gaps.

Exact thresholds for relevance labels and coverage states are tuned during implementation using the eval set (§11).

## 8. Lesson generation

- **Trigger:** on demand, when a user first opens a subtopic in a given format. Streamed to the browser.
- **Input:** subtopic title and summary, user format and level, and the top relevant chunks from non-off-topic sources, capped at ~8k tokens and spread across sources.
- **Output:** JSON sections `{markdown, mermaid?, citations: [chunk_ids]}`.

| Format | Shape |
|--------|-------|
| Visual | 2–4 diagrams carrying the explanation; short captions; minimal prose |
| Text | Structured explanation with headings; 1 supporting diagram |
| Examples | Worked examples and analogies; 1 diagram |
| Summary | ~200 words of key points; 1 overview diagram |

- **Faithfulness:** explain only what sources support; cite every section; when sources are thin, say so instead of filling in from general knowledge. Citations render as `[n]` links to the paragraph, timestamp, or page.
- **Diagram validation:** each Mermaid block is checked with the Mermaid CLI in the worker; one repair attempt, otherwise the diagram is dropped.
- **Format switcher:** "Show me this as: Visual | Text | Examples | Summary". Each format is generated once and cached; switches are logged to `format_events`.
- **Staleness:** new coverage for a subtopic marks its lessons `stale`; the user sees "New sources available. Refresh lesson?" No silent regeneration.
- **Feedback:** thumbs up/down and "Report an error" per lesson.

## 9. Quizzes and mastery

- **Bank:** generated the first time a subtopic is quizzed, ~6 questions per difficulty level, from the same chunks as lessons. 4 options, one correct, plausible distractors, explanation with citation. Topped up when the user runs out of unseen questions at a level.
- **Validation:** Haiku checks each question (exactly one correct answer, answerable from the cited source, no "all of the above", no giveaway wording). Failures are regenerated once, then marked `rejected`.
- **Quiz types:** subtopic quiz (5 questions, offered after a lesson); review quiz (10 questions across the goal, prioritizing lowest decayed mastery and subtopics due for review).
- **Difficulty:** start at `current_difficulty` (initialized from stated level: beginner→1, intermediate→2, advanced→2). Two correct in a row → up one level; one wrong → down one level. No repeats of questions seen in the last 7 days.
- **Mastery update** per answer: `score ← decayed + w × (result − decayed)`, with `result` ∈ {0, 1} and `w` = 0.2 / 0.3 / 0.4 for difficulty 1 / 2 / 3. `half_life_days` starts at 3, doubles when a review session for that subtopic ends with decayed mastery ≥ 0.8, capped at 60; it resets to 3 when decayed mastery falls below 0.5.
- **Feedback:** per subtopic Strong (≥ 0.8) / Developing / Weak (< 0.5). Wrong answers show the explanation and link to the lesson section and source location. "What to study next" lists Weak subtopics, then those due for review (decayed < 0.6).
- **Disputes:** "Flag this question" removes it from the user's rotation, logs it, and excludes that answer from mastery.

## 10. Error handling, cost controls, security

**Error handling**
- Jobs are idempotent and record their current step; retries resume from the last completed step.
- LLM calls retry 3 times with backoff on rate limits and timeouts; malformed JSON gets one repair attempt, then the job fails cleanly.
- Claude API outages leave jobs queued; the UI shows "Processing is delayed."
- User-facing errors are plain language with a next step.

**Cost controls**
- Free tier (initial values, to be tuned): 2 active goals, 5 sources/day, 15 lesson generations/day; quizzes unlimited from already-generated questions.
- Pro: higher limits with a fair-use ceiling.
- Daily global spend alert from `usage_events`; above a hard threshold, new free-tier generation pauses.
- Haiku for mapping, validation, tagging; Sonnet only for maps, lessons, and questions.

**Security**
- Supabase row-level security on all user tables; shared cache tables are writable only by the worker.
- URL fetching blocks private/internal IP ranges, limits redirects, and enforces size and time limits.
- PDF uploads: max file size, page cap, parsing in a sandboxed worker process.
- Source text is treated as untrusted: clearly delimited in prompts, models return structured output only, and models have no tools or actions.

## 11. Testing and monitoring

- **Unit tests:** extractors against saved fixtures, URL normalization, chunking, mastery math, difficulty adaptation, cache-key computation.
- **Integration tests:** full pipeline with LLM calls mocked.
- **Quality evals:** fixed set of ~20 sources across varied subjects. Metrics: share of citations pointing to supporting text, Mermaid validity rate, question validator pass rate, spot-checked lesson accuracy. Run on every prompt or model change.
- **End-to-end (Playwright):** sign up → onboarding → create goal → add source → open lesson → take quiz → see feedback.
- **Monitoring:** Sentry for errors, job status dashboard, cost per user from `usage_events`.

## 12. Future work

1. Turn on format inference from `format_events` and per-format quiz performance.
2. AI-graded short-answer questions with dispute handling.
3. Real figures from PDFs and key video frames alongside diagrams.
4. GitHub sources; course platform support via user notes and syllabus metadata.
5. Speech-to-text for videos without transcripts; OCR for scanned PDFs.
6. Suggested sources to fill coverage gaps.
