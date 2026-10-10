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
- Replace the scaffold metadata ("Create Next App").
- `npm audit`: the 5 "high" findings are one dev-only `braces` chain under `eslint-config-next`. `--omit=dev` reports 0. Don't apply the suggested downgrade.

## Polish and hardening (any time)

- **Database:**
  - Qualify `subtopics.goal_id` in the RLS policy.
  - Use `(select auth.uid())` in policies.
  - Trim tabs and newlines in titles, not just spaces.
  - Take `FOR SHARE` on the parent lookup in the depth guard.
  - Raise `subtopic_not_found` in `move_subtopic` when the row disappears.
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
  - Rename needs blur handling and double-Enter protection.
  - The README run commands are written in PowerShell style.
