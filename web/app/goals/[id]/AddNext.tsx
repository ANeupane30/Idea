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
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        What to add next
      </h2>
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {items.map((node) => (
          <li
            key={node.id}
            className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="flex flex-wrap items-center gap-2 font-medium text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-50">
              {node.title} <CoverageBadge state={coverage[node.id].state} />
            </p>
            <div className="mt-2">
              <SearchLinks query={searchQuery(goalTitle, node.title)} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
