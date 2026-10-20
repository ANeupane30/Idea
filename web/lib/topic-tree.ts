export type SubtopicRow = {
  id: string;
  parent_id: string | null;
  title: string;
  summary: string | null;
  position: number;
  user_edited: boolean;
};

export type TreeNode = SubtopicRow & { children: TreeNode[] };

const byPosition = (a: SubtopicRow, b: SubtopicRow) =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildTree(rows: SubtopicRow[]): TreeNode[] {
  const sorted = [...rows].sort(byPosition);
  const nodes = new Map<string, TreeNode>(sorted.map((r) => [r.id, { ...r, children: [] }]));
  const roots: TreeNode[] = [];
  for (const r of sorted) {
    const node = nodes.get(r.id)!;
    const parent = r.parent_id ? nodes.get(r.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
