"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FormError } from "@/components/form-error";
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

type Props = { goalId: string; subtopicId: string | null; mode: "subtopic" | "review" };

const POLL_MS = 2000;

export function QuizRunner({ goalId, subtopicId, mode }: Props) {
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
      return setState(summary.ok ? { kind: "results", summary: summary.data } : { kind: "error", code: summary.code });
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
  }, []);

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

  const box = "mt-6 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900";
  const primary =
    "rounded-xl bg-indigo-600 px-5 py-2.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:focus-visible:ring-offset-zinc-950";
  const secondary =
    "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

  if (state.kind === "loading" || state.kind === "preparing") {
    return (
      <p role="status" className="mt-6 text-zinc-600 dark:text-zinc-400">
        {state.kind === "preparing" ? "Preparing your questions…" : "Loading…"}
      </p>
    );
  }

  if (state.kind === "error") {
    const retryable = state.code === "failed" || state.code === "exhausted";
    return (
      <div className={`${box} flex flex-col items-start gap-3`}>
        <FormError error={QUIZ_ERROR_TEXT[state.code] ?? QUIZ_ERROR_TEXT.failed} />
        {retryable && (
          <button type="button" className={secondary} onClick={() => void retry()}>
            Try again
          </button>
        )}
      </div>
    );
  }

  if (state.kind === "results") {
    return <Results goalId={goalId} summary={state.summary} />;
  }

  const { q, chosen, result } = state;
  const last = q.number >= q.total;
  return (
    <div className={box}>
      <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
        Question {q.number} of {q.total}
        {mode === "review" && <span className="ml-2 normal-case tracking-normal text-zinc-500">· {q.subtopic_title}</span>}
      </p>
      <h2 id={groupId} className="mt-2 text-lg font-semibold text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-50">
        {q.stem}
      </h2>
      <div role="radiogroup" aria-labelledby={groupId} className="mt-4 flex flex-col gap-2">
        {q.options.map((option, i) => {
          const isRight = result && i === result.correct_index;
          const isWrongPick = result && i === chosen && !result.correct;
          return (
            <label
              key={i}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-[15px] ${
                isRight
                  ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-400/10"
                  : isWrongPick
                    ? "border-rose-500 bg-rose-50 dark:bg-rose-400/10"
                    : "border-zinc-200 has-checked:border-indigo-500 has-checked:bg-indigo-50 dark:border-zinc-800 dark:has-checked:bg-indigo-400/10"
              }`}
            >
              <input
                type="radio"
                name="answer"
                checked={chosen === i}
                disabled={!!result}
                onChange={() => setState({ ...state, chosen: i })}
                className="mt-1 accent-indigo-600"
              />
              <span className="text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-100">{option}</span>
            </label>
          );
        })}
      </div>

      {!result ? (
        <button type="button" className={`${primary} mt-5`} disabled={chosen === null || busy} onClick={() => void check()}>
          Check answer
        </button>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          <p className={`font-semibold ${result.correct ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
            {result.correct ? "Correct!" : `Not quite. The answer is: ${q.options[result.correct_index]}`}
          </p>
          <p className="text-zinc-700 dark:text-zinc-300">{result.explanation}</p>
          <SourceLine citations={result.citations} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={primary} onClick={() => void load()}>
              {last ? "See results" : "Next question"}
            </button>
            {state.flagged ? (
              <span role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
                Thanks. This question won&apos;t be shown to you again.
              </span>
            ) : (
              <button type="button" className={secondary} onClick={() => void flag()}>
                Flag this question
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceLine({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      Source:{" "}
      {citations.map((c, i) => {
        const text = `[${c.n}] ${c.title}${c.label ? `, ${c.label}` : ""}`;
        return (
          <span key={i}>
            {i > 0 && " "}
            {c.href ? (
              <a
                href={c.href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
              >
                {text}
              </a>
            ) : (
              text
            )}
          </span>
        );
      })}
    </p>
  );
}

function Results({ goalId, summary }: { goalId: string; summary: QuizSummary }) {
  return (
    <div className="mt-6 flex flex-col gap-6">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Your results</h2>
      <ul className="flex flex-col gap-2">
        {summary.topics.map((t) => (
          <li
            key={t.subtopic_id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <span className="font-medium text-zinc-900 dark:text-zinc-50">{t.title}</span>
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {LABEL_TEXT[t.label]} · {t.correct} of {t.total}
            </span>
          </li>
        ))}
      </ul>
      {summary.wrong.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">To review</h3>
          <ul className="mt-3 flex flex-col gap-3">
            {summary.wrong.map((w, i) => (
              <li key={i} className="rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
                <p className="font-medium text-zinc-900 dark:text-zinc-50">{w.stem}</p>
                <p className="mt-1 text-zinc-700 dark:text-zinc-300">Answer: {w.correct_option}</p>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">{w.explanation}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <SourceLine citations={w.citations} />
                  <Link
                    href={`/goals/${goalId}/topics/${w.subtopic_id}`}
                    className="font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
                  >
                    Review the lesson
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Link href={`/goals/${goalId}`} className="text-sm font-medium text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400">
        ← Back to your map
      </Link>
    </div>
  );
}
