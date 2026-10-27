# Password Reset and Friendlier Sign-in: Design

**Status:** both design sections approved by the user on 2026-10-27. This written spec awaits review.

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

- **Reset by a 6-digit code sent by email.** No reset link.
- **Emails are sent through Resend** (SMTP) on staging and production. Locally, they go to Supabase's test mailbox (Mailpit).
- **Included:** password field help, clearer form feedback, smoother navigation, and "Continue with Google".
- **Not included:** an account page, and changing the password while signed in. People who want a new password use "Forgot password?".

**Assumptions** (stated to the user in the design; none was corrected):
- A guest who signs up or uses Google for the first time keeps their goal, as email sign-up does today.
- Reset and sign-in never reveal whether an email has an account.
- Captcha is out of scope; it's already on the list for before production.
- The user does the outside setup (Resend, Google Cloud, Supabase dashboard). This work documents the exact steps.

## 3. What people see

### 3.1 Forgot password

1. **The link.** The sign-in page has a "Forgot password?" link next to the Password label. Any email already typed carries over.
2. **Step 1, ask for a code.** The reset page asks for the email; the button is "Send code". The answer is always the same, whether or not an account exists:
   > If there's an account for this email, we sent a 6-digit code. It expires in 1 hour.
3. **Step 2, same page.** "Code" is one field: digits only, numeric keypad on phones, `autocomplete="one-time-code"`. A pasted "123 456" or "123-456" works. "New password" follows, with the same rules and help as sign-up. One "Reset password" button checks the code and saves the new password in one go. The person is then signed in and taken to their goals, with a "Password changed" note.
4. **A wrong or expired code** shows "That code is wrong or has expired." The new password stays filled in.
5. **Resending.** "Send a new code" is shown in step 2, with a 60-second countdown; it's disabled until the countdown ends. "Use a different email" goes back to step 1.
6. **Too many attempts** shows "Too many attempts. Please wait a minute and try again."
7. **A guest with a goal** sees the same warning as on sign-in: "Signing in to another account won't keep your guest goal."

### 3.2 Sign in and sign up

**Password help**
- A show/hide button on every password field, labelled "Show password" / "Hide password" for screen readers.
- "Caps Lock is on" under the field while Caps Lock is on.
- On sign-up and reset, "At least 8 characters" is shown before typing, and turns into a tick once met.

**Form feedback**
- While waiting, the button reads "Signing in…", "Creating account…", "Sending code…" or "Resetting…", and is disabled, so a double click sends one request.
- The email stays filled in after an error.
- After an error, focus moves to the field that needs fixing.
- Common email typos get a hint, for example "Did you mean name@gmail.com?". Tapping the hint fixes the email. Domains covered: gmail.com, googlemail.com, yahoo.com, hotmail.com, outlook.com, live.com, icloud.com, me.com, aol.com, proton.me, protonmail.com.

