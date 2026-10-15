"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FormError } from "@/components/form-error";
import { LessonSections } from "@/components/lesson-sections";
import {
  FORMAT_TEXT,
  FORMATS,
  LESSON_ERROR_TEXT,
  readEvents,
  type Format,
  type Lesson,
  type LessonSource,
  type Section,
} from "@/lib/lessons";
import { searchQuery } from "@/lib/sources";
import { SearchLinks } from "../../Coverage";
import { chooseFormat, logFormatSwitch } from "./lesson-actions";

type Live = { status: "writing" | "error"; code?: string; sections: Section[]; sources: LessonSource[] };

type Props = {
  goalTitle: string;
  subtopic: { id: string; title: string };
  preferredFormat: Format;
  formatChosen: boolean;
  initialLessons: Partial<Record<Format, Lesson>>;
  hasSources: boolean;
};

export function LessonView({ goalTitle, subtopic, preferredFormat, formatChosen, initialLessons, hasSources }: Props) {
  const chooserId = useId();
  const [chosen, setChosen] = useState(formatChosen);
  const [pick, setPick] = useState<Format>(preferredFormat);
  const [format, setFormat] = useState<Format>(preferredFormat);
  const [lessons, setLessons] = useState(initialLessons);
  const [live, setLive] = useState<Partial<Record<Format, Live>>>({});
  const started = useRef(new Set<Format>());

  const start = useCallback(
    async (fmt: Format, refresh = false) => {
      const update = (next: Live | undefined) => setLive((l) => ({ ...l, [fmt]: next }));
      const fail = (code: string) => update({ status: "error", code, sections: [], sources: [] });
      update({ status: "writing", sections: [], sources: [] });

      let res: Response;
      try {
        res = await fetch("/api/lessons", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subtopicId: subtopic.id, format: fmt, refresh }),
        });
      } catch {
        return fail("unavailable");
      }
      if (!res.ok || !res.body) return fail(res.status === 404 ? "not_found" : "unavailable");

      let sources: LessonSource[] = [];
      const sections: Section[] = [];
      try {
        for await (const event of readEvents(res.body)) {
          if (event.type === "start") {
            sources = event.sources;
          } else if (event.type === "section") {
            sections.push(event.section);
            update({ status: "writing", sections: [...sections], sources });
          } else if (event.type === "lesson") {
            setLessons((l) => ({ ...l, [fmt]: event.lesson }));
            return update(undefined);
          } else if (event.type === "done") {
            const lesson: Lesson = {
              id: event.lesson_id,
              format: fmt,
              stale: false,
              created_at: new Date().toISOString(),
              body: { sections, sources },
            };
            setLessons((l) => ({ ...l, [fmt]: lesson }));
            return update(undefined);
          } else if (event.type === "error") {
            return fail(event.code);
          }
        }
        fail("failed"); // the stream ended without finishing
      } catch {
        fail("failed");
      }
    },
    [subtopic.id],
  );

  // Open a format with no stored lesson: write it (once per format per visit).
  useEffect(() => {
    if (!chosen || !hasSources || lessons[format] || started.current.has(format)) return;
    started.current.add(format);
    void start(format);
  }, [chosen, hasSources, format, lessons, start]);

  function switchTo(next: Format) {
    if (next === format) return;
    void logFormatSwitch(subtopic.id, format, next);
    setFormat(next);
  }

  function retry() {
    started.current.add(format);
    void start(format);
  }

  if (!hasSources) {
    return (
      <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-zinc-800 dark:text-zinc-200">{LESSON_ERROR_TEXT.no_sources}</p>
        <div className="mt-3">
          <SearchLinks query={searchQuery(goalTitle, subtopic.title)} />
        </div>
      </div>
    );
  }

  if (!chosen) {
    return (
      <form
        className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900"
        onSubmit={async (e) => {
          e.preventDefault();
          await chooseFormat(pick);
          setFormat(pick);
          setChosen(true);
        }}
      >
        <h2 id={chooserId} className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          How do you like to learn?
        </h2>
        <div role="radiogroup" aria-labelledby={chooserId} className="mt-4 grid gap-3 sm:grid-cols-2">
          {FORMATS.map((f) => (
            <label
              key={f}
              className="flex cursor-pointer gap-3 rounded-xl border border-zinc-200 p-4 has-checked:border-indigo-500 has-checked:bg-indigo-50 has-checked:ring-1 has-checked:ring-indigo-500 dark:border-zinc-800 dark:has-checked:border-indigo-400 dark:has-checked:bg-indigo-400/10"
            >
              <input
                type="radio"
                name="format"
                value={f}
                checked={pick === f}
                onChange={() => setPick(f)}
                className="mt-1 accent-indigo-600"
              />
              <span>
                <span className="block font-semibold text-zinc-900 dark:text-zinc-50">{FORMAT_TEXT[f].label}</span>
                <span className="block text-sm text-zinc-600 dark:text-zinc-400">{FORMAT_TEXT[f].hint}</span>
              </span>
            </label>
          ))}
        </div>
        <button
          type="submit"
          className="mt-5 rounded-xl bg-indigo-600 px-5 py-2.5 font-semibold text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:focus-visible:ring-offset-zinc-950"
        >
          Show my lesson
        </button>
      </form>
    );
  }

  const lesson = lessons[format];
  const state = live[format];

  return (
    <div className="mt-6">
      <div role="group" aria-label="Show me this as:" className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="text-sm text-zinc-600 dark:text-zinc-400">
          Show me this as:
        </span>
        {FORMATS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={f === format}
            onClick={() => switchTo(f)}
            className="rounded-full border px-3 py-1 text-sm font-medium transition aria-pressed:border-indigo-600 aria-pressed:bg-indigo-600 aria-pressed:text-white border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:aria-pressed:border-indigo-500 dark:aria-pressed:bg-indigo-500"
          >
            {FORMAT_TEXT[f].label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {lesson ? (
          <LessonSections sections={lesson.body.sections} sources={lesson.body.sources} />
        ) : state?.status === "error" ? (
          <div className="flex flex-col items-start gap-3">
            <FormError error={LESSON_ERROR_TEXT[state.code ?? "failed"] ?? LESSON_ERROR_TEXT.failed} />
            {state.code !== "not_found" && state.code !== "no_sources" && (
              <button
                type="button"
                onClick={retry}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Try again
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
              Writing your lesson…
            </p>
            {state && state.sections.length > 0 && (
              <LessonSections sections={state.sections} sources={state.sources} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
