// The secret-key gate (spec §4.4). Re-run it whenever Supabase Auth's version changes.
//
//   SUPABASE_SECRET_KEY=... node scripts/auth-gate.mjs <site-url> <supabase-url> <publishable-key>
//
// (a) 31 wrong-password sign-ins through the app's form, from this machine's IP,
//     for one made-up email. #31 must show the rate-limit message.
// (b) The admin check: GET /auth/v1/admin/users with only the secret key.
//     200 means a secret-key request counts as admin, so captcha would be skipped.
// The secret key is read from the environment and never printed.
import { chromium } from "@playwright/test";

const [site, supabaseUrl, publishable] = process.argv.slice(2);
const secret = process.env.SUPABASE_SECRET_KEY;
if (!site || !supabaseUrl || !publishable || !secret) {
  console.error(
    "usage: SUPABASE_SECRET_KEY=... node scripts/auth-gate.mjs <site-url> <supabase-url> <publishable-key>",
  );
  process.exit(2);
}

const RATE_LIMITED = "Too many attempts. Please wait a minute and try again.";
const ATTEMPTS = 31;

async function signIns() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const email = `gate-${Date.now()}@example.com`;
  const started = Date.now();
  const messages = [];
  try {
    for (let i = 1; i <= ATTEMPTS; i++) {
      await page.goto(new URL("/sign-in", site).toString());
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="password"]').fill(`wrong-password-${i}`);
      const submit = page.locator('form button[type="submit"]').last();
      const posted = page.waitForResponse((r) => r.request().method() === "POST");
      await submit.click();
      const response = await posted;
      await page.waitForFunction(
        () => (document.querySelector('[role="alert"]')?.textContent ?? "").trim().length > 0,
        null,
        { timeout: 30_000 },
      );
      const text = (await page.locator('[role="alert"]').first().textContent())?.trim() ?? "";
      messages.push(text);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`#${String(i).padStart(2)} ${secs.padStart(6)} s  HTTP ${response.status()}  ${text}`);
    }
  } finally {
    await browser.close();
  }
  const elapsed = (Date.now() - started) / 1000;
  const last = messages[messages.length - 1];
  console.log(`(a) ${ATTEMPTS} attempts in ${elapsed.toFixed(0)} s; #${ATTEMPTS}: ${last === RATE_LIMITED ? "RATE LIMITED (pass)" : "NOT rate limited (FAIL)"}`);
  if (elapsed > 300) console.log("    (took over 5 minutes, so the window may have reset; re-run)");
  return last === RATE_LIMITED;
}

async function adminCheck() {
  const r = await fetch(new URL("/auth/v1/admin/users?per_page=1", supabaseUrl), {
    headers: { apikey: secret },
  });
  console.log(`(b) admin check with only the secret key: HTTP ${r.status}${r.status === 200 ? " (counts as admin: captcha would be skipped)" : ""}`);
  return r.status;
}

async function version() {
  const r = await fetch(new URL("/auth/v1/health", supabaseUrl), { headers: { apikey: publishable } });
  const body = await r.json().catch(() => ({}));
  console.log(`Auth version: ${body.version ?? `unknown (HTTP ${r.status})`}`);
}

await version();
const limited = await signIns();
await adminCheck();
process.exitCode = limited ? 0 : 1;
