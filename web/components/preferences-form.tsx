"use client";

import { useActionState } from "react";
import { FilterChip } from "@/components/ui/chips";
import { button } from "@/components/ui/buttons";
import type { ActionResult } from "@/lib/validation";

const FORMATS = [
  { value: "visual", label: "Visual", desc: "Diagrams do most of the explaining, with short captions." },
  { value: "text", label: "Text", desc: "A structured written explanation with one supporting diagram." },
  { value: "examples", label: "Examples", desc: "Worked examples and analogies, with one diagram." },
  { value: "summary", label: "Summary", desc: "The key points in about 200 words, with an overview diagram." },
];
const LEVELS = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
];

type Props = {
  action: (formData: FormData) => Promise<ActionResult>;
  format: string;
  level: string;
};

export function PreferencesForm({ action, format, level }: Props) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_prev, formData) => {
      const result = await action(formData);
      if (result.ok) window.location.assign("/goals");
      return result;
    },
    null,
  );
  return (
    <form action={formAction} className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-title-m text-on-surface">How do you like to learn?</legend>
        {FORMATS.map((f) => (
          <label
            key={f.value}
            className="flex cursor-pointer items-start gap-3 rounded-2xl border border-outline-variant p-4 has-checked:border-2 has-checked:border-primary has-checked:bg-primary-container has-checked:p-[15px] has-focus-visible:outline-3 has-focus-visible:outline-primary"
          >
            <input
              type="radio"
              name="preferred_format"
              value={f.value}
              defaultChecked={format === f.value}
              required
              className="mt-1 accent-(--m-primary)"
            />
            <span className="text-title-m text-on-surface">
              {f.label}
              <span className="block text-body-m text-on-surface-variant">{f.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-title-m text-on-surface">What is your level?</legend>
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((l) => (
            <FilterChip
              key={l.value}
              label={l.label}
              type="radio"
              name="level"
              value={l.value}
              defaultChecked={level === l.value}
              required
            />
          ))}
        </div>
      </fieldset>
      <div role="alert" className="min-h-5 text-body-m text-on-negative">
        {state && !state.ok ? state.error : null}
      </div>
      <button
        type="submit"
        disabled={pending || state?.ok === true}
        className={button("filled", "self-start")}
      >
        Save
      </button>
    </form>
  );
}
