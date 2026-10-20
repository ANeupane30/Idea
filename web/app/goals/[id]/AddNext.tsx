import { useId } from "react";
import { addNextItems, searchQuery, type NodeCoverage } from "@/lib/sources";
import type { TreeNode } from "@/lib/topic-tree";
import { CoverageBadge, SearchLinks } from "./Coverage";

/** Gaps and thin topics to find sources for next, with search suggestions. */
export function AddNext({
  goalTitle,
  tree,
  coverage,
}: {
  goalTitle: string;
  tree: TreeNode[];
  coverage: Record<string, NodeCoverage>;
}) {
  const headingId = useId();
  const items = addNextItems(tree, coverage);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="rounded-2xl bg-surface-container-high p-5">
      <h2 id={headingId} className="text-title-l text-on-surface">
        What to add next
      </h2>
      <ul className="mt-3 flex flex-col divide-y divide-outline-variant">
        {items.map((node) => {
          const state = coverage[node.id].state;
          return (
            <li key={node.id} className="flex flex-col gap-1 py-3 first:pt-1 last:pb-0">
              <p className="flex flex-wrap items-start gap-2 text-body-m text-on-surface [overflow-wrap:anywhere]">
                <CoverageBadge state={state} />
                <span className="min-w-0">
                  {node.title} {state === "gap" ? "has no sources yet." : "has thin coverage."}
                </span>
              </p>
              <SearchLinks query={searchQuery(goalTitle, node.title)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
