"use client";

import { useActionState, useId, useState } from "react";
import { FormError } from "@/components/form-error";
import { button, field } from "@/components/ui/buttons";
import { FilterChip } from "@/components/ui/chips";
import { Icon } from "@/components/ui/icon";
import { LEARNING_STYLES, MAX_START_LINKS, STYLE_LABELS, type ActionResult } from "@/lib/validation";

const LEVELS = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
];

const STEP = "text-title-m text-on-surface";

export function StartForm({
  action,
  note,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  /** A line under the button, e.g. "No account needed…" for guests. */
  note?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    (_prev, formData) => action(formData),
    null,
  );
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sourcesId = useId();
  const linksTabId = useId();

  return (
    <form action={formAction} className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className={STEP}>What do you want to master?</p>
        <label className="relative w-full">
          <span className="sr-only">Your goal</span>
          <Icon name="school" size={24} className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-on-surface-variant" />
          <input
            name="title"
            required
            maxLength={120}
            autoComplete="off"
            placeholder="Learn the basics of personal finance"
            className="min-h-14 w-full rounded-full border border-outline bg-surface-container-low py-3 pr-6 pl-14 text-body-l text-on-surface placeholder:text-on-surface-variant focus:border-2 focus:border-primary focus:pl-[55px] focus:outline-none"
          />
        </label>
        <fieldset className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <legend className="sr-only">Your level</legend>
          <span aria-hidden className="mr-2 text-body-m text-on-surface-variant">
            Your level
          </span>
          {LEVELS.map((l) => (
            <FilterChip
              key={l.value}
              label={l.label}
              type="radio"
              name="level"
              value={l.value}
              defaultChecked={l.value === "beginner"}
              required
            />
          ))}
        </fieldset>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className={`${STEP} mb-1`}>How do you like to learn?</legend>
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          {LEARNING_STYLES.map((s) => (
            <FilterChip
              key={s}
              label={STYLE_LABELS[s]}
              type="radio"
              name="learning_style"
              value={s}
              defaultChecked={s === "reading"}
              required
            />
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={sourcesOpen}
          aria-controls={sourcesId}
          onClick={() => setSourcesOpen((o) => !o)}
          className={`${STEP} flex min-h-12 items-center gap-2 self-start rounded-lg text-left`}
        >
          <Icon name={sourcesOpen ? "close" : "add"} size={20} className="text-on-surface-variant" />
          Where do you want to learn from?
        </button>
        {sourcesOpen && (
          <div id={sourcesId} className="flex flex-col gap-3 rounded-xl bg-surface-container-low p-4">
            <p className="text-body-m text-on-surface-variant">
              Have a specific course, book, or playlist? Paste it here and we&apos;ll map it out. Otherwise, leave
              blank and we&apos;ll find the best materials for your style.
            </p>
            <div role="tablist" aria-label="Your sources" className="flex gap-2">
              <button type="button" role="tab" id={linksTabId} aria-selected="true" className={button("tonal")}>
                Links
              </button>
            </div>
            <div role="tabpanel" aria-labelledby={linksTabId} className="flex flex-col gap-2">
              {Array.from({ length: MAX_START_LINKS }, (_, i) => (
                <input
                  key={i}
                  type="url"
                  name="links"
                  aria-label={`Link ${i + 1}`}
                  placeholder="https://"
                  className={field()}
                />
              ))}
            </div>
            <button type="submit" name="intent" value="pick" disabled={pending} className={button("text", "self-start")}>
              I don&apos;t have sources, pick the best ones for me
            </button>
          </div>
        )}
      </div>

      {state && !state.ok ? <FormError error={state.error} className="text-center" /> : null}
      <button type="submit" disabled={pending} className={button("filled", "self-center")}>
        <Icon name="account_tree" size={20} />
        Build my learning map
      </button>
      {note}
    </form>
  );
}
