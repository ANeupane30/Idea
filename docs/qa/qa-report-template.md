# QA report: staging

Copy this file to `docs/qa/<yyyy-mm-dd>-staging.md`, fill it in, and link it from the staging → main pull request.

- **Staging commit:** `<sha>`
- **Tester(s):**
- **Date:**
- **Browsers / devices:** (e.g. Chrome 1440 desktop, Safari iPhone 375, dark mode)

**Result:** ☐ Ready for production ☐ Not ready (see blocking issues)

## 1. Core flows

| # | Flow | Pass / fail | Notes |
|---|---|---|---|
| 1 | Guest: enter a goal and level, map builds, topics numbered in order | | |
| 2 | Add a web link, a YouTube video, a PDF: each reaches Ready with a relevance chip | | |
| 3 | A bad link fails with a plain message; "Try again" works | | |
| 4 | Map shows coverage chips (Covered / Thin / Gap); What to add next suggests searches | | |
| 5 | Open a lesson: format chooser (Esc goes back to the map); lesson streams with diagrams and citations | | |
| 6 | Switch format; stale banner after a new source (Dismiss, Refresh) | | |
| 7 | Topic quiz: answer, explanation, sources, flag; results show score and mastery | | |
| 8 | Review page: What to study next, Your topics; review quiz runs and can be restarted | | |
| 9 | Sign up from guest keeps the map; sign out returns to a fresh guest; sign in | | |
| 10 | Limits: guest source, lesson and quiz limits show "Sign up free" | | |

## 2. Design review focus

| Check | Pass / fail | Notes |
|---|---|---|
| Long titles (≈120 characters) wrap in the rail pages, map cards, detail card, dialogs and lesson bar; no sideways scroll at 375 px | | |
| Dialogs: opening Add source or the format chooser moves focus inside; Esc closes; focus returns to the button that opened it | | |
| Archived goal: no Add source button or dialog; the sources list is still readable | | |
| Dark mode: no white cards or unreadable text on any page | | |
| Screen reader: statuses say a word (Covered, Highly relevant, Strong…), not just a colour; quiz announces the correct answer | | |
| Keyboard only: every action reachable; visible focus ring | | |

## 3. Production readiness (from the follow-ups)

| Item | Done | Notes |
|---|---|---|
| Live Claude smoke test: map, relevance, lessons with diagrams, quiz generation and validation | | |
| YouTube transcripts work from the deploy region | | |
| `FETCH_USER_AGENT` names the real site; Wikipedia links work | | |
| Real app name in `web/lib/brand.ts` | | |
| Supabase auth: min password length 8, anonymous sign-ins with per-IP limit, captcha | | |
| Daily spend alert and pause | | |
| Lesson server token set in both Vercel and Fly | | |

## 4. Issues found

| # | Severity (blocking / major / minor) | Page | Steps to reproduce | Expected | Actual |
|---|---|---|---|---|---|
| | | | | | |

## 5. Sign-off

- **QA:**
- **Product owner:**
