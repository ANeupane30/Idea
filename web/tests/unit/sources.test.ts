import { describe, expect, it } from "vitest";
import {
  addNextItems,
  COVERAGE_TEXT,
  detectLinkType,
  goalTopic,
  isUploadPath,
  LABEL_TEXT,
  linkSchema,
  searchQuery,
  STEP_TEXT,
  type NodeCoverage,
} from "@/lib/sources";
import type { TreeNode } from "@/lib/topic-tree";
import { dbErrorToMessage } from "@/lib/validation";

describe("detectLinkType", () => {
  it.each([
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ",
  ])("treats %s as youtube", (url) => {
    expect(detectLinkType(url)).toBe("youtube");
  });
  it.each(["https://example.com", "https://notyoutube.com/watch?v=x", "https://youtube.com.evil.test/"])(
    "treats %s as web",
    (url) => {
      expect(detectLinkType(url)).toBe("web");
    },
  );
});

describe("linkSchema", () => {
  const message = "Enter a link that starts with http:// or https://";
  it.each(["javascript:alert(1)", "ftp://x", "example.com", "", `https://example.com/${"a".repeat(2000)}`])(
    "rejects %s",
    (url) => {
      const r = linkSchema.safeParse(url);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe(message);
    },
  );
  it("accepts http and https, trimmed, with a lowercase scheme", () => {
    expect(linkSchema.parse("  https://example.com/a?b=1  ")).toBe("https://example.com/a?b=1");
    expect(linkSchema.parse("HTTP://Example.com/x")).toBe("http://example.com/x");
  });
});

describe("source copy", () => {
  it("has a line for every step and label", () => {
    expect(STEP_TEXT).toEqual({
      queued: "Waiting to start…",
      extracting: "Reading the source…",
      chunking: "Splitting into sections…",
      embedding: "Indexing…",
      mapping: "Matching to your topics…",
    });
    expect(LABEL_TEXT).toEqual({ high: "Highly relevant", partial: "Partly relevant", off_topic: "Off-topic" });
  });
});

describe("dbErrorToMessage for sources", () => {
  it("maps the source errors", () => {
    expect(dbErrorToMessage({ message: "guest_source_limit_reached" })).toBe("Sign up free to add more sources.");
    expect(dbErrorToMessage({ message: "source_limit_reached" })).toBe(
      "You've reached today's limit for new sources. Try again tomorrow.",
    );
    expect(dbErrorToMessage({ message: "goal_not_ready" })).toBe(
      "Wait for your topic map to finish before adding sources.",
    );
    expect(dbErrorToMessage({ message: "goal_archived" })).toBe("Unarchive this goal to add sources.");
    expect(dbErrorToMessage({ message: "invalid_source" })).toBe("That link or file can't be added.");
    expect(dbErrorToMessage({ message: "source_attempt_limit_reached" })).toBe(
      "You've tried adding sources too many times today. Try again tomorrow.",
    );
  });
});

describe("goalTopic and searchQuery", () => {
  it("strips a leading learning verb", () => {
    expect(goalTopic("Learn the basics of personal finance")).toBe("personal finance");
    expect(goalTopic("Learn about Roman history")).toBe("Roman history");
    expect(goalTopic("learn SQL")).toBe("SQL");
    expect(goalTopic("How to bake bread")).toBe("bake bread");
    expect(goalTopic("Understand statistics")).toBe("statistics");
    expect(goalTopic("Master chess openings")).toBe("chess openings");
    expect(goalTopic("SQL")).toBe("SQL");
  });
  it("builds the search query from the subtopic and the goal topic", () => {
    expect(searchQuery("Learn SQL", "Joining tables")).toBe("Joining tables SQL");
  });
  it("names the coverage states", () => {
    expect(COVERAGE_TEXT).toEqual({ covered: "Covered", thin: "Thin", gap: "Gap" });
  });
});

describe("addNextItems", () => {
  const node = (id: string, children: TreeNode[] = []): TreeNode => ({
    id,
    parent_id: null,
    title: id,
    summary: null,
    position: 0,
    user_edited: false,
    children,
  });
  const tree = [node("a", [node("a1"), node("a2")]), node("b"), node("c", [node("c1")]), node("d"), node("e"), node("f")];
  const cov = (state: NodeCoverage["state"]): NodeCoverage => ({ state, sources: [] });

  it("lists gaps first, then thin, in map order, at most 5, never covered", () => {
    const coverage: Record<string, NodeCoverage> = {
      a: cov("covered"),
      a1: cov("thin"),
      a2: cov("gap"),
      b: cov("gap"),
      c: cov("thin"),
      c1: cov("gap"),
      d: cov("gap"),
      e: cov("covered"),
      f: cov("gap"),
    };
    expect(addNextItems(tree, coverage).map((n) => n.id)).toEqual(["a2", "b", "c1", "d", "f"]);
  });
  it("fills with thin items when there are few gaps", () => {
    const coverage: Record<string, NodeCoverage> = {
      a: cov("covered"),
      a1: cov("thin"),
      a2: cov("covered"),
      b: cov("gap"),
      c: cov("thin"),
      c1: cov("covered"),
      d: cov("covered"),
      e: cov("covered"),
      f: cov("covered"),
    };
    expect(addNextItems(tree, coverage).map((n) => n.id)).toEqual(["b", "a1", "c"]);
  });
});

describe("isUploadPath", () => {
  const uid = "11111111-1111-4111-8111-111111111111";
  it("accepts only <user id>/<uuid>.pdf", () => {
    expect(isUploadPath(uid, `${uid}/22222222-2222-4222-8222-222222222222.pdf`)).toBe(true);
    expect(isUploadPath(uid, `${uid}/../x/22222222-2222-4222-8222-222222222222.pdf`)).toBe(false);
    expect(isUploadPath(uid, `${uid}/notes.pdf`)).toBe(false);
    expect(isUploadPath(uid, `33333333-3333-4333-8333-333333333333/22222222-2222-4222-8222-222222222222.pdf`)).toBe(false);
  });
});
