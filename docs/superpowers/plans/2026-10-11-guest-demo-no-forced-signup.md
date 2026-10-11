# Guest Demo (No Forced Sign-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor who opens the site starts learning immediately, with no login or sign-up screen. They type a goal, pick how much they already know, and see their AI-designed map. Sign-up is offered only when they want more, and signing up keeps everything they did as a guest.

**Architecture:** Supabase anonymous sign-ins. The proxy silently creates a guest session for any visitor without one. A guest is a normal `authenticated` user with `is_anonymous = true`, so every existing RLS rule applies unchanged. Signing up converts the same user (`updateUser({ email, password })`), so goals and maps carry over. Guests get a stricter goal limit of 1, enforced in the database.

**Tech Stack:** Supabase Auth (anonymous sign-ins) + Postgres triggers + pgTAP, Next.js 16.4 proxy + server actions, Playwright.

**Spec:** [docs/superpowers/specs/2026-10-07-adaptive-learning-platform-design.md](../specs/2026-10-07-adaptive-learning-platform-design.md), plus decision 12 in [the decision log](../../brainstorm/2026-10-07-adaptive-learning-platform-decisions.md) (defaults applied on 2026-10-11).

## Global Constraints

- **No forced sign-up.** Opening any app page without a session creates a guest session. A visitor never sees `/sign-in` or `/sign-up` unless they click to get there.
- **Guest limit: 1 active goal.** The database raises `guest_goal_limit_reached`, and the UI shows "Sign up free to save your progress and add more goals." with a link to `/sign-up`. Signed-up free users keep 2 active goals and Pro keeps 25 (unchanged).
- **Signing up converts the guest's own account.** The user id stays the same, so their goal and map are still there afterwards.
- **First screen copy:**
  - Heading: "What do you want to learn?"
  - Goal field: label "Your goal", placeholder "e.g. Learn the basics of personal finance".
  - Level question: "How much do you already know about it?", with the options "I'm new to it" (beginner), "I know the basics" (intermediate) and "I'm experienced" (advanced). "I'm new to it" is selected by default.
  - Button: "Build my learning map".
  - The format question is not asked here (lessons don't exist yet). Store `preferred_format = 'text'` as a placeholder.
- **Header:**
  - Guests: a "Save your progress" button linking to `/sign-up`, and a "Sign in" link.
  - Signed-up users: "Sign out".
- **Abuse protection:** Supabase's built-in per-IP anonymous sign-in rate limit (`anonymous_users = 30` per hour, already in config.toml). A captcha and guest cleanup are follow-ups, not part of this plan.
- Everything else keeps working: the map lifecycle, clarify, retry, archive, the paid limits and the worker.

## Review Focus

1. **A crawler or prefetch hitting the site creates many guests.** Expected: one guest per browser, because the session cookie is set on the first response. Static assets never create sessions. *Test: Task 2 e2e `one guest session per browser`: two page loads give the same user id.*
2. **A guest signs in to an existing account.** Expected: they end up in that account and the guest's goal is not merged in. The sign-in page warns "Signing in to another account won't keep your guest goal." only when the guest has a goal. *Test: Task 2 e2e `sign in from guest`.*
3. **Sign-up with an email that is already registered.** Expected: the existing friendly message, and the guest data stays intact. *Test: Task 2 e2e `guest signup duplicate email`.*
4. **Sign out.** Expected: a fresh guest session on the start page, where the previous account's goals are not visible. *Test: Task 2 e2e `sign out returns to a fresh guest`.*

---

### Task 1: Database and auth config for guests

**Files:**
- Modify: `supabase/config.toml` (`enable_anonymous_sign_ins = true`)
- Create: `supabase/migrations/20261011000002_guest_users.sql`, `supabase/tests/guest_users_test.sql`

**Interfaces:**
- Produces:
  - `enforce_goal_limit` raises `guest_goal_limit_reached` when an anonymous user (`auth.users.is_anonymous`) would get a second active goal. Non-anonymous users are unchanged.
  - A trigger syncs `public.users.email` when `auth.users.email` changes, which happens on guest conversion.

- [ ] **Step 1: Write the failing pgTAP tests.** Each one inserts into `auth.users` with `is_anonymous = true` and a null email:
  - `guest_row_created`: the `public.users` row exists with `plan = 'free'`.
  - `guest_one_goal`: the 1st active goal succeeds, and the 2nd throws `P0001` with `guest_goal_limit_reached`.
  - `converted_guest_gets_free_limit`: after `update auth.users set is_anonymous = false, email = 'x@example.com'`, a 2nd goal succeeds and a 3rd throws `goal_limit_reached`. The `public.users.email` becomes `'x@example.com'`.
  - `guest_unarchive_limit`: a guest with one archived goal and one active goal can't unarchive (`guest_goal_limit_reached`).
- [ ] **Step 2: Run to verify fail.** `npx supabase test db`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write the migration (replace `enforce_goal_limit` with `create or replace`, add the email sync trigger as `security definer` with `set search_path = public`) and the config change. Restart the local stack so the config takes effect: `npx supabase stop` then `npx supabase start`. This keeps the data; never run `db reset`. Then `npx supabase migration up`.
- [ ] **Step 4: Verify.** `npm run test:db` passes, and `npm run test:worker` still passes.
- [ ] **Step 5: Commit** `feat(db): guest users with a one-goal limit and email sync on conversion`

---

### Task 2: Guest-first web flow

**Files:**
- Modify:
  - `web/lib/supabase/middleware.ts`: with no user on a non-static path, call `supabase.auth.signInAnonymously()` and continue, carrying its cookies on the response. Remove the redirect to `/sign-in`. `/sign-in` and `/sign-up` stay reachable.
  - `web/app/page.tsx`: the start page. If the user already has any goal, redirect to `/goals`; otherwise render the start form.
  - `web/app/goals/layout.tsx`: the Gate redirects to `/` (not `/onboarding`) when there are no prefs, and the header follows the Header constraint.
  - `web/app/(auth)/actions.ts`: `signUp` converts the current anonymous user via `updateUser({ email, password })` and redirects to `/goals`. It falls back to `signUp()` if there is no current user. `signIn` is unchanged. `signOut` redirects to `/`.
  - `web/app/(auth)/sign-in/page.tsx`: the warning from Review Focus 2.
  - `web/lib/validation.ts`: map `guest_goal_limit_reached`.
  - The e2e helpers and specs that assumed a forced sign-in or an `/onboarding` redirect.
- Create: `web/app/start-actions.ts` (`startLearning(formData): Promise<ActionResult>`, which upserts prefs and inserts the goal, then redirects to `/goals/[id]`), `web/tests/e2e/guest.spec.ts`
- Keep `/onboarding` reachable as the preferences page. Nothing redirects to it anymore.

**Interfaces:**
- Consumes: Task 1's `guest_goal_limit_reached`, `ActionResult`, `dbErrorToMessage`, `goalSchema`.
- Produces: the `startLearning` action and guest-aware `signUp` / `signOut`.

- [ ] **Step 1: Write the failing e2e tests** in `guest.spec.ts`:
  - `visitor lands on start page`: a fresh context visiting `/` sees "What do you want to learn?". It never reaches `/sign-in`, and the URL stays `/`.
  - `guest builds a map`: fill in the goal "Learn SQL", keep "I'm new to it", click "Build my learning map". The map shows the fixture topics and "Built for: Beginner".
  - `guest second goal prompts signup`: on `/goals`, creating a 2nd goal shows the guest limit message with a link to `/sign-up`.
  - `guest signup keeps the map`: click "Save your progress", fill in the email and password. The user lands on `/goals`, the "Learn SQL" goal is still there, and the header shows "Sign out". A 2nd goal can now be created.
  - `one guest session per browser`: the user id (shown in a `data-user-id` attribute on the header, or read through a test-only route; choose the simplest) is the same across two page loads.
  - `sign in from guest` (Review Focus 2), `guest signup duplicate email` (3), `sign out returns to a fresh guest` (4).
  - Update the existing specs: any test asserting "unauthenticated → /sign-in" becomes "unauthenticated → start page". `signUpFresh` keeps working, because it converts the guest.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** the full suites (`test:db`, `test:worker`, `test:web`, `test:e2e`), lint and tsc. Then take a screenshot of the start page (1440×900 dark and 375×812) to the path the controller gives you, and look at it.
- [ ] **Step 5: Commit** `feat(web): guest-first demo; sign-up only when users want more`
