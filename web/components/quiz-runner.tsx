"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FormError } from "@/components/form-error";
import { button } from "@/components/ui/buttons";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  answerQuestion,
  finishQuiz,
  flagQuestion,
  nextQuestion,
  retryQuizBank,
  startQuiz,
} from "@/app/goals/[id]/quiz-actions";
import {
  LABEL_TEXT,
  QUIZ_ERROR_TEXT,
  type AnswerResult,
  type Citation,
  type QuizQuestion,
  type QuizSummary,
} from "@/lib/quiz";

type State =
  | { kind: "loading" }
  | { kind: "preparing" }
  | { kind: "error"; code: string; bankTopic?: string }
  | { kind: "question"; q: QuizQuestion; chosen: number | null; result: AnswerResult | null; flagged: boolean }
  | { kind: "results"; summary: QuizSummary };

type Props = {
  goalId: string;
  subtopicId: string | null;
  mode: "subtopic" | "review";
  /** The quiz name, e.g. "Joining tables quiz". */
  title: string;
  /** Server-rendered study-next and topic mastery, shown with the results (refreshed on finish). */
  overview: React.ReactNode;
};

const LETTERS = ["A", "B", "C", "D", "E", "F"];

const POLL_MS = 2000;

export function QuizRunner({ goalId, subtopicId, mode, title, overview }: Props) {
  const router = useRouter();
  const groupId = useId();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const quizId = useRef<string | null>(null);
  const answering = useRef(false); // guards double clicks before React re-renders
  const started = useRef(false);

  const load = useCallback(async () => {
    const id = quizId.current;
    if (!id) return;
    const res = await nextQuestion(id);
    if (!res.ok) return setState({ kind: "error", code: res.code });
    const next = res.data;
    if ("done" in next) {
      const summary = await finishQuiz(id);
      if (!summary.ok) return setState({ kind: "error", code: summary.code });
      setState({ kind: "results", summary: summary.data });
      // Re-render the server overview with the new mastery; this component's state is kept.
      return router.refresh();
    }
    if ("preparing" in next) return setState({ kind: "preparing" });
    if ("failed" in next) {
      // A bank that failed for lack of sources won't succeed on retry; otherwise retry that topic's bank.
      return setState(
        next.error === "no_sources"
          ? { kind: "error", code: "no_sources" }
          : { kind: "error", code: "failed", bankTopic: next.subtopic_id },
      );
    }
    if ("limit" in next) return setState({ kind: "error", code: next.limit });
    if ("exhausted" in next) return setState({ kind: "error", code: "exhausted" });
    setState({ kind: "question", q: next, chosen: null, result: null, flagged: false });
  }, [router]);

  const start = useCallback(async () => {
    const res = await startQuiz(goalId, subtopicId);
    if (!res.ok) return setState({ kind: "error", code: res.code });
    quizId.current = res.data.quiz_id;
    await load();
  }, [goalId, subtopicId, load]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  // While the bank is being written, ask again every few seconds.
  useEffect(() => {
    if (state.kind !== "preparing") return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [state, load]);

  async function check() {
    if (state.kind !== "question" || state.chosen === null || state.result || answering.current) return;
    answering.current = true;
    setBusy(true);
    const res = await answerQuestion(quizId.current!, state.q.question_id, state.chosen);
    setBusy(false);
    answering.current = false;
    if (!res.ok) return setState({ kind: "error", code: res.code });
    setState({ ...state, result: res.data });
  }

  async function flag() {
    if (state.kind !== "question" || state.flagged) return;
    const res = await flagQuestion(state.q.question_id);
    if (res.ok) setState({ ...state, flagged: true });
  }

  async function retry() {
    if (state.kind !== "error") return;
    // The quiz never started (e.g. a transient error): start it again.
    if (!quizId.current) {
      setState({ kind: "loading" });
      return void start();
    }
    if (state.code === "failed" && state.bankTopic) {
      const res = await retryQuizBank(state.bankTopic);
      // "not_failed" (another tab already retried) maps to "failed": carry on and poll.
      if (!res.ok && res.code !== "failed") return setState({ kind: "error", code: res.code });
    }
    setState({ kind: "loading" });
    await load();
  }

  if (state.kind === "loading" || state.kind === "preparing") {
    return (
      <p role="status" className="mt-8 flex items-center gap-2 text-body-m text-on-surface-variant">
        <Icon name="progress_activity" size={18} className="text-primary motion-safe:animate-spin" />
        {state.kind === "preparing" ? "Preparing your questions…" : "Loading…"}
      </p>
    );
  }

  if (state.kind === "error") {
    const retryable = state.code === "failed" || state.code === "exhausted";
    return (
      <div className="mt-8 flex flex-col items-start gap-3 rounded-2xl bg-surface-container-high p-5">
        <FormError error={QUIZ_ERROR_TEXT[state.code] ?? QUIZ_ERROR_TEXT.failed} />
        {retryable && (
          <button type="button" className={button("outlined")} onClick={() => void retry()}>
            Try again
          </button>
        )}
      </div>
    );
  }

  if (state.kind === "results") {
    return <Results goalId={goalId} mode={mode} title={title} summary={state.summary} overview={overview} />;
  }

  const { q, chosen, result } = state;
  const last = q.number >= q.total;
  const right = result ? LETTERS[result.correct_index] : "";
  return (
    <div className="mt-6">
      <p className="text-label-l text-on-surface-variant">
        Question {q.number} of {q.total}
        {mode === "review" && <span className="font-normal"> · {q.subtopic_title}</span>}
      </p>
      <div
        role="progressbar"
        aria-label="Quiz progress"
        aria-valuemin={0}
        aria-valuenow={q.number}
        aria-valuemax={q.total}
        className="mt-2 h-1 overflow-hidden rounded-full bg-outline-variant"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${(q.number / q.total) * 100}%` }} />
      </div>
      <h2 id={groupId} className="mt-6 text-headline-s text-on-surface [overflow-wrap:anywhere]">
        {q.stem}
      </h2>
      <div role="radiogroup" aria-labelledby={groupId} className="mt-6 flex flex-col gap-3">
        {q.options.map((option, i) => {
          const isRight = !!result && i === result.correct_index;
          const isWrongPick = !!result && i === chosen && !result.correct;
          const tone = isRight
            ? "border-2 border-on-positive bg-positive text-on-positive"
            : isWrongPick
              ? "border-2 border-on-negative bg-negative text-on-negative"
              : result
                ? "border border-outline-variant text-on-surface-variant"
                : "border border-outline-variant text-on-surface hover:bg-on-surface/4 has-checked:border-2 has-checked:border-primary has-checked:bg-primary-container has-checked:text-on-primary-container";
          const avatar = isRight
            ? "bg-on-positive text-positive"
            : isWrongPick
              ? "bg-on-negative text-negative"
              : "bg-surface-container-highest text-on-surface-variant group-has-checked:bg-primary group-has-checked:text-on-primary";
          return (
            <label
              key={i}
              className={`group relative flex min-h-14 items-center gap-4 rounded-2xl px-4 py-3 text-body-l ${result ? "" : "cursor-pointer"} has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary ${tone}`}
            >
              <input
                type="radio"
                name="answer"
                checked={chosen === i}
                disabled={!!result}
                onChange={() => setState({ ...state, chosen: i })}
                aria-label={option}
                className="peer absolute inset-0 z-10 m-0 cursor-pointer appearance-none opacity-0 disabled:cursor-default"
              />
              <span aria-hidden className={`grid size-8 shrink-0 place-items-center rounded-full text-label-l ${avatar}`}>
                {LETTERS[i]}
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option}</span>
              {isWrongPick && (
                <span className="flex shrink-0 items-center gap-1 text-label-m">
                  <Icon name="close" size={18} />
                  Not quite · your answer
                </span>
              )}
              {isRight && (
                <span className="flex shrink-0 items-center gap-1 text-label-m">
                  <Icon name="check" size={18} />
                  Correct answer
                </span>
              )}
            </label>
          );
        })}
      </div>

      {result && (
        <>
          <p role="status" className="sr-only">
            {result.correct
              ? "Correct!"
              : `You chose ${LETTERS[chosen ?? 0]}. Not quite. The correct answer is ${right}.`}
          </p>
          {result.correct && (
            <p aria-hidden className="mt-4 flex items-center gap-1.5 text-title-m text-on-positive">
              <Icon name="check_circle" filled />
              Correct!
            </p>
          )}
          <div className="mt-6 rounded-2xl bg-surface-container-high p-5">
            <h3 className="flex items-center gap-2 text-title-m text-on-surface">
              <Icon name="lightbulb" />
              Why {right} is right
            </h3>
            <p className="mt-2 text-body-l text-on-surface">{result.explanation}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              <SourceLine citations={result.citations} />
              {mode === "subtopic" && subtopicId && (
                <Link
                  href={`/goals/${goalId}/topics/${subtopicId}`}
                  className="flex items-center gap-1.5 text-label-l text-primary hover:underline"
                >
                  <Icon name="menu_book" size={18} />
                  Review in lesson
                </Link>
              )}
            </div>
          </div>
        </>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        {result ? (
          state.flagged ? (
            <span role="status" className="text-body-m text-on-surface-variant">
              Thanks. This question won&apos;t be shown to you again.
            </span>
          ) : (
            <button type="button" className={button("text", "-ml-3")} onClick={() => void flag()}>
              <Icon name="flag" />
              Flag this question
            </button>
          )
        ) : (
          <span />
        )}
        {!result ? (
          <button
            type="button"
            className={button("filled")}
            disabled={chosen === null || busy}
            onClick={() => void check()}
          >
            Check answer
          </button>
        ) : (
          <button type="button" className={button("filled")} onClick={() => void load()}>
            {last ? "See results" : "Next"}
            <Icon name="arrow_forward" />
          </button>
        )}
      </div>
    </div>
  );
}

const TYPE_ICON: Record<string, IconName> = { web: "article", youtube: "smart_display", pdf: "picture_as_pdf" };

function SourceLine({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return (
    <ul aria-label="Sources" className="flex flex-wrap gap-x-4 gap-y-2">
      {citations.map((c, i) => {
        const text = `${c.title}${c.label ? ` · ${c.label}` : ""}`;
        return (
          <li key={i} className="flex items-center gap-2 text-body-m text-on-surface-variant">
            <span
              aria-hidden
              className="grid h-5 min-w-5 place-items-center rounded-full bg-surface px-1.5 text-[11px] font-medium"
            >
              {c.n}
            </span>
            <Icon name={TYPE_ICON[c.type] ?? "article"} size={18} />
            {c.href ? (
              <a
                href={c.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 [overflow-wrap:anywhere]"
              >
                {text}
              </a>
            ) : (
              <span className="[overflow-wrap:anywhere]">{text}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function praise(score: number): string {
  return score >= 0.8 ? "Nice work." : score >= 0.5 ? "Good effort." : "Keep practising.";
}

function Results({
  goalId,
  mode,
  title,
  summary,
  overview,
}: {
  goalId: string;
  mode: "subtopic" | "review";
  title: string;
  summary: QuizSummary;
  overview: React.ReactNode;
}) {
  const correct = summary.topics.reduce((n, t) => n + t.correct, 0);
  const total = summary.topics.reduce((n, t) => n + t.total, 0);
  const score = total ? correct / total : 0;
  return (
    <div className="mt-6 flex flex-col gap-8">
      <div>
        <p className="text-body-m text-on-surface-variant">{title}</p>
        <h2 className="mt-1 text-display-s text-on-surface">
          {correct} of {total}
        </h2>
        {mode === "subtopic" && summary.topics[0] ? (
          <p className="mt-2 text-body-l text-on-surface-variant">
            {praise(score)} {summary.topics[0].title} is now {LABEL_TEXT[summary.topics[0].label]}.
          </p>
        ) : (
          <ul aria-label="This quiz" className="mt-2 flex flex-col gap-1 text-body-l text-on-surface-variant">
            {summary.topics.map((t) => (
              <li key={t.subtopic_id}>
                {t.title}: {t.correct} of {t.total}, now {LABEL_TEXT[t.label]}.
              </li>
            ))}
          </ul>
        )}
      </div>

      {summary.wrong.length > 0 && (
        <section aria-labelledby="to-review">
          <h3 id="to-review" className="text-title-m text-on-surface">
            To review
          </h3>
          <ul className="mt-3 flex flex-col gap-2">
            {summary.wrong.map((w, i) => (
              <li key={i} className="rounded-2xl bg-surface-container-low p-4 text-body-m">
                <p className="text-title-m text-on-surface">{w.stem}</p>
                <p className="mt-1 text-on-surface">Answer: {w.correct_option}</p>
                <p className="mt-1 text-on-surface-variant">{w.explanation}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                  <SourceLine citations={w.citations} />
                  <Link
                    href={`/goals/${goalId}/topics/${w.subtopic_id}`}
                    className="flex items-center gap-1.5 text-label-l text-primary hover:underline"
                  >
                    <Icon name="menu_book" size={18} />
                    Review the lesson
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {overview}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href={`/goals/${goalId}`} className={button("text")}>
          Back to map
        </Link>
        <Link href={`/goals/${goalId}/review/quiz`} className={button("filled")}>
          <Icon name="quiz" />
          Start review quiz
        </Link>
      </div>
    </div>
  );
}
