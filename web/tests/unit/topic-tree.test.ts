import { describe, expect, it } from "vitest";
import { buildTree, type SubtopicRow } from "@/lib/topic-tree";

const row = (id: string, parent_id: string | null, position: number): SubtopicRow => ({
  id,
  parent_id,
  title: id,
  summary: null,
  position,
  user_edited: false,
});

describe("buildTree", () => {
  it("returns an empty list for no rows", () => {
    expect(buildTree([])).toEqual([]);
  });
  it("nests children under parents in position order", () => {
    const tree = buildTree([row("c2", "a", 1), row("b", null, 5), row("a", null, 0), row("c1", "a", 0)]);
    expect(tree.map((n) => n.id)).toEqual(["a", "b"]);
    expect(tree[0].children.map((n) => n.id)).toEqual(["c1", "c2"]);
    expect(tree[1].children).toEqual([]);
  });
  it("breaks position ties by id", () => {
    expect(buildTree([row("z", null, 0), row("m", null, 0)]).map((n) => n.id)).toEqual(["m", "z"]);
  });
  it("promotes orphans to top level", () => {
    const tree = buildTree([row("a", null, 0), row("o", "missing", 1)]);
    expect(tree.map((n) => n.id)).toEqual(["a", "o"]);
  });
});
