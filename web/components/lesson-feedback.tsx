"use client";

import { useId, useState, useTransition } from "react";
import { FormError } from "@/components/form-error";
import type { ActionResult } from "@/lib/validation";

type Send = (lessonId: string, input: { rating?: "up" | "down"; reportText?: string }) => Promise<ActionResult>;

/** Thumbs up/down and "Report an error" for one lesson. */
export function LessonFeedback({ lessonId, send }: { lessonId: string; send: Send }) {
  const reportId = useId();
  const [done, setDone] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [report, setReport] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(input: { rating?: "up" | "down"; reportText?: string }) {
    setError(null);
    startTransition(async () => {
      const result = await send(lessonId, input);
      if (result.ok) setDone(true);
      else setError(result.error);
    });
  }

  if (done) {
    return (
      <p role="status" className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
        Thanks for the feedback.
      </p>
    );
  }

  const button =
    "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
  return (
    <div className="mt-6 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-zinc-700 dark:text-zinc-300">Was this lesson helpful?</span>
        <button type="button" className={button} disabled={pending} onClick={() => submit({ rating: "up" })}>
          Yes
        </button>
        <button type="button" className={button} disabled={pending} onClick={() => submit({ rating: "down" })}>
          No
        </button>
        <button
          type="button"
          className="text-sm font-medium text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
          aria-expanded={reporting}
          aria-controls={reportId}
          onClick={() => setReporting((r) => !r)}
        >
          Report an error
        </button>
      </div>
      {reporting && (
        <form
          id={reportId}
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit({ reportText: report });
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            What&apos;s wrong?
            <textarea
              value={report}
              onChange={(e) => setReport(e.target.value)}
              maxLength={2000}
              rows={3}
              className="rounded-lg border border-zinc-300 bg-white p-2 font-normal text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </label>
          <button type="submit" className={`${button} self-start`} disabled={pending}>
            Send report
          </button>
        </form>
      )}
      {error && <FormError error={error} />}
    </div>
  );
}
