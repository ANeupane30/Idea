# Password Reset and Friendlier Sign-in: Design

**Status:** Approved on 2026-10-28, after review and two revisions.
- Both design sections were approved by the user on 2026-10-27.
- A review on 2026-10-28 found problems and asked for decisions. The user decided:
  - turn on email confirmation;
  - harden the "never reveal" promise;
  - use 8-digit codes that last 15 minutes;
  - pass each person's IP address to Supabase.

  This revision applies those decisions.
- The user approved the spec with two last changes: `recentEmailProof` is spelled out (4.1), and the staging Auth version is recorded (4.3). The answers to section 8 are recorded there.

**Supabase behaviour:** every claim about it here was checked against Supabase Auth (GoTrue) **v2.197.0**, the version in the local stack. Each was checked in its source, by an experiment on the local stack, or in Supabase's docs, as noted. Section 4.3 lists them. What couldn't be confirmed is in section 8.

## 1. Why

People can sign up and sign in with an email and password, but **someone who forgets their password can't get back in**. There is no reset.

The sign-in and sign-up forms are also bare:
- No way to see the password you typed.
- No hint before submitting that a password needs 8 characters.
- No "please wait" state while the form is sent.
- After signing in, you always land on the goals page, whatever page you came from.
- No sign-in with Google.

**Goal:** anyone can recover their account without help, and signing in or up is quick and hard to get wrong, on a phone or a desktop, by mouse, keyboard or screen reader.

## 2. Decisions (from the user)

- **Reset by a code sent by email.** No reset link.
- **Codes have 8 digits and last 15 minutes** (`otp_length = 8`, `otp_expiry = 900`).
  - Changed after review from 6 digits and 1 hour.
  - The reason: an attacker can ask for a new code every 60 seconds and keep guessing, so the guessing rate, not the expiry, decides how long a code holds out. See *Remaining risk* below.
- **Email confirmation on sign-up is turned on,** with a code like the reset (3.4).
  - Changed after review: the first version kept it off.
  - The reason: with it off, sign-up marks the email confirmed straight away. A later "Continue with Google" with that email is then linked to the account, and its password stays. So someone could sign up with another person's email, wait, and still sign in with their own password after the real owner arrives through Google (4.3, checks C1–C2).
  - With confirmation on, Supabase removes an unconfirmed account's password and other identities when the real owner signs in with Google.
- **Emails are sent through Resend** (SMTP) on staging and production. Locally, they go to Supabase's test mailbox (Mailpit).
- **Included:** password field help, clearer form feedback, smoother navigation, and "Continue with Google".
- **Not included:** an account page, and changing the password while signed in. People who want a new password use "Forgot password?".
- **Never reveal whether an email has an account, and harden it** (decided after review). Every action that takes an email gives the same answer, whether or not an account exists:
  - **Which actions:** sign-in, sign-up, "send code", and both kinds of "send a new code".
  - **Same timing:** each answers after a fixed minimum time (4.1, `padTo`).
  - **Sending limits:** the per-email sending limit is treated as "sent" (5).
  - **A taken email:** gets the same "enter the code we sent" screen as a new one.
- **Supabase sees each person's IP address,** not our server's (decided after review).
  - Server-side auth calls send the person's IP in `Sb-Forwarded-For`, with the secret key, from a client that can only reach `.auth` (4.1).
  - The first implementation step checks on staging that this still rate-limits each person (4.4).

**Assumptions** (stated to the user in the design; none was corrected):
- A guest who signs up, or links Google while they have a goal, keeps their goal.
- Captcha is out of scope (7).
- The user does the outside setup: Resend, Google Cloud, the Supabase dashboard and Vercel. This work documents the exact steps.

**Remaining risk (accepted).** Codes can be guessed through Supabase's API directly, using the public key.
- **What limits the guessing:**
  - The only limit on code checks is per IP: 30 per 5 minutes (4.3, R5).
  - Supabase counts no attempts per code. A wrong code and an expired one give the same answer (C9).
  - Captcha doesn't cover the code check (C17).
  - Attempt counters in our server actions don't help, since the attacker never goes through them.
- **The odds:** an attacker with 1,000 IP addresses gets 6,000 guesses a minute.
  - Each code faces about 6,000 guesses before the next one replaces it, so each has a 0.006 % chance.
  - That's about **8 % a day**, about 45 % after a week, and about 65 % after 12 days.
  - Throughout, the victim gets a reset email every minute.
- **Deliberately not done here:** detecting floods of resets for one email and pausing them, and lowering the code-check limit. Both are deferred until after the first release (7).

## 3. What people see

### 3.1 Forgot password

1. **The link.** The sign-in page has a "Forgot password?" link next to the Password label. Any email already typed carries over.
2. **Step 1, ask for a code.** The reset page asks for the email; the button is "Send code". The answer is always the same, and arrives after the same time, whether or not an account exists:
   > If there's an account for this email, we sent an 8-digit code. It expires in 15 minutes.

   Step 1 also has an "Already have a code?" link that goes straight to step 2.
