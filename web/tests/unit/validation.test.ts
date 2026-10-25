import { describe, expect, it } from "vitest";
import { dbErrorToMessage, goalSchema, preferencesSchema, startSchema, styleFormat } from "@/lib/validation";

describe("goalSchema", () => {
  it("rejects a blank title", () => {
    const r = goalSchema.safeParse({ title: "  " });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Title can't be empty.");
  });
  it("rejects a 121-character title", () => {
    const r = goalSchema.safeParse({ title: "a".repeat(121) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Keep the title under 120 characters.");
  });
  it("trims and keeps unicode", () => {
    const r = goalSchema.parse({ title: "  Learn 日本語 🎌 " });
    expect(r.title).toBe("Learn 日本語 🎌");
  });
  it("allows a missing description", () => {
    expect(goalSchema.safeParse({ title: "x" }).success).toBe(true);
  });
});

describe("preferencesSchema", () => {
  it("rejects an unknown style", () => {
    expect(preferencesSchema.safeParse({ learning_style: "audio", level: "beginner" }).success).toBe(false);
  });
  it("accepts valid values", () => {
    expect(preferencesSchema.safeParse({ learning_style: "visual_video", level: "advanced" }).success).toBe(true);
  });
  it("maps styles to lesson formats", () => {
    expect([styleFormat("visual_video"), styleFormat("reading"), styleFormat("hands_on")]).toEqual([
      "visual",
      "text",
      "examples",
    ]);
  });
});

describe("dbErrorToMessage", () => {
  it("maps known errors", () => {
    expect(dbErrorToMessage({ message: "goal_limit_reached" })).toBe("Free plan allows 2 active goals. Archive one to add another.");
    expect(dbErrorToMessage({ message: "not_clarifying" })).toBe("This goal's topic map has already moved on. Refresh the page.");
    expect(dbErrorToMessage({ message: "not_failed" })).toBe("This goal's topic map has already moved on. Refresh the page.");
    expect(dbErrorToMessage({ message: "invalid_answer" })).toBe("Please write an answer of up to 1000 characters.");
    expect(dbErrorToMessage({ message: "guest_goal_limit_reached" })).toBe(
      "Sign up free to save your progress and add more goals.",
    );
    expect(dbErrorToMessage({ message: "boom" })).toBe("Something went wrong. Please try again.");
  });
});

describe("startSchema", () => {
  const base = { title: "Learn SQL", level: "beginner", learning_style: "reading" };

  it("drops blank links and normalises the rest", () => {
    const r = startSchema.parse({ ...base, links: [" https://a.example/x ", "", "  "] });
    expect(r.links).toEqual(["https://a.example/x"]);
  });
  it("rejects more than 3 links", () => {
    const r = startSchema.safeParse({ ...base, links: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Add up to 3 links.");
  });
  it("rejects an invalid link with the link message", () => {
    const r = startSchema.safeParse({ ...base, links: ["not a link"] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/link/i);
  });
  it("ignores links when the learner asks us to pick", () => {
    const r = startSchema.parse({ ...base, links: ["not a link"], intent: "pick" });
    expect(r.links).toEqual([]);
  });
  it("defaults the style to reading", () => {
    expect(startSchema.parse({ title: "x", level: "beginner", links: [] }).learning_style).toBe("reading");
  });
});

describe("dbErrorToMessage for links", () => {
  it("maps too_many_links", () => {
    expect(dbErrorToMessage({ message: "too_many_links" })).toBe("Add up to 3 links.");
  });
});

describe("startSchema outline", () => {
  const base = { title: "Learn SQL", level: "beginner", learning_style: "reading", links: [] };
  it("treats a whitespace-only outline as none", () => {
    expect(startSchema.parse({ ...base, outline: "  \n  " }).outline).toBeNull();
  });
  it("keeps an outline", () => {
    expect(startSchema.parse({ ...base, outline: "1. Tables\n2. Joins" }).outline).toBe("1. Tables\n2. Joins");
  });
  it("rejects an outline over 20,000 characters", () => {
    const r = startSchema.safeParse({ ...base, outline: "x".repeat(20001) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Outlines can be up to 20,000 characters.");
  });
  it("ignores the outline when the learner asks us to pick", () => {
    expect(startSchema.parse({ ...base, outline: "1. A", intent: "pick" }).outline).toBeNull();
  });
});

