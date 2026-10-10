# Adaptive Learning Platform — Brainstorm Decision Log

**Started:** 2026-10-07
**Status:** Phase 1 implemented on branch `phase-1` (2026-10-10). Awaiting review and merge. This is a decision log, not the final spec.

## The idea

A platform where users learn in the way that suits them:

1. Users add knowledge sources (YouTube, GitHub, websites, books, course platforms like Udemy/Coursera/Educative).
2. The platform analyzes each source against what the user wants to learn and judges its relevance.
3. The platform turns source content into simpler versions with visuals so users learn faster.
4. Adaptive quizzes test knowledge and show which areas need more study.

## Decisions made

| # | Question | Decision |
|---|----------|----------|
| 1 | Who is it for? | A real product for real users (possibly paying), not a personal tool or portfolio piece. |
| 2 | Target audience | General: anyone learning anything. All features must work across subjects. |
| 3 | What "learning habit" means | **Preferred format**: visual / text / examples / summary. |
| 4 | How preferences are known | **Both**: users state a preference at onboarding (first release); the data model supports inferring format from quiz performance later. |
| 5 | First-release sources | **Websites, YouTube (via transcripts), PDF uploads.** All are normalized to text. GitHub and course platforms come later (course platforms are paywalled and their ToS forbid scraping, so support will be limited, e.g. user notes or syllabus metadata). |
| 6 | Visuals | **Structured diagrams** (AI writes Mermaid diagram code, rendered in the app). No AI-generated images in the first release. Later: also pull real figures/frames from sources. |
| 7 | Relevance matching | **Goal → AI-designed topic map** (revised 2026-10-10, see decision 11; was "editable topic map"). A goal is broken into subtopics; each source is mapped to the subtopics it covers, with a relevance score and reason; gaps are shown. |
| 8 | Quizzes | **Multiple choice with difficulty adaptation and decaying per-subtopic mastery** (spaced review) in the first release. AI-graded short answers added later. |
| 9 | Build constraints | Small team / solo, web app first, stack chosen by Claude. |
| 10 | Architecture | **Next.js web app + Python worker + Supabase** (Postgres, auth, storage, pgvector). |
| 11 | Who shapes the topic map (2026-10-10) | **The AI designs it; the user does not edit it.** Learners don't know a subject well enough to name, order, or nest its subtopics. The map is built from the goal and the user's level (beginner/intermediate/advanced) and shown as a visual mind map (goal → numbered main topics in learning order → child topics). The Phase 1 rename/move/nest/add/delete editor is removed. |
| 12 | Sign-up (2026-10-10, **pending details**) | **No forced sign-up for the demo.** A visitor can set a goal (and later add sources) as a guest; sign-up is asked only when they want more. Proposed: Supabase anonymous sessions upgraded to a real account on sign-up. Open: sign-up triggers, guest limits (proposed 1 goal / 3 sources / ~5 lessons + captcha + IP rate limit), inline onboarding, guest cleanup (proposed 30 days). |

## Assumptions (not explicitly confirmed; correct if wrong)

- Business model is **freemium**: free tier with usage limits, paid tiers above it. Hence caching and per-user generation caps.
- English only at launch.
- Each goal belongs to one user (no shared/team goals in the first release).

## Agreed architecture (approach 1)

- **Next.js**: UI and a thin API.
- **Supabase**: Postgres, auth, file storage, pgvector.
- **Python worker**: processes a job queue: ingest → chunk → map to subtopics → generate lessons → generate quiz questions. Chosen for Python's strong extraction tooling (article text, YouTube transcripts, PDF parsing) and to keep slow AI jobs off the web app.
- **AI models**: Claude Sonnet 5.5 for lesson and quiz generation; Haiku 4.5 for cheap tasks (relevance checks, chunk tagging).
- **Diagrams**: Mermaid, rendered in the browser.
- **Caching**: by source content + subtopic + format, so identical sources aren't reprocessed or regenerated across users.

Rejected alternatives:
- *All TypeScript*: one language, but weaker text and PDF extraction libraries.
- *Fully serverless/BaaS*: fastest start, but long AI jobs hit function timeouts.

## First-release success criteria

A user sets a goal, adds a few links or PDFs, sees what each source covers and what's missing, gets lessons in their preferred format with diagrams, and takes quizzes that show which subtopics to revisit.

## Design sections

