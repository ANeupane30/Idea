import Link from "next/link";
import { cache } from "react";
import { connection } from "next/server";
import { signOut } from "@/app/(auth)/actions";
import { button } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";
import { APP_NAME } from "@/lib/brand";
import { createClient } from "@/lib/supabase/server";

export type Viewer = { id: string | null; isGuest: boolean };

/** The current user, once per request. Guests are anonymous users (or no user yet). */
export const getViewer = cache(async (): Promise<Viewer> => {
  await connection();
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  return { id: user?.id ?? null, isGuest: !user || user.is_anonymous === true };
});

const RAIL_ITEM =
  "group flex w-16 flex-col items-center gap-1 rounded-2xl py-1 text-label-m text-on-surface-variant focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary";
const RAIL_PILL = "grid h-8 w-14 place-items-center rounded-full transition-colors group-hover:bg-on-surface/8";

/**
 * Guests get "Save your progress" (sign up, which keeps their goal) and "Sign in";
 * signed-up users get "Sign out". `rail` stacks them as rail items.
 */
export function AccountActions({ viewer, layout }: { viewer: Viewer; layout: "row" | "rail" }) {
  if (layout === "rail") {
    return viewer.isGuest ? (
      <>
        <Link href="/sign-up" className={RAIL_ITEM}>
          <span className={RAIL_PILL}>
            <Icon name="cloud_upload" size={24} />
          </span>
          <span className="text-center leading-tight">Save your progress</span>
        </Link>
        <Link href="/sign-in" className={RAIL_ITEM}>
          <span className={RAIL_PILL}>
            <Icon name="login" size={24} />
          </span>
          Sign in
        </Link>
      </>
    ) : (
      <form action={signOut}>
        <button type="submit" className={RAIL_ITEM}>
          <span className={RAIL_PILL}>
            <Icon name="logout" size={24} />
          </span>
          Sign out
        </button>
      </form>
    );
  }
  return viewer.isGuest ? (
    <div className="flex items-center gap-1">
      <Link href="/sign-in" className={button("text")}>
        Sign in
      </Link>
      <Link href="/sign-up" className={button("outlined", "max-sm:hidden")}>
        Save your progress
      </Link>
    </div>
  ) : (
    <form action={signOut}>
      <button type="submit" className={button("text")}>
        Sign out
      </button>
    </form>
  );
}

const BAR = "flex min-h-16 items-center justify-between gap-2 px-4 sm:px-6";

/** Same height as the real bar, so nothing jumps when it streams in. */
export function SiteHeaderFallback() {
  return (
    <header className={BAR} aria-busy="true">
      <span className="text-title-l">{APP_NAME}</span>
    </header>
  );
}

/** The start and auth pages' bar: the app name and account links. data-user-id lets tests check identity. */
export async function SiteHeader() {
  const viewer = await getViewer();
  return (
    <header className={BAR} data-user-id={viewer.id ?? undefined}>
      <Link href="/" className="rounded-lg text-title-l text-on-surface focus-visible:outline-3 focus-visible:outline-primary">
        {APP_NAME}
      </Link>
      <AccountActions viewer={viewer} layout="row" />
    </header>
  );
}
