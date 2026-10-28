import { beforeAll, describe, expect, it } from "vitest";
import { createAuthClient } from "@/lib/supabase/auth-server";

const URL_ = "https://abcdefghijkl.supabase.co";

function recorder() {
  const seen: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (_u, init) => {
    seen.push(new Headers(init?.headers));
    return Response.json({}, { status: 200 });
  };
  return { seen, fetch };
}

const noCookies = { getAll: () => [], setAll: () => {} };

// A session cookie in the format @supabase/ssr writes.
function sessionCookies() {
  const session = {
    access_token: "header.payload.signature",
    refresh_token: "refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated" },
  };
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  return { getAll: () => [{ name: "sb-abcdefghijkl-auth-token", value }], setAll: () => {} };
}

function redact(h: Headers) {
  const out = Object.fromEntries(h);
  if (out.apikey) out.apikey = "<secret>";
  if (out.authorization)
    out.authorization = out.authorization === "Bearer sb_secret_test" ? "Bearer <secret>" : "Bearer <jwt>";
  return out;
}

describe("createAuthClient", () => {
  beforeAll(() => {
    process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
  });

  it("sends the secret key and the person's IP without a session, and the key as Authorization", async () => {
    const { seen, fetch } = recorder();
    const auth = createAuthClient({
      cookies: noCookies,
      headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }),
      fetch,
    });
    await auth.resetPasswordForEmail("a@example.com");
    expect(seen[0].get("apikey")).toBe("sb_secret_test");
    expect(seen[0].get("sb-forwarded-for")).toBe("203.0.113.7");
    // supabase-js falls back to the key itself as the bearer token (gate step 1 records this).
    expect(seen[0].get("authorization")).toBe("Bearer sb_secret_test");
    console.log("gate step 1, no session:", JSON.stringify(redact(seen[0])));
  });

  it("leaves Sb-Forwarded-For out when there is no Vercel IP", async () => {
    const { seen, fetch } = recorder();
    const auth = createAuthClient({
      cookies: noCookies,
      headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
      fetch,
    });
    await auth.resetPasswordForEmail("a@example.com");
    expect(seen[0].has("sb-forwarded-for")).toBe(false);
  });

  it("sends the session's access token as Authorization when signed in", async () => {
    const { seen, fetch } = recorder();
    const auth = createAuthClient({
      cookies: sessionCookies(),
      headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }),
      fetch,
    });
    await auth.getUser();
    const last = seen[seen.length - 1];
    expect(last.get("authorization")).toBe("Bearer header.payload.signature");
    expect(last.get("apikey")).toBe("sb_secret_test");
    expect(last.get("sb-forwarded-for")).toBe("203.0.113.7");
    console.log("gate step 1, with session:", JSON.stringify(redact(last)));
  });

  it("exposes only auth", () => {
    const auth = createAuthClient({ cookies: noCookies, headers: new Headers() });
    expect("from" in auth).toBe(false);
    expect(typeof auth.signInWithPassword).toBe("function");
  });

  it("refuses to start without the secret key", () => {
    const saved = process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    try {
      expect(() => createAuthClient({ cookies: noCookies, headers: new Headers() })).toThrow();
    } finally {
      process.env.SUPABASE_SECRET_KEY = saved;
    }
  });
});