| Section | Status |
|---------|--------|
| 1. Data model | Approved for first release |
| 2. Ingestion pipeline | Approved for first release |
| 3. Topic map and relevance | Approved for first release |
| 4. Lesson generation | Approved for first release |
| 5. Quizzes and mastery | Approved for first release |
| 6. Error handling, cost controls, testing | Approved for first release |

**Spec written:** [docs/superpowers/specs/2026-10-07-adaptive-learning-platform-design.md](../superpowers/specs/2026-10-07-adaptive-learning-platform-design.md). Approved by user on 2026-10-07.

### Section 1 draft: Data model

```
users            id, email, display_name, plan (free|pro), created_at
learning_prefs   user_id, preferred_format (visual|text|examples|summary),
                 level (beginner|intermediate|advanced), inferred_format (null until enough data)

goals            id, user_id, title, description, status (active|archived)
subtopics        id, goal_id, title, summary, parent_id (null = top level), position,
                 user_edited (bool)

sources          id, user_id, goal_id, type (web|youtube|pdf), url_or_file,
                 content_hash, title, status (queued|processing|ready|failed), error
source_chunks    id, source_id, text, position, embedding (pgvector),
                 timestamp_start (youtube) / page (pdf)
source_coverage  source_id, subtopic_id, relevance (0–1), reason

lessons          id, subtopic_id, format, content_hash_key, body (markdown),
                 diagrams (mermaid[]), source_chunk_ids[], model, created_at
quiz_questions   id, subtopic_id, difficulty (1–3), stem, options[], correct_index,
                 explanation, source_chunk_ids[]
quiz_attempts    id, user_id, question_id, chosen_index, correct, answered_at
mastery          user_id, subtopic_id, score (0–1), last_practiced_at, current_difficulty

usage_events     user_id, kind (ingest|lesson|quiz), tokens, cost_cents, at
```

Key points:
- Topic map is at most two levels deep.
- Every lesson and question records its `source_chunk_ids`, so content can be traced back to the article paragraph, video timestamp, or PDF page.
- Shared cache via `content_hash`: identical sources are extracted and chunked once across all users.
- Mastery decay is computed on read: `score × e^(−days_since / half_life)`.
- Editing the topic map marks subtopics `user_edited` and recomputes coverage only for affected sources.
- `usage_events` supports free-tier limits and per-user cost visibility.

### Section 2 (approved): Ingestion pipeline

`add source → dedupe → extract → clean → chunk + embed → map to subtopics → ready`, run by the Python worker from a job queue.

- **Dedupe:** normalized URL or PDF file hash; reuse existing chunks and embeddings across users.
- **Extract:** web via `trafilatura` (headless-browser fallback for JS-only pages); YouTube via `youtube-transcript-api` (manual captions preferred; no transcript = fail with a clear message, no speech-to-text in v1); PDF via `PyMuPDF` (scanned PDFs rejected in v1). All extractors return `{title, segments: [{text, location}]}`.
- **Clean:** strip boilerplate; light punctuation repair for transcripts.
- **Chunk + embed:** ~500–800 tokens, slight overlap, sentence-aligned, location kept; pgvector.
- **Map:** vector shortlist per subtopic, then Haiku confirms relevance and writes a one-line reason → `source_coverage`.
- **Limits:** free tier caps source length and daily source count; live status updates in the UI.
- **Failures:** 3 retries with backoff; permanent failures get an actionable message and don't consume quota.

### Section 3 (approved): Topic map and relevance

- **Creation:** Sonnet generates the map from goal text + user level, before sources: 5–12 top-level subtopics, at most 2 levels, each with a 1–2 sentence summary (also the matching definition), ordered basics-first. Vague goals get one clarifying question first.
- **Editing:** rename/add/delete/reorder/nest; marks `user_edited` (never overwritten); recomputes coverage against existing chunks only.
- **Suggestions:** unmatched source content prompts "add as subtopic?". The map is never changed automatically.
- **Per-source relevance:** Highly relevant / Partly relevant / Off-topic + one-line reason. Off-topic sources are kept but excluded from lessons.
- **Per-subtopic coverage:** Covered / Thin / Gap. Gaps show suggested search terms; no automatic web search in v1.
- **Goal page:** map with coverage badges and mastery bars, source list with relevance labels, "what to add next" area.

### Section 4 (approved): Lesson generation

