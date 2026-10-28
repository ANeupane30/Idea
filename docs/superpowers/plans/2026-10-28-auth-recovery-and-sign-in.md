# Password Reset and Friendlier Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can reset a forgotten password with an 8-digit email code, confirm new accounts the same way, and use "Continue with Google". The sign-in and sign-up forms are friendlier and never reveal whether an email has an account.

**Architecture:**
- All rate-limited Supabase Auth calls go through one server-only client. It uses the secret key, sends the person's IP in `Sb-Forwarded-For`, and exposes only `.auth`.
- Server actions in `app/(auth)/actions.ts` pad their timing, mask account-revealing errors, and return one `FormState` shape, which small client components render.
- **Task 2 is a gate on staging.** If its steps 2–4 fail, work stops.

**Tech Stack:**
- Next.js 16.4.3 (App Router, server actions, `proxy.ts`), React 19.3.0;
- `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.3, Supabase Auth v2.197.0;
- Vitest 5 with Testing Library and jsdom; Playwright 1.64; Mailpit (local Supabase test mailbox, port 44324).

**Spec:** [docs/superpowers/specs/2026-10-27-auth-recovery-and-sign-in-design.md](../specs/2026-10-27-auth-recovery-and-sign-in-design.md). Read it with this plan; section numbers below (§) refer to it.

## Global Constraints

- **Codes:**
  - exactly **8 digits**, and they last **15 minutes** (`otp_length = 8`, `otp_expiry = 900`);
  - **60 s** between emails (`max_frequency = "60s"`);
  - **no `maxlength`** on any code field.
- **Passwords:** at least **8 characters** (`minimum_password_length = 8`); `password_requirements` stays empty.
- **Copy:** every message shown to a person is copied verbatim from §5; no other wording.
- **Errors are mapped by `error.code` only,** never by message text.
- **The secret key** (`SUPABASE_SECRET_KEY`) is read only in `web/lib/supabase/auth-server.ts`, which starts with `import "server-only"`. It's never `NEXT_PUBLIC_`.
  - `createAuthClient` returns `client.auth` only, never the full client.
  - It's built per request and never cached across requests.
  - It's used only in `app/(auth)/actions.ts`, `app/auth/callback/route.ts` and the proxy's guest creation.
- **The person's IP** comes only from the `x-vercel-forwarded-for` header (first value, a valid IP). If it's missing, `Sb-Forwarded-For` isn't sent.
- **The same answer for every email:** sign-in, sign-up, send code and both resends pad to their minimum time (`SIGN_IN_MS = 1500`, `SEND_MS = 1500` until Task 12 measures staging).
  - `over_email_send_rate_limit` counts as "sent" and is logged at error level as `auth_email_send_limited`.
  - `email_exists` / `user_already_exists` on sign-up count as "code sent".
- **Navigation:** every `next` goes through `safeNext`; `from` is `signin` or `signup`, and anything else means `signin`.
- **Email carry-over and reset state** live in `sessionStorage`, never in the URL.
- **No other OAuth provider** is turned on, on any project (§7).
- **The UI keeps the existing look:** `button()`, `field()` and the colour tokens from `components/ui`.

## Review Focus

Five inputs the spec doesn't spell out, and that a person is likely to meet. Each has a test in the task named.
1. **Email case and spaces:** "Name@Example.com " at sign-in works for an account made as "name@example.com". The email comparison in `recentEmailProof` ignores case. *(Task 4: unit; Task 6: e2e)*
2. **A password with spaces or non-ASCII characters**, e.g. `"pässwörd 123 "`. It's never trimmed: sign-up, sign-in and reset accept it exactly as typed, and a trimmed version is rejected. *(Task 6: e2e)*
3. **A guest sign-up left before the code:**
   - **Cookies lost on the same device:** entering the code must still confirm the account. The state carries the code kind (`email_change` / `signup`) and the email, so the check doesn't depend on the guest session.
   - **Coming back on another device:** the guest's email is still only pending (C15), so signing in says "Email or password is incorrect.", and a reset sends nothing. Signing up again with that email must work, and a code must arrive.

   *(Task 7: e2e)*
4. **Going back after success:** pressing Back after a finished reset or confirmation and resubmitting the old form. It must end on a clear message ("That code is wrong or has expired."), or a redirect for a signed-in person, never the generic error. *(Task 8: e2e)*
5. **A very long password** (over 72 bytes, which Supabase's bcrypt hashing rejects with `validation_failed`). The person must see a plain message on the Password field, not "Something went wrong".
   - §5 has no copy for it, so **the user approves the copy in Task 4, step 1**.
   - The form checks it before any Supabase call.

   *(Task 4: unit; Task 6: e2e)*

---

### Task 1: The secret-key auth client

**Files:**
- Create: `web/lib/supabase/client-ip.ts`, `web/lib/supabase/auth-server.ts`
- Create test: `web/lib/supabase/client-ip.test.ts`, `web/tests/unit/auth-server.test.ts`
- Modify:
  - `web/vitest.config.ts`: alias `server-only` to an empty module, `web/tests/unit/empty.ts`;
  - `web/package.json`: add `server-only`;
  - `web/.env.local.example`: add `SUPABASE_SECRET_KEY=` with a comment;
  - `.github/workflows/ci.yml:104-108`: write `SUPABASE_SECRET_KEY=$SECRET_KEY` into `web/.env.local`.

**Interfaces:**
- Produces:
  - `clientIp(headers: Headers): string | null`;
  - `type SupabaseAuthClient = SupabaseClient["auth"]`;
  - `createAuthClient(opts: { cookies: CookieMethodsServer; headers: Headers; fetch?: typeof fetch }): SupabaseAuthClient`;
  - `authClient(): Promise<SupabaseAuthClient>`, which uses `next/headers` `cookies()` and `headers()`.

- [ ] **Step 1: Write the failing tests**

`client-ip.test.ts`:
```ts
it("takes the first value of x-vercel-forwarded-for", () =>
  expect(clientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7"));
it("accepts IPv6", () => expect(clientIp(new Headers({ "x-vercel-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1"));
it.each([[{}], [{ "x-forwarded-for": "203.0.113.7" }], [{ "x-real-ip": "203.0.113.7" }], [{ "x-vercel-forwarded-for": "not-an-ip" }], [{ "x-vercel-forwarded-for": "" }]])(
  "returns null for %j", (h) => expect(clientIp(new Headers(h))).toBeNull());
```
`auth-server.test.ts`: record the request headers through a fake `fetch`. This is gate step 1 (§4.4).
```ts
it("sends the secret key and the person's IP, and no Authorization without a session", async () => {
  const seen: Headers[] = [];
  const auth = createAuthClient({ cookies: { getAll: () => [], setAll: () => {} },
    headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }),
    fetch: async (_u, init) => { seen.push(new Headers(init?.headers)); return Response.json({}, { status: 200 }); } });
  await auth.resetPasswordForEmail("a@example.com");
  expect(seen[0].get("apikey")).toBe(process.env.SUPABASE_SECRET_KEY);
  expect(seen[0].get("sb-forwarded-for")).toBe("203.0.113.7");
  console.log("gate step 1, no session:", Object.fromEntries(seen[0]));
});
it("leaves Sb-Forwarded-For out when there is no Vercel IP", …expect(seen[0].has("sb-forwarded-for")).toBe(false));
it("sends the session's access token as Authorization when signed in", …cookie jar holding a session, then auth.getUser(); log the headers as "gate step 1, with session").
it("exposes only auth", () => expect("from" in createAuthClient(…)).toBe(false));
```
Set `process.env.SUPABASE_SECRET_KEY = "sb_secret_test"` and `NEXT_PUBLIC_SUPABASE_URL` in the test's `beforeAll`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run lib/supabase/client-ip.test.ts tests/unit/auth-server.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

- **`clientIp`:** splits on `,`, trims, and validates with `node:net` `isIP`.
- **`createAuthClient`:** `createServerClient(url, SUPABASE_SECRET_KEY, { cookies, global: { headers: ip ? { "Sb-Forwarded-For": ip } : {}, fetch } })`, and returns `.auth`. It throws if `SUPABASE_SECRET_KEY` is unset.
- **`authClient`:** wraps it with `next/headers`, with the same `setAll` try/catch as `lib/supabase/server.ts`.

- [ ] **Step 4: Run the tests to verify they pass, and keep the two logged header sets for Task 2**

Run: the same command. Expected: PASS. Copy the two `gate step 1` lines into the gate record (Task 2, step 5).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `cd web && npx tsc --noEmit && npm run lint`. Expected: no errors.
```bash
git add web/lib/supabase web/tests/unit/auth-server.test.ts web/tests/unit/empty.ts web/vitest.config.ts web/package.json web/package-lock.json web/.env.local.example .github/workflows/ci.yml
git commit -m "feat(auth): server-only auth client with the secret key and the person's IP"
```

### Task 2: The secret-key gate on staging (§4.4). Stop if steps 2–4 fail

**Files:**
- Modify:
  - `web/app/(auth)/actions.ts`: `signIn`, `signUp` and `signOut` use `authClient()` instead of `createClient()`;
  - `web/lib/supabase/middleware.ts`: the guest's `signInAnonymously()` goes through `createAuthClient({ cookies: <the proxy's request/response cookie methods>, headers: request.headers })`. `getUser()` stays on the publishable client.
  - `docs/deploy.md`: add the IP-forwarding, secret-key and rotation steps, and the "nothing in front of Vercel" warning (§4.2).
- Create: `web/scripts/auth-gate.mjs`, the gate script (kept for re-running if Auth's version changes).

**Interfaces:**
- Consumes: `authClient()` and `createAuthClient()` from Task 1.
- Produces: the gate record, added to spec §4.4 under "Result".

- [ ] **Step 1: Wire the three call sites**

Behaviour is otherwise unchanged. The existing e2e suite must still pass.

Run: `cd web && npx vitest run && npx playwright test tests/e2e/auth.spec.ts tests/e2e/guest.spec.ts`
Expected: PASS.

- [ ] **Step 2: Write `auth-gate.mjs`**

Usage: `node scripts/auth-gate.mjs <site-url> <supabase-url> <publishable-key>`.
- **(a) 31 sign-ins:** 31 sign-in form posts through the app within 5 minutes, with wrong passwords for one made-up email. It prints each one's on-screen message; #31 must be "Too many attempts. Please wait a minute and try again."
- **(b) Admin check:** `GET <supabase-url>/auth/v1/admin/users?per_page=1` with `apikey: <secret key>` and no `Authorization`. It prints the status: **200 means the secret key alone counts as admin**, so captcha would be skipped.

  The script reads the secret key from the `SUPABASE_SECRET_KEY` env var, and **never prints it**.

Posting the form: drive `/sign-in` with Playwright's `chromium` (it's already a dev dependency), not raw requests, because server actions need Next's action headers.

- [ ] **Step 3: Ask the user for the staging setup, then release to staging**

The user does these:
- **Vercel (staging project):** add `SUPABASE_SECRET_KEY`, server-only.
- **Supabase staging, Authentication → Rate Limits:** turn on IP Address Forwarding.
- **Supabase staging, email confirmation:** turn it on, and paste a temporary template into "Confirm signup" and "Change email address": `Your code is {{ .Token }}`.

Then open a PR into `dev`, and release it with `.superpowers/tools/release.sh <pr>`. **Each merge needs the user's explicit OK for that PR.**

- [ ] **Step 4: Run the gate**

1. **Limits apply:** `SUPABASE_SECRET_KEY=… node scripts/auth-gate.mjs https://learnmap-staging.vercel.app https://iaxhzwsyacnbnwihfxdy.supabase.co <publishable>`. Expected: #31 is rate-limited.
2. **Limits are per person:** while (a)'s limit is still active, **the user** signs in on staging from a phone on mobile data. Expected: it works.
3. **Sign-up behaves normally:** sign up on staging, as a guest with a goal, using the user's own address.
   - Expected: a code email arrives.
   - `signInWithPassword` with the publishable key gives `email_not_confirmed`.
   - The header's "Save your progress" is still shown, so the person is still a guest.
   - After `verifyOtp({ type: "email_change" })` with the emailed code, the goal is still there and sign-in works.
4. **Captcha:** record the admin-check status from (b).

- [ ] **Step 5: Record the result, and stop on failure**

Add a "Result (date)" block under spec §4.4 with:
- the step 1 header sets from Task 1 (with the key values replaced by `<secret>` / `<jwt>`);
- each step's outcome;
- the admin status.

If (b) is 200, add to §7's captcha line: "our server checks the captcha token itself".

**If step 4.1, 4.2 or 4.3 failed: commit the record, report to the user, and stop. Don't continue to Task 3, and don't change the approach.**
```bash
git add docs web/scripts/auth-gate.mjs && git commit -m "docs(auth): record the secret-key gate on staging"
```

### Task 3: `safeNext`, `normalizeCode`, `suggestEmail`

**Files:**
- Create: `web/lib/auth/next.ts`, `web/lib/auth/code.ts`, `web/lib/auth/email-suggest.ts`
- Tests: `web/lib/auth/next.test.ts`, `code.test.ts`, `email-suggest.test.ts`

**Interfaces:**
- Produces:
  - `safeNext(value: unknown): string`, which returns `/goals` when the value is rejected;
  - `CODE_LENGTH = 8`;
  - `normalizeCode(value: string): string | null`;
  - `suggestEmail(email: string): string | null`.

- [ ] **Step 1: Write the failing tests** with the exact cases from §6.1:

```ts
it.each(["/goals", "/goals/abc?tab=map#t2", "/sign-in?x=1"])("keeps %s", (v) => expect(safeNext(v)).toBe(v));
it.each(["//evil.com", "/\\evil.com", "\\\\evil.com", "/%5Cevil.com", "https://evil.com", "javascript:alert(1)",
  "%2F%2Fevil.com", "/go\tals", "/go\nals", "", undefined, null, "goals"])("rejects %j", (v) => expect(safeNext(v)).toBe("/goals"));

it.each(["12345678", "1234 5678", "1234-5678", "  12345678 "])("accepts %j", (v) => expect(normalizeCode(v)).toBe("12345678"));
it.each(["1234567", "123456789", "1234abcd", ""])("rejects %j", (v) => expect(normalizeCode(v)).toBeNull());

it.each([["Name@gmial.com", "Name@gmail.com"], ["a@gmail.co", "a@gmail.com"], ["a@hotmal.com", "a@hotmail.com"],
  ["a@yaho.com", "a@yahoo.com"], ["a@outlok.com", "a@outlook.com"], ["a@icloud.co", "a@icloud.com"], ["a@me.cm", "a@me.com"]])(
  "suggests %s → %s", (i, o) => expect(suggestEmail(i)).toBe(o));
it.each(["a@mail.com", "a@email.com", "a@ymail.com", "a@mac.com", "a@cloud.com", "a@my.com", "a@mi.com", "a@ma.com",
  "a@gmail.com", "a@example.org", "not-an-email"])("leaves %s alone", (v) => expect(suggestEmail(v)).toBeNull());
```

- [ ] **Step 2: Run them to verify they fail.** Run: `cd web && npx vitest run lib/auth`. Expected: FAIL.

- [ ] **Step 3: Implement**

- **`safeNext`:**
  - rejects anything that isn't a string;
  - rejects a value not starting with exactly one `/`;
  - rejects a value containing `\`, `%5c`/`%5C`, or any control character;
  - then parses `new URL(value, "https://next.invalid")`, requires that origin, and returns `pathname + search + hash`.
- **`normalizeCode`:** strips whitespace and `-`, then requires `/^\d{8}$/`.
- **`suggestEmail`:**
  - Damerau distance 1 (insert, delete, substitute, adjacent swap) against the §3.2 list;
  - the never-suggest list is checked first;
  - for `me.com`, it only suggests when the name before the dot is exactly `me`;
  - it keeps the local part as typed.

- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.** `git add web/lib/auth && git commit -m "feat(auth): safe next paths, 8-digit codes, email typo hints"`

### Task 4: Messages, `padTo`, `recentEmailProof`, `FormState`

**Files:**
- Create:
  - `web/lib/auth/messages.ts`: every §5 string as a named constant, plus `messageFor`;
  - `web/lib/auth/pad.ts`;
  - `web/lib/auth/recent-proof.ts`;
  - `web/lib/auth/state.ts`.
- Tests: `web/lib/auth/messages.test.ts`, `pad.test.ts`, `recent-proof.test.ts`

**Interfaces:**
- Produces:
  - **`messages.ts`:** constants named `WRONG_CREDENTIALS`, `RATE_LIMITED`, `PASSWORD_TOO_SHORT` (re-exported from `lib/validation.ts`), `INVALID_EMAIL`, `CODE_FORMAT`, `CODE_WRONG`, `CODE_ACCEPTED`, `SAME_PASSWORD`, `RESET_SENT`, `SIGNUP_SENT(email: string)`, `HAVE_ACCOUNT`, `ASK_NEW_CODE`, `PASSWORD_CHANGED`, `GOOGLE_HAS_ACCOUNT`, `GOOGLE_FAILED`, `GENERIC_ERROR` (re-exported).
  - **`messageFor(code: string | undefined): string`.**
  - **`padTo<T>(ms, work, clock?)`:** `padTo<T>(ms: number, work: () => Promise<T>, clock?: Clock): Promise<T>`, where `type Clock = { now(): number; sleep(ms: number): Promise<void> }`. Also `SIGN_IN_MS = 1500` and `SEND_MS = 1500`.
  - **`CODE_LIFETIME_S = 900`.**
  - **`recentEmailProof(claims, email, nowS)`:** `recentEmailProof(claims: { email?: string; amr?: { method: string; timestamp: number }[] } | null, email: string, nowS: number): boolean`.
  - **`FormState`:**
    ```ts
    type FormState =
      | { status: "idle" }
      | { status: "error"; message: string; field?: "email" | "password" | "code" }
      | { status: "code-sent"; email: string; kind: "signup" | "email_change" | "recovery" }
      | { status: "code-accepted"; email: string }
    ```

- [ ] **Step 1: Ask the user for the long-password copy (Review Focus 5)**

Supabase answers a password over 72 bytes with `validation_failed`. Propose: "Password must be 72 characters or fewer." Ask the user to approve it, or to say what to show instead. If approved, add it to spec §5 and `messages.ts` as `PASSWORD_TOO_LONG`, and add `.refine(byteLength <= 72)` to the password schema in `lib/validation.ts`.

- [ ] **Step 2: Write the failing tests**

```ts
it.each([["invalid_credentials", WRONG_CREDENTIALS], ["over_request_rate_limit", RATE_LIMITED], ["weak_password", PASSWORD_TOO_SHORT],
  ["otp_expired", CODE_WRONG], ["same_password", SAME_PASSWORD], ["identity_already_exists", GOOGLE_HAS_ACCOUNT],
  ["email_exists", GOOGLE_HAS_ACCOUNT], ["access_denied", GOOGLE_FAILED], ["something_new", GENERIC_ERROR], [undefined, GENERIC_ERROR]])(
  "maps %s", (c, m) => expect(messageFor(c)).toBe(m));
it("never reads message text", () => expect(messageFor.toString()).not.toMatch(/message/));

// pad.test.ts with a fake clock { t: 0, now: () => t, sleep: async (ms) => { t += ms } }
it("waits until ms after a fast success"); // work takes 200 → total 1500
it("waits, then rethrows a fast failure"); // rejects after clock.now() === 1500
it("adds no wait when work is slower than ms"); // work takes 2000 → sleep not called

// recent-proof.test.ts, now = 10_000
it("true for otp 899 s ago, same email in other case", () =>
  expect(recentEmailProof({ email: "a@x.com", amr: [{ method: "otp", timestamp: 9_101 }] }, "A@X.com ", 10_000)).toBe(true));
it.each([
  [{ email: "a@x.com", amr: [{ method: "password", timestamp: 9_900 }] }],
  [{ email: "a@x.com", amr: [{ method: "otp", timestamp: 9_099 }] }],   // 901 s
  [{ email: "a@x.com", amr: [{ method: "otp", timestamp: 10_001 }] }],  // in the future
  [{ email: "b@x.com", amr: [{ method: "otp", timestamp: 9_900 }] }],
  [{ email: "a@x.com" }], [null]])("false for %j", (c) => expect(recentEmailProof(c, "a@x.com", 10_000)).toBe(false));
```

- [ ] **Step 3: Run to verify they fail.** Run: `cd web && npx vitest run lib/auth`. Expected: the new tests FAIL.

- [ ] **Step 4: Implement**

`messageFor` is a `switch` on the code. `padTo` records `clock.now()`, awaits `work` (catching), sleeps the remainder, then returns or rethrows. `recentEmailProof` compares the emails after `trim().toLowerCase()`.

- [ ] **Step 5: Run to verify they pass, then commit**

Run: `cd web && npx vitest run lib/auth`. Expected: PASS.
```bash
git add web/lib && git commit -m "feat(auth): messages, timing padding, recent email proof"
```

### Task 5: Form parts

**Files:**
- Create:
  - `web/components/auth/password-field.tsx`, `email-field.tsx`, `code-field.tsx`, `resend-button.tsx`, `submit-button.tsx`;
  - `web/lib/auth/carry.ts`, which provides `useCarriedEmail` and `useResetState`.
- Modify: `web/scripts/gen-icons.mjs` (NAMES += `"visibility"`, `"visibility_off"`), then run `npm run icons`.
- Test: `web/tests/unit/auth-fields.test.tsx`

**Interfaces:**
- Consumes: `suggestEmail` (Task 3), `PASSWORD_TOO_SHORT` (Task 4).
- Produces:
  - **`PasswordField(props)`:** `PasswordField(props: { name: string; label: string; value: string; onChange(v: string): void; mode: "current" | "new"; error?: string; inputRef?: Ref<HTMLInputElement> })`.
  - **`EmailField(props)`:** `EmailField(props: { value: string; onChange(v: string): void; error?: string; inputRef?: Ref<HTMLInputElement> })`.
  - **`CodeField(props)`:** `CodeField(props: { value: string; onChange(v: string): void; error?: string; inputRef?: Ref<HTMLInputElement> })`.
  - **`ResendButton(props)`:** `ResendButton(props: { resendAt: number; onResend(): void; pending: boolean })`.
  - **`SubmitButton(props)`:** `SubmitButton(props: { idle: string; pending: string })`. It reads `useFormStatus()` and is disabled while pending.
  - **`useCarriedEmail()`:** `useCarriedEmail(): [string, (v: string) => void]`, stored under the `sessionStorage` key `auth:email`.
  - **`useResetState<T>(key, initial)`:** `useResetState<T>(key: string, initial: T): [T, (v: T) => void]`, stored in `sessionStorage` as JSON, and returning `initial` when storage throws.

- [ ] **Step 1: Write the failing tests** (`// @vitest-environment jsdom`, Testing Library, `afterEach(cleanup)`), one `it` each:
  - **Show/hide:** the button switches `type` between `password` and `text`, and its name between "Show password" and "Hide password".
  - **Caps Lock:** a `keydown` with `getModifierState("CapsLock") === true` shows "Caps Lock is on"; the next `keyup` without it hides the note.
  - **The 8-character rule:** `mode="new"` shows "At least 8 characters" before typing; after 8 characters it has the met state (`data-met="true"`); it's linked by `aria-describedby`.
  - **Autocomplete:** `mode="current"` sets `autocomplete="current-password"`, and `new` sets `new-password`.
  - **Errors:** an `error` sets `aria-invalid="true"`.
  - **The typo hint:** typing `a@gmial.com` shows a button "Did you mean a@gmail.com?"; clicking it calls `onChange("a@gmail.com")`.
  - **The code field:** has `inputmode="numeric"` and `autocomplete="one-time-code"`, and **no `maxlength`**. Pasting "1234 5678" keeps all of it.
  - **The resend button:** disabled until `resendAt`. A polite live region announces "Send a new code" once, when it becomes enabled; it's never updated every second (check `textContent` changes at most once, with fake timers).
  - **`SubmitButton`:** shows its pending label and is disabled while its form's action is pending.
  - **Storage:** `useResetState` survives a remount from `sessionStorage`, and returns `initial` when `sessionStorage.getItem` throws.

- [ ] **Step 2: Run to verify they fail.** Run: `cd web && npx vitest run tests/unit/auth-fields.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** Use `field()` and `button()` from `components/ui/buttons`, and the `visibility` / `visibility_off` icons.

- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.** `git add web/components web/lib/auth/carry.ts web/scripts web/tests/unit && git commit -m "feat(auth): password, email and code fields"`

### Task 6: Sign-in and navigation

**Files:**
- Modify:
  - `web/app/(auth)/actions.ts`: `signIn(prev: FormState, formData: FormData): Promise<FormState>`;
  - `web/components/auth-form.tsx`: rewrite with the Task 5 parts and controlled inputs, plus a "Forgot password?" link next to the Password label (`/forgot-password`);
  - `web/app/(auth)/sign-in/page.tsx`: pass `next` from `searchParams`; `GuestGoalWarning` stays only for a guest with a goal (it already is);
  - `web/lib/supabase/middleware.ts`: a signed-in non-guest opening `/sign-in`, `/sign-up` or `/forgot-password` is redirected to `safeNext(next)`;
  - `web/components/site-header.tsx`: the guest's "Sign in" and "Save your progress" links carry `?next=<current path>`, via a small client component using `usePathname()`.
- Test: `web/tests/e2e/auth.spec.ts`

**Interfaces:**
- Consumes: `authClient` (1), `safeNext` (3), `padTo` + `SIGN_IN_MS` + `messageFor` + `FormState` (4), the fields (5).
- Produces: `AuthForm(props: { mode: "sign-in" | "sign-up"; action: (prev: FormState, fd: FormData) => Promise<FormState>; next: string; notice?: ReactNode; google?: ReactNode })`. Task 7 adds a code step and Task 9 adds the Google slot.

**The `signIn` action:**
- It validates the email, then runs the call inside `padTo(SIGN_IN_MS, …)`.
- `invalid_credentials` gives `{ status: "error", message: WRONG_CREDENTIALS, field: "password" }`.
- `email_not_confirmed` returns `{ status: "code-sent", email, kind: "signup" }`. Task 7 renders it. The code isn't re-sent automatically; the person uses "Send a new code".
- On success: `redirect(safeNext(next))`.

- [ ] **Step 1: Write the failing e2e tests** in `auth.spec.ts`, keeping the 3 existing tests:
  - `"returns to next after sign-in"`: `next=/goals?tab=map` ends on exactly that URL.
  - `"unsafe next goes to /goals"`: `next=//evil.com`.
  - `"signed-in people skip the auth pages"`: each of the 3 pages redirects to `/goals`.
  - `"email carries over between auth pages"`: type on `/sign-in`, then follow the "Create an account" link; the field is pre-filled.
  - `"fields stay filled after a failed sign-in"`: the email and password are still filled after "Email or password is incorrect.", and focus is on Password.
  - `"typo hint fixes the email"`.
  - `"double click sends one request"`: count `POST` requests to `/sign-in` with `page.on("request")`; expect 1.
  - `"keyboard only"`: Tab order is Email, "Forgot password?" (in the Password label row), Password, "Show password", "Sign in". Enter in Password submits; Space on "Show password" toggles it.
  - `"no horizontal scroll at 360 px"`: use the existing `expectNoOverlap` helper at width 360.
  - `"accessible names"`: add `@axe-core/playwright` (dev dependency) and expect zero violations on `/sign-in` and `/sign-up`.
  - **Review Focus 1:** `"email case and spaces"`. Sign up as `name@…`, then sign in as `"  Name@…  "`: success.
  - **Review Focus 2:** `"password kept exactly"`. Sign up with `"pässwörd 123 "`; signing in with it works, and `"pässwörd 123"` fails.
  - **Review Focus 5:** `"very long password"`. A password of 100 characters shows the approved message on the Password field.

- [ ] **Step 2: Run to verify they fail.** Run: `cd web && npx playwright test tests/e2e/auth.spec.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** as described above.

- [ ] **Step 4: Run them, plus the guest and shell suites.** Run: `cd web && npx playwright test tests/e2e/auth.spec.ts tests/e2e/guest.spec.ts tests/e2e/shell.spec.ts && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(auth): friendlier sign-in, next paths, signed-in redirect"` (also `git add` the new files).

### Task 7: Confirming a new account (§3.4), with confirmation turned on

**Files:**
- Modify:
  - **`supabase/config.toml`:**
    - `[auth.email]`: `enable_confirmations = true`, `otp_length = 8`, `otp_expiry = 900`, `max_frequency = "60s"`;
    - `[auth.sms]`: `enable_confirmations = true`;
    - `[auth]`: `minimum_password_length = 8`;
    - `[auth.email.template.confirmation]`, subject "Your sign-up code", `content_path = "./supabase/templates/confirmation.html"`;
    - `[auth.email.template.email_change]`, subject "Your sign-up code", `content_path = "./supabase/templates/email_change.html"`.
  - **`web/app/(auth)/actions.ts`:** `signUp`, `confirmSignUp`, `resendSignUpCode`.
  - **`web/components/auth-form.tsx`:** render the code step on `status: "code-sent"`.
  - **`web/tests/e2e/helpers.ts`:** `signUpRaw` reads the code from Mailpit and confirms.
  - **`docs/deploy.md`:**
    - Resend: account, domain DNS, API key, SMTP settings per project, a high hourly cap;
    - the dashboard steps for confirmation, SMS confirmation, password length, 60 s, 8 digits, 15 minutes;
    - pasting both templates.
- Create:
  - `supabase/templates/confirmation.html` and `email_change.html`. Each body: "Your code is {{ .Token }}. It expires in 15 minutes. If you didn't ask for this, ignore this email." No link.
  - `web/tests/e2e/mail.ts`.
  - `web/tests/unit/auth-actions.test.ts`.
- Test: `web/tests/e2e/sign-up.spec.ts`.

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5.
- Produces:
  - `signUp(prev, fd)`, `confirmSignUp(prev, fd)`, `resendSignUpCode(prev, fd)`: all `(prev: FormState, fd: FormData) => Promise<FormState>`;
  - `mailCode(email: string, after?: number): Promise<string>`, which polls `http://127.0.0.1:44324/api/v1/search?query=to:"<email>"` and returns the first 8-digit run in the newest message's text.
  - `createUnconfirmedUser(email: string, password: string): Promise<void>`, in `mail.ts`. It calls the local admin API with `email_confirm: false`, using `SUPABASE_SECRET_KEY` from `web/.env.local`. It's needed because every visitor is a guest, and a guest's unconfirmed email is only pending (C15).

**The actions:**
- **`signUp`:**
  - For a guest: `updateUser({ email, password })`, giving kind `email_change`. Otherwise `signUp`, giving kind `signup`.
  - It runs in `padTo(SEND_MS, …)`.
  - `email_exists`, `user_already_exists` and `over_email_send_rate_limit` all return `code-sent` (the last is also logged as `auth_email_send_limited` with `console.error`).
- **`confirmSignUp`:** reads `kind` and `email` from hidden fields, not from the session (Review Focus 3). It runs `verifyOtp({ email, token, type: kind })`, then `redirect(safeNext(next))`. `otp_expired` gives `CODE_WRONG` on the code field.
- **`resendSignUpCode`:** `email_change` calls `updateUser({ email })` again, and `signup` calls `resend({ type: "signup", email })`. Same masking and padding as `signUp`.

- [ ] **Step 1: Write the failing unit tests** in `auth-actions.test.ts`, mocking `@/lib/supabase/auth-server` with a fake auth object, and `next/navigation` `redirect`:
  - **Taken emails are masked:** plain `signUp` with `user_already_exists` returns `{ status: "code-sent", kind: "signup" }`; a guest's with `email_exists` returns `{ status: "code-sent", kind: "email_change" }`.
  - **The sending limit is masked:** `over_email_send_rate_limit` returns `code-sent`, and `console.error` is called with `"auth_email_send_limited"`.
  - **Plain sign-up confirms with type `signup`.** This covers the §6.2 "plain sign-up" case, since e2e can't stop the proxy from creating a guest. That's a planned deviation from §6.2.
  - **Padding:** each action awaits `padTo` (spy on `pad.ts`), with `SEND_MS`.

- [ ] **Step 2: Write the failing e2e tests** in `sign-up.spec.ts`:
  - `"guest sign-up keeps the goal"`: build a map as a guest, sign up, then `mailCode`, "Confirm". It ends signed in, the same goal is listed, and `userId` is unchanged.
  - `"taken email shows the same code screen"`: the same heading and "Already have an account? Sign in or reset your password.", and `mailCode` times out (no email).
  - `"unconfirmed sign-in goes to the code screen"`: `createUnconfirmedUser`. The right password goes to the code screen; a wrong one shows "Email or password is incorrect.". After "Send a new code" and entering it, the person is signed in.
  - `"send a new code"`: the button is disabled with the countdown. With `page.clock`, fast-forward 60 s, click it: a new code arrives, and the new code works.
  - **Review Focus 3:** `"code still works after cookies are lost"`. Sign up, `context.clearCookies()`, reload: the code screen is restored from storage. Entering the code confirms, and signing in works.
  - **Review Focus 3:** `"sign-up left on another device can start again"`. A guest signs up and doesn't enter the code. In a new context with the same email:
    - sign-in shows "Email or password is incorrect.";
    - signing up again shows the code screen, and `mailCode` returns a code;
    - entering it signs the person in.

- [ ] **Step 3: Run to verify they fail.** Run: `cd web && npx vitest run tests/unit/auth-actions.test.ts && npx playwright test tests/e2e/sign-up.spec.ts`. Expected: FAIL.

- [ ] **Step 4: Implement**, then restart the local stack so the config applies: `npx supabase stop && npx supabase start` at the repo root.

- [ ] **Step 5: Run everything that signs up.** Run: `cd web && npx vitest run && npx playwright test`. Expected: the whole suite passes. Every spec using `signUpRaw` / `signUpFresh` now goes through `mailCode`.

- [ ] **Step 6: Commit.** `git add supabase web docs && git commit -m "feat(auth): confirm new accounts with an 8-digit code"`

### Task 8: Forgot password (§3.1)

**Files:**
- Create:
  - `web/app/(auth)/forgot-password/page.tsx` and `web/components/auth/reset-form.tsx`;
  - `supabase/templates/recovery.html` (same body as Task 7's templates; subject "Your password reset code");
  - `supabase/templates/password_changed.html` ("Your password was changed. If this wasn't you, reset your password now.");
  - `supabase/templates/identity_linked.html` ("Google was linked to your account. If this wasn't you, reset your password now.");
  - `web/tests/e2e/reset.spec.ts`.
- Modify:
  - `supabase/config.toml`: `[auth.email.template.recovery]`, plus `[auth.email.notification.password_changed]` and `[auth.email.notification.identity_linked]`, each `enabled = true` with its template;
  - `web/app/(auth)/actions.ts`: `sendResetCode`, `resetPassword`, `retryNewPassword`;
  - `web/app/goals/page.tsx`: shows `PASSWORD_CHANGED` when `searchParams.notice === "password-changed"`;
  - `docs/deploy.md`: paste the recovery and the two notification templates.

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5.
- Produces: `sendResetCode`, `resetPassword`, `retryNewPassword`, all `(prev: FormState, fd: FormData) => Promise<FormState>`.
- Reset state in `useResetState("auth:reset", { step: 1, email: "", resendAt: 0 })`.

**The actions:**
- **`sendResetCode`:** runs in `padTo(SEND_MS, …)`. Any valid email gives `{ status: "code-sent", kind: "recovery", email }`; `over_email_send_rate_limit` is also logged.
- **`resetPassword`:**
  1. Checks the password with `credentialsSchema` and the code with `normalizeCode`, before any Supabase call.
  2. `verifyOtp({ type: "recovery" })`.
  3. `updateUser({ password })`.
  4. `redirect("/goals?notice=password-changed")`.
  5. If step 3 fails after step 2 succeeded, it returns `{ status: "code-accepted", email }`, with the message from `messageFor`.
- **`retryNewPassword`:**
  - `getClaims()`; if `recentEmailProof(claims, email, now)`, it runs `updateUser` (and redirects as above);
  - otherwise `signOut()`, then `{ status: "error", message: ASK_NEW_CODE }` back on step 1.

- [ ] **Step 1: Write the failing e2e tests** in `reset.spec.ts`, one per §6.2 "Reset" line:
  - `"full reset"`: ends on `/goals` with "Password changed."; the old password fails and the new one works.
  - `"other devices are signed out"`: a second `browser.newContext()`, signed in before the reset, shows "Save your progress" after a reload.
  - `"password changed email arrives"`: `mailCode` isn't used; check the Mailpit subject.
  - `"wrong code keeps the new password"`.
  - `"used code is rejected"`.
  - `"expired code is rejected"`: `UPDATE auth.users SET recovery_sent_at = now() - interval '16 minutes' WHERE email = $1`, through `docker exec supabase_db_ideas-phase-1 psql` (helper `sql(query)` in `mail.ts`).
  - `"new code replaces the old"`: after `page.clock` moves 60 s, "Send a new code"; the old code is rejected and the new one works.
  - `"unknown email gets the same answer and no email"`.
  - `"code accepted, then a different password"`: submit the current password with a good code; "Code accepted. Choose a different password." appears; a new password succeeds without a code.
  - `"reload restores step 2"`: the email and countdown come back.
  - `"already have a code"`: the step 1 link "Already have a code?" opens step 2 with the typed email.
  - `"step 2 names the account for password managers"`: a read-only input with `autocomplete="username"` holds the email; the new password has `autocomplete="new-password"`.
  - `"pasted code keeps 8 digits"`.
  - `"guest warning only with a goal"`.
  - **Review Focus 4:** `"back after success"`. Finish a reset, `page.goBack()`, resubmit: "That code is wrong or has expired." or a redirect to `/goals`, never "Something went wrong. Please try again.".

- [ ] **Step 2: Run to verify they fail.** Run: `cd web && npx playwright test tests/e2e/reset.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**, then restart the local stack: `npx supabase stop && npx supabase start` at the repo root.

- [ ] **Step 4: Run to verify they pass, plus the full suite.** Run: `cd web && npx playwright test && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit.** `git add supabase web docs && git commit -m "feat(auth): reset a forgotten password with an emailed code"`

### Task 9: Continue with Google (§3.3)

**Files:**
- Modify:
  - **`supabase/config.toml`:**
    - `[auth]`: `enable_manual_linking = true`; `additional_redirect_urls` adds `http://127.0.0.1:3000/auth/callback**` and `http://localhost:3000/auth/callback**`;
    - `[auth.external.google]`: `enabled = true`, `client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"`, `secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"`.
  - **`web/components/auth-form.tsx`:** render the `google` slot above an "or" divider.
  - **`web/app/(auth)/sign-in/page.tsx` and `sign-up/page.tsx`:** pass `<GoogleButton …>` with `linkGuest` true only for a guest with a goal.
  - **`web/app/page.tsx`:** show `GOOGLE_FAILED` when `searchParams.error` is present.
  - **`docs/deploy.md`:**
    - the Google Cloud OAuth client and redirect URI;
    - the consent screen's name, logo and **publishing**, and the note that it shows `<ref>.supabase.co`;
    - the dashboard's redirect glob `https://<site>/auth/callback**` and manual linking;
    - the advisory check, and the rule that no other provider is turned on.
- Create: `web/components/auth/google-button.tsx`, `web/app/auth/callback/route.ts`, `web/tests/e2e/google.spec.ts`

**Interfaces:**
- Consumes: `authClient` (1), `safeNext` (3), `messageFor` / `GOOGLE_*` (4).
- Produces:
  - `GoogleButton(props: { from: "signin" | "signup"; next: string; linkGuest: boolean })`: a form posting to the server action `startGoogle`.
  - `startGoogle(fd: FormData): Promise<never>`: `linkIdentity` or `signInWithOAuth` with `redirectTo = ${origin}/auth/callback?next=…&from=…`, then `redirect(data.url)`.
  - `GET /auth/callback`: on success, `exchangeCodeForSession(code)`, then `redirect(safeNext(next))`. On an error, `redirect("/sign-in" | "/sign-up" + "?google_error=<error_code or error>&next=…")`.
  - The form shows `messageFor(google_error)`. For `GOOGLE_HAS_ACCOUNT`, it also shows a "Continue with Google" button with `linkGuest=false`.

- [ ] **Step 1: Write the failing e2e tests** in `google.spec.ts`. Google itself is stubbed: `page.route("https://accounts.google.com/**", …)` captures the URL and fulfils it with a 200 blank page.
  - `"redirects to Google with the callback, next and from"`: Supabase's `/authorize` redirects to Google; the decoded `redirect_to` is `http://localhost:3000/auth/callback?next=%2Fgoals%3Ftab%3Dmap&from=signin`.
  - `"Google warning only with a goal"`: the guest-goal warning under the button is shown for a guest with a goal, and not for a guest without one.
  - Callback error cases, each a direct `page.goto("/auth/callback?error=…&error_code=…&from=signup&next=%2Fgoals")`:
    - `access_denied` gives "Google sign-in didn't finish. Please try again." on `/sign-up`;
    - `identity_already_exists` and `email_exists` give "This Google account already has an account here. Continue to sign in to it? Your guest goal won't be kept.", plus the button;
    - an unknown error gives the Google failure message;
    - `from=evil` lands on `/sign-in`.
  - `"error on the Site URL"`: `page.goto("/?error=access_denied&error_description=x")` shows the Google failure message.
  - `"next with a query string survives"`: `page.goto("/auth/callback?code=bad&next=%2Fgoals%3Ftab%3Dmap")` with a bad code shows the failure message on `/sign-in`, with `next` kept in the URL, never on `/`.

- [ ] **Step 2: Add the unit test** `"startGoogle links a guest with a goal, otherwise signs in"` to `tests/unit/auth-actions.test.ts`. With the auth client mocked:
  - `linkGuest=true` calls `linkIdentity({ provider: "google", options: { redirectTo } })`;
  - `false` calls `signInWithOAuth` with the same `redirectTo`.

  This runs on the server, so the browser can't see which one was used.

- [ ] **Step 3: Run to verify they fail.** Run: `cd web && npx vitest run tests/unit/auth-actions.test.ts && npx playwright test tests/e2e/google.spec.ts`. Expected: FAIL.

- [ ] **Step 4: Implement**, then restart the local stack. With the Google env vars unset, `supabase start` still works (§4.3, C18).

- [ ] **Step 5: Run to verify they pass, plus the full suite.** Run: `cd web && npx playwright test && npx vitest run && npx tsc --noEmit && npm run lint`. Expected: PASS.

- [ ] **Step 6: Commit.** `git add supabase web docs && git commit -m "feat(auth): continue with Google, keeping a guest's goal"`

### Task 10: Stress and fault runs (§6.3)

**Files:**
- Create: `web/playwright.stress.config.ts` (same web servers as `playwright.config.ts`, `workers: 1`, timeout 10 minutes) and `web/tests/stress/auth.stress.ts`.
- Output: `web/test-results/stress-auth.json` (git-ignored, since `test-results/` already is).

**Interfaces:**
- Consumes: `mailCode`, `sql` (Tasks 7–8) and `newEmail` (helpers).

- [ ] **Step 1: Write `auth.stress.ts`**

**The load run:**
- For waves of **10, 25 and 50**, it opens that many `browser.newContext()` at once. Each runs: guest sign-up, confirm by code, sign out, sign in, ask for a reset code, reset.
- It records each step's ms and on-screen message into the JSON.
- It asserts, per wave:
  - no step failed;
  - no message was "Too many attempts…" or "Something went wrong…";
  - no response had status ≥ 500;
  - each context's final `userId` belongs to its own email: compare with `select id from auth.users where email = $1`.

**The limits run:** asking for a reset code twice within 60 s shows the normal sent message both times.

- [ ] **Step 2: Run it.** Run: `cd web && npx playwright test -c playwright.stress.config.ts`. Expected: PASS. Then print the median and p95 per step from the JSON.

- [ ] **Step 3: The fault runs**, as two more tests in the same file:
  - `"auth stopped mid-reset"`: after "Send code", `docker stop supabase_auth_ideas-phase-1`. "Reset password" must show "Something went wrong. Please try again." with no 500 page. After `docker start` and waiting for `/auth/v1/health`, the same form succeeds.
  - `"slow 3G"`: CDP `Network.emulateNetworkConditions` (latency 400 ms, 400 kbit/s). "Signing in…" is visible and the button is disabled; one POST only.

  Run: the same command. Expected: PASS.

- [ ] **Step 4: Commit** the scripts, and put the summary table (waves × steps × median/p95/errors) in the PR description.

  `git add web/playwright.stress.config.ts web/tests/stress && git commit -m "test(auth): stress and fault runs"`

### Task 11: Usability and screen-reader pass (§6.4)

- [ ] **Step 1: Walk through each flow at 360 px and at 1280 px**, using the `run` skill's browser driving to take screenshots: sign-up and confirm, unconfirmed sign-in, reset (including the "code accepted" path and a reload), and Google (stubbed).
- [ ] **Step 2: Screen readers.** VoiceOver on iOS, and NVDA or VoiceOver on desktop. **The user runs these**, following a short script I write (what to listen for: field names, the 8-character note, Caps Lock, errors announced once, resend announced once).
- [ ] **Step 3: Write `docs/qa/2026-10-28-auth-usability.md`** with each confusing point, its screenshot, and its fix. Fix each, with a test where one applies, then re-run `cd web && npx playwright test && npx vitest run`. Expected: PASS.
- [ ] **Step 4: Commit.** `git add docs/qa web && git commit -m "fix(auth): usability pass"`

### Task 12: Staging checks after the user's setup (§6.5)

These need the user's Resend, Google Cloud and dashboard setup from `docs/deploy.md`. Release the branch to staging first (with the user's OK for each merge).

- [ ] **Step 1: Re-read both projects' Auth versions** with `GET /auth/v1/health` (publishable key). If either isn't v2.197.0, recheck the §4.3 rows marked "Source" or "Local" on that project before going on (spec §4.3).
- [ ] **Step 2: Padding times.**
  - Measure, 30 or more runs each, through the app on staging: a correct-password sign-in, and a real email send for sign-up, send code and resend.
  - Set `SIGN_IN_MS` and `SEND_MS` in `lib/auth/pad.ts` above each p99, rounded up to the next 250 ms.
  - If the sends' p99 is over 3,000 ms, or more than twice their median, move the Supabase calls in `sendResetCode`, `resendSignUpCode` and `signUp` into `after()` instead. The guest's resend builds its client from the session read before `after()`. Then tell the user.
  - Commit the values with the measurements in the message.
- [ ] **Step 3: Google.**
  - A real sign-in as a guest with a goal: the goal is kept.
  - Cancelling on Google's screen gives the Google failure message.
  - Linking a Google account that already has an account here shows the "already has an account" message.
  - A guest linking a Google account whose email belongs to an email/password account shows the same message (C13).
- [ ] **Step 4: Real emails.** One reset and one sign-up through Resend: the codes have 8 digits; the "password changed" and "Google linked" emails arrive.
- [ ] **Step 5: Per-IP limit message.** From one IP, trip the sign-in limit: "Too many attempts. Please wait a minute and try again." is shown.
- [ ] **Step 6: Record everything in the PR description,** and update spec §4.3 for any row that turned out different on staging.
