"use client";

import { useActionState, useId } from "react";
import { FormError } from "@/components/form-error";
import type { ActionResult } from "@/lib/validation";

const LEVELS = [
  { value: "beginner", label: "I'm new to it", hint: "Start from the very beginning." },
  { value: "intermediate", label: "I know the basics", hint: "Build on what you already know." },
  { value: "advanced", label: "I'm experienced", hint: "Go straight to the deeper parts." },
];

export function StartForm({ action }: { action: (formData: FormData) => Promise<ActionResult> }) {
  const id = useId();
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    (_prev, formData) => action(formData),
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-7">
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Your goal</span>
        <input
          name="title"
          required
          maxLength={120}
          autoComplete="off"
          placeholder="e.g. Learn the basics of personal finance"
          className="rounded-xl border border-zinc-300 bg-white px-3.5 py-3 text-base sm:px-4 text-zinc-900 shadow-sm placeholder:text-zinc-400 max-sm:placeholder:text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-400/30"
        />
      </label>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          How much do you already know about it?
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {LEVELS.map((l) => (
            <label
              key={l.value}
              className="relative flex cursor-pointer gap-3 rounded-2xl border border-zinc-200 bg-white p-4 transition-colors hover:border-zinc-300 has-checked:border-indigo-500 has-checked:bg-indigo-50 has-checked:ring-1 has-checked:ring-indigo-500 has-focus-visible:ring-2 has-focus-visible:ring-indigo-500 sm:flex-col sm:gap-2 dark:border-zinc-800 dark:bg-zinc-950/40 dark:hover:border-zinc-700 dark:has-checked:border-indigo-400 dark:has-checked:bg-indigo-400/10 dark:has-checked:ring-indigo-400"
            >
              <input
                type="radio"
                name="level"
                value={l.value}
                defaultChecked={l.value === "beginner"}
                required
                aria-labelledby={`${id}-${l.value}`}
                aria-describedby={`${id}-${l.value}-hint`}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 border-zinc-300 peer-checked:border-indigo-600 peer-checked:[&>span]:scale-100 dark:border-zinc-600 dark:peer-checked:border-indigo-400"
              >
                <span className="size-2.5 scale-0 rounded-full bg-indigo-600 transition-transform dark:bg-indigo-400" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span id={`${id}-${l.value}`} className="font-semibold text-zinc-900 dark:text-zinc-50">
                  {l.label}
                </span>
                <span id={`${id}-${l.value}-hint`} className="text-sm text-zinc-600 dark:text-zinc-400">
                  {l.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-3">
        {state && !state.ok ? <FormError error={state.error} /> : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 px-5 py-3.5 text-base font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:from-indigo-500 hover:to-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-60 dark:from-indigo-500 dark:to-violet-500 dark:shadow-indigo-950/40 dark:focus-visible:ring-offset-zinc-900"
        >
          Build my learning map
        </button>
      </div>
    </form>
  );
}
