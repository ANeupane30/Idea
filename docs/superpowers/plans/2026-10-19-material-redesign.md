# Material Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every existing screen of the web app to the "Learning app prototype" design (Material 3, kept minimal), without adding backend features.

**Architecture:**
- **Tokens:** the design's colour roles become Tailwind v4 theme tokens in `globals.css`, with light and dark values swapped under `prefers-color-scheme`. Components use role classes (`bg-primary`, `text-on-surface-variant`), never raw zinc or indigo, and drop their `dark:` variants.
- **Shared pieces:** an `Icon` component (inline Material Symbols Rounded SVGs, generated once from the npm package), status chips, buttons and the mastery meter live in `components/ui/`.
- **Pages:** each page is rebuilt on those pieces. Behaviour, server actions and RPCs stay as they are.

**Tech Stack:** Next.js 16.4, React 19.3, Tailwind v4, `next/font/google` (Roboto Flex), `@material-symbols/svg-400@0.47.5` (dev dependency, read by a generator script), Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/Learning app prototype.pdf`, 11 pages:
1. Foundations
2. Start
3. Map (light)
4. Add a source
5. Format chooser
6. Library
7. Lesson (Summary)
8. Quiz answer
9. Quiz results
10. Map (dark)
11. Lesson (Visual, dark)

**Decisions from the user (2026-10-19):** follow the design's layout, including Sources on the right and adding a source in a dialog; restyle the existing screens now and build Library and the cross-goal Review later; use Roboto Flex and Material Symbols Rounded.

## Global Constraints

- **Colour roles (light):**
  - Primary `#3F5F90`, on-primary `#FFFFFF`.
  - Primary container `#D6E3FF`, text `#264777`.
  - Secondary container `#D9E3F9`, text `#3E4758`.
  - Surface `#F9F9FF`.
  - Surface containers: low `#F3F3FA`, base `#EDEDF4`, high `#E7E8EE`, highest `#E2E2E9`.
  - On-surface `#191C20`, on-surface variant `#43474E`.
  - Outline `#74777F` (controls), outline variant `#C4C6CF` (dividers).
- **Status (light):**
  - Positive: bg `#D7F0DD`, text `#00522A`.
  - Partial: bg `#FFEEDB`, text `#624000`.
  - Missing or wrong: bg `#FFDAD6`, text `#93000A`.
- **Dark values:**
  - Primary `#A9C7FF`, on-primary `#0B305F`.
  - Primary container `#284777`, text `#D6E3FF`.
  - Secondary container `#3E4759`, text `#D9E3F9`.
  - Surface `#111318`; containers low `#191C20`, base `#1D2024`, high `#282A2F`, highest `#33353A`.
  - On-surface `#E2E2E9`, variant `#C4C6CF`; outline `#8E9099`, outline variant `#43474E`.
  - Positive: bg `#0F5223`, text `#A6F2B5`. Partial: bg `#5C4300`, text `#FFDDB0`. Wrong: bg `#93000A`, text `#FFDAD6`.
- **Type scale (Roboto Flex):**

  | Style | Size / line height | Weight |
  |---|---|---|
  | Display small | 36/44 | |
  | Headline medium | 28/36 | |
  | Headline small | 24/32 | |
  | Title large | 22/28 | |
  | Title medium | 16/24 | 500 |
  | Body large | 16/24 | |
  | Body medium | 14/20 | |
  | Label large | 14/20 | 500 |
  | Label medium | 12/16 | 500 |

- **Buttons:** 48px targets, fully rounded. One filled button per screen. Focus is a 3px ring with a 2px gap.
- **Cards:** 12–16px radius, tonal, no shadows. Lesson reading columns hold 60–75 characters.
- **Colour use:** colour marks primary actions, selection and status only. Every status carries an icon and a word, never colour alone.
- **Status words:**
  - Coverage: Covered, Thin, Gap.
  - Relevance: Highly relevant, Partly relevant, Off-topic.
  - Mastery: Strong, Developing, Weak.
  - Answers: Correct, Not quite.
- **Icons:** Material Symbols Rounded, always `aria-hidden`. Accessible names come from text or `aria-label`.
- **Name:** the design's "[App name]" placeholder becomes `APP_NAME = "Learning Map"` in `web/lib/brand.ts`, also used for `metadata.title`.
- **Scope:** no new backend. Library and the cross-goal Review rail page, source removal and "matched to <topic>" text are out of scope (noted in the follow-ups).
- **Browser storage:** only for per-viewer conveniences (the dismissed guest card), and every access is wrapped in try/catch.
- **Pages:** no horizontal page scroll at 375px, and a 16px side gutter on phones.

## Review Focus

