"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FormatCards } from "@/components/format-cards";
import { FormError } from "@/components/form-error";
import { LessonFeedback } from "@/components/lesson-feedback";
import { LessonSections } from "@/components/lesson-sections";
import { TopBarView } from "@/components/top-bar-view";
import { button } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";
import { GENERIC_ERROR, type ActionResult } from "@/lib/validation";
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
import { chooseFormat, logFormatSwitch, sendFeedback } from "./lesson-actions";

type Live = { status: "writing" | "error"; code?: string; sections: Section[]; sources: LessonSource[] };

type Props = {
  userId: string | null;
  /** "<n> <title>" for main topics. */
  title: string;
  summary: string | null;
  goalId: string;
  goalTitle: string;
  subtopic: { id: string; title: string };
  preferredFormat: Format;
  formatChosen: boolean;
  initialLessons: Partial<Record<Format, Lesson>>;
  hasSources: boolean;
  /** No source covers this topic yet, but some are still being read. */
  sourcesPending?: boolean;
};

const PENDING_TEXT = "Sources for this topic are still being read. This takes a minute or two.";

export function LessonView({
  userId,
  title,
  summary,
  goalId,
  subtopic,
  preferredFormat,
  formatChosen,
  initialLessons,
  hasSources,
  sourcesPending = false,
}: Props) {
  const [chosen, setChosen] = useState(formatChosen);
  const [pick, setPick] = useState<Format>(preferredFormat);
  const [format, setFormat] = useState<Format>(preferredFormat);
  const [lessons, setLessons] = useState(initialLessons);
  const [live, setLive] = useState<Partial<Record<Format, Live>>>({});
  const started = useRef(new Set<Format>());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const router = useRouter();

  // A source still being read may cover this topic soon.
  useEffect(() => {
    if (hasSources || !sourcesPending) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [hasSources, sourcesPending, router]);

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

  const mapHref = `/goals/${goalId}`;
  const lesson = lessons[format];
  const state = live[format];
  const showSwitcher = chosen && hasSources;

  let body: React.ReactNode;
  if (!hasSources) {
    body = (
      <div className="rounded-2xl bg-surface-container-high p-5">
        <p className="text-body-l text-on-surface">{sourcesPending ? PENDING_TEXT : LESSON_ERROR_TEXT.no_sources}</p>
        <Link href={`${mapHref}?add=source`} className={button("filled", "mt-3")}>
          <Icon name="add" size={20} />
          Add a source
        </Link>
      </div>
    );
  } else if (!chosen) {
    body = (
      <FormatChooser
        mapHref={mapHref}
        pick={pick}
        onPick={setPick}
        onContinue={async () => {
          const result = await chooseFormat(pick);
          if (!result.ok) return result;
          setFormat(pick);
          setChosen(true);
          return result;
        }}
      />
    );
  } else if (lesson && !state) {
    body = (
      <>
        {lesson.stale && !dismissed.has(lesson.id) && (
          <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-primary-container py-2 pr-2 pl-4 text-body-m text-on-primary-container">
            <Icon name="update" />
            <span className="flex-1">New sources available. Refresh lesson?</span>
            <span className="flex">
              <button
                type="button"
                onClick={() => setDismissed((d) => new Set([...d, lesson.id]))}
                className={button("text", "min-h-10 text-on-primary-container")}
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => void start(format, true)}
                className={button("text", "min-h-10 text-on-primary-container")}
              >
                Refresh
              </button>
            </span>
          </div>
        )}
        <LessonSections sections={lesson.body.sections} sources={lesson.body.sources} />
        <LessonFeedback key={lesson.id} lessonId={lesson.id} send={sendFeedback}>
          <Link href={`/goals/${goalId}/topics/${subtopic.id}/quiz`} className={button("filled")}>
            <Icon name="quiz" />
            Quiz me on this
          </Link>
        </LessonFeedback>
      </>
    );
  } else if (state?.status === "error") {
    body = (
      <div className="flex flex-col items-start gap-3">
        <FormError error={LESSON_ERROR_TEXT[state.code ?? "failed"] ?? LESSON_ERROR_TEXT.failed} />
        {state.code !== "not_found" && state.code !== "no_sources" && (
          <button type="button" onClick={retry} className={button("outlined")}>
            Try again
          </button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        <p role="status" className="flex items-center gap-2 text-body-m text-on-surface-variant">
          <Icon name="progress_activity" size={18} className="text-primary motion-safe:animate-spin" />
          Writing your lesson…
        </p>
        {state && state.sections.length > 0 && <LessonSections sections={state.sections} sources={state.sources} />}
      </div>
    );
  }

  return (
    <>
      <TopBarView
        userId={userId}
        back={{ href: mapHref, label: "Back to your map" }}
        title={title}
        actions={
          showSwitcher && (
            <div
              role="group"
              aria-label="Show me this as:"
              className="flex overflow-hidden rounded-full border border-outline max-sm:w-full"
            >
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={f === format}
                  onClick={() => switchTo(f)}
                  className="flex min-h-10 flex-1 items-center justify-center gap-1.5 border-l border-outline px-3 text-label-l text-on-surface first:border-l-0 hover:bg-on-surface/8 focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-primary aria-pressed:bg-secondary-container aria-pressed:text-on-secondary-container max-sm:px-2 sm:px-4 [&>svg]:hidden sm:aria-pressed:[&>svg]:block"
                >
                  <Icon name="check" size={18} />
                  {FORMAT_TEXT[f].label}
                </button>
              ))}
            </div>
          )
        }
      />
      <main className="mx-auto w-full max-w-[65ch] px-4 pt-4 pb-16">
        {summary && <p className="mb-6 text-body-l text-on-surface-variant">{summary}</p>}
        {body}
      </main>
    </>
  );
}

/** First visit: pick a format in a dialog. Closing it (or Esc) goes back to the map. */
function FormatChooser({
  mapHref,
  pick,
  onPick,
  onContinue,
}: {
  mapHref: string;
  pick: Format;
  onPick: (f: Format) => void;
  onContinue: () => Promise<ActionResult>;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      // Start on the selected format, not the close button.
      dialog.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
    }
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        router.push(mapHref);
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-[28px] bg-surface-container-high p-6 text-on-surface motion-safe:open:animate-dialog-in"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            const result = await onContinue();
            if (!result.ok) setError(result.error);
          } catch {
            setError(GENERIC_ERROR);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 id={titleId} className="text-headline-s">
              How do you like to learn?
            </h2>
            <p className="mt-1 text-body-m text-on-surface-variant">We&apos;ll shape every lesson this way.</p>
          </div>
          <Link href={mapHref} aria-label="Close" className={button("icon", "-mr-3 -mt-1")}>
            <Icon name="close" size={24} />
          </Link>
        </div>
        <div className="mt-6">
          <FormatCards name="format" labelledBy={titleId} value={pick} onChange={onPick} />
        </div>
        {error && <FormError error={error} className="mt-4" />}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-1.5 text-body-m text-on-surface-variant">
            <Icon name="swap_horiz" size={18} />
            You can switch anytime
          </p>
          <button type="submit" disabled={saving} className={button("filled")}>
            Continue
          </button>
        </div>
      </form>
    </dialog>
  );
}
