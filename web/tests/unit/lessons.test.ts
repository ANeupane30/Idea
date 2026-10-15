import { describe, expect, it } from "vitest";
import { LESSON_ERROR_TEXT, lessonRequestSchema, readEvents } from "@/lib/lessons";

function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of pieces) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

describe("readEvents", () => {
  it("parses NDJSON events split across chunks", async () => {
    const events = [];
    for await (const e of readEvents(streamOf('{"type":"sta', 'rt","sources":[]}\n{"type":"done","lesson_id":"x"}\n', "\n"))) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "start", sources: [] },
      { type: "done", lesson_id: "x" },
    ]);
  });
  it("reads a last line without a newline", async () => {
    const events = [];
    for await (const e of readEvents(streamOf('{"type":"error","code":"failed"}'))) events.push(e);
    expect(events).toEqual([{ type: "error", code: "failed" }]);
  });
});

describe("lesson request and copy", () => {
  it("validates the request", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(lessonRequestSchema.safeParse({ subtopicId: id, format: "visual" }).success).toBe(true);
    expect(lessonRequestSchema.safeParse({ subtopicId: "x", format: "visual" }).success).toBe(false);
    expect(lessonRequestSchema.safeParse({ subtopicId: id, format: "audio" }).success).toBe(false);
  });
  it("has copy for every error code", () => {
    expect(LESSON_ERROR_TEXT).toEqual({
      failed: "We couldn't write this lesson. Please try again.",
      unavailable: "Lessons are unavailable right now. Please try again in a moment.",
      in_progress: "This lesson is already being written. It will appear in a moment.",
      lesson_limit: "You've reached today's limit for new lessons. Try again tomorrow.",
      guest_lesson_limit: "Sign up free to get more lessons.",
      no_sources: "None of your sources cover this topic yet. Add one to get a lesson.",
      not_found: "We couldn't find this topic.",
    });
  });
});
