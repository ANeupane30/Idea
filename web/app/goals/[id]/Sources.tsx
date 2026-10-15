"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/form-error";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  LABEL_TEXT,
  linkSchema,
  PDF_MAX_BYTES,
  PDF_TOO_BIG,
  STEP_TEXT,
  TYPE_TEXT,
  type SourceRow,
} from "@/lib/sources";
import { GENERIC_ERROR, type ActionResult } from "@/lib/validation";
import { addLinkSource, addPdfSource, retrySource } from "./source-actions";

const OFF_TOPIC_NOTE = "Off-topic sources stay in your library but aren't used for lessons or quizzes.";

const LABEL_STYLE: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-200",
  partial: "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
  off_topic: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-300",
};

type Props = { goalId: string; userId: string; archived: boolean; sources: SourceRow[] };

export function Sources({ goalId, userId, archived, sources }: Props) {
  const router = useRouter();
  const headingId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const busy = sources.some((s) => s.status === "queued" || s.status === "processing");

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [busy, router]);

  function run(action: () => Promise<ActionResult>, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) setError(result.error);
        else {
          onOk?.();
          router.refresh();
        }
      } catch {
        setError(GENERIC_ERROR);
      }
    });
  }

  function submitLink(e: React.FormEvent) {
    e.preventDefault();
    const parsed = linkSchema.safeParse(url);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? GENERIC_ERROR);
      return;
    }
    run(() => addLinkSource(goalId, parsed.data), () => setUrl(""));
  }

  function uploadPdf(file: File | undefined) {
    if (!file) return;
    const reset = () => {
      if (fileRef.current) fileRef.current.value = "";
    };
    if (file.size > PDF_MAX_BYTES) {
      setError(PDF_TOO_BIG);
      reset();
      return;
    }
    run(async () => {
      const path = `${userId}/${crypto.randomUUID()}.pdf`;
      const { error: uploadError } = await createBrowserClient()
        .storage.from("sources")
        .upload(path, file, { contentType: "application/pdf" });
      if (uploadError) return { ok: false, error: GENERIC_ERROR };
      return addPdfSource(goalId, path, file.name);
    }, reset);
  }

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Sources
      </h2>

      {!archived && (
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <form onSubmit={submitLink} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Add a link
              <input
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste a web page or YouTube link"
                maxLength={2000}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base font-normal text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
            </label>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-60 dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:focus-visible:ring-offset-zinc-950"
            >
              Add link
            </button>
          </form>
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Upload a PDF
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              disabled={isPending}
              aria-describedby={`${headingId}-pdf-hint`}
              onChange={(e) => uploadPdf(e.target.files?.[0])}
              className="text-sm font-normal text-zinc-700 file:mr-3 file:rounded-lg file:border file:border-zinc-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-zinc-50 dark:text-zinc-300 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-200"
            />
            <span id={`${headingId}-pdf-hint`} className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
              PDF, up to 25 MB
            </span>
          </label>
        </div>
      )}
      {error && <FormError error={error} className="mt-3" />}

      <ul aria-label="Your sources" className="mt-6 flex flex-col gap-3">
        {sources.map((s) => (
          <SourceItem key={s.id} source={s} archived={archived} onRetry={() => run(() => retrySource(goalId, s.id))} />
        ))}
      </ul>
    </section>
  );
}

function SourceItem({ source: s, archived, onRetry }: { source: SourceRow; archived: boolean; onRetry: () => void }) {
  const working = s.status === "queued" || s.status === "processing";
  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words font-medium text-zinc-900 dark:text-zinc-50">
          {s.title ?? s.file_name ?? s.url_or_file}
        </p>
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {TYPE_TEXT[s.type]}
        </span>
      </div>

      {working && (
        <div role="status" className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          <p>{STEP_TEXT[s.step ?? "queued"]}</p>
          {s.delayed && <p>Processing is delayed. We&apos;ll keep trying.</p>}
        </div>
      )}

      {s.status === "ready" && s.relevance_label && (
        <div className="mt-2 flex flex-col gap-1 text-sm">
          <p>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${LABEL_STYLE[s.relevance_label]}`}>
              {LABEL_TEXT[s.relevance_label]}
            </span>
          </p>
          {s.relevance_reason && <p className="text-zinc-700 dark:text-zinc-300">{s.relevance_reason}</p>}
          {s.relevance_label === "off_topic" && <p className="text-zinc-500 dark:text-zinc-400">{OFF_TOPIC_NOTE}</p>}
        </div>
      )}

      {s.status === "failed" && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <p className="text-red-700 dark:text-red-400">{s.error ?? GENERIC_ERROR}</p>
          {!archived && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-zinc-300 px-3 py-1 font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Try again
            </button>
          )}
        </div>
      )}
    </li>
  );
}
