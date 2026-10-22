import { useId } from "react";
import { StatusChip } from "@/components/ui/chips";
import { MasteryMeter } from "@/components/ui/mastery-meter";
import type { TreeNode } from "@/lib/topic-tree";
import { numberedTitles, StudyNext, type MasteryRow } from "@/app/goals/[id]/StudyNext";

/** What to study next, then every topic with its mastery. */
export function ReviewOverview({ goalId, tree, rows }: { goalId: string; tree: TreeNode[]; rows: MasteryRow[] }) {
  const headingId = useId();
  const byId = new Map(rows.map((r) => [r.subtopic_id, r]));
  const titles = numberedTitles(tree);
  const topics = tree.flatMap((n) => [{ node: n, child: false }, ...n.children.map((c) => ({ node: c, child: true }))]);
  return (
    <div className="flex flex-col gap-8">
      <StudyNext goalId={goalId} tree={tree} rows={rows} />
      <section aria-labelledby={headingId}>
        <h2 id={headingId} className="text-title-m text-on-surface">
          Your topics
        </h2>
        <ul aria-label="Your topics" className="mt-2 flex flex-col divide-y divide-outline-variant">
          {topics.map(({ node, child }) => {
            const m = byId.get(node.id);
            return (
              <li
                key={node.id}
                className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 ${child ? "pl-6" : ""}`}
              >
                <span className="min-w-0 flex-1 text-body-l text-on-surface [overflow-wrap:anywhere]">
                  {titles.get(node.id)}
                </span>
                <span className="flex w-full items-center justify-end gap-3 sm:w-auto">
                  {m ? (
                    <>
                      <MasteryMeter decayed={m.decayed} label={m.label} showLabel={false} className="w-36" />
                      <StatusChip kind="mastery" value={m.label} className="w-28 justify-center" />
                    </>
                  ) : (
                    <span className="text-body-m text-on-surface-variant">Not practised yet</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
