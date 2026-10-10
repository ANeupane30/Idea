# Adaptive Learning Platform

Next.js web app + Python worker + Supabase (Postgres, Auth).

## Prerequisites

Docker Desktop (running), Node 22+, uv with Python 3.12+. No global installs: the Supabase CLI is a devDependency.

## Commands

```
npm install
npx supabase start     # local Supabase stack
npm run db:reset       # apply migrations
npm run test:db        # pgTAP tests (supabase/tests)
npm run test:worker    # worker pytest
npm run test:web       # web vitest
npm run test:e2e       # playwright
```

Design: `docs/superpowers/specs/2026-10-07-adaptive-learning-platform-design.md`.
