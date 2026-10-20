"use client";

import { useActionState } from "react";
import { FormError } from "@/components/form-error";
import { button } from "@/components/ui/buttons";
import { FilterChip } from "@/components/ui/chips";
import { Icon } from "@/components/ui/icon";
import type { ActionResult } from "@/lib/validation";

const LEVELS = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
];

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

  return (
    <form action={formAction} className="flex w-full flex-col items-center gap-6">
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

      <fieldset className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
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

      {state && !state.ok ? <FormError error={state.error} className="text-center" /> : null}
      <button type="submit" disabled={pending} className={button("filled")}>
        <Icon name="account_tree" size={20} />
        Build my learning map
      </button>
      {note}
    </form>
  );
}