- **Long titles:** goal, topic and source titles of 120 characters must wrap (`[overflow-wrap:anywhere]`) in rail pages, map cards, the detail card, the dialog and the lesson top bar, never overflow. Pinned by `workspace.spec.ts` "long titles wrap" (Task 5).
- **Native `<dialog>` and focus:** opening Add source or the format chooser must move focus into the dialog, Esc must close it (except the format chooser's first run, where Esc goes back to the map), and focus must return to the opener. Pinned by `add-source.spec.ts` "focus returns to the opener" (Task 5) and `lessons.spec.ts` "format chooser closes back to the map" (Task 7).
- **Archived goals:** no FAB, no "Add source" in the detail card and no dialog, but the sources list stays readable. Pinned by `workspace.spec.ts` "archived goal has no add controls" (Task 5).
- **Dark mode:** every surface must use tokens, with no white cards on the dark surface. Pinned by `foundations.spec.ts` "dark tokens apply", which checks the computed body background and a card background under `colorScheme: "dark"` (Task 1), plus the Task 9 screenshots.
- **Icon ligature text must not leak into names:** icons are inline SVG, so accessible names and `toHaveText` stay clean. Pinned by `icon.test.tsx` "has no text content and is hidden" (Task 1).

---

### Task 1: Foundations: tokens, font, icons, primitives

**Files:**
- Create: `web/scripts/gen-icons.mjs`, `web/components/ui/icons.generated.ts`, `web/components/ui/icon.tsx`, `web/components/ui/chips.tsx`, `web/components/ui/buttons.ts`, `web/components/ui/mastery-meter.tsx`, `web/lib/brand.ts`
- Modify: `web/app/globals.css`, `web/app/layout.tsx`, `web/package.json`
- Test: `web/tests/unit/ui.test.tsx`, `web/tests/e2e/foundations.spec.ts`

**Interfaces:**
- Produces:
  - `Icon({ name: IconName; filled?: boolean; size?: 16 | 18 | 20 | 24; className?: string })`: an inline `<svg aria-hidden focusable="false">` using `fill="currentColor"`.
  - `type IconName`: a union of the generated names.
  - `StatusChip({ kind: "coverage" | "relevance" | "mastery" | "answer"; value: string })`:
    - coverage: `CoverageState`; relevance: `RelevanceLabel`; mastery: `MasteryLabel`; answer: `"correct" | "wrong"`.
    - Renders a `<span>` with an icon and the word: Covered/check_circle, Thin/contrast, Gap/radio_button_unchecked, Highly relevant/check_circle, Partly relevant/contrast, Off-topic/block, Strong/signal_cellular_alt, Developing/signal_cellular_alt_2_bar, Weak/signal_cellular_alt_1_bar, Correct/check, Not quite/close.
  - `FilterChip` (a label wrapping a sr-only radio or checkbox; check icon when checked).
  - `button(variant: "filled" | "tonal" | "outlined" | "text" | "fab", extra?: string): string`: the class strings, 48px min height (FAB 56px), `rounded-full`, with the focus ring `focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary`.
  - `MasteryMeter({ decayed: number; label: MasteryLabel; showLabel?: boolean })`:
    - The wrapper is `role="img"` with `aria-label="Mastery: <Word>"`.
    - Inside: a 4px track (outline-variant) with a primary fill at `max(4, round(decayed*100))%`, then the signal icon and word.
  - `APP_NAME`.
  - Tailwind colour tokens: `primary`, `on-primary`, `primary-container`, `on-primary-container`, `secondary-container`, `on-secondary-container`, `surface`, `surface-container-low`, `surface-container`, `surface-container-high`, `surface-container-highest`, `on-surface`, `on-surface-variant`, `outline`, `outline-variant`, `positive`, `on-positive`, `partial`, `on-partial`, `negative`, `on-negative`.
  - Text utilities `text-display-s`, `text-headline-m`, `text-headline-s`, `text-title-l`, `text-title-m`, `text-body-l`, `text-body-m`, `text-label-l`, `text-label-m`, defined as `@utility` with size, line height and weight from the type scale.

- [ ] **Step 1: Install the icon source.** Run `npm install --save-dev --save-exact @material-symbols/svg-400@0.47.5`. Expected: the package is added; `node_modules/@material-symbols/svg-400/rounded/flag.svg` exists.
- [ ] **Step 2: Write `scripts/gen-icons.mjs`.**
  - It reads `rounded/<name>.svg` and `rounded/<name>-fill.svg` for a fixed `NAMES` list and writes `components/ui/icons.generated.ts`.
  - Output: `export const ICONS = { name: { d: "...", fill: "..." } } as const` (the path `d` and the 960 viewBox `0 -960 960 960`), plus a do-not-edit header.
  - NAMES: account_tree, add, arrow_back, arrow_forward, article, block, check, check_circle, close, cloud_upload, contrast, error, event_repeat, flag, info, lightbulb, link, local_library, menu_book, notes, open_in_new, picture_as_pdf, progress_activity, quiz, radio_button_unchecked, school, schema, search, signal_cellular_alt, signal_cellular_alt_1_bar, signal_cellular_alt_2_bar, smart_display, swap_horiz, thumb_down, thumb_up, update, upload_file, format_list_bulleted, logout, login.
  - Add `"icons": "node scripts/gen-icons.mjs"` to the package.json scripts, run it, and commit the generated file.
- [ ] **Step 3: Write the failing unit tests in `tests/unit/ui.test.tsx`.**
  - `icon has no text content and is hidden`: `render(<Icon name="flag" />)`; the svg has `aria-hidden="true"` and `textContent === ""`.
  - `status chip says the word`: for each kind/value, `getByText(word)` exists and the chip's accessible text is exactly the word (e.g. coverage gap gives "Gap").
  - `mastery meter is an image named by its label`: `getByRole("img", { name: "Mastery: Developing" })`; the fill's style width is `"40%"` for decayed 0.4 and `"4%"` for 0.
  - `button classes`: `button("filled")` contains `bg-primary`, `rounded-full` and `min-h-12`.
- [ ] **Step 4: Run `npx vitest run tests/unit/ui.test.tsx`.** Expected: FAIL (modules missing).
- [ ] **Step 5: Implement the primitives, tokens and font.**
  - Tokens: `@theme` with `--color-*: var(--m-*)`. The `--m-*` light values sit on `:root` and the dark values under `@media (prefers-color-scheme: dark)`.
  - `body`: `bg-surface text-on-surface`, `font-family: var(--font-sans)`.
  - Font: `Roboto_Flex({ subsets: ["latin"], variable: "--font-roboto-flex" })`, with `--font-sans: var(--font-roboto-flex)`. Remove Geist.
  - Metadata: `title: APP_NAME`, description "Learn anything with a map built for you."
  - `MermaidDiagram` keeps its own theme switch.
- [ ] **Step 6: Run `npx vitest run tests/unit/ui.test.tsx`.** Expected: PASS.
- [ ] **Step 7: Write the e2e test `tests/e2e/foundations.spec.ts`.**
  - `dark tokens apply`: with `test.use({ colorScheme: "dark" })` on `/`, the body's computed `background-color` is `rgb(17, 19, 24)`.
  - Under the default light scheme it is `rgb(249, 249, 255)`.
  - The `font-family` contains "Roboto Flex" (the next/font family name).

  Run `npx playwright test foundations.spec.ts`. Expected: PASS.
- [ ] **Step 8: Run `npx tsc --noEmit && npx eslint . && npx vitest run`, then commit** `feat(web): material foundations: tokens, Roboto Flex, icons, chips`.

### Task 2: App shell: navigation rail, account actions, simple pages

**Files:**
- Create: `web/components/app-shell.tsx`, `web/components/nav-rail.tsx`, `web/components/top-bar.tsx`
- Modify: `web/components/site-header.tsx` (becomes the account-actions source; `SiteHeaderFallback` is deleted), `web/app/goals/layout.tsx`, `web/app/goals/page.tsx`, `web/components/goals-ui.tsx`, `web/components/auth-form.tsx`, `web/app/(auth)/sign-in/page.tsx`, `web/app/onboarding/page.tsx`, `web/components/preferences-form.tsx`
- Test: `web/tests/e2e/shell.spec.ts`; update `tests/e2e/helpers.ts` `userId()`

**Interfaces:**
- Consumes: `Icon`, `button()`, tokens (Task 1).
- Produces:
  - `AppShell({ children, goalId?: string })`: a server component. It loads the user once and renders `<header data-user-id={id}>` containing `<NavRail>` and the account actions, then `<main>` with `children`.
    - Wide screens (`sm` and up): an 80px left rail on `surface-container-low`.
    - Below `sm`: a bottom bar 80px high.
  - `NavRail({ goalId?: string; account: React.ReactNode })`: a client component.
    - It renders `<nav aria-label="Main">` with items Goals (`/goals`, icon flag) and Review (`/goals/<goalId>/review`, icon event_repeat; only when `goalId` is set).
    - The active item gets `aria-current="page"`, a filled icon and a pill indicator (`secondary-container`, 56×32). Goals is active on `/goals` and `/goals/<id>`; Review on `/goals/<id>/review…`, from `usePathname()`.
    - Library is not rendered (out of scope).
    - Account actions sit at the bottom of the rail. Guests get the link "Save your progress" (`/sign-up`, icon cloud_upload) and "Sign in" (icon login). Signed-up users get the button "Sign out" (icon logout).
  - `TopBar({ back?: { href: string; label: string }; close?: { href: string; label: string }; title: React.ReactNode; actions?: React.ReactNode })`: the focused-page bar from spec pages 7 and 8. It is a `<header data-user-id>` with an icon button whose `aria-label` is the label, the title as `h1` in title-large, and the actions on the right. TopBar loads the user itself (server).
  - `userId()` in the helpers now reads `header[data-user-id]:visible` (unchanged selector; both AppShell and TopBar render that header).
- Layout: `goals/layout.tsx` keeps only `Gate` (no header). The start page and the auth pages use a minimal bar: `APP_NAME` on the left, account links on the right (spec page 2).

- [ ] **Step 1: Write the failing `tests/e2e/shell.spec.ts`.**
  - `rail marks the current page`: after `guestBuildsMap`, `getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Goals" })` has `aria-current="page"`. Clicking "Review" lands on `/goals/<id>/review`, where "Review" has `aria-current`.
  - `guest account actions`: the rail shows the links "Save your progress" and "Sign in".
  - `rail at 375px is a bottom bar`: at 375×812 the nav's bounding box bottom equals the viewport height, and the page doesn't scroll sideways.
- [ ] **Step 2: Run it.** Expected: FAIL (no "Main" navigation).
- [ ] **Step 3: Implement AppShell, NavRail and TopBar, and wire `/goals` and `/goals/[id]` into AppShell.**
  - The goal page passes `goalId`.
  - Restyle `/goals`:
    - headline-medium "Your goals";
    - the "New goal" card with outlined fields and the filled "Create goal" button;
    - goal rows as outlined cards: the title link (title-medium), the status in body-medium on-surface-variant, and an outlined "Archive"/"Unarchive" button.
  - Keep every label and region name.
- [ ] **Step 4: Restyle the auth pages and onboarding on tokens.**
  - Auth: outlined text fields with `rounded-xl`, the filled submit button and the same copy.
  - Onboarding: the format choice uses `FormatCards` from Task 7 once it exists; until then, restyle the radio list with tokens, keeping the labels "Visual", "Text", "Examples", "Summary" and the button "Save".
- [ ] **Step 5: Run `npx playwright test shell.spec.ts auth.spec.ts goals.spec.ts onboarding.spec.ts guest.spec.ts`.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): navigation rail and app shell`.

### Task 3: Start page (spec page 2)

**Files:**
- Modify: `web/app/page.tsx`, `web/components/start-form.tsx`
- Test: update `tests/e2e/first-run.spec.ts`, `tests/e2e/guest.spec.ts` level radios

**Interfaces:**
- Consumes: `FilterChip`, `Icon`, `button()`, the minimal top bar (Task 2).
- Produces: none.

- [ ] **Step 1: Update the tests first.**
  - Level radios are now named "Beginner", "Intermediate" and "Advanced", replacing "I'm new to it", "I know the basics" and "I'm experienced".
  - Add `start page matches the design` to `first-run.spec.ts`:
    - the heading "What do you want to learn?";
    - `getByLabel("Your goal")` has placeholder "Learn the basics of personal finance";
    - `getByRole("radio", { name: "Beginner" })` is checked by default;
    - for a guest, the text "No account needed. Add articles, videos and PDFs once your map is ready." is visible.
- [ ] **Step 2: Run `npx playwright test first-run.spec.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The page is centred, with no card.
  - Heading: display-small "What do you want to learn?".
  - Goal field: a pill (`rounded-full`, `surface-container-low`, outline) with a leading `school` icon, a visually hidden label "Your goal" and the placeholder above.
  - Level row: "Your level" plus three `FilterChip` radios.
  - Submit: the filled button with the `account_tree` icon, "Build my learning map".
  - Guests also see the helper line. Errors show via `FormError`, restyled to `text-on-negative`.