- **When:** on demand, the first time a subtopic is opened; streamed to the UI.
- **Input:** subtopic title + summary, user format + level, top relevant chunks from non-off-topic sources (~8k token cap, spread across sources).
- **Output:** JSON sections `{markdown, mermaid?, citations: [chunk_ids]}`. Formats: Visual (2–4 diagrams, minimal prose), Text (headings + 1 diagram), Examples (worked examples/analogies + 1 diagram), Summary (~200 words + 1 overview diagram).
- **Faithfulness:** only source-supported content, every section cited, thin sources stated rather than filled in. Citations link to paragraph, timestamp, or page.
- **Diagram validation:** Mermaid CLI in the worker; one repair attempt, else dropped.
- **Format switcher:** generate once per format and cache; switches + post-lesson quiz results are the future format-inference signal.
- **Staleness:** new coverage marks lessons stale with a "Refresh lesson?" prompt; never silent regeneration.
- **Feedback:** thumbs up/down + "Report an error".

### Section 5 (approved): Quizzes and mastery

- **Bank:** generated lazily per subtopic, ~6 per difficulty (easy/medium/hard), 4 options, plausible distractors, cited explanation; more generated when a level runs out.
- **Quality check:** Haiku validates (one correct answer, answerable from source, no "all of the above", no giveaways); regenerate once, then drop.
- **Quiz types:** subtopic quiz (5 questions, after a lesson); review quiz (10 questions, lowest/due mastery).
- **Adaptation:** 2 correct in a row → up a level; 1 wrong → down; no repeats within 7 days; start level from user's stated level.
- **Mastery:** `score ← decayed + w × (result − decayed)`, `w` larger for harder questions. Per-subtopic half-life starts at 3 days, doubles per successful review, capped at 60. **Adds `half_life_days` to the `mastery` table (amends Section 1).**
- **Feedback:** Strong (≥0.8) / Developing / Weak (<0.5); wrong answers link to the lesson section and source location; "What to study next" = weak first, then due (decayed <0.6).
- **Disputes:** flagged questions leave the user's rotation, are logged, and don't count against mastery.

## Progress so far (end of session 2026-10-07)

- [x] Clarifying questions answered (decisions 1–10)
- [x] Architecture approach agreed (Next.js + Python worker + Supabase)
- [x] All 6 design sections presented and approved
- [x] Full spec written and approved by user
- [x] Implementation plan (Phase 1: foundation, goals, topic map)
- [x] Phase 1 implemented on branch `phase-1` (2026-10-10)
- [ ] Phase 2 (ingestion pipeline) plan

## Spec amendments (Phase 1)

- `goals` gains `map_status (pending|clarifying|ready|failed)`, `map_delayed bool`, `clarifying_question text`, `clarification_answer text`, `map_error text`.
- `users.id` is `auth.users.id`; a trigger creates the `public.users` row at sign-up.
- `subtopics.summary` is nullable: user-added subtopics may have no summary (Phase 2 matching falls back to the title).
- `usage_events.kind` gains `topic_map`. `jobs` gains `locked_at`, `created_at`.

## Implementation decisions (Phase 1)

- npm instead of pnpm, with the Supabase CLI as a root dev dependency (no global installs).
- Next.js 16 `proxy.ts` is used instead of `middleware.ts`.
- Pro tier is 25 active goals and up to 6 children per subtopic (placeholder values, tune later).
- The worker retry bound includes crash reclaims: a job that crashed the worker 4 times fails.
- Usage is recorded even when a job fails (`pending_writes`), and truncated calls are billed.
- An unknown serving model (server-side refusal fallback) is priced at the max known rate.
- Onboarding preselects Text + Beginner.
- The map editor uses buttons (rename, move, indent, outdent, delete), not drag-and-drop.
- The live Claude smoke test is pending an API key (manual steps in the README).

## Pending decisions when resuming (planned 2026-10-08)

1. **Implementation plan.** Resolved: Phase 1 plan written and executed (one plan per phase). The needed skills (`writing-plans`, `executing-plans`, `subagent-driven-development`, `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `systematic-debugging`, `requesting-code-review`, `finishing-a-development-branch`) were installed and reviewed.
2. **Git.** Resolved: the project is a git repository; work was done on branch `phase-1`.

## Next

Review and merge `phase-1`, then write the Phase 2 (ingestion pipeline) plan.
