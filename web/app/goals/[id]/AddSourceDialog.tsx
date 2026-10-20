"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/form-error";
import { button } from "@/components/ui/buttons";
import { StatusChip } from "@/components/ui/chips";
import { Icon } from "@/components/ui/icon";
import { createBrowserClient } from "@/lib/supabase/client";
import { linkSchema, PDF_MAX_BYTES, PDF_TOO_BIG, STAGE_TEXT, stageOf, type SourceRow } from "@/lib/sources";
import { GENERIC_ERROR, type ActionResult } from "@/lib/validation";
import { addLinkSource, addPdfSource } from "./source-actions";
import { sourceTitle, TYPE_ICON } from "./SourceList";

type Props = {
  goalId: string;
  userId: string;
  rows: SourceRow[];
  open: boolean;
  onClose: () => void;
  onRetry: (id: string) => void;
  /** Why the last "Try again" failed (shown here, since the page behind is inert). */
  retryError?: string | null;
};

/**
 * Add a link or a PDF, and watch each one being added: the sources still being processed or that
 * failed, plus those that finished while the dialog was open.
 */
export function AddSourceDialog({ goalId, userId, rows, open, onClose, onRetry, retryError }: Props) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Rows to list: those not ready yet (or failed), and those added or finished since it opened.
  // `settled` is the ready rows when the dialog opened, plus any seen ready while it was closed.
  const [settled, setSettled] = useState<ReadonlySet<string>>(
    () => new Set(rows.filter((r) => r.status === "ready").map((r) => r.id)),
  );
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSettled(new Set(rows.filter((r) => r.status === "ready").map((r) => r.id)));
      setError(null);
    }
  }
  const listed = rows.filter((r) => !settled.has(r.id));

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      urlRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

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
      const storage = createBrowserClient().storage.from("sources");
      const { error: uploadError } = await storage.upload(path, file, { contentType: "application/pdf" });
      if (uploadError) return { ok: false, error: GENERIC_ERROR };
      const result = await addPdfSource(goalId, path, file.name);
      // Don't leave the file behind when the source couldn't be added (e.g. a limit).
      if (!result.ok) await storage.remove([path]);
      return result;
    }, reset);
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-[28px] bg-surface-container-high p-6 text-on-surface motion-safe:open:animate-dialog-in"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id={titleId} className="text-headline-s">
          Add a source
        </h2>
        <button type="button" aria-label="Close" onClick={onClose} className={button("icon", "-mr-3 -mt-2")}>
          <Icon name="close" size={24} />
        </button>
      </div>

      <form onSubmit={submitLink} className="mt-6">
        <label htmlFor={`${titleId}-url`} className="text-label-l">
          Paste a link to a web page or YouTube video
        </label>
        <div className="mt-2 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon
              name="link"
              size={20}
              className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-on-surface-variant"
            />
            <input
              id={`${titleId}-url`}
              type="url"
              inputMode="url"
              ref={urlRef}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://"
              maxLength={2000}
              className="min-h-12 w-full rounded-full border border-outline bg-surface py-2 pr-4 pl-11 text-body-l text-on-surface placeholder:text-on-surface-variant focus:border-2 focus:border-primary focus:pl-[43px] focus:outline-none"
            />
          </div>
          <button type="submit" disabled={isPending} className={button("filled")}>
            Add
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label
          className={button(
            "outlined",
            "cursor-pointer has-disabled:opacity-50 has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary",
          )}
        >
          <Icon name="upload_file" />
          Upload PDF
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            disabled={isPending}
            aria-describedby={hintId}
            onChange={(e) => uploadPdf(e.target.files?.[0])}
            className="sr-only"
          />
        </label>
        <p id={hintId} className="flex items-center gap-1.5 text-body-m text-on-surface-variant">
          <Icon name="info" size={18} />
          PDFs need selectable text, up to 25 MB
        </p>
      </div>
      {error && <FormError error={error} className="mt-3" />}

      <hr className="my-6 border-outline-variant" />
      <h3 className="text-label-l text-on-surface-variant">Adding to your map</h3>
      {listed.length === 0 && (
        <p className="mt-2 text-body-m text-on-surface-variant">Sources you add appear here while they&apos;re read.</p>
      )}
      <ul aria-label="Adding to your map" className="mt-3 flex flex-col gap-2">
        {listed.map((s) => (
          <AddingRow key={s.id} source={s} onRetry={() => onRetry(s.id)} />
        ))}
      </ul>
      {retryError && <FormError error={retryError} className="mt-3" />}

      <div className="mt-6 flex justify-end">
        <button type="button" onClick={onClose} className={button("text")}>
          Done
        </button>
      </div>
    </dialog>
  );
}

function AddingRow({ source: s, onRetry }: { source: SourceRow; onRetry: () => void }) {
  const { stage, failed } = stageOf(s);
  return (
    <li className={`flex gap-4 rounded-2xl p-4 ${failed ? "bg-negative text-on-negative" : "bg-surface"}`}>
      <Icon name={TYPE_ICON[s.type]} size={24} className={failed ? "" : "text-on-surface-variant"} />
      <div className="min-w-0 flex-1">
        <p className="text-title-m [overflow-wrap:anywhere]">{sourceTitle(s)}</p>
        {failed ? (
          <div className="mt-1 flex flex-wrap items-start justify-between gap-x-4">
            <p className="flex gap-1.5 text-body-m">
              <Icon name="error" size={20} />
              {s.error ?? GENERIC_ERROR}
            </p>
            <button type="button" onClick={onRetry} className={button("text", "-mr-3 min-h-10 text-on-negative")}>
              Try again
            </button>
          </div>
        ) : stage === 3 ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-body-m text-on-positive">
            <span className="inline-flex items-center gap-1">
              <Icon name="check_circle" size={18} filled />
              Ready
            </span>
            {s.relevance_label && <StatusChip kind="relevance" value={s.relevance_label} />}
          </p>
        ) : (
          <ol aria-label="Progress" className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-label-m">
            {STAGE_TEXT.map((text, i) => (
              <li
                key={text}
                aria-current={i === stage ? "step" : undefined}
                className={`flex items-center gap-1 ${i === stage ? "text-primary" : "text-on-surface-variant"}`}
              >
                <Icon
                  name={i < stage ? "check_circle" : i === stage ? "progress_activity" : "radio_button_unchecked"}
                  filled={i < stage}
                  size={16}
                  className={i === stage ? "motion-safe:animate-spin" : ""}
                />
                {text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}