- [ ] **Step 4: Run `npx playwright test first-run.spec.ts guest.spec.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): start page redesign`.

### Task 4: Topic map and detail card (spec pages 3 and 10)

**Files:**
- Modify: `web/app/goals/[id]/TopicMap.tsx` (remove the ACCENTS palette and the old `MasteryBar`), `web/app/goals/[id]/Coverage.tsx` (`CoverageBadge` becomes a thin wrapper over `StatusChip`)
- Test: update `tests/e2e/topic-map-visual.spec.ts`, `tests/e2e/review.spec.ts` (mastery assertions)

**Interfaces:**
- Consumes: `StatusChip`, `MasteryMeter`, `button()`, `Icon` (Task 1).
- Produces:
  - `TopicMap` props unchanged, plus `onAddSource?: () => void`. When set and the goal isn't archived, a gap topic's card shows an outlined "Add source" button (icon add).
  - `DetailPanel` keeps `role="dialog"`, `aria-modal="false"`, `aria-controls` wiring, Esc, Close returning focus, and closing when a link inside it is followed.
- Visuals:
  - Goal node: `surface-container-highest` card, title-medium.
  - Main topic card: `rounded-xl border border-outline-variant bg-surface`, about 15rem wide. Line 1: "<n>  <title>" in title-medium (the button's text starts `"<n> <title>"`). Line 2: the coverage chip. Line 3: `MasteryMeter`.
  - Selected card: `border-2 border-primary bg-primary-container text-on-primary-container`.
  - Child cards: same style, smaller.
  - Connectors: 1px `outline` lines (keep the existing geometry helpers).
  - Detail card: `rounded-2xl bg-surface-container-high`, about 18rem wide, with no shadow.
    - Header: "<n> <title>" (title-large h2) and an icon button `aria-label="Close"`. Children show "Part of: <parent>" above the title.
    - Chips: coverage, then mastery.
    - Body: the summary in body-medium.
    - Actions: gap → "Add a source on this topic to build its lesson." and an outlined "Add source" button. Otherwise → a tonal "Open lesson" (menu_book) and an outlined "Quiz me" (quiz).
    - Without any sources (coverage undefined) → "Open lesson" and "Quiz me".
    - The "In this topic", sources-list and search-links sections are removed (search moves to What to add next).
  - Placement on `xl`: a static column directly right of the map, `sticky top-6`. Below `xl`: the existing bottom sheet.

- [ ] **Step 1: Update `topic-map-visual.spec.ts`.**
  - The panel heading contains `${2} ${MAP[1].title}`; the "Topic 2 of 6" assertion is removed.
  - Selected border width "2px" vs "1px" (unchanged).
  - New `detail card sits beside the map on wide screens`: at 1440, the panel's left edge ≥ the nav's right edge, and the panel's top < 400.
  - New `gap topic offers Add source`: after `mapWithArticle`, select "Indexes and query performance"; the panel has the button "Add source" and no "Open lesson" link.
  - In `review.spec.ts`, the mastery image name regex is unchanged.
- [ ] **Step 2: Run `npx playwright test topic-map-visual.spec.ts topic-map.spec.ts`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement the restyle** as described under Interfaces.
- [ ] **Step 4: Run `npx playwright test topic-map-visual.spec.ts topic-map.spec.ts review.spec.ts coverage.spec.ts`.**
  - In `lessons.spec.ts` "topic without sources", open the gap topic's lesson by URL: read `data-topic-id` from its map button and `page.goto` the lesson URL. The helper `openLessonByUrl(page, topic)` goes in `helpers.ts`.
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): topic map and detail card redesign`.

### Task 5: Goal workspace, Sources column, What to add next, Add source dialog (spec pages 3 and 4)

**Files:**
- Create: `web/app/goals/[id]/AddSourceDialog.tsx`, `web/app/goals/[id]/SourceList.tsx`, `web/app/goals/[id]/GuestSaveCard.tsx`
- Delete: `web/app/goals/[id]/GoalWorkspace.tsx`, `web/app/goals/[id]/Sources.tsx` (split into SourceList + AddSourceDialog, which share one polling hook `useSourceRows(goalId, initial)` in `web/app/goals/[id]/use-source-rows.ts`, moved from Sources.tsx unchanged)
- Modify: `web/app/goals/[id]/page.tsx`, `web/app/goals/[id]/AddNext.tsx`, `web/app/goals/[id]/Coverage.tsx` (`SearchLinks` becomes query chips), `web/lib/sources.ts` (add `STAGES`)
- Test: `web/tests/e2e/add-source.spec.ts` (new), rewrite `web/tests/e2e/workspace.spec.ts`; update `helpers.ts` (`showSources` → `addLink(page, url)`), `sources.spec.ts`, `coverage.spec.ts`, `lessons.spec.ts`; `tests/unit/sources.test.ts` (stage mapping)

**Interfaces:**
- Consumes: `TopicMap.onAddSource` (Task 4), `StatusChip`, `Icon`, `button()`.
- Produces:
  - `stageOf(row: SourceRow): { stage: 0 | 1 | 2 | 3; failed: boolean }` in `lib/sources.ts`. Stages: 0 Fetching (queued, extracting), 1 Reading (chunking, embedding), 2 Matching to your topics (mapping), 3 Ready.
  - `STAGE_TEXT = ["Fetching", "Reading", "Matching to your topics", "Ready"]`.
  - `AddSourceDialog({ goalId, userId, rows, open, onClose })`: a native `<dialog>` opened with `showModal()`, `aria-labelledby` its title "Add a source".
    - Link field: labelled "Paste a link to a web page or YouTube video", with the link icon; submit button "Add".
    - "Upload PDF": a label styled as an outlined button over a sr-only file input, accessible name "Upload PDF". Hint: info icon + "PDFs need selectable text".
    - Divider, then "Adding to your map" (`<ul aria-label="Adding to your map">`), listing the rows that are queued, processing or failed, plus rows that became ready while the dialog was open.
      - Each row: type icon (article / smart_display / picture_as_pdf), title.
      - In progress: a stepper of the four stages. Done stages get check_circle, the current stage a spinning progress_activity in primary, later stages radio_button_unchecked.
      - Ready: check_circle + "Ready" and the relevance chip.
      - Failed: a `negative` container with the error icon, the error text and a text button "Try again" (the existing retry; there is no Remove).
    - Footer: text button "Done" (closes). Errors from adding (limits, invalid link) show as `FormError` under the field.
  - `SourceList({ rows, archived, onRetry })`: `<section aria-labelledby>` with title-medium "Sources" and `<ul aria-label="Your sources">`.
    - Each item is a `surface-container-low` card: type icon, title (title-medium), relevance chip, reason (body-medium).
    - Processing rows show the current stage text; failed rows show the error and "Try again".
  - `AddNext` card (`surface-container-high`, title-large "What to add next"): each item is the coverage chip + "<title> has no sources yet." (gap) or "<title> has thin coverage." (thin), then "Try searching for:".
  - Query chips: an outlined chip with the search icon whose visible text is the query and `aria-label="Search the web for <query>"` (Google), plus a chip with smart_display, visible text "YouTube" and `aria-label="Search YouTube for <query>"`.
  - `GuestSaveCard`: guests only. Outlined card, cloud_upload icon, "Save your progress. " + link "Create a free account." and an icon button `aria-label="Dismiss"`. Dismissal is remembered in localStorage key `guest-save-dismissed` (try/catch).
  - Goal page layout (`xl`): `[map + detail card]` flexible on the left, and a right column `w-80` with `SourceList`, `AddNext` and `GuestSaveCard`. Below `xl` the right column stacks under the map.
  - Header row: headline-medium goal title + level chip (`surface-container-high`, signal icon, sr-only "Built for: " + the level word, so its text reads "Built for: Beginner").
  - Under the header: title-medium "Your learning map" and body-medium "Select a topic to start. Chips show source coverage, bars show your mastery."
  - FAB: a tonal extended FAB "Add source" (add icon), `fixed bottom-6 right-6` (above the bottom bar below `sm`), hidden for archived goals. It opens the dialog; `TopicMap.onAddSource` opens the same dialog.
  - StudyNext is removed from this page (it moves to the Review hub, Task 6).

- [ ] **Step 1: Unit test `stageOf`.** queued→0, extracting→0, chunking→1, embedding→1, mapping→2, ready→3, failed with step embedding→`{stage:1, failed:true}`. Run `npx vitest run tests/unit/sources.test.ts`. Expected: FAIL.
- [ ] **Step 2: Implement `stageOf` and `STAGE_TEXT`; run the unit test.** Expected: PASS.
- [ ] **Step 3: Write `add-source.spec.ts`.**
  - `add a link from the dialog`: click "Add source" (FAB) → the dialog "Add a source" is visible → fill the link field with the fixture article → "Add".
    - In the dialog list "Adding to your map", the row shows "Ready" within 30s.
    - "Done" closes the dialog.
    - The "Your sources" list shows "Highly relevant".
  - `focus returns to the opener`: open with the FAB, press Escape; the dialog is hidden and the FAB is focused.
  - `limit error shows in the dialog`: three links, then a fourth → the alert in the dialog reads "Sign up free to add more sources." (moved from `sources.spec.ts` "guest source limit").
  - `gap topic opens the dialog`: select "Indexes and query performance" → "Add source" in the detail card → the dialog is visible.
- [ ] **Step 4: Rewrite `workspace.spec.ts`.**
  - `wide screen columns`: at 1440, the map's left < the "Sources" region's left; the "What to add next" region is inside the right column; no sideways scroll.
  - `phone stacks`: at 375, the Sources region's top > the map's bottom; no sideways scroll.
  - `long titles wrap`: a 120-character goal title builds a map with no sideways scroll at 375 and 1440.
  - `archived goal has no add controls`: archive, open the goal → no "Add source" button, and the "Your sources" list is visible.
- [ ] **Step 5: Update the helpers and specs.**
  - `addLink(page, url)` opens the dialog, fills the field, presses "Add", waits for "Ready" in the dialog, then clicks "Done". `mapWithArticle` uses it.
  - `sources.spec.ts` uses `addLink` and keeps its row assertions on "Your sources" (the retry test clicks "Try again" in the list).
  - `coverage.spec.ts` "Search the web" becomes `getByRole("link", { name: /^Search the web for / })`.
  - `lessons.spec.ts` uses the same search-link regex.
- [ ] **Step 6: Implement the layout, dialog, list, chips and guest card.** Delete GoalWorkspace and Sources.
- [ ] **Step 7: Run `npx playwright test add-source.spec.ts workspace.spec.ts sources.spec.ts coverage.spec.ts lessons.spec.ts`.** Expected: PASS. (Stop any hand-started worker first: it steals test jobs.)
- [ ] **Step 8: Commit** `feat(web): goal workspace, sources column and add-source dialog`.

### Task 6: Review hub (spec page 9 frame, Review rail item)

**Files:**
- Create: `web/app/goals/[id]/review/quiz/page.tsx`, `web/components/review-overview.tsx`
- Modify: `web/app/goals/[id]/review/page.tsx`, `web/app/goals/[id]/StudyNext.tsx`
- Test: update `tests/e2e/review.spec.ts`

**Interfaces:**
- Consumes: `MasteryMeter`, `StatusChip`, `button()`, `AppShell` (goalId).
- Produces:
  - `ReviewOverview({ goalId, tree, rows }: { goalId: string; tree: TreeNode[]; rows: MasteryRow[] })`: a server-renderable component with two parts.
    - The `StudyNext` card (`surface-container-high`, title-large "What to study next"). Each row: "<n> <title>" in title-medium, the chip (Weak mastery chip, or `secondary-container` "Due for review" with the event_repeat icon), and an outlined "Open lesson" (menu_book) on the right. Rows are separated by outline-variant dividers. Ordering is unchanged.
    - "Your topics" (title-medium): a table-like list of every main topic and child (children indented 24px). Each row: the title, a `MasteryMeter` with the bar about 9rem, and the label chip. Unpractised topics show the meter at 0 with no chip ("Not practised yet").
  - `/goals/[id]/review`: AppShell (Review active), headline-medium "Review" and the body line "See how each topic is going and practise what's due."
    - Then `ReviewOverview`, and the actions "Back to map" (text) and "Start review quiz" (filled, quiz icon) → `/goals/[id]/review/quiz`.
    - With no mastery rows: the text "Take a topic quiz first, then come back for a review." and no start button.
  - `/goals/[id]/review/quiz`: the focused page with TopBar `close={{ href: "/goals/<id>/review", label: "Close quiz" }}`, title "Review quiz", and `<QuizRunner mode="review">`.

- [ ] **Step 1: Update `review.spec.ts`.**
  - `review quiz`: after `quizJoins`, click the rail link "Review" → the region "What to study next" has a list item containing "Joining tables" and a link "Open lesson".
  - Click "Start review quiz" → "Question 1 of 10" → answer all 10.
  - Results show "10 of 10" (Task 8 heading).
  - `review without practice`: `/review` shows the empty text and no "Start review quiz".
  - `your topics lists every topic`: the hub's "Your topics" list has one item per subtopic (count equals the map's `button[data-topic-id]` count).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the hub, the quiz route and ReviewOverview.** StudyNext becomes part of ReviewOverview and is no longer imported by the goal page.
- [ ] **Step 4: Run `npx playwright test review.spec.ts`.** Expected: PASS once Task 8's heading lands. Until then, assert `getByRole("heading", { name: "Your results" })` and switch it in Task 8.
- [ ] **Step 5: Commit** `feat(web): review hub with study-next and topic mastery`.

### Task 7: Lesson page and format chooser (spec pages 5, 7 and 11)

**Files:**
- Create: `web/components/format-cards.tsx`
- Modify: `web/app/goals/[id]/topics/[subtopicId]/page.tsx`, `LessonView.tsx`, `web/components/lesson-sections.tsx`, `web/components/lesson-feedback.tsx`, `web/components/mermaid-diagram.tsx`, `web/components/preferences-form.tsx`, `web/lib/lessons.ts` (FORMAT_TEXT hints)
- Test: update `tests/e2e/lessons.spec.ts`, `tests/unit/lesson-sections.test.tsx`

**Interfaces:**
- Consumes: TopBar (Task 2), `Icon`, `button()`.
- Produces:
  - `FORMAT_TEXT` hints become exactly: visual "Diagrams first, with short notes.", text "Clear explanations, step by step.", examples "Worked examples and everyday analogies.", summary "Key points only."
  - Icons: visual schema, text notes, examples lightbulb, summary format_list_bulleted.
  - `FormatCards({ name: string; value: Format; onChange: (f: Format) => void })`:
    - a `role="radiogroup"` 2×2 grid (one column below `sm`);
    - each card is a label over a sr-only radio named `"<Label> <hint>"`;
    - checked card: `border-2 border-primary bg-primary-container` and a check_circle (filled) top-right.
    - Used by the chooser and by onboarding (`name="preferred_format"`).
  - Format chooser: a native `<dialog>` (showModal) titled "How do you like to learn?" with "We'll shape every lesson this way."
    - Body: FormatCards.
    - Footer: swap_horiz + "You can switch anytime" and the filled "Continue".
    - The close icon button (`aria-label="Close"`) and Esc navigate back to the map (`router.push("/goals/<id>")`).
  - Lesson page:
    - TopBar `back={{ href: "/goals/<id>", label: "Back to your map" }}`. The title is `h1` "<n> <title>" (n only for main topics, from the goal's subtopics via `buildTree`).
    - The actions slot holds the segmented control: `role="group" aria-label="Show me this as:"`, four buttons with `aria-pressed`, the selected one with a check icon and `secondary-container`.
    - Content: `max-w-[65ch] mx-auto`.
  - Stale banner: `primary-container`, update icon, "New sources available. Refresh lesson?", and the text buttons "Dismiss" (hides it for this view) and "Refresh".
  - `LessonSections`:
    - sections are no longer cards;
    - headings get headline-small;
    - paragraphs body-large;
    - after each section's prose, citation chips: a pill link `aria-label="Source <n>: <title>"`, visible text `<n>`, `title="<title> · <label>"`;
    - Mermaid sits in an outlined `rounded-2xl` figure.
  - After the sections, "Sources" (label-large) as a numbered list: the number chip, the type icon, the underlined title link (or plain text when there's no href) and "· <label>".
  - `LessonFeedback`:
    - "Was this helpful?" with icon buttons `aria-label="Helpful"` (thumb_up) and `aria-label="Not helpful"` (thumb_down);
    - the text button "Report an error" (flag);
    - "Quiz me on this" as the filled button (quiz icon) on the same row on wide screens, passed in as `children` from LessonView;
    - "Thanks for the feedback." is unchanged.
  - The no-sources state: a `surface-container-high` card with `LESSON_ERROR_TEXT.no_sources` and the query chips (Task 5).

- [ ] **Step 1: Update the tests.**
  - `lessons.spec.ts`: "Show my lesson" → "Continue"; "Refresh lesson" → "Refresh"; "Was this lesson helpful?" → "Was this helpful?"; the button "Yes" → "Helpful".
  - Citation links `"[1]"` → `/^Source 1:/`; "← Back to your map" → `getByRole("link", { name: "Back to your map" })`, here and in `review.spec.ts` (exact "Back to map" on the results page).
  - New `format chooser closes back to the map`: on a first lesson the dialog is visible; Escape → the URL is `/goals/<id>`.
  - New `stale banner can be dismissed`: make a lesson stale (as in the existing "stale lesson can be refreshed"), click "Dismiss" → the text is gone and the lesson stays.
  - `lesson-sections.test.tsx`: citation link names `Source 1: <title>`.
- [ ] **Step 2: Run `npx vitest run tests/unit/lesson-sections.test.tsx && npx playwright test lessons.spec.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement** FormatCards, the chooser dialog, TopBar use, the segmented control, banner, sections, sources list and feedback. Onboarding uses FormatCards; its level choice uses FilterChips.
- [ ] **Step 4: Run `npx vitest run && npx playwright test lessons.spec.ts onboarding.spec.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): lesson page and format chooser redesign`.

