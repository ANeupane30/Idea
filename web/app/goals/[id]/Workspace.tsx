"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/form-error";
import { button } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";
import type { SourceRow } from "@/lib/sources";
import { GENERIC_ERROR } from "@/lib/validation";
import { AddSourceContext, type AddSourceTab } from "./add-source-context";
import { AddSourceDialog } from "./AddSourceDialog";
import { GuestSaveCard } from "./GuestSaveCard";
import { retrySource } from "./source-actions";
import { SourceList } from "./SourceList";
import { useSourceRows } from "./use-source-rows";

type Props = {
  goalId: string;
  userId: string;
  archived: boolean;
  isGuest: boolean;
  sources: SourceRow[];
  /** Open the Add source dialog straight away (the lesson page's "Add a source" link). */
  openAddSource?: boolean;
  /** The topic map (with its detail card). */
  map: React.ReactNode;
  /** Above the map, e.g. the starting-point notice. */
  notice?: React.ReactNode;
};

/**
 * The goal page body: the map on the left, Sources on the right (stacked
 * under the map below xl), and the Add source dialog behind a floating button.
 */
export function Workspace({
  goalId,
  userId,
  archived,
  isGuest,
  sources,
  openAddSource = false,
  map,
  notice,
}: Props) {
  const router = useRouter();
  const rows = useSourceRows(goalId, sources);
  const [open, setOpen] = useState(openAddSource && !archived);
  const [tab, setTab] = useState<AddSourceTab>("link");
  const [retryError, setRetryError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function retry(id: string) {
    setRetryError(null);
    startTransition(async () => {
      try {
        const result = await retrySource(goalId, id);
        if (!result.ok) setRetryError(result.error);
        else router.refresh();
      } catch {
        setRetryError(GENERIC_ERROR);
      }
    });
  }

  return (
    <AddSourceContext
      value={
        archived
          ? null
          : (options) => {
              setTab(options?.tab ?? "link");
              setOpen(true);
            }
      }
    >
      <div className="mt-6 flex flex-col gap-8 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <h2 className="text-title-m text-on-surface">
            Your learning map{" "}
            <span className="text-body-m font-normal text-on-surface-variant max-sm:block">
              Select a topic to start. Chips show source coverage, bars show your mastery.
            </span>
          </h2>
          {notice}
          <div className="mt-4">{map}</div>
        </div>
        <aside aria-label="Sources" className="flex flex-col gap-6 xl:w-80 xl:shrink-0">
          <SourceList goalId={goalId} rows={rows} archived={archived} onRetry={retry} />
          {retryError && <FormError error={retryError} />}
          {isGuest && <GuestSaveCard />}
        </aside>
      </div>

      {!archived && (
        <>
          {/* Room so the floating button never covers the last card. */}
          <div aria-hidden className="h-20" />
          <button
            type="button"
            data-testid="add-source-fab"
            onClick={() => setOpen(true)}
            className={button("fab", "fixed right-4 bottom-24 z-20 sm:right-6 sm:bottom-6")}
          >
            <Icon name="add" size={24} />
            Add source
          </button>
          <AddSourceDialog
            initialTab={tab}
            goalId={goalId}
            userId={userId}
            rows={rows}
            open={open}
            onClose={() => setOpen(false)}
            onRetry={retry}
            retryError={retryError}
          />
        </>
      )}
    </AddSourceContext>
  );
}
