"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/form-error";
import { button, field } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";
import { isPreparing, stageText, topicsReady } from "@/lib/prep";
import { SOURCE_COLUMNS, stageOf, type SourceRow } from "@/lib/sources";
import { createBrowserClient } from "@/lib/supabase/client";
import { GENERIC_ERROR } from "@/lib/validation";
import { answerClarification, answerSourceDecision, retryTopicMap } from "../actions";
import { sourceTitle, TYPE_ICON } from "./SourceList";
import { SourceStepper } from "./SourceStepper";

export const DECISION_HEADING = "Some of your sources don't look right for this goal.";

export type MapGoal = {
  id: string;
  status: string;
  map_status: string;
  map_delayed: boolean;
  clarifying_question: string | null;
  map_error: string | null;
};

type Topics = { ready: number; total: number };

/**
 * Everything before the map: the goal's preparation stages (with counts, kept live by polling the
 * database, so a refresh or another device shows the same stage), the learner's decision about
 * sources that didn't pass the check, a clarifying question, or a failure. The map (children) is
 * shown only once the goal is ready.
 */
export function MapStatus({
  goal,
  sources: initialSources = [],
  topics: initialTopics = null,
  children,
}: {
  goal: MapGoal;
  /** The goal's sources while it's prepared. */
  sources?: SourceRow[];
  /** Top-level topics with a source, while lessons are prepared. */
  topics?: Topics | null;
  children?: React.ReactNode;
}) {
  const [sources, setSources] = useState(initialSources);
  const [topics, setTopics] = useState(initialTopics);
  const [prev, setPrev] = useState({ initialSources, initialTopics });
  if (prev.initialSources !== initialSources || prev.initialTopics !== initialTopics) {
    setPrev({ initialSources, initialTopics });
    setSources(initialSources);
    setTopics(initialTopics);
  }
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const archived = goal.status === "archived";
  const [delayed, setDelayed] = useState(goal.map_delayed);
  const [prevDelayed, setPrevDelayed] = useState(goal.map_delayed);
  if (goal.map_delayed !== prevDelayed) {
    setPrevDelayed(goal.map_delayed);
    setDelayed(goal.map_delayed);
  }

  // Poll the goal (and its sources and topics) until it's ready, failed or asks a question; refresh
  // once its stage changes. (Refreshing the whole page every 2 s raced React's commits.)
  useEffect(() => {
    if (!isPreparing(goal.map_status) && goal.map_status !== "awaiting_source_decision") return;
    const supabase = createBrowserClient();
    let stopped = false;
    let refreshedAt = 0;
    const timer = setInterval(async () => {
      const matching = goal.map_status === "matching_sources";
      const [{ data }, { data: rows }, { data: tops }, { data: states }] = await Promise.all([
        supabase.from("goals").select("map_status, map_delayed").eq("id", goal.id).maybeSingle(),
        supabase.from("sources").select(SOURCE_COLUMNS).eq("goal_id", goal.id).order("created_at"),
        matching
          ? supabase.from("subtopics").select("id").eq("goal_id", goal.id).is("parent_id", null)
          : Promise.resolve({ data: null }),
        matching
          ? supabase.from("subtopic_coverage").select("subtopic_id, state").eq("goal_id", goal.id)
          : Promise.resolve({ data: null }),
      ]);
      if (stopped || !data) return;
      if (rows) setSources(rows as SourceRow[]);
      if (tops && states) setTopics(topicsReady(tops, states));
      if (data.map_status === goal.map_status) {
        setDelayed(data.map_delayed);
      } else if (Date.now() - refreshedAt > 5000) {
        // Keep polling: a refresh that lands mid-render can be dropped, so ask again if the page
        // still shows the old stage a few seconds later.
        refreshedAt = Date.now();
        router.refresh();
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [goal.map_status, goal.id, router]);

  function run(action: () => ReturnType<typeof retryTopicMap>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  if (isPreparing(goal.map_status)) {
    const shown = goal.map_status === "understanding" ? sources.filter((s) => s.status !== "failed") : sources;
    return (
      <div className="mt-6 max-w-xl">
        <p role="status" className="flex items-center gap-2 text-body-l text-on-surface">
          <Icon name="progress_activity" className="text-primary motion-safe:animate-spin" />
          {stageText(goal.map_status, sources, topics)}
        </p>
        {delayed && <p className="mt-1 text-body-m text-on-surface-variant">Processing is delayed. We&apos;ll keep trying.</p>}
        {shown.length > 0 && goal.map_status !== "matching_sources" && <SourceProgress sources={shown} />}
      </div>
    );
  }

  if (goal.map_status === "awaiting_source_decision") {
    const failing = sources.filter((s) => s.vetted === false || s.status === "failed");
    return (
      <div className="mt-6 max-w-xl rounded-2xl bg-surface-container-high p-5">
        <h2 className="text-title-m text-on-surface">{DECISION_HEADING}</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {failing.map((s) => (
            <li key={s.id} className="text-body-m text-on-surface-variant">
              <p className="text-title-s text-on-surface [overflow-wrap:anywhere]">{sourceTitle(s)}</p>
              <p>{s.vet_reason ?? s.error ?? GENERIC_ERROR}</p>
            </li>
          ))}
        </ul>
        {!archived && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={isPending} onClick={() => run(() => answerSourceDecision(goal.id, "find"))} className={button("filled")}>
              Find sources for me
            </button>
            <button type="button" disabled={isPending} onClick={() => run(() => answerSourceDecision(goal.id, "use"))} className={button("outlined")}>
              Use mine anyway
            </button>
          </div>
        )}
        {error && <FormError error={error} className="mt-2" />}
      </div>
    );
  }

  if (goal.map_status === "clarifying") {
    return (
      <div className="mt-6 max-w-xl rounded-2xl bg-surface-container-high p-5">
        <p className="text-title-m text-on-surface">{goal.clarifying_question}</p>
        {archived ? (
          <p className="mt-2 text-body-m text-on-surface-variant">Unarchive this goal to answer.</p>
        ) : (
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => answerClarification(goal.id, answer));
            }}
          >
            <label className="flex flex-col gap-1.5 text-label-l text-on-surface-variant">
              Your answer
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                maxLength={1000}
                rows={3}
                className={`${field()} resize-y`}
              />
            </label>
            <button type="submit" disabled={isPending} className={button("filled", "self-start")}>
              Submit answer
            </button>
          </form>
        )}
        {error && <FormError error={error} className="mt-2" />}
      </div>
    );
  }

  if (goal.map_status === "failed") {
    return (
      <div className="mt-6">
        <p role="alert" className="text-body-l text-on-negative">
          {goal.map_error ?? "We couldn't build your topic map."}
        </p>
        {!archived && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => retryTopicMap(goal.id))}
            className={button("outlined", "mt-3")}
          >
            Try again
          </button>
        )}
        {error && <FormError error={error} className="mt-2" />}
      </div>
    );
  }

  return <>{children}</>;
}

function SourceProgress({ sources }: { sources: SourceRow[] }) {
  return (
    <ul aria-label="Your sources" className="mt-4 flex flex-col gap-2">
      {sources.map((s) => {
        const { stage, failed } = stageOf(s);
        return (
          <li key={s.id} className="flex gap-4 rounded-2xl bg-surface-container-low p-4">
            <Icon name={TYPE_ICON[s.type]} size={24} className="text-on-surface-variant" />
            <div className="min-w-0 flex-1">
              <p className="text-title-m text-on-surface [overflow-wrap:anywhere]">{sourceTitle(s)}</p>
              {failed ? (
                <p className="mt-1 flex gap-1.5 text-body-m text-on-negative">
                  <Icon name="error" size={20} />
                  {s.error ?? GENERIC_ERROR}
                </p>
              ) : (
                <SourceStepper stage={stage} />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