**Navigation**
- **Return to where you were.** Sign-in and sign-up take a `next` path and go there afterwards. Only paths inside this site are followed: a single leading `/`, and no `//`, `\`, scheme or control characters. Anything else goes to `/goals`.
- **Already signed in.** A signed-in person (not a guest) who opens sign-in, sign-up or forgot-password is sent to `next`, or to `/goals`.
- **Email carries over** between sign-in, sign-up and forgot-password through the browser's `sessionStorage`, never the URL.

### 3.3 Continue with Google

- **Where.** "Continue with Google" is at the top of the sign-in and sign-up forms, above an "or" divider.
- **A guest is linked, not replaced.** For a guest, Google is linked to the guest account (`linkIdentity`), so their goal is kept, as with email sign-up.
- **Not a guest.** Anyone else signs in with Google (`signInWithOAuth`). A new Google user gets a new account.
- **Google account already has an account here.** Linking fails, and the page says:
  > This Google account already has an account. Continue to sign in? Your guest goal won't be kept.

  with a "Continue with Google" button that signs in normally.
- **Cancelled or failed.** If Google sign-in is cancelled or fails, the person is back on the form with "Google sign-in didn't finish. Please try again."

## 4. How it's built

### 4.1 Web app

| Piece | Job |
|---|---|
| `app/(auth)/forgot-password/page.tsx` | The two-step reset page. |
| `app/(auth)/actions.ts` | **`sendResetCode(formData)`** calls `resetPasswordForEmail(email)` and returns the same "sent" result for every valid email; only rate limits and invalid input show an error. **`resetPassword(formData)`** runs `verifyOtp({ email, token, type: "recovery" })`, then `updateUser({ password })`, then redirects to `/goals?notice=password-changed`. **`signIn` and `signUp`** read `next` through `safeNext`. |
| `app/auth/callback/route.ts` | Google returns here. It calls `exchangeCodeForSession(code)` and redirects to `safeNext(next)`. On an error it redirects to the form it came from, with an error code that the form turns into a message (3.3). |
| `components/auth-form.tsx` | Composes the parts below; keeps the existing look (`button`, `field`, tokens). |
| `components/auth/password-field.tsx` | Show/hide, Caps Lock, the 8-character rule. |
| `components/auth/email-field.tsx` | Typo hint; reads and writes the carried-over email. |
| `components/auth/google-button.tsx` | Starts Google with `linkIdentity` (guest) or `signInWithOAuth` (anyone else), `redirectTo` the callback with `next`. |
| `lib/auth/next.ts` | `safeNext(value): string`. |
| `lib/auth/email-suggest.ts` | `suggestEmail(email): string \| null`. |
| `lib/auth/code.ts` | `normalizeCode(value): string \| null`: strips spaces and dashes, needs exactly 6 digits. |
| `lib/auth/errors.ts` | Maps Supabase auth errors to the messages in section 5. |
| `lib/supabase/middleware.ts` | Redirects signed-in, non-guest people away from the auth pages (3.2). |

**One step, not two, for the reset.** The code check and the password save happen in one server action. A recovery session never sits around waiting for a separate "new password" page.

### 4.2 Supabase

**`supabase/config.toml`:**
- `enable_manual_linking = true`, which `linkIdentity` needs.
- `[auth.external.google]` turned on, with `client_id` and `secret` read from environment variables. With no keys set locally, the Google button still renders, and tests stub Google.
- `[auth.email.template.recovery]` pointing to `supabase/templates/recovery.html`: the code (`{{ .Token }}`), its expiry, and "If you didn't ask for this, ignore this email." No link.
- `max_frequency = "60s"`, matching the resend countdown.
- `otp_length = 6`, `otp_expiry = 3600` (already set).

**[docs/deploy.md](../../deploy.md)** gets the user's steps:
- **Resend:** create an account, verify the sending domain (DNS records), create an API key, then enter Resend's SMTP settings in each Supabase project. Raise Supabase's emails-per-hour limit, since custom SMTP lifts the cap.
- **Google Cloud:** create an OAuth client (web). Its authorised redirect URI is `https://<ref>.supabase.co/auth/v1/callback`. Enter the client ID and secret under Supabase → Authentication → Providers → Google.
- **Supabase dashboard,** per project:
  - Paste the recovery template.
  - Set the site URL, and add `https://<site>/auth/callback` to the redirect URLs.
  - Turn on manual linking.
  - Set a 60 s minimum between emails.

## 5. Messages

| Situation | Message |
|---|---|
| Wrong email or password | Email or password is incorrect. |
| Rate limited (any auth call) | Too many attempts. Please wait a minute and try again. |
| Email already has an account (sign-up) | An account with this email already exists. Try signing in. |
| Password too short | Password must be at least 8 characters. |
| Password rejected as weak | Choose a stronger password. |
| Invalid email | Enter a valid email address. |
| Code not 6 digits | Enter the 6-digit code from the email. |
| Wrong, expired or used code | That code is wrong or has expired. |
| New password same as the old one | Choose a password you haven't used here before. |
| Reset code sent | If there's an account for this email, we sent a 6-digit code. It expires in 1 hour. |
| Password changed (goals page) | Password changed. |
| Google account already has an account | This Google account already has an account. Continue to sign in? Your guest goal won't be kept. |
| Google cancelled or failed | Google sign-in didn't finish. Please try again. |
| Network or unknown error | Something went wrong. Please try again. (and logged on the server) |

