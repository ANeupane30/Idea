import { describe, expect, it } from "vitest";
import { detectLinkType, LABEL_TEXT, linkSchema, STEP_TEXT } from "@/lib/sources";
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
  });
});
