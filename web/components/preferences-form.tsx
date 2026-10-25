"use client";

import { useActionState } from "react";
import { FilterChip } from "@/components/ui/chips";
import { button } from "@/components/ui/buttons";
import { LEARNING_STYLES, STYLE_LABELS, type ActionResult } from "@/lib/validation";

const LEVELS = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
];

type Props = {
  action: (formData: FormData) => Promise<ActionResult>;
  /** The learner's style; it sets their default lesson format. */
  learningStyle: string;
  level: string;
};

export function PreferencesForm({ action, learningStyle, level }: Props) {
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
        <div className="flex flex-wrap gap-2">
          {LEARNING_STYLES.map((s) => (
            <FilterChip
              key={s}
              label={STYLE_LABELS[s]}
              type="radio"
              name="learning_style"
              value={s}
              defaultChecked={(LEARNING_STYLES.includes(learningStyle as never) ? learningStyle : "reading") === s}
              required
            />
          ))}
        </div>
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
