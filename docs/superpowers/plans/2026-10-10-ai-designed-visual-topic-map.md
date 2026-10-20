# AI-Designed Visual Topic Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The topic map is designed only by the AI, based on the goal and the user's level. Users can't edit it, and it is shown as a visual mind map instead of a list of edit buttons.

**Architecture:** The database removes every user write path on `subtopics` (only the worker writes). The web app drops the editor and renders the map as a left-to-right mind map built with plain HTML and Tailwind. CSS draws the connector lines, and no new dependencies are added. Selecting a topic opens a detail panel with its summary.

**Tech Stack:** Supabase migrations + pgTAP, Next.js 16.4 (App Router, `cacheComponents`), Tailwind, Vitest, Playwright.

**Spec:** [docs/superpowers/specs/2026-10-07-adaptive-learning-platform-design.md](../specs/2026-10-07-adaptive-learning-platform-design.md) §7 (revised 2026-10-10), and decision 11 in [the decision log](../../brainstorm/2026-10-07-adaptive-learning-platform-decisions.md).

## Global Constraints

- The map is AI-designed. No user action may create, rename, move, nest or delete a subtopic, and the database enforces this (not just the UI).
- The map is built from the goal and the user's level (`learning_prefs.level`). The worker already does this; the worker is not changed in this plan.
- Shape: goal → 5–12 main topics in learning order, numbered 1…N → 0–6 child topics each. At most 2 levels.
- No new npm dependencies. Use plain HTML and Tailwind, with CSS-drawn connectors.
- Readable in both the app's dark theme and light mode. Responsive: a left-to-right mind map at ≥768px, and a vertical tree below that. No horizontal page scroll at 375px.
- Accessible: the map is a `<nav aria-label="Topic map">` with nested `<ol>`. Every topic is a `<button>` in learning order. The detail panel closes with Esc and with a Close button, and focus returns to the topic.
- Everything else keeps working: the clarify, retry, archive, goal limit and onboarding flows.

## Review Focus

1. **A user still writing to subtopics** through the REST API (PostgREST) after the UI is gone. Expected: insert, update and delete as `authenticated` all fail with 42501. *Test: Task 1 pgTAP `subtopics_not_user_writable`.*
2. **Long titles (≤120 characters) and long summaries (≤300 characters) on small screens.** Expected: text wraps inside its node with no overflow or horizontal page scroll at 375px. *Test: Task 2 e2e `mobile layout has no horizontal scroll`.*
3. **A main topic with 0 children next to one with 6.** Expected: the connectors and alignment stay correct, with no dangling lines. *Test: Task 2 e2e `renders children beside their parent` (the fixture has both cases).*
4. **Archived goal.** Expected: its map is still viewable, read-only like every map. *Test: Task 2 e2e `archived goal shows map`.*

---

### Task 1: Make the map AI-only (database + remove the editor)

**Files:**
- Create: `supabase/migrations/20261010000001_ai_owned_topic_map.sql`
- Modify: `supabase/tests/topic_map_rpc_test.sql`, `supabase/tests/core_schema_test.sql` (subtopic setups that ran as `authenticated` now run as postgres)
- Delete: `web/app/goals/[id]/TopicMapEditor.tsx`, `web/app/goals/[id]/map-actions.ts`
- Modify: `web/app/goals/[id]/page.tsx` (render a temporary read-only nested list from `buildTree`; Task 2 replaces it), `web/lib/validation.ts` + `web/tests/unit/validation.test.ts` (remove `subtopicTitleSchema`, `subtopicSummarySchema`, and the `map_not_editable` / `max_depth_exceeded` mappings, which are unreachable now), `web/tests/e2e/topic-map.spec.ts` (remove the editor tests, keep the lifecycle tests), `web/tests/e2e/first-run.spec.ts` (drop the rename step; instead assert the map shows the fixture titles after reload)

**Interfaces:**
- Produces:
  - `authenticated` has only SELECT on `subtopics` (RLS owner-only, unchanged).
  - `move_subtopic` no longer exists.
  - `answer_clarification` and `retry_topic_map` are unchanged.
  - The depth and trim triggers still apply to worker writes.
  - The `user_edited` column stays (unused; leave it).

- [ ] **Step 1: Write the failing tests.**
  - pgTAP `subtopics_not_user_writable`: as `authenticated`, the owner of a ready, active goal gets 42501 from `insert`, `update … set title`, and `delete` on `subtopics`. They can still `select` their own subtopics.
  - `move_subtopic_removed`: `hasnt_function('public','move_subtopic', ARRAY['uuid','uuid','integer'])`.
  - Keep the worker-role depth tests: a postgres insert under a child still throws `max_depth_exceeded`.
  - Delete the pgTAP tests that exercised user edits (move, rename marking, insert/delete guards as `authenticated`).
