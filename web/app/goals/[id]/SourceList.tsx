"use client";

import { useId } from "react";
import { button } from "@/components/ui/buttons";
import { StatusChip } from "@/components/ui/chips";
import { Icon, type IconName } from "@/components/ui/icon";
import { STAGE_TEXT, stageOf, TYPE_TEXT, type SourceRow } from "@/lib/sources";
import { GENERIC_ERROR } from "@/lib/validation";

const OFF_TOPIC_NOTE = "Off-topic sources stay in your library but aren't used for lessons or quizzes.";

export const TYPE_ICON: Record<SourceRow["type"], IconName> = {
  web: "article",
  youtube: "smart_display",
  pdf: "picture_as_pdf",
};

export const sourceTitle = (s: SourceRow) => s.title ?? s.file_name ?? s.url_or_file;

/** The goal's sources: what each one is, how relevant it is and why. */
export function SourceList({
  rows,
  archived,
  onRetry,
}: {
  rows: SourceRow[];
  archived: boolean;
  onRetry: (id: string) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-title-m text-on-surface">
        Sources
      </h2>
      {rows.length === 0 && (
        <p className="mt-2 text-body-m text-on-surface-variant">Add a link, video or PDF to see which topics it covers.</p>
      )}
      <ul aria-label="Your sources" className="mt-3 flex flex-col gap-2">
        {rows.map((s) => (
          <li key={s.id} className="flex gap-4 rounded-2xl bg-surface-container-low p-4">
            <Icon name={TYPE_ICON[s.type]} size={24} className="text-on-surface-variant" />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <p className="text-title-m text-on-surface [overflow-wrap:anywhere]">
                <span className="sr-only">{TYPE_TEXT[s.type]}: </span>
                {sourceTitle(s)}
              </p>
              <SourceStatus source={s} archived={archived} onRetry={() => onRetry(s.id)} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceStatus({ source: s, archived, onRetry }: { source: SourceRow; archived: boolean; onRetry: () => void }) {
  if (s.status === "failed") {
    return (
      <>
        <p className="flex gap-1.5 text-body-m text-on-negative">
          <Icon name="error" size={20} />
          {s.error ?? GENERIC_ERROR}
        </p>
        {!archived && (
          <button type="button" onClick={onRetry} className={button("text", "-ml-3 min-h-10")}>
            Try again
          </button>
        )}
      </>
    );
  }
  if (s.status !== "ready") {
    return (
      <div role="status" className="text-body-m text-on-surface-variant">
        <p className="flex items-center gap-1.5">
          <Icon name="progress_activity" size={18} className="motion-safe:animate-spin text-primary" />
          {STAGE_TEXT[stageOf(s).stage]}…
        </p>
        {s.delayed && <p className="mt-1">Processing is delayed. We&apos;ll keep trying.</p>}
      </div>
    );
  }
  return (
    <>
      {s.relevance_label && <StatusChip kind="relevance" value={s.relevance_label} />}
      {s.relevance_reason && <p className="text-body-m text-on-surface-variant">{s.relevance_reason}</p>}
      {s.relevance_label === "off_topic" && <p className="text-body-m text-on-surface-variant">{OFF_TOPIC_NOTE}</p>}
    </>
  );
}
