// Next.js 16 renamed `middleware.ts` to `proxy.ts`; same behaviour.
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Static files never get a session (every other path creates a guest when there is none).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|json|webmanifest|css|js|map|woff2?)$).*)",
  ],
};
