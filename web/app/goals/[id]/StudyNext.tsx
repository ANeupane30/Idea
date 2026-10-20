import Link from "next/link";
import { useId } from "react";
import { LABEL_TEXT, type MasteryLabel } from "@/lib/quiz";
import type { TreeNode } from "@/lib/topic-tree";

export type MasteryRow = { subtopic_id: string; decayed: number; label: MasteryLabel; due: boolean };

/** Weak topics first, then those due for review (map order within each), and the review quiz. */
export function StudyNext({ goalId, tree, rows }: { goalId: string; tree: TreeNode[]; rows: MasteryRow[] }) {
  const headingId = useId();
  if (rows.length === 0) return null;
  const byId = new Map(rows.map((r) => [r.subtopic_id, r]));
  const ordered = tree.flatMap((n) => [n, ...n.children]).filter((n) => byId.has(n.id));
  const weak = ordered.filter((n) => byId.get(n.id)!.label === "weak");
  const due = ordered.filter((n) => byId.get(n.id)!.label !== "weak" && byId.get(n.id)!.due);
  const items = [...weak, ...due];

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        What to study next
      </h2>
      {items.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2">
          {items.map((n) => (
            <li
              key={n.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <Link
                href={`/goals/${goalId}/topics/${n.id}`}
                className="font-medium text-zinc-900 underline-offset-4 hover:underline [overflow-wrap:anywhere] dark:text-zinc-50"
              >
                {n.title}
              </Link>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {byId.get(n.id)!.label === "weak" ? LABEL_TEXT.weak : "Due for review"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">You&apos;re on track. Nothing is due for review.</p>
      )}
      <Link
        href={`/goals/${goalId}/review`}
        className="mt-4 inline-flex rounded-xl bg-indigo-600 px-5 py-2.5 font-semibold text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:focus-visible:ring-offset-zinc-950"
      >
        Start a review quiz
      </Link>
    </section>
  );
}
