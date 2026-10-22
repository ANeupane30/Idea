"use client";

import { useId, useState, useTransition } from "react";
import { FormError } from "@/components/form-error";
import { button, field } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";
import type { ActionResult } from "@/lib/validation";

type Send = (lessonId: string, input: { rating?: "up" | "down"; reportText?: string }) => Promise<ActionResult>;

/** Thumbs up/down and "Report an error" for one lesson; `children` (the next step) sits on the right. */
export function LessonFeedback({ lessonId, send, children }: { lessonId: string; send: Send; children?: React.ReactNode }) {
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

  return (
    <div className="mt-8 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        {done ? (
          <p role="status" className="text-body-m text-on-surface-variant">
            Thanks for the feedback.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-body-m text-on-surface-variant">Was this helpful?</span>
            <button
              type="button"
              aria-label="Helpful"
              className={button("icon")}
              disabled={pending}
              onClick={() => submit({ rating: "up" })}
            >
              <Icon name="thumb_up" />
            </button>
            <button
              type="button"
              aria-label="Not helpful"
              className={button("icon")}
              disabled={pending}
              onClick={() => submit({ rating: "down" })}
            >
              <Icon name="thumb_down" />
            </button>
            <button
              type="button"
              className={button("text")}
              aria-expanded={reporting}
              aria-controls={reportId}
              onClick={() => setReporting((r) => !r)}
            >
              <Icon name="flag" />
              Report an error
            </button>
          </div>
        )}
        {children}
      </div>
      {reporting && !done && (
        <form
          id={reportId}
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit({ reportText: report });
          }}
        >
          <label className="flex flex-col gap-1.5 text-label-l text-on-surface-variant">
            What&apos;s wrong?
            <textarea
              value={report}
              onChange={(e) => setReport(e.target.value)}
              maxLength={2000}
              rows={3}
              className={`${field()} resize-y`}
            />
          </label>
          <button type="submit" className={button("outlined", "self-start")} disabled={pending}>
            Send report
          </button>
        </form>
      )}
      {error && <FormError error={error} />}
    </div>
  );
}
