import { Suspense } from "react";
import { NavRail } from "@/components/nav-rail";
import { AccountActions, getViewer } from "@/components/site-header";

const RAIL =
  "fixed inset-x-0 bottom-0 z-30 h-20 bg-surface-container-low sm:inset-x-auto sm:inset-y-0 sm:left-0 sm:h-auto sm:w-20";

async function Rail({ goalId }: { goalId?: string }) {
  const viewer = await getViewer();
  return (
    <header className={RAIL} data-user-id={viewer.id ?? undefined}>
      <NavRail goalId={goalId} account={<AccountActions viewer={viewer} layout="rail" />} />
    </header>
  );
}

/** Pages with the navigation rail: Goals, a goal's map and its Review page. */
export function AppShell({ goalId, children }: { goalId?: string; children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<header className={RAIL} aria-busy="true" />}>
        <Rail goalId={goalId} />
      </Suspense>
      <div className="flex min-h-dvh flex-col pb-20 sm:pb-0 sm:pl-20">{children}</div>
    </>
  );
}
