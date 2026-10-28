import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { createAuthClient } from "./auth-server";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase session. A visitor without one gets a guest (anonymous)
 * session, so nobody is ever forced to sign up or sign in.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const cookies: CookieMethodsServer = {
    getAll() {
      return request.cookies.getAll();
    },
    setAll(cookiesToSet) {
      // Set on the request too, so this request's pages and actions see the new session.
      cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
      response = NextResponse.next({ request });
      cookiesToSet.forEach(({ name, value, options }) =>
        response.cookies.set(name, value, options),
      );
    },
  };
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies },
  );

  // getUser() validates the token with the auth server; never trust getSession() here.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // setAll() above puts the guest's session cookies on `response`, which is returned
    // as is (no redirect), so the browser keeps this one guest for later requests.
    // If it fails (for example the per-IP rate limit), pages render without a user.
    // Through the auth client, so the per-IP guest limit counts this person, not our server.
    await createAuthClient({ cookies, headers: request.headers }).signInAnonymously();
  }

  return response;
}
