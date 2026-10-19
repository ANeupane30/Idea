import Link from "next/link";
import { useId } from "react";
import { button } from "@/components/ui/buttons";
import { InfoChip, StatusChip } from "@/components/ui/chips";
import { Icon } from "@/components/ui/icon";
import type { MasteryLabel } from "@/lib/quiz";
import type { TreeNode } from "@/lib/topic-tree";

export type MasteryRow = { subtopic_id: string; decayed: number; label: MasteryLabel; due: boolean };

/** "<n> <title>" for main topics, the title alone for children. */
export function numberedTitles(tree: TreeNode[]): Map<string, string> {
  const titles = new Map<string, string>();
  tree.forEach((n, i) => {
    titles.set(n.id, `${i + 1} ${n.title}`);
    for (const c of n.children) titles.set(c.id, c.title);
  });
  return titles;
}

/** Weak topics first, then those due for review (map order within each). */
export function StudyNext({ goalId, tree, rows }: { goalId: string; tree: TreeNode[]; rows: MasteryRow[] }) {
  const headingId = useId();
  const byId = new Map(rows.map((r) => [r.subtopic_id, r]));
  const titles = numberedTitles(tree);
  const ordered = tree.flatMap((n) => [n, ...n.children]).filter((n) => byId.has(n.id));
  const weak = ordered.filter((n) => byId.get(n.id)!.label === "weak");
  const due = ordered.filter((n) => byId.get(n.id)!.label !== "weak" && byId.get(n.id)!.due);
  const items = [...weak, ...due];

  return (
    <section aria-labelledby={headingId} className="rounded-2xl bg-surface-container-high p-5 sm:p-6">
      <h2 id={headingId} className="text-title-l text-on-surface">
        What to study next
      </h2>
      {items.length > 0 ? (
        <ul className="mt-2 flex flex-col divide-y divide-outline-variant">
          {items.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 py-4 last:pb-0">
              <div className="flex min-w-0 flex-col items-start gap-2">
                <p className="text-title-m text-on-surface [overflow-wrap:anywhere]">{titles.get(n.id)}</p>
                {byId.get(n.id)!.label === "weak" ? (
                  <StatusChip kind="mastery" value="weak" />
                ) : (
                  <InfoChip icon="event_repeat" className="h-6 rounded-lg bg-surface px-2 text-label-m">
                    Due for review
                  </InfoChip>
                )}
              </div>
              <Link href={`/goals/${goalId}/topics/${n.id}`} className={button("outlined")}>
                <Icon name="menu_book" />
                Open lesson
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-body-m text-on-surface-variant">You&apos;re on track. Nothing is due for review.</p>
      )}
    </section>
  );
}
