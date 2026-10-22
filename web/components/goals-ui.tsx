"use client";

import Link from "next/link";
import { useState } from "react";
import { useActionState } from "react";
import { FormError } from "@/components/form-error";
import { button, field } from "@/components/ui/buttons";
import type { ActionResult } from "@/lib/validation";

export type GoalRow = { id: string; title: string; status: string; statusText: string };

const LABEL = "flex flex-col gap-1.5 text-label-l text-on-surface-variant";

export function NewGoalForm({ action }: { action: (formData: FormData) => Promise<ActionResult> }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    (_prev, formData) => action(formData),
    null,
  );
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className={LABEL}>
        Title
        <input name="title" required className={field()} />
      </label>
      <label className={LABEL}>
        Description (optional)
        <textarea name="description" rows={2} className={`${field()} resize-y`} />
      </label>
      {state && !state.ok ? <FormError error={state.error} /> : null}
      <button type="submit" disabled={pending} className={button("filled", "self-start")}>
        Create goal
      </button>
    </form>
  );
}

export function GoalLists({
  active,
  archived,
  action,
}: {
  active: GoalRow[];
  archived: GoalRow[];
  action: (goalId: string, status: "active" | "archived") => Promise<ActionResult>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function change(id: string, status: "active" | "archived") {
    setBusy(true);
    const r = await action(id, status);
    setError(r.ok ? "" : r.error);
    setBusy(false);
  }

  const row = "flex items-center justify-between gap-4 rounded-2xl border border-outline-variant p-4";
  return (
    <>
      {error ? <FormError error={error} /> : null}
      <section aria-labelledby="active-h" className="flex flex-col gap-3">
        <h2 id="active-h" className="text-title-m text-on-surface">
          Active
        </h2>
        {active.length === 0 ? <p className="text-body-m text-on-surface-variant">No active goals yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {active.map((g) => (
            <li key={g.id} className={row}>
              <div className="min-w-0">
                <Link
                  href={`/goals/${g.id}`}
                  className="text-title-m text-primary underline-offset-4 [overflow-wrap:anywhere] hover:underline"
                >
                  {g.title}
                </Link>
                <p className="text-body-m text-on-surface-variant">{g.statusText}</p>
              </div>
              <button type="button" disabled={busy} className={button("outlined")} onClick={() => change(g.id, "archived")}>
                Archive
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="archived-h" className="flex flex-col gap-3">
        <h2 id="archived-h" className="text-title-m text-on-surface">
          Archived
        </h2>
        {archived.length === 0 ? <p className="text-body-m text-on-surface-variant">Nothing archived.</p> : null}
        <ul className="flex flex-col gap-2">
          {archived.map((g) => (
            <li key={g.id} className={row}>
              <Link
                href={`/goals/${g.id}`}
                className="min-w-0 text-title-m text-on-surface-variant underline-offset-4 [overflow-wrap:anywhere] hover:underline"
              >
                {g.title}
              </Link>
              <button type="button" disabled={busy} className={button("outlined")} onClick={() => change(g.id, "active")}>
                Unarchive
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