## 6. Testing

### 6.1 Unit (Vitest)
- **`safeNext`:** valid paths are kept, with their query and hash. These are rejected:
  - `//evil.com`, `/\evil.com`, `\\evil.com`
  - `https://evil.com`, `javascript:alert(1)`
  - `%2F%2Fevil.com`, a tab or newline inside the value
  - an empty value, a missing value, and anything not starting with `/`
- **`suggestEmail`:** fixes typos (`gmial.com`, `gmail.co`, `hotmal.com`, `yaho.com`, `outlok.com`, `icloud.co`). Leaves correct and unknown domains alone. Keeps the local part and its case.
- **`normalizeCode`:** accepts `123456`, `123 456`, `123-456` and surrounding spaces. Rejects 5 or 7 digits, letters and an empty value.
- **Error mapping:** each Supabase error code gives its message from section 5.
- **Form parts:**
  - show/hide toggles the field type and its button label;
  - Caps Lock appears and disappears;
  - the 8-character tick follows typing;
  - pending labels appear and the button is disabled;
  - focus moves to the field with the error;
  - tapping the typo hint fixes the email.

### 6.2 End to end (Playwright, local stack, emails read from Mailpit's API)
**Reset**
- **The full reset:** ask for a code, read it from the email, set a new password. The person lands on their goals page with "Password changed". The old password then fails and the new one works.
- **Wrong code:** shows its message, and the new password stays filled in.
- **A used code** tried a second time is rejected.
- **An expired code** is rejected. The test shortens `otp_expiry` through the auth admin API or a test config.
- **Resend:** the countdown shows and the button is disabled; afterwards a new code arrives and works.
- **Unknown email:** same answer as a known one, and no email is sent.
- **A guest with a goal** sees the warning.

**Sign in / sign up**
- After sign-in and sign-up, the person returns to `next`. An unsafe `next` goes to `/goals`.
- A signed-in person is redirected away from all three auth pages.
- The email carries over between sign-in, sign-up and forgot-password.
- The typo hint appears and fixes the email.
- A double click sends one request (the request count is checked).
- Keyboard only: tab order, Enter submits, and the toggles work with Space.
- At 360 px width there's no horizontal scroll, and nothing is cut off.
- Every input and button has an accessible name; checked with an axe-core scan.

**Google** (Google itself stubbed)
- The button sends you to Supabase's authorise URL for Google, with the callback and `next`.
- For a guest, it uses the linking flow.
- Each callback error lands on its friendly message (section 5).

The existing auth and guest tests keep passing.

### 6.3 Stress test (script against the local stack)
- **Waves of 10, 25 and 50 at once.** Each simulated person signs up, signs out, signs in, asks for a reset code, reads it from Mailpit and resets their password.
- **Recorded per step:** median and 95th-percentile time, error rate, and the exact message shown.
- **Pass:**
  - every failure is a rate-limit message or a successful retry;
  - no blank page, no 500 error, no generic message;
  - no person ends up signed in to the wrong account.
- **Fault runs:**
  - the auth container stopped mid-reset: a plain message, and recovery after a restart;
  - slow 3G (Playwright throttling): the pending state shows, and there's no double submit.

### 6.4 Usability pass
I walk through each flow at 360 px and at desktop width, taking screenshots. The user gets a short report of anything confusing, and what I find is fixed.

### 6.5 Manual, after the user's setup
- One real Google sign-in on staging, as a guest with a goal.
- One real reset email through Resend on staging.

## 7. Out of scope
- An account page, and changing the password while signed in.
- Captcha.
- Magic-link sign-in.
- Email confirmation on sign-up (stays off).
- Providers other than Google.