3. **Step 2, same page.**
   - **Who it's for:** the email is shown in a read-only field (`autocomplete="username"`), so password managers update the right entry.
   - **"Code":**
     - one field;
     - `inputmode="numeric"` and `autocomplete="one-time-code"`;
     - **no `maxlength`**, so a pasted "1234 5678" isn't cut short;
     - a pasted "1234 5678" or "1234-5678" works.
   - **"New password":** same rules and help as sign-up.
   - **"Reset password":** one button that checks the code and saves the new password in one go. The person is then signed in and taken to their goals, with a "Password changed" note.
4. **Checked before the code is used.** The new password's length and the code's format are checked first. A form that fails either never sends the code to Supabase, so the code isn't used up.
5. **A wrong or expired code** shows "That code is wrong or has expired." The new password stays filled in.
6. **A good code, but the password is refused** (for example, it's the current password). By then Supabase has used up the code and signed the person in (4.3, C3–C4). So:
   - The page stays on step 2, in a "code accepted" state: the code field is replaced by "Code accepted. Choose a different password." The new password field stays.
   - "Reset password" now saves the password on the current session, without a code.
   - This retry is allowed only for a session that proved the inbox just now (4.1, `recentEmailProof`). If the check fails, the person is signed out and asked for a new code.
7. **Resending.**
   - "Send a new code" shows a 60-second countdown, and is disabled until it ends.
   - When it's available again, screen readers hear it once. The countdown isn't read out every second.
   - A new code makes the old one stop working (C6).
   - "Use a different email" goes back to step 1.
8. **Surviving a reload.** On phones, switching to the mail app often reloads the tab. The page keeps the step, the email and the countdown's end time in `sessionStorage`, and restores them when it loads. The person lands back on step 2 with the countdown still right, and doesn't ask for a code that would replace the one they just read.
9. **Too many attempts** (Supabase's per-IP limit) shows "Too many attempts. Please wait a minute and try again."
10. **A guest with a goal** sees the same warning as on sign-in: "Signing in to another account won't keep your guest goal." A guest without a goal sees no warning.
11. **After the reset:**
    - Every other device signed in to the account is signed out (C7).
    - A "Your password was changed" email is sent (4.2).

### 3.2 Sign in and sign up

**Password help**
- A show/hide button on every password field, labelled "Show password" / "Hide password" for screen readers.
- "Caps Lock is on" under the field while Caps Lock is on.
- On sign-up and reset, "At least 8 characters" is shown before typing, and turns into a tick once met.
- Both notes are tied to the field with `aria-describedby`.

**Form feedback**
- While waiting, the button reads "Signing in…", "Creating account…", "Sending code…" or "Resetting…", and is disabled, so a double click sends one request.
- **Typed text stays.** The email and password fields are controlled inputs. React 19 resets uncontrolled inputs after a `<form action>` finishes, and that would clear what the person typed.
- After an error:
  - focus moves to the field that needs fixing, which gets `aria-invalid`;
  - the message is in a `role="alert"` region.
- Common email typos get a hint, for example "Did you mean name@gmail.com?". Tapping the hint fixes the email. The rules:
  - **Domains covered:** gmail.com, googlemail.com, yahoo.com, hotmail.com, outlook.com, live.com, icloud.com, me.com, aol.com, proton.me, protonmail.com.
  - **What counts as a typo:** a domain one edit away from one in the list (a letter added, removed, changed, or two letters swapped).
  - **Never suggested,** because they're real mail domains near the list: mail.com, email.com, ymail.com, mac.com, cloud.com, my.com, mi.com.
  - **me.com** is special: almost every two-letter `.com` is one edit away from it. So for me.com, only fixes to the ending are suggested (`me.cm`, `me.co`).
- **Autocomplete:**
  - the email field uses `email`;
  - the password uses `current-password` on sign-in, and `new-password` on sign-up and reset.

**Navigation**
- **Return to where you were.** Sign-in and sign-up take a `next` path and go there afterwards. `safeNext` (4.1) only lets through paths on this site; anything else goes to `/goals`.
- **Already signed in.** A signed-in person (not a guest) who opens sign-in, sign-up or forgot-password is sent to `next`, or to `/goals`.
- **Email carries over** between sign-in, sign-up and forgot-password through `sessionStorage`, never the URL.

**Sign-in with an unconfirmed account.** If the password is right but the email isn't confirmed yet, the form moves to the sign-up code screen (3.4). This can only happen after a correct password (C11), so it reveals nothing to someone who doesn't know the password.

### 3.3 Continue with Google

- **Where.** "Continue with Google" is at the top of the sign-in and sign-up forms, above an "or" divider.
- **A guest with a goal is linked, not replaced.** Google is linked to the guest account (`linkIdentity`), so the goal is kept.
- **Everyone else signs in.** A guest without a goal, or anyone else, uses `signInWithOAuth`. A new Google user gets a new account. Every visitor gets a guest session (the proxy creates one), which is why "has a goal" decides, not "is a guest".
- **The guest-goal warning** under the button is shown only when there's a goal.
- **The Google account already has an account here.** Linking fails in two ways (C13–C14):
  - the Google identity is already linked to another user (`identity_already_exists`);
  - the Google email belongs to an email/password account (`email_exists`).

  Both show:
  > This Google account already has an account here. Continue to sign in to it? Your guest goal won't be kept.

  with a "Continue with Google" button that signs in normally (`signInWithOAuth`). That sign-in links Google to the existing account if its email is confirmed.
- **Cancelled or failed.** If Google sign-in is cancelled or fails, the person is back on the form they came from, with "Google sign-in didn't finish. Please try again."
- **Which form to return to.** The callback URL carries `from=signin` or `from=signup`, checked against that list (anything else means `signin`), and `next`.

### 3.4 Confirming a new account

1. **After "Sign up"** the form moves to a code screen, which says:
   > Enter the 8-digit code we sent to name@example.com. It expires in 15 minutes.

   with "Already have an account? Sign in or reset your password." underneath.
2. **The same screen for a taken email.** This screen appears, at the same time, whether the email is new or already has an account (2). For a taken email no code arrives. That's why the line about having an account is always shown.
3. **The code field** works as in reset step 2 (3.1.3). "Confirm" checks it. The person is then signed in, and taken to `next` or their goals.
4. **Guests keep their goal.**
   - A guest's sign-up sets the password at once, but stays a guest until the code is entered (C15).
   - Entering the code turns the same user (same ID, same goal) into a full account.
5. **"Send a new code"** has the same countdown, reload survival and answer as in 3.1. Its answer and timing are the same for a pending sign-up, a taken email, and an unknown email (2).
6. **A wrong or expired code** shows "That code is wrong or has expired."

## 4. How it's built

### 4.1 Web app

| Piece | Job |
|---|---|
| `lib/supabase/auth-server.ts` | **The only place the secret key is used.** Starts with `import "server-only"` (the `server-only` package is added). Exports `authClient()`, which builds a new `createServerClient` for each request and returns **only `client.auth`**, so no database query can run with the secret key. Rules: `apikey` is the secret key; the person's session (cookies) is used as normal; `Sb-Forwarded-For` is set to the person's IP from `x-vercel-forwarded-for`, and is **left out** when that header is missing (local development). The IP is never taken from any other header. Used only in `app/(auth)/actions.ts`, the OAuth callback and the proxy's guest creation. |
| `app/(auth)/forgot-password/page.tsx` | The two-step reset page (3.1). Its state (step, email, countdown end) lives in `sessionStorage`. |
| `app/(auth)/actions.ts` | See the actions below the table. |
| `app/auth/callback/route.ts` | Google returns here. On success, `exchangeCodeForSession(code)`, then a redirect to `safeNext(next)`. On an error, which arrives in the query string (C16), a redirect to the form named by `from`, with an error code that the form turns into a message (5). |
| `app/page.tsx` | If Google sent the person to the Site URL instead, because the callback URL wasn't on the allow list (C16), the page sees `error` in the query and shows "Google sign-in didn't finish. Please try again." |
| `components/auth-form.tsx` | Composes the parts below. Keeps the existing look (`button`, `field`, tokens). Uses controlled inputs for email, password and code. |
| `components/auth/password-field.tsx` | Show/hide, Caps Lock, the 8-character rule. |
| `components/auth/email-field.tsx` | Typo hint; reads and writes the carried-over email. |
| `components/auth/code-field.tsx` | The 8-digit code field (3.1.3). |
| `components/auth/google-button.tsx` | Starts Google: `linkIdentity` for a guest with a goal, `signInWithOAuth` otherwise. `redirectTo` is the callback with `next` and `from`. |
| `lib/auth/next.ts` | `safeNext(value)`. Parses with `new URL(value, origin)`. Accepts only a value that starts with a single `/`, where the parsed URL has the same origin and no backslash or control character in the input. Returns the pathname, search and hash. Anything else gives `/goals`. |
| `lib/auth/email-suggest.ts` | `suggestEmail(email)` with the rules in 3.2. |
| `lib/auth/code.ts` | `normalizeCode(value)`. Strips spaces and dashes; needs exactly 8 digits. |
| `lib/auth/errors.ts` | Maps Supabase auth errors to the messages in section 5, by `error.code` only, never by the message text. |
| `lib/auth/pad.ts` | `padTo(ms, work)`. Runs `work`, then waits until at least `ms` have passed since it started, and returns or rethrows its result. Takes a clock, so tests can use a fake one. |
| `lib/auth/recent-proof.ts` | `recentEmailProof(claims, email, now)`. **True only for a session created by an email code within the 15-minute code lifetime**, for the email on the form. It checks four things, and all must hold: the claims come from `getClaims()`, which verifies Supabase's signature; `amr` has an entry with `method: "otp"`; that entry's `timestamp` is no more than 900 s before `now` (and not after it); the claims' `email` equals the form's email, ignoring case. This is reliable (C19): Supabase adds the `otp` entry only when a code creates a new session, sets its time itself, and keeps it unchanged on refresh. If any part is missing or fails, the result is false. |
| `lib/supabase/middleware.ts` | Redirects signed-in, non-guest people away from the auth pages (3.2). Creates the guest session through `authClient()`, so new-guest limits apply to the visitor's IP. |

**The actions in `app/(auth)/actions.ts`:**
- **`signIn`:**
  - Runs inside `padTo(SIGN_IN_MS, …)`. Supabase answers an unknown email about 8 times faster than a wrong password (R3).
  - `email_not_confirmed` moves the form to the code screen (3.4).
  - Reads `next` through `safeNext`.
- **`signUp`:**
  - Validates the email and password first.
  - For a guest: `updateUser({ email, password })`. For anyone else: `signUp`.
  - Then the code screen.
  - `email_exists` (guest) and `user_already_exists` (others) are masked as success (2).
  - Runs inside `padTo(SEND_MS, …)`.
- **`confirmSignUp`:**
  - `verifyOtp` with type `email_change` for a guest, `signup` for anyone else (C15).
  - Then a redirect to `safeNext(next)`.
- **`sendResetCode`:**
  - `resetPasswordForEmail(email)`.
  - Returns the same "sent" result for every valid email.
  - `over_email_send_rate_limit` counts as sent (5). It's also logged at error level as `auth_email_send_limited`, which raises an alert, because the hourly sending cap returns the same code (C10).
- **`resendSignUpCode`:**
  - For a guest, `updateUser({ email })` again. Supabase's `resend` doesn't find a guest's pending email (C15).
  - For anyone else, `resend({ type: "signup" })`.
  - Masked and padded like `signUp`.
- **`resetPassword`:**
  1. Checks the password length and the code format.
  2. `verifyOtp({ email, token, type: "recovery" })`.
  3. `updateUser({ password })`.
  4. A redirect to `/goals?notice=password-changed`.
  5. If step 3 fails after a good code, it returns the "code accepted" state (3.1.6).
- **`retryNewPassword`:** for the "code accepted" state. Runs `updateUser({ password })` only if `recentEmailProof` holds; otherwise it calls `signOut()` and asks for a new code.

**Padding times.**
- `SIGN_IN_MS` starts at 1,500 ms, and `SEND_MS` also starts at 1,500 ms.
- **Both are set from staging measurements with Resend** (6.5). Each must be above the 99th-percentile time of its slowest real case: a correct password check for sign-in, a real email send for the others.
- **If real sends vary too much for a sensible `SEND_MS`,** the Supabase call in `sendResetCode` and `resendSignUpCode` moves into Next's `after()`. Those two then answer "sent" at once, and lose the per-IP "Too many attempts" message, which the user accepted.
  - `after()` runs in Server Functions and can read cookies, but can't set them once the response has gone.
  - So the guest resend builds its client from the session read before `after()`. A token refresh inside `after()` wouldn't be saved.
  - Sign-up also sends an email; see section 8.

**Recovery sessions.** After a good code, the person is signed in with a new session created by that code. If the password save then fails, that session stays, and is used for the "code accepted" retry while `recentEmailProof` holds (3.1.6). That's at most 15 minutes after the code was checked. After that, the person is signed out and needs a new code.
- `amr` records `otp` for a reset code and for an email sign-in code alike (C5), so the check can't tell the two apart. Both prove the person controls the inbox, which is what the retry needs.
- A session that started with a password never gets an `otp` entry, so it can't use the retry (C19).
- Supabase itself would accept a password change from any session (`secure_password_change` is off). This check is the app's own rule.

### 4.2 Supabase

**`supabase/config.toml`:**
- **`[auth]`:**
  - `minimum_password_length = 8`; `password_requirements` stays empty;
  - `enable_manual_linking = true`, which `linkIdentity` needs;
  - `additional_redirect_urls` adds `http://127.0.0.1:3000/auth/callback**` and `http://localhost:3000/auth/callback**`.
- **`[auth.email]`:**
  - `enable_confirmations = true`;
  - `otp_length = 8` (Supabase accepts 6 to 10, and silently uses 6 outside that range, C8);
  - `otp_expiry = 900`;
  - `max_frequency = "60s"`.
- **`[auth.sms]`:** `enable_confirmations = true`. SMS sign-up stays off. This is needed because Supabase only hides an existing account on plain sign-up when SMS autoconfirm is also off (C12).
- **Email templates** (`supabase/templates/`), each with the code (`{{ .Token }}`), its 15-minute expiry, and "If you didn't ask for this, ignore this email." None has a link.
  - `[auth.email.template.recovery]`: reset.
  - `[auth.email.template.confirmation]`: plain sign-up, "Confirm signup".
  - `[auth.email.template.email_change]`: guest sign-up, "Change email address". For a guest, `{{ .Token }}` is the code for the new address (C15).
- **Notifications:** `[auth.email.notification.password_changed]` and `[auth.email.notification.identity_linked]`, each turned on with its own template.
- **`[auth.external.google]`:**
  - turned on, with `client_id` and `secret` read from environment variables;
  - with the variables unset, `supabase start` still works, and the button leads to Google's error page (C18);
  - local development and tests stub Google (6.2).
- **IP forwarding:**
  - Local development has neither IP forwarding nor per-IP rate limits (R6), so `Sb-Forwarded-For` is simply not sent there (4.1).
  - No local setting is needed.

**[docs/deploy.md](../../deploy.md)** gets the user's steps:
- **Resend:**
  - create an account, verify the sending domain (DNS records) and create an API key;
  - enter Resend's SMTP settings in each Supabase project;
  - set a **high** emails-per-hour limit. The hourly cap answers like the per-email limit, so hitting it means nobody gets codes (C10).
- **Google Cloud:**
  - Create an OAuth client (web). Its authorised redirect URI is `https://<ref>.supabase.co/auth/v1/callback`. Enter the client ID and secret under Supabase → Authentication → Providers → Google.
  - Set the consent screen's app name and logo, and **publish** it. In Testing mode, only listed test users can sign in.
  - Note: the consent screen shows `<ref>.supabase.co` unless a Supabase custom domain is set up.
- **Supabase dashboard,** for each project:
  - **Email templates:** paste the three code templates and the two notification templates.
  - **Site URL and redirects:** set the Site URL, and add `https://<site>/auth/callback**` to the redirect URLs.
  - **Linking:** turn on manual linking. Then confirm that the project's Auth version includes the fix for advisory ANT-2026-7WJV60DR (https://red.anthropic.com/2026/cvd/findings/ANT-2026-7WJV60DR), which concerns manual linking (8).
  - **Email confirmation:** turn it on, with 8-digit codes and a 15-minute expiry.
  - **SMS:** turn on SMS confirmations (`[auth.sms] enable_confirmations = true`).
  - **Passwords and resends:** set the minimum password length to 8, and 60 s between emails.
  - **IP Address Forwarding:** turn it on under Authentication → Rate Limits.
- **Vercel:**
  - add `SUPABASE_SECRET_KEY` as a server-only environment variable, never `NEXT_PUBLIC_`;
  - the secret key's rotation (create a new key, deploy, then revoke the old one).
- **Warning:** nothing may sit in front of Vercel. A proxy such as Cloudflare would make every person appear to come from the proxy's address, and they would all share one set of rate limits.

### 4.3 Supabase behaviour this design relies on

Checked on Supabase Auth v2.197.0 (local stack). "Source" means the supabase/auth repository at tag v2.197.0; "Local" means an experiment on the local stack; "Docs" means supabase.com/docs/guides/auth/rate-limits.

**Staging runs the same version.** `GET https://iaxhzwsyacnbnwihfxdy.supabase.co/auth/v1/health`, called with the publishable key on 2026-10-28, answered `{"version":"v2.197.0","name":"GoTrue"}`. So none of the rows below needs rechecking because of a version difference. Production hasn't been checked. The implementation plan reads both projects' versions again before the 4.4 gate; if either differs from v2.197.0, every row marked "Source" or "Local" is rechecked on that project first.

| # | Behaviour | How checked |
|---|---|---|
| C1 | With confirmation off, a new email/password account is confirmed at once. A later OAuth sign-in with the same email is linked to it, and the password stays. | Source: `external.go` LinkAccount case; `models/linking.go` |
| C2 | If that account is unconfirmed, the OAuth sign-in removes its password and other identities. A reset code also confirms an unconfirmed account. | Source: `external.go:411`, `models/user.go` `RemoveUnconfirmedIdentities`; `verify.go` `recoverVerify` |
| C3 | A good reset code is used up by `verifyOtp`, even if the following `updateUser` fails. Trying it again gives `otp_expired`. | Local |
| C4 | `verifyOtp` writes the session cookie. Then `updateUser` with the current password fails with `same_password` (422). A retry with another password on that session works without a code. | Local |
| C5 | After a code check, the session's `amr` is `[{ "method": "otp", "timestamp": … }]`. | Local; Source: `verify.go` (POST verify issues `models.OTP`) |
| C6 | A new reset code replaces the old one; the old one gives `otp_expired`. | Local; Source: `mail.go` `sendPasswordRecovery` |
| C7 | A password change deletes the person's other sessions: their refresh fails, and `/user` answers `session_not_found`. Their access token still reads the data API until it expires (up to `jwt_expiry`, 1 hour). | Local; Source: `models/user.go` `UpdatePassword` → `LogoutAllExceptMe` |
| C8 | `otp_length = 8` gives 8-digit codes. Values outside 6–10 silently become 6. | Local; Source: `conf/configuration.go:1206` |
| C9 | Code expiry is measured from `recovery_sent_at`. A wrong code and an expired one both give `otp_expired` (403). Nothing counts attempts per code. | Local; Source: `verify.go` `isOtpExpired`, `verifyUserAndToken` |
| C10 | The per-email 60 s limit and the hourly sending cap both give `over_email_send_rate_limit` (429). The per-email limit only applies to real accounts. An unknown email gets `200` with nothing sent. | Local; Source: `mail.go:420`, `mail.go:726`, `recover.go:52` |
| C11 | Sign-in: an unknown email, or an account without a password, gets `invalid_credentials` before any password check. `email_not_confirmed` comes only after a correct password. | Source: `token.go:110–182`; Local |
| C12 | With confirmation on, plain sign-up of a confirmed email still gives `user_already_exists` while SMS autoconfirm is on. Supabase hides it only when both email and SMS autoconfirm are off. | Local; Source: `signup.go:293` |
| C13 | A guest (no email) linking a Google account whose email belongs to another account gets `email_exists`, and the link is rolled back. | Source: `identity.go:199–203` |
| C14 | Linking a Google identity that's already linked gives `identity_already_exists`. | Source: `identity.go:181–186` |
| C15 | Plain sign-up sends the `confirmation` email and is checked with type `signup`. A guest's `updateUser({ email, password })` sends the `email_change` email, sets the password at once, keeps the guest anonymous until the code is checked with type `email_change`, and keeps the same user ID. `resend` finds users by `email` only, so it sends nothing for a guest's pending email; `updateUser` again does (429 within 60 s). A guest's sign-up with a taken email gives `email_exists`, whatever the confirmation setting. | Local; Source: `mail.go`, `resend.go`, `user.go:135–138`, `models/user.go` `FindUserByEmailAndAudience` |
| C16 | A redirect is valid if its scheme, host and port match the Site URL, whatever its path and query. Loopback IPs are always valid. Otherwise the URL, without its fragment, is matched against the allow-list globs. An invalid `redirectTo` silently becomes the Site URL. OAuth errors arrive in both the query string and the fragment, and the redirect's own query (`next`, `from`) is kept. | Local (authorize + fake error callback); Source: `utilities/request.go:94`, `external.go:821–845` |
| C17 | Captcha covers `/signup` (including guests), `/recover`, `/resend`, `/magiclink`, `/otp` and password sign-in. It doesn't cover `/verify` (code checks) or `/user` (a guest's email change). It's skipped for requests with admin credentials. | Source: `api.go:229–268`, `middleware.go:242–283` |
| C18 | `supabase start` works with Google turned on and its environment variables unset. The literal `env(...)` text is used as the client ID. | Local |
| C19 | A code check creates a new session whose `amr` is only `[{ "method": "otp" }]`. Nothing carries over from an earlier password session. The timestamp is the time Supabase recorded the claim, and a refresh keeps it unchanged (tested 3 s apart). Claims are added only when a session is issued, never on refresh. | Local; Source: `tokens/service.go:939` (`IssueRefreshToken` → `AddClaimToSession`), `tokens/service.go:194` (`RefreshTokenGrant`, no claim added), `models/sessions.go:390` |
| R1 | Rate limits use the calling IP. For server-side calls, that's the server's. | Docs |
| R2 | `Sb-Forwarded-For` carries the person's IP. It works only when IP Address Forwarding is turned on for the project, and only on requests made with a secret API key. Supabase Auth trusts its first value. | Docs; Source: `sbff/sbff.go`, README |
| R3 | Sign-in with a wrong password takes about 96 ms locally; an unknown email takes about 12 ms. A reset for a real account takes about 45 ms; for an unknown email, about 12 ms. | Local |
| R4 | Hosted defaults: sign-ups and sign-ins, 30 per 5 minutes per IP; code checks, 30 per 5 minutes per IP; new guests, 30 per hour per IP; 60 s between emails to one user. | Docs |
| R5 | The only limit on code checks is the per-IP one in R4. | Source: `api.go:270` |
| R6 | The local stack sets no rate-limit header, so per-IP limits aren't enforced there: 35 sign-ins, code checks and guest sign-ups from one IP all went through. The per-email 60 s limit is enforced. | Local; Source: `middleware.go:73–78` |
| R7 | Vercel overwrites `X-Forwarded-For` with the client's public IP, and doesn't forward external IPs, to prevent spoofing. `x-vercel-forwarded-for` and `x-real-ip` are identical to it, and `x-vercel-forwarded-for` isn't changed by a proxy on top of Vercel. | vercel.com/docs/headers/request-headers |

### 4.4 First step: the secret-key gate

`authClient()` sends the secret key.
- **The risk:** if Supabase treats a secret-key request with no user token as admin, it may skip rate limits as well as captcha (C17). Our server would then be an unlimited route to Supabase, and anyone could guess codes through our reset form.
- **When to check:** before anything else is built on `authClient()`, on staging:
1. **Headers.** Record the headers supabase-js sends with the secret key, with and without a session (`apikey`, `Authorization`).
2. **Limits still apply.** Through the app, from one client IP, make 31 sign-in attempts within 5 minutes. The 31st must be rate-limited.
3. **Limits are per person.** At the same time, sign in from a second client IP (for example a phone on mobile data). It must still work.
4. **Sign-up behaves normally** through `authClient()`:
   - a code email is sent;
   - the account stays unconfirmed until the code is entered;
   - a guest stays a guest until then.
5. **Captcha.** Record whether captcha is skipped. If it is, the captcha follow-up (7) must say that our server checks the captcha token itself.

**If any of steps 2–4 fails, stop and report back.** No falling back to raising the limits or making the calls from the browser.

## 5. Messages

| Situation | Message |
|---|---|
| Wrong email or password | Email or password is incorrect. |
| Per-IP request limit (`over_request_rate_limit`) | Too many attempts. Please wait a minute and try again. |
| Password too short, or `weak_password` | Password must be at least 8 characters. |
| Invalid email | Enter a valid email address. |
| Code not 8 digits | Enter the 8-digit code from the email. |
| Wrong, expired or used code (`otp_expired`) | That code is wrong or has expired. |
| Good code, password refused | Code accepted. Choose a different password. |
| New password same as the current one (`same_password`) | Choose a password different from your current one. |
| Reset code sent (also for unknown emails and `over_email_send_rate_limit`) | If there's an account for this email, we sent an 8-digit code. It expires in 15 minutes. |
| Sign-up code sent (also for a taken email) | Enter the 8-digit code we sent to {email}. It expires in 15 minutes. |
| Under the sign-up code | Already have an account? Sign in or reset your password. |
| Retry session too old, or not from a code | Please ask for a new code. |
| Password changed (goals page) | Password changed. |
| Google account already has an account (`identity_already_exists`, `email_exists`) | This Google account already has an account here. Continue to sign in to it? Your guest goal won't be kept. |
| Google cancelled or failed (any other callback error) | Google sign-in didn't finish. Please try again. |
| Network or unknown error | Something went wrong. Please try again. (and logged on the server) |

**Changed from the approved design:**
- **"Choose a stronger password" is gone.** `weak_password` only fires for rule sets this design doesn't turn on, or for a length below the minimum, which the form checks first.
- **"An account with this email already exists" is gone,** under decision 2.
- **The hourly-cap message is dropped.** It can't be told apart from the per-email limit by code (C10).

## 6. Testing

### 6.1 Unit (Vitest)
- **`safeNext`:**
  - **Kept:** valid paths, with their query and hash.
  - **Rejected:** `//evil.com`, `/\evil.com`, `\\evil.com`, `/%5Cevil.com`, `https://evil.com`, `javascript:alert(1)`, `%2F%2Fevil.com`, a tab or newline inside the value, an empty value, a missing value, and anything not starting with `/`.
- **`suggestEmail`:**
  - **Fixed:** typos such as `gmial.com`, `gmail.co`, `hotmal.com`, `yaho.com`, `outlok.com`, `icloud.co`, `me.cm`.
  - **Never suggested:** mail.com, email.com, ymail.com, mac.com, cloud.com, my.com, mi.com, and any two-letter `.com` other than me.com.
  - **Left alone:** correct and unknown domains. The local part and its case are kept.
- **`normalizeCode`:**
  - **Accepted:** `12345678`, `1234 5678`, `1234-5678`, and surrounding spaces.
  - **Rejected:** 7 or 9 digits, letters, and an empty value.
- **Error mapping:** each Supabase `error.code` gives its message from section 5. No mapping looks at message text.
- **`padTo`,** with a fake clock:
  - a fast success waits until `ms`;
  - a fast failure waits, then rethrows;
  - work slower than `ms` returns without extra wait.
- **`recentEmailProof`:**
  - true for `otp` within 15 minutes with a matching email;
  - false for `password` only, for `otp` older than 15 minutes, for another email, and for missing claims.
- **Form parts:**
  - show/hide toggles the field type and its button label;
  - Caps Lock appears and disappears;
  - the 8-character tick follows typing;
  - pending labels appear and the button is disabled;
  - focus and `aria-invalid` move to the field with the error;
  - tapping the typo hint fixes the email;
  - the countdown announces only when resending becomes available;
  - controlled inputs keep their values after an action returns an error.

### 6.2 End to end (Playwright, local stack, emails read from Mailpit's API)
Timing isn't checked here; `padTo` is covered by unit tests.

**Reset**
- **The full reset:** ask for a code, read it from the email, set a new password. The person lands on their goals page with "Password changed". The old password then fails and the new one works.
- **Signed out elsewhere:** a second browser context, signed in before the reset, is signed out after it: its next page load gets a fresh guest.
- **A notification arrives:** the "Your password was changed" email arrives.
- **Wrong code:** shows its message, and the new password stays filled in.
- **A used code** tried again is rejected.
- **An expired code** is rejected. The test sets that user's `auth.users.recovery_sent_at` back by more than 15 minutes, which is what expiry is measured from (C9).
- **"Send a new code":** the countdown shows and the button is disabled. Afterwards, a new code arrives; the old one is rejected and the new one works.
- **Unknown email:** the same answer as a known one, and no email is sent.
- **Good code, refused password:** submit the current password with a good code. The page shows "Code accepted. Choose a different password." A different password then succeeds without a code.
- **Reload survival:** after asking for a code, reload the page. Step 2 comes back with the email and the countdown.
- **Paste:** pasting "1234 5678" into the code field keeps all 8 digits.
- **Guest warning:** a guest with a goal sees the warning; a guest without a goal doesn't.

**Sign up and confirm**
- **Guest sign-up:** a guest with a goal signs up, enters the code from the "Change email address" email, and keeps the same goal.
- **Plain sign-up:** a person without a guest session signs up (the test clears its cookies and blocks guest creation), and enters the code from the "Confirm signup" email.
- **Taken email:** signing up with a taken email shows the same code screen, and no email arrives.
- **Unconfirmed sign-in:** signing in with the right password to an unconfirmed account goes to the code screen; a wrong password shows "Email or password is incorrect."
- **"Send a new code" on the sign-up screen:** works for a guest and for plain sign-up, and gives the same answer for a taken email.

**Sign in, sign up and navigation**
- **`next`:** after sign-in and sign-up, the person returns to `next`, including a `next` with its own query string (`/goals?tab=map`). An unsafe `next` goes to `/goals`.
- **Already signed in:** a signed-in person is redirected away from all three auth pages.
- **Carried email:** the email carries over between sign-in, sign-up and forgot-password.
- **Fields kept:** after a failed sign-in, the email and password are still filled in.
- **Typo hint:** appears and fixes the email.
- **Double click:** sends one request (the request count is checked).
- **Keyboard only:** tab order, Enter submits, and the toggles work with Space.
- **Phone width:** at 360 px, no horizontal scroll and nothing cut off.
- **Accessible names:** every input and button has one; checked with an axe-core scan.

**Google** (Google itself stubbed: tests intercept the redirect to Google, and call our callback with a fake `code` or error)
- **The redirect:** the button sends you to Supabase's authorise URL for Google, with a callback carrying `next` (with its own query string) and `from`.
- **Linking or signing in:** a guest with a goal uses the linking flow; a guest without one uses `signInWithOAuth`.
- **Error messages:** callback errors `access_denied`, `identity_already_exists`, `email_exists` and an unknown error each land on their message (5), on the form named by `from`.
- **Fallback:** an error that lands on the Site URL (`/?error=…`) shows the Google message.
- **Not the Site URL:** a successful callback with `next=/goals?tab=map` ends on that page.

The existing auth and guest tests keep passing.

### 6.3 Stress test (script against the local stack)
- **Rate limits locally:** per-IP limits aren't enforced on the local stack (R6). So the load run needs no raised limits, and needs no test-only config. It still runs from one IP.
- **The load run.** Waves of 10, 25 and 50 people at once. Each simulated person:
  - signs up (as a guest) and confirms with the code from Mailpit;
  - signs out and signs in;
  - asks for a reset code;
  - resets their password.
- **Recorded per step:** median and 95th-percentile time, error rate, and the exact message shown.
- **Pass:**
  - every step succeeds;
  - a rate-limit message counts as a failure;
  - no blank page, no 500 error, no generic message;
  - no person ends up signed in to the wrong account.
- **The limits run.**
  - Locally, only the per-email 60 s limit can be tripped. Asking for a reset code twice within 60 s must show the normal "sent" message (5).
  - The per-IP limits are checked on staging (4.4 step 2, and 6.5).
- **Fault runs:**
  - the auth container stopped mid-reset: a plain message, and recovery after a restart;
  - slow 3G (Playwright throttling): the pending state shows, and there's no double submit.

### 6.4 Usability pass
- **Walk-through:** I walk through each flow at 360 px and at desktop width, taking screenshots.
- **Screen readers:** VoiceOver on iOS, and NVDA or VoiceOver on desktop.
- **Outcome:** the user gets a short report of anything confusing, and what I find is fixed.

### 6.5 Manual, after the user's setup
- **The secret-key gate (4.4).** All five steps, including the two-network check. This comes first.
- **Padding times.** Measure on staging, with Resend, the time of each padded action for a real account. That's sign-in with a correct password, and a real email send for sign-up, send code and resend. At least 30 runs each. Set `SIGN_IN_MS` and `SEND_MS` above each 99th percentile, or switch the sends to `after()` (4.1).
- **Google:**
  - one real Google sign-in, as a guest with a goal;
  - cancelling on Google's screen;
  - linking a Google account that already has an account here;
  - a guest linking a Google account whose email belongs to an email/password account (C13).
- **Real emails:**
  - one real reset email and one real sign-up email through Resend;
  - checking that codes have 8 digits;
  - checking that the "password changed" email arrives.
- **Per-IP limit messages.** From one IP, trip the sign-in limit: "Too many attempts…" is shown.

## 7. Out of scope
- An account page, and changing the password while signed in.
- Captcha. When it's added: Supabase skips the captcha for admin-credential requests (C17). If the gate (4.4, step 5) finds that our secret-key calls count as admin, our server must check the captcha token itself.
- Magic-link sign-in.
- Providers other than Google. **Rule:** no other OAuth provider is turned on, on any project, until a version of Supabase Auth with the fix for advisory ANT-2026-7WJV60DR is confirmed (8).
- **Deferred until after the first release:**
  - lowering `token_verifications` below 30 per 5 minutes;
  - a send-email hook that detects and pauses floods of reset emails to one address.
- **Follow-up: create the guest only when someone starts a goal.**
  - Now the proxy creates a guest for every new visitor. Crawlers and bots that don't keep cookies create a new user on every request, and with IP forwarding, each of their IPs can create 30 an hour.
  - Creating the guest at the first goal would stop that. It would also make 3.3 simpler: link Google only for a guest, since every guest would have a goal.

## 8. Open questions and their answers
1. **The hosted Auth version.** Staging runs v2.197.0, the version checked here (4.3). Production is read again before the 4.4 gate, and rechecked if it differs.
2. **Advisory ANT-2026-7WJV60DR (manual linking).** **Accepted while Google is the only provider** (user, 2026-10-28), under the rule in 7.
   - The advisory names no fixed version, and says it hasn't been reproduced.
   - In v2.197.0, the code it describes still looks unchanged. Automatic linking matches existing identities by their stored email, whether or not the provider verified it (`models/linking.go:121`). Manual linking only rejects an email collision when the target user has no email.
   - Exposure is low: Google is the only provider, and it verifies emails.
3. **Old access tokens on other devices.** After a reset they still read the data API for up to an hour (C7), although they can't refresh or reach `/user`. **Accepted** (user, 2026-10-28); `jwt_expiry` stays at 3,600 s.
4. **Sign-up's padding.** **Decided from the staging timings** (user, 2026-10-28), like send code and resend (4.1, 6.5).
   - If real sends fit under a sensible `SEND_MS`, sign-up is padded.
   - If they don't, sign-up's Supabase call moves into `after()` as well. Its answer is always "enter the code", and it loses its "Too many attempts" message.
