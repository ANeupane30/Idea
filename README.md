# Adaptive Learning Platform

A platform where people learn in the way that suits them. Users set a learning goal, get an AI-designed topic map shown as a visual mind map, and (in later phases) add sources such as websites, YouTube videos and PDFs, receive lessons in their preferred format, and take adaptive quizzes. Phase 1 (foundation, goals, topic map) is implemented: visitors start as guests with no sign-up (they type a goal, pick their level and get their map), sign-up keeps everything they did as a guest, goals have per-plan limits (guest 1, free 2), and the topic map is AI-designed and shown as a visual mind map. It is a Next.js web app plus a Python worker, backed by Supabase (Postgres, Auth).

## Prerequisites

- Docker Desktop, running
- Node 22+ and npm
- uv and Python 3.12+

No global Supabase CLI is needed: it is a dev dependency, run through `npx supabase`.

## Setup

```
npm install                  # repo root (installs the Supabase CLI)
cd web && npm install && cd ..
npx supabase start           # local Postgres + Auth; applies migrations
```

The local stack uses ports 44320-44329. They sit below Windows's dynamic port range (49152-65535), where Hyper-V reserves blocks of ports at boot; Supabase's default 543xx and our earlier 563xx were both taken that way. Guest sessions need anonymous sign-ins, which `supabase/config.toml` enables locally; a hosted project needs them enabled in its dashboard.

1. Copy `web/.env.local.example` to `web/.env.local` and fill in the values from `npx supabase status` (API URL and anon/publishable key).
2. Create `worker/.env` with:
   - `SUPABASE_SECRET_KEY=...` (the secret key from `npx supabase status`), so the worker can download uploaded PDFs; and either
   - `ANTHROPIC_API_KEY=...` for real topic maps and source matching, or
   - `LLM_PROVIDER=fake` to use the built-in fake LLM (no key, deterministic output).
3. Lessons stream from the worker's lesson server. Put the same random value in `LESSON_SERVER_TOKEN` in both `worker/.env` and `web/.env.local`, and set `LESSON_SERVER_URL=http://127.0.0.1:8787` in `web/.env.local`.
4. Install the worker's headless browser (used for web pages that need JavaScript): `cd worker && uv run playwright install chromium`.

Embeddings come from a local model (`BAAI/bge-small-en-v1.5` via fastembed, about 130 MB, downloaded on first use). No API key is needed. `EMBEDDER=fake` switches to a deterministic test embedder.

## Running

```
cd web; npm run dev                  # web app on http://localhost:3000
cd worker; uv run python -m worker   # job worker (polls the jobs table)
cd worker; uv run python -m worker.lesson_server   # lesson server on http://127.0.0.1:8787
```

(In Git Bash use `&&` or separate lines instead of `;`.)

## Tests

Run from the repo root. `db:reset` wipes the local database.

```
npm run db:reset     # apply migrations to a clean local DB
npm run test:db      # pgTAP tests (supabase/tests)
npm run test:worker  # worker pytest
npm run test:web     # web Vitest unit tests
npm run test:e2e     # Playwright; starts the web server, a fixture site, a fake-LLM worker and a lesson server itself
```

> **Warning: stop any worker or lesson server you started yourself before running `npm run test:e2e`.** The e2e run starts its own fake-LLM worker against the same local database. A separately running worker with a real `ANTHROPIC_API_KEY` would also pick up the e2e jobs, call Claude, and spend real money (and make the tests flaky).

## Live Claude smoke test (not yet run)

All automated tests use the fake LLM. The real Claude path has not been exercised because no API key was available. To check it manually:

1. Put `ANTHROPIC_API_KEY=...` in `worker/.env` (and make sure `LLM_PROVIDER` is not set to `fake`).
2. Start Supabase, the web app and the worker (see above), open http://localhost:3000 (you start as a guest).
3. Enter the goal "Learn the basics of personal finance" and click "Build my learning map".
4. Wait for the worker to process the job.
5. Expected: the goal's map becomes ready with 5-12 top-level subtopics, each with a short summary, ordered basics-first.
