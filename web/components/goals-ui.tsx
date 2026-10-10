"use client";

import Link from "next/link";
import { useState } from "react";
import { useActionState } from "react";
import type { ActionResult } from "@/lib/validation";

export type GoalRow = { id: string; title: string; status: string; statusText: string };

export function NewGoalForm({ action }: { action: (formData: FormData) => Promise<ActionResult> }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    (_prev, formData) => action(formData),
    null,
  );
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input name="title" required className="rounded border border-zinc-400 px-3 py-2 text-base" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Description (optional)
        <textarea name="description" rows={2} className="rounded border border-zinc-400 px-3 py-2 text-base" />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-60"
      >
        Create goal
      </button>
      {state && !state.ok ? (
        <div role="alert" className="text-sm text-red-700">
          {state.error}
        </div>
      ) : null}
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

  const btn = "rounded border border-zinc-400 px-3 py-1 text-sm disabled:opacity-60";
  return (
    <>
      {error ? (
        <div role="alert" className="text-sm text-red-700">
          {error}
        </div>
      ) : null}
      <section aria-labelledby="active-h" className="flex flex-col gap-2">
        <h2 id="active-h" className="text-lg font-semibold">
          Active
        </h2>
        {active.length === 0 ? <p className="text-sm text-zinc-600">No active goals yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {active.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 rounded border border-zinc-300 p-3">
              <div>
                <Link href={`/goals/${g.id}`} className="underline">
                  {g.title}
                </Link>
                <p className="text-sm text-zinc-600">{g.statusText}</p>
              </div>
              <button type="button" disabled={busy} className={btn} onClick={() => change(g.id, "archived")}>
                Archive
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="archived-h" className="flex flex-col gap-2">
        <h2 id="archived-h" className="text-lg font-semibold">
          Archived
        </h2>
        {archived.length === 0 ? <p className="text-sm text-zinc-600">Nothing archived.</p> : null}
        <ul className="flex flex-col gap-2">
          {archived.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 rounded border border-zinc-300 p-3">
              <span>{g.title}</span>
              <button type="button" disabled={busy} className={btn} onClick={() => change(g.id, "active")}>
                Unarchive
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
