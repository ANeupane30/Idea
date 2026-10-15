import Link from "next/link";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/(auth)/actions";

const BAR =
  "flex min-h-14 items-center justify-end gap-2 border-b border-zinc-200 px-4 py-2.5 sm:px-6 dark:border-zinc-800";

/** Same height as the real header, so nothing jumps when it streams in. */
export function SiteHeaderFallback() {
  return <header className={BAR} aria-busy="true" />;
}

/**
 * Guests get "Save your progress" (sign up, which keeps their goal) and "Sign in";
 * signed-up users get "Sign out". data-user-id lets tests check guest identity.
 */
export async function SiteHeader() {
  await connection();
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  const isGuest = !user || user.is_anonymous === true;

  return (
    <header className={BAR} data-user-id={user?.id}>
      {isGuest ? (
        <>
          <Link
            href="/sign-in"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:focus-visible:ring-offset-zinc-950"
          >
            Save your progress
          </Link>
        </>
      ) : (
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Sign out
          </button>
        </form>
      )}
    </header>
  );
}
