# Branches, CI and deployment

## Branch flow

```
feature/* ──PR──▶ dev ──PR (opened by CI)──▶ staging ──PR──▶ main
                   │                          │                │
             CI on every PR             deploys staging   deploys production
             and push                   (QA happens here)  (after your approval)
```

- **feature/\*:** work branches. Each merges into `dev` with a pull request.
  - The first release merges them in this order, because each builds on the one before: `feature/foundation` → `feature/sources` → `feature/lessons` → `feature/quizzes` → `feature/material-redesign`.
- **dev:** integration.
  - Every pull request into it runs the full checks (workflow `CI`).
  - When CI passes on `dev`, the `Promote dev to staging` workflow opens or updates the pull request from `dev` to `staging`.
- **staging:** merging that pull request deploys the staging environment for user testing and QA. Record the results in [qa/qa-report-template.md](qa/qa-report-template.md).
- **main:** production. You open a pull request from `staging` to `main`. Merging it starts the production deploy, which waits until you approve it.

## What CI checks (`.github/workflows/ci.yml`)

| Job | Checks |
|---|---|
| Web | `tsc --noEmit`, `eslint`, `vitest` |
| Database, worker and browser tests | starts a local Supabase stack, then `supabase test db` (pgTAP), worker `pytest`, then Playwright end to end with the fake LLM |

It runs on pull requests into `dev`, `staging` and `main`, and on pushes to `dev`.

## Deploys (`.github/workflows/deploy.yml`)

A push to `staging` deploys the **staging** environment; a push to `main` deploys **production**. Steps, in order:

1. **Database:** `supabase db push` to that environment's Supabase project.
2. **Worker and lesson server:** `flyctl deploy` of `deploy/worker.Dockerfile` to that environment's Fly.io app. Two process groups: `worker` (jobs) and `lesson` (HTTP, port 8787).
3. **Web app:** `vercel build` and `vercel deploy --prod` to that environment's Vercel project.

A step whose secrets aren't set prints a notice and is skipped. Once everything below is set up, every step runs.

## One-time setup

### 1. Supabase (two projects: staging and production)

For each project:
- Note the **project ref**, the **database password**, the **API URL**, the **publishable (anon) key** and the **secret (service role) key**.
- **Authentication:**
  - Minimum password length: 8.
  - Enable anonymous sign-ins.
  - Set the per-IP anonymous sign-in rate limit.
  - Turn on captcha (Turnstile or hCaptcha) before production.
- **Storage:** CI's `supabase db push` creates the `sources` bucket and its policies; nothing to do by hand.
- **Database URL for the worker:** use a dedicated non-superuser role (see the follow-ups doc), with the session pooler connection string.

You also need a Supabase **access token** (Account → Access tokens) for CI.

### 2. Fly.io (two apps: e.g. `learning-worker-staging`, `learning-worker-prod`)

Create each app with `fly apps create <name>`, then set its secrets once:

```
fly secrets set --app <name> \
  DATABASE_URL=... \
  ANTHROPIC_API_KEY=... \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_SECRET_KEY=... \
  LESSON_SERVER_TOKEN=<random, 32+ chars> \
  FETCH_USER_AGENT="LearningPlatform/1.0 (+https://<your-site>)"
```

Create a deploy token with `fly tokens create deploy --app <name>`.

The lesson server is then at `https://<name>.fly.dev`.

### 3. Vercel (two projects: e.g. `learning-staging`, `learning`)

Import the repo for each project. Leave **Root Directory** blank, because CI deploys from `web/`. Turn off Vercel's own Git deployments (Settings → Git → Ignored Build Step: `exit 0`), since GitHub Actions deploys.

Environment variables (Production scope) in each project:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the Supabase API URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable key |
| `LESSON_SERVER_URL` | `https://<fly app>.fly.dev` |
| `LESSON_SERVER_TOKEN` | the same value as the Fly secret |

Create a Vercel **token** (Account → Tokens). Note the **Org ID** and each **Project ID** (Settings → General).

### 4. GitHub (repository Settings)

**Environments:** create `staging` and `production`.
- `production`: add yourself under **Required reviewers**, and limit deployment branches to `main`.
- `staging`: limit deployment branches to `staging`.

Per environment:

| Kind | Name | Value |
|---|---|---|
| Secret | `SUPABASE_ACCESS_TOKEN` | Supabase access token |
| Secret | `SUPABASE_DB_PASSWORD` | that project's DB password |
| Variable | `SUPABASE_PROJECT_REF` | that project's ref |
| Secret | `FLY_API_TOKEN` | that app's deploy token |
| Variable | `FLY_APP` | that Fly app's name |
| Secret | `VERCEL_TOKEN` | Vercel token |
| Variable | `VERCEL_ORG_ID` | Vercel org ID |
| Variable | `VERCEL_PROJECT_ID` | that Vercel project's ID |

**Actions:** Settings → Actions → General → Workflow permissions: allow GitHub Actions to create pull requests. The promotion workflow needs this.

Optional repository secret `PROMOTION_TOKEN`: a fine-grained personal access token with pull-requests write. With it, the promotion pull request is opened as you rather than as `github-actions`.

**Branch rules** (Settings → Rules → Rulesets), for `dev`, `staging` and `main`:
- Require a pull request.
- Require the status checks `Web (typecheck, lint, unit)` and `Database, worker and browser tests`.
- Block force pushes and deletion.

GitHub doesn't let you approve your own pull request, so for `main` the approval is the `production` environment's required reviewer: the deploy waits for you.
