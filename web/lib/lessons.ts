import { z } from "zod";

export const FORMATS = ["visual", "text", "examples", "summary"] as const;
export type Format = (typeof FORMATS)[number];

export const FORMAT_TEXT: Record<Format, { label: string; hint: string }> = {
  visual: { label: "Visual", hint: "Diagrams that carry the explanation" },
  text: { label: "Text", hint: "A structured explanation with headings" },
  examples: { label: "Examples", hint: "Worked examples and analogies" },
  summary: { label: "Summary", hint: "About 200 words of key points" },
};

export type Section = { markdown: string; mermaid: string | null; citations: number[] };
export type LessonSource = { n: number; title: string; type: string; href: string | null; label: string };
export type LessonBody = { sections: Section[]; sources: LessonSource[] };
export type Lesson = { id: string; format: Format; stale: boolean; created_at: string; body: LessonBody };

export type LessonEvent =
  | { type: "start"; sources: LessonSource[] }
  | { type: "section"; index: number; section: Section }
  | { type: "done"; lesson_id: string }
  | { type: "lesson"; lesson: Lesson }
  | { type: "error"; code: string };

export const LESSON_ERROR_TEXT: Record<string, string> = {
  failed: "We couldn't write this lesson. Please try again.",
  unavailable: "Lessons are unavailable right now. Please try again in a moment.",
  in_progress: "This lesson is already being written. It will appear in a moment.",
  lesson_limit: "You've reached today's limit for new lessons. Try again tomorrow.",
  guest_lesson_limit: "Sign up free to get more lessons.",
  no_sources: "None of your sources cover this topic yet. Add one to get a lesson.",
  not_found: "We couldn't find this topic.",
};

export const lessonRequestSchema = z.object({
  subtopicId: z.uuid(),
  format: z.enum(FORMATS),
  refresh: z.boolean().optional(),
});

/** NDJSON from the lesson stream: one event per line, lines may be split across chunks. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<LessonEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as LessonEvent;
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  const last = buffer.trim();
  if (last) yield JSON.parse(last) as LessonEvent;
}

export const feedbackSchema = z
  .object({
    rating: z.enum(["up", "down"]).optional(),
    reportText: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((f) => f.rating !== undefined || f.reportText !== undefined, "Choose a rating or describe the problem.");
