import "server-only";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { clientIp } from "./client-ip";

export type SupabaseAuthClient = SupabaseClient["auth"];

/**
 * An Auth-only client with the secret key, which passes the person's IP to
 * Supabase in Sb-Forwarded-For so rate limits apply per person (spec §4.1).
 * Only `.auth` is returned: the secret key bypasses row-level security, so the
 * data API must never be reachable through it. Build one per request.
 */
export function createAuthClient(opts: {
  cookies: CookieMethodsServer;
  headers: Headers;
  fetch?: typeof fetch;
}): SupabaseAuthClient {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set");
  const ip = clientIp(opts.headers);
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, secret, {
    cookies: opts.cookies,
    global: {
      headers: ip ? { "Sb-Forwarded-For": ip } : {},
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    },
  }).auth;
}

/** createAuthClient for server actions and route handlers. */
export async function authClient(): Promise<SupabaseAuthClient> {
  const cookieStore = await cookies();
  return createAuthClient({
    headers: await headers(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}
