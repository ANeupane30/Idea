"use client";

import { useActionState } from "react";
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
        <legend className="mb-1 font-medium">How do you like to learn?</legend>
        {FORMATS.map((f) => (
          <label key={f.value} className="flex items-start gap-2">
            <input
              type="radio"
              name="preferred_format"
              value={f.value}
              defaultChecked={format === f.value}
              required
              className="mt-1"
            />
            <span>
              {f.label}
              <span className="block text-sm text-zinc-600">{f.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">What is your level?</legend>
        {LEVELS.map((l) => (
          <label key={l.value} className="flex items-center gap-2">
            <input type="radio" name="level" value={l.value} defaultChecked={level === l.value} required />
            {l.label}
          </label>
        ))}
      </fieldset>
      <div role="alert" className="min-h-5 text-sm text-red-700">
        {state && !state.ok ? state.error : null}
      </div>
      <button
        type="submit"
        disabled={pending || state?.ok === true}
        className="self-start rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-60"
      >
        Save
      </button>
    </form>
  );
}