- [ ] **Step 2: Run to verify fail.** `npm run db:reset; npm run test:db`. Expected: the new assertions FAIL.
- [ ] **Step 3: Write the migration.** `revoke insert, update, delete on public.subtopics from authenticated;` and `drop function public.move_subtopic(uuid, uuid, int);`. Then remove the editor files and update the web code and tests as listed above.
- [ ] **Step 4: Verify.** From the repo root, `npm run db:reset; npm run test:db; npm run test:worker; npm run test:web; npm run test:e2e`, plus `cd web; npm run lint; npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: topic map is AI-designed only; remove user editing`

---

### Task 2: Visual mind map

**Files:**
- Create: `web/app/goals/[id]/TopicMap.tsx` (client component), `web/tests/e2e/topic-map-visual.spec.ts`
- Modify: `web/app/goals/[id]/page.tsx` (fetch subtopics + `learning_prefs.level`; render `<TopicMap>` when the map is ready), `web/lib/topic-tree.ts` only if a pure helper is needed (with a unit test)

**Interfaces:**
- Consumes: `buildTree(rows): TreeNode[]` and `SubtopicRow` from `web/lib/topic-tree.ts`.
- Produces: `TopicMap({ goalTitle: string; level: "beginner" | "intermediate" | "advanced" | null; tree: TreeNode[] })`.

**Design (exact):**
- **Header:** above the map, a badge "Built for: Beginner" (or Intermediate / Advanced). Hide it when the level is null. One line of helper text: "Your learning path, designed for your level. Start at 1 and work down."
- **Desktop (≥768px), three columns left to right:**
  1. **Goal node:** a prominent rounded pill with the goal title, vertically centred against the main-topic column.
  2. **Main topics:** stacked vertically in order. Each is a rounded card with a circular number badge (1…N) and the title. Each branch has an accent colour, cycling a 6-colour Tailwind palette (for example indigo, emerald, amber, rose, sky, violet), used for the badge, a left border, and that branch's connector and child chips.
  3. **Children:** small chips in the third column, aligned to their parent's row and stacked if there are several. No placeholder when a topic has no children.
  - **Connectors:** 2px lines drawn with borders or pseudo-elements: goal → each main topic (a vertical trunk plus horizontal stubs), and main topic → each child (the same pattern). Muted colour, with the branch accent for child connectors.
- **Mobile (<768px):** a vertical tree. The goal sits on top, the numbered main topics go down a left trunk line, and children are indented under their parent with their own short connector. Every title wraps and nothing overflows.
- **Selection:** clicking a node (main topic or child) opens a detail panel. On desktop it's a right-side panel; on mobile, a bottom sheet. The panel shows:
  - the title;
  - "Topic n of N" for main topics, or "Part of: <parent title>" for children;
  - the summary (or "No summary yet." when it's null);
  - for main topics, the list of their children as buttons that switch the panel to that child.
  - The selected node gets a visible ring.
- **No edit controls anywhere:** no Rename, Move, Indent, Outdent, Add or Delete.
- Readable in light and dark themes. Respect `prefers-reduced-motion` for any transition.

- [ ] **Step 1: Write the failing e2e tests** in `topic-map-visual.spec.ts`. Each one starts from a "Learn SQL" goal made by the fake worker (see `worker/tests/fixtures/fake_llm/topic_map.json` for the titles):
  - `shows numbered main topics in learning order`: inside `nav[aria-label="Topic map"]`, the top-level buttons read `1 <title1>` … `6 <title6>` in fixture order.
  - `renders children beside their parent`: each fixture child is visible and nested in its parent's `li`.
  - `selecting a topic shows its summary`: clicking main topic 2 shows its fixture summary and "Topic 2 of 6". Clicking one of its listed children switches to "Part of: <topic 2 title>". Esc closes the panel and focus returns to the topic-2 button.
  - `no edit controls`: zero buttons named /Rename|Move up|Move down|Indent|Outdent|Add child|Add subtopic|Delete/.
  - `level badge`: a user who chose Advanced at onboarding sees "Built for: Advanced".
  - `mobile layout has no horizontal scroll`: at a 375×812 viewport, `document.documentElement.scrollWidth <= 375` and all titles are visible.
  - `archived goal shows map`: after archiving the goal, the map is still visible.
- [ ] **Step 2: Run to verify fail.** `cd web; npx playwright test tests/e2e/topic-map-visual.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `TopicMap.tsx`** and wire it into `page.tsx`.
- [ ] **Step 4: Verify.** Run the full suites as in Task 1, plus lint and tsc. Then capture Playwright screenshots of a ready "Learn SQL" map, saved to the path the controller gives you: desktop 1440×900 in dark scheme, desktop with a topic selected, and mobile 375×812.
- [ ] **Step 5: Commit** `feat(web): visual mind-map topic map with topic details`