### Task 8: Quiz and results (spec pages 8 and 9)

**Files:**
- Modify: `web/components/quiz-runner.tsx`, `web/app/goals/[id]/topics/[subtopicId]/quiz/page.tsx`
- Test: update `tests/unit/quiz-runner.test.tsx`, `tests/e2e/quiz.spec.ts`, `tests/e2e/review.spec.ts`

**Interfaces:**
- Consumes: TopBar, `ReviewOverview` (Task 6), `StatusChip`, `button()`.
- Produces:
  - `QuizRunner({ goalId, subtopicId, mode, title, overview })`, where `title: string` is the quiz name ("<topic> quiz" / "Review quiz") and `overview: React.ReactNode` is the server-rendered `ReviewOverview`.
    - After `finishQuiz` succeeds, it calls `router.refresh()` so `overview` re-renders with the new mastery while the client state stays.
  - Topic quiz page: TopBar `close={{ href: lesson URL, label: "Close quiz" }}`, title "<topic> quiz".
  - Question view:
    - "Question n of N" (label-large) and a 4px progress bar (`role="progressbar"`, `aria-valuenow=n`, `aria-valuemax=N`, `aria-label="Quiz progress"`).
    - The stem as headline-small h2.
    - Options as cards with letter avatars A–D. The radio stays sr-only inside the label, and the accessible name is the option text.
    - Before answering: "Check answer" (filled).
    - After answering:
      - The chosen wrong option: `negative` container, 2px border, close icon + "Not quite · your answer".
      - The correct option: `positive` container + check + "Correct answer".
      - The others are dimmed.
      - A `role="status"` line: correct → "Correct!"; wrong → "You chose <L>. Not quite. The correct answer is <L>."
      - The explanation card (`surface-container-high`): lightbulb + "Why <L> is right" (title-medium), the explanation, then citation chips (number + type icon + "<title> · <label>" link).
      - In topic mode only, "Review in lesson" (menu_book) links to `/goals/<id>/topics/<subtopicId>`. Review mode omits it, because `QuizQuestion` carries no subtopic id.
    - Footer: the text button "Flag this question" (flag icon) on the left, and on the right the filled "Next" (arrow_forward), or "See results" on the last question. Flagged → "Thanks. This question won't be shown to you again."
  - Results:
    - eyebrow `title` (body-medium);
    - display-small `h2` "<correct> of <total>", summed over topics;
    - line: topic mode → "<praise> <topic> is now <Label>."; review mode → one line per topic "<title>: <c> of <t>, now <Label>.";
    - praise is "Nice work." if score ≥ 0.8, "Good effort." if ≥ 0.5, else "Keep practising.";
    - then the "To review" list (wrong answers, restyled as `surface-container-low` cards, links "Review the lesson");
    - then `overview`;
    - actions: the text link "Back to map" and the filled "Start review quiz" → `/goals/<id>/review/quiz`.

