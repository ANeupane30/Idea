import { describe, expect, it } from "vitest";
import { dbErrorToMessage, goalSchema, preferencesSchema } from "@/lib/validation";

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
  it("rejects unknown format", () => {
    expect(preferencesSchema.safeParse({ preferred_format: "audio", level: "beginner" }).success).toBe(false);
  });
  it("accepts valid values", () => {
    expect(preferencesSchema.safeParse({ preferred_format: "visual", level: "advanced" }).success).toBe(true);
  });
});

describe("dbErrorToMessage", () => {
  it("maps known errors", () => {
    expect(dbErrorToMessage({ message: "goal_limit_reached" })).toBe("Free plan allows 2 active goals. Archive one to add another.");
    expect(dbErrorToMessage({ message: "map_not_editable" })).toBe("The topic map can't be edited right now.");
    expect(dbErrorToMessage({ message: "max_depth_exceeded" })).toBe("Topic maps can only be two levels deep.");
    expect(dbErrorToMessage({ message: "not_clarifying" })).toBe("This goal's topic map has already moved on. Refresh the page.");
    expect(dbErrorToMessage({ message: "not_failed" })).toBe("This goal's topic map has already moved on. Refresh the page.");
    expect(dbErrorToMessage({ message: "invalid_answer" })).toBe("Please write an answer of up to 1000 characters.");
    expect(dbErrorToMessage({ message: "boom" })).toBe("Something went wrong. Please try again.");
  });
});
