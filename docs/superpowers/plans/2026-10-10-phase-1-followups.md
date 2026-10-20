# Phase 1 Follow-ups

Items the per-task reviews and the final whole-branch review found and left for later. None of them blocks merging `phase-1`. The final reviewer triaged each one. The list is ordered by when it should be done.

## Before Phase 2 builds on it

- **Run the live Claude smoke test once** (see README). The real `beta.messages.parse` and fallbacks call shape has only been checked against the installed SDK, never live.
- **Add an e2e test for the failed, delayed and retry states** using a FakeLLM failure fixture. These are the main UI paths with no test.
- **Bill refused calls.** A `PermanentJobError` from a refusal carries no usage, so spend is under-counted. Fix this before building spend alerts.
- **Count cache tokens in usage** (`cache_creation_input_tokens`, `cache_read_input_tokens`) as soon as prompt caching is added.
- **Decide who may write `learning_prefs.inferred_format`** (currently the user) before format inference ships.
- **Make the goal-limit message plan-aware.** It says "Free plan allows 2 active goals" even to Pro users.
- **Spec vs plan:** the spec says Claude outages leave jobs queued and show "Processing is delayed". Phase 1 fails the job after 4 attempts. Also show "delayed" when a goal has been pending for more than ~60s, which covers a worker that is down or a stuck job.

## Before production

- Deployment docs:
  - deploying migrations (`supabase db push`);
  - a non-superuser `DATABASE_URL` for the worker;
  - process supervision and SIGTERM handling.
- Set the Supabase auth `minimum_password_length` to 8, to match the UI.
- **Guests:** enable anonymous sign-ins and the per-IP anonymous sign-in rate limit on the hosted Supabase project (the local config only covers local). Add a captcha and clean up guests after 30 days (decision 12).
- Replace the scaffold metadata ("Create Next App").
- `npm audit`: the 5 "high" findings are one dev-only `braces` chain under `eslint-config-next`. `--omit=dev` reports 0. Don't apply the suggested downgrade.

## Polish and hardening (any time)

- **Database:**
  - Qualify `subtopics.goal_id` in the RLS policy.
  - Use `(select auth.uid())` in policies.
  - Trim tabs and newlines in titles, not just spaces.
  - Take `FOR SHARE` on the parent lookup in the depth guard.
  - Add pgTAP tests for cross-user update/delete and for rejecting `map_status` on insert.
- **Worker:**
  - The `serve()` log message is misleading when connect raises a non-`OperationalError`.
  - Treat Anthropic 409/422 as permanent errors.
  - Truncate model titles echoed in the repair prompt.
  - Tidy the test fixtures.
- **Web:**
  - Delete dialog: Esc to close, focus trap, return focus, autofocus Cancel instead of Confirm, and show the error inside the dialog.
  - `MapStatus`: avoid overlapping refreshes, add try/catch around actions, clear stale errors, and auto-refresh on "already moved on".
  - Fix the NEXT_REDIRECT log noise from the Suspense gate in `goals/layout.tsx`, perhaps by moving the prefs check into `proxy.ts`. This is related to the full-page navigation workaround in `savePreferences`.
  - `setGoalStatus` reports success on a 0-row update.
  - Duplicate React import in `goals-ui.tsx`. `busy` state needs try/finally.
  - Signed-in users can still reach `/sign-in`.
  - The README run commands are written in PowerShell style.

## From the AI-designed visual map work

- **Mobile sheet:** trap focus inside the topic bottom sheet, lock page scroll while it is open, and pad it for the safe area (`env(safe-area-inset-bottom)`).
- **Desktop row gaps:** rows with children are taller than rows without, so the gaps between main topics are uneven on desktop.
- **Cascade test:** when anything starts deleting subtopics again, re-add the parent→children cascade test, run as `postgres`.
- **Stale test label:** the `subtopic_parent_same_goal` pgTAP test expects the `max_depth_exceeded` error, so its label no longer describes what it checks.
- **Dead guard branches:** users can no longer write subtopics, so the `if current_user = 'authenticated'` branches in the trigger functions in `20261008000002_topic_map_rpc.sql` are dead code. Remove them in a future migration.
- **Long-text layout test:** add an e2e layout test with a 120-character title and a 300-character summary (the worker's maximums) at mobile, 1024 and desktop widths.

## From Phase 2 (ingestion)

- **Before production:**
  - Run the live Claude smoke test for the Haiku mapping and punctuation calls too (all tests use the fake LLM).
  - Run headless rendering in a separate container with no secrets and with egress rules, ideally through an egress proxy that applies the host check to every connection. This also closes DNS rebinding, which the URL fetcher doesn't pin.
  - A cleanup job for uploaded PDFs that no source references (closed tabs, crashes).
  - YouTube may block transcript requests from cloud IPs; check from the deploy region.
- **Tuning:** `shortlist_min` (0.50) and the relevance thresholds (0.70 / 0.40) need the eval set. Consider `claude-haiku-5-5` for mapping and punctuation (about 10x cheaper than Haiku 4.5); it takes effort but has no server-side fallback.
- **Product:** removing sources (count removals against quota so add/remove can't bypass it); "Add X to the map" suggestions.
- **Deferred minors from the final review:**
  - An unknown page charset makes the fetch retry instead of falling back to utf-8.
  - Chunks can fall below 500 tokens when the next sentence would pass 800.
  - An off-topic source with no shortlisted subtopic has no reason line.
  - `PlaywrightRenderer.aborted` grows for the worker's lifetime.
  - `addPdfSource` doesn't schema-validate `fileName` and `goalId`.
  - The PDF child process has a time limit but no memory limit.
  - `test_archived_goal_skips_write` is misnamed: it fails the source; it doesn't archive the goal.
