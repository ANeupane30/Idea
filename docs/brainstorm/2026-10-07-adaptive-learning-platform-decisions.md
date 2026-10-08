# Adaptive Learning Platform — Brainstorm Decision Log

**Started:** 2026-10-07
**Status:** Brainstorming in progress. Architecture approach agreed; detailed design sections being reviewed one at a time. This is a decision log, not the final spec.

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
| 7 | Relevance matching | **Goal → editable topic map.** A goal is broken into subtopics; each source is mapped to the subtopics it covers, with a relevance score and reason; gaps are shown. |
| 8 | Quizzes | **Multiple choice with difficulty adaptation and decaying per-subtopic mastery** (spaced review) in the first release. AI-graded short answers added later. |
| 9 | Build constraints | Small team / solo, web app first, stack chosen by Claude. |
| 10 | Architecture | **Next.js web app + Python worker + Supabase** (Postgres, auth, storage, pgvector). |

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

**Spec written:** [docs/superpowers/specs/2026-10-07-adaptive-learning-platform-design.md](../superpowers/specs/2026-10-07-adaptive-learning-platform-design.md). Approved by user on 2026-10-07. Next: implementation plan.

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
- [ ] Implementation plan (next)
- [ ] Execution of plan

## Pending decisions when resuming (planned 2026-10-08)

1. **Implementation plan.** Resolved: user installed `writing-plans` and `executing-plans` (from `obra/superpowers`). Proposed: one plan per phase, starting with setup + auth, goals, topic map; awaiting user confirmation. `subagent-driven-development` also installed (scripts reviewed: benign). Then installed and reviewed (user gave blanket permission): `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `systematic-debugging`, `requesting-code-review`, `finishing-a-development-branch`. All skills needed for planning and execution are now present (project-scoped, Claude Code only).
2. **Git.** `Desktop\ideas` is **not a git repository**, so nothing is committed yet. Decide whether to `git init` and commit the spec and this log.

Implementation must not start until the plan is written, reviewed, and an execution method is chosen.
