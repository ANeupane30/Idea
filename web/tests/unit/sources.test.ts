import { describe, expect, it } from "vitest";
import {
  COVERAGE_TEXT,
  detectLinkType,
  isUploadPath,
  LABEL_TEXT,
  linkSchema,
  mainReference,
  PAYWALLED,
  STAGE_TEXT,
  stageOf,
  STEP_TEXT,
  TYPE_TEXT,
  type SourceRow,
} from "@/lib/sources";
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

describe("coverage", () => {
  it("names the coverage states", () => {
    expect(COVERAGE_TEXT).toEqual({ covered: "Covered", thin: "Thin", gap: "Gap" });
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

describe("stageOf", () => {
  const row = (status: SourceRow["status"], step: SourceRow["step"]) => ({ status, step }) as SourceRow;
  it.each([
    ["queued", null, 0],
    ["processing", "extracting", 0],
    ["processing", "chunking", 1],
    ["processing", "embedding", 1],
    ["processing", "mapping", 2],
    ["ready", null, 3],
    // Read before the map existed; next comes matching.
    ["awaiting_map", null, 2],
  ] as const)("%s/%s is stage %i", (status, step, stage) => {
    expect(stageOf(row(status, step))).toEqual({ stage, failed: false });
  });
  it("a failure keeps the stage it failed at", () => {
    expect(stageOf(row("failed", "embedding"))).toEqual({ stage: 1, failed: true });
    expect(stageOf(row("failed", null))).toEqual({ stage: 0, failed: true });
  });
  it("names the stages", () => {
    expect(STAGE_TEXT).toEqual(["Fetching", "Reading", "Matching to your topics", "Ready"]);
  });
});

describe("mainReference", () => {
  const ref = (o: Partial<Parameters<typeof mainReference>[0]>) =>
    mainReference({
      source_title: "T",
      source_type: "web",
      url_or_file: "https://a.example/x",
      page: null,
      timestamp_start: null,
      anchor: null,
      ...o,
    });
  it("links a web page to its passage", () => {
    expect(ref({ anchor: "Inner joins keep rows" })).toEqual({
      title: "T",
      label: "",
      href: "https://a.example/x#:~:text=Inner%20joins%20keep%20rows",
    });
  });
  it("links a video to its moment", () => {
    expect(ref({ source_type: "youtube", url_or_file: "https://youtu.be/abc123def45", timestamp_start: 135 })).toEqual({
      title: "T",
      label: "at 2:15",
      href: "https://www.youtube.com/watch?v=abc123def45&t=135s",
    });
  });
  it("names a PDF page without a link", () => {
    expect(ref({ source_type: "pdf", page: 4 })).toEqual({ title: "T", label: "page 4", href: null });
  });
  it("an outline has no link", () => {
    expect(ref({ source_type: "outline", url_or_file: "outline" })).toEqual({ title: "T", label: "", href: null });
  });
});

describe("outline sources", () => {
  it("are labelled Outline", () => {
    expect(TYPE_TEXT.outline).toBe("Outline");
  });
  it("share the worker's paywall message", () => {
    expect(PAYWALLED).toBe(
      "We can't read this page, it needs a login. Paste the course's syllabus or table of contents instead.",
    );
  });
});