- [ ] **Step 1: Update the tests.**
  - `quiz-runner.test.tsx`: "Next question" → "Next"; the wrong-answer status text is `You chose B. Not quite. The correct answer is A.` for the fixture; the results heading is "4 of 5" for a 4-of-5 summary; the praise line is "Nice work. <topic> is now Strong."; the progressbar has `aria-valuenow` equal to the question number.
  - `quiz.spec.ts` / `review.spec.ts`: "Next question" → "Next"; `Not quite. The answer is: X` → `getByRole("status")` containing "Not quite. The correct answer is"; "Your results" → `getByRole("heading", { name: /^\d+ of \d+$/ })`.
- [ ] **Step 2: Run `npx vitest run tests/unit/quiz-runner.test.tsx`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `title` and `overview` from both quiz pages; each page loads the tree and the `goal_mastery` rows as the goal page does.
- [ ] **Step 4: Run `npx vitest run && npx playwright test quiz.spec.ts review.spec.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): quiz and results redesign`.

### Task 9: Sweep, dark mode and final verification

**Files:**
- Modify: any file still using `zinc-`, `indigo-`, `emerald-`, `amber-`, `rose-` or `dark:` classes (except `mermaid-diagram.tsx`'s theme logic), `docs/superpowers/plans/2026-10-10-phase-1-followups.md`
- Test: whole suite

- [ ] **Step 1: Run `grep -rnE "(zinc|indigo|violet|emerald|amber|rose|sky)-[0-9]|dark:" web/app web/components`.** Expected: no matches. Fix any that are left.
- [ ] **Step 2: Take screenshots.** Use Playwright with the fake worker at 1440×900 light and dark and at 375×812 light. Screens: start, map with the detail card open, the Add source dialog, the format chooser, lesson, quiz answered and results. Save them to the scratchpad and compare against spec pages 2–5 and 7–11. Fix visible drift: spacing on the 8px grid, radii, type roles.
- [ ] **Step 3: Run `npx tsc --noEmit && npx eslint . && npx vitest run && npx playwright test`** (with no hand-started worker running). Expected: all pass.
- [ ] **Step 4: Update the follow-ups** under "From the redesign": the Library page (search, type filters, source detail, Remove); the cross-goal Review rail page; source removal (needs an RPC); "Ready · matched to <topic>" in the Add source dialog (needs a coverage lookup per source); the lesson's inline citation chips (the model emits per-section citations today); the real app name in `lib/brand.ts`.
- [ ] **Step 5: Commit** `chore(web): redesign sweep and follow-ups`.
