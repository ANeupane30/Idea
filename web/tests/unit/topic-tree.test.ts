import { describe, expect, it } from "vitest";
import { buildTree, type SubtopicRow } from "@/lib/topic-tree";
import { subtopicSummarySchema, subtopicTitleSchema } from "@/lib/validation";

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

describe("subtopicTitleSchema", () => {
  it("rejects blank", () => {
    const r = subtopicTitleSchema.safeParse("   ");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Title can't be empty.");
  });
  it("rejects 121 chars", () => {
    const r = subtopicTitleSchema.safeParse("a".repeat(121));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Keep the title under 120 characters.");
  });
  it("trims and keeps unicode", () => {
    expect(subtopicTitleSchema.parse("  日本語 🎌 ")).toBe("日本語 🎌");
  });
});

describe("subtopicSummarySchema", () => {
  it("is optional and capped at 300", () => {
    expect(subtopicSummarySchema.safeParse(undefined).success).toBe(true);
    expect(subtopicSummarySchema.safeParse("a".repeat(300)).success).toBe(true);
    expect(subtopicSummarySchema.safeParse("a".repeat(301)).success).toBe(false);
  });
});
