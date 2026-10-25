"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { button, field } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";
import { SOURCE_COLUMNS, stageOf, type SourceRow } from "@/lib/sources";
import { createBrowserClient } from "@/lib/supabase/client";
import { GENERIC_ERROR } from "@/lib/validation";
import { answerClarification, answerExpand, retryTopicMap } from "../actions";
import { sourceTitle, TYPE_ICON } from "./SourceList";
import { SourceStepper } from "./SourceStepper";

// Stages before the map exists; the page polls while a goal is in one of them.
const WAITING = ["pending", "reading_sources", "building_map"];
export const SHALLOW_QUESTION =
  "This looks like a single article rather than a full curriculum. Expand this topic with related guides?";

export type MapGoal = {
  id: string;
  status: string;
  map_status: string;
  map_delayed: boolean;
  clarifying_question: string | null;
  map_error: string | null;
};

export function MapStatus({
  goal,
  sources: initialSources = [],
  children,
}: {
  goal: MapGoal;
  /** The learner's own sources, while they're read before the map. */
  sources?: SourceRow[];
  children?: React.ReactNode;
}) {
  const [sources, setSources] = useState(initialSources);
  const [prevSources, setPrevSources] = useState(initialSources);
  if (initialSources !== prevSources) {
    setPrevSources(initialSources);
    setSources(initialSources);
  }
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const archived = goal.status === "archived";

  // While the map is being built, poll just its status and refresh the page once when it changes.
  // (Refreshing the whole page every 2 s raced React's commits and could crash the page.)
  const [delayed, setDelayed] = useState(goal.map_delayed);
  const [prevDelayed, setPrevDelayed] = useState(goal.map_delayed);
  if (goal.map_delayed !== prevDelayed) {
    setPrevDelayed(goal.map_delayed);
    setDelayed(goal.map_delayed);
  }
  useEffect(() => {
    if (!WAITING.includes(goal.map_status)) return;
    const supabase = createBrowserClient();
    let stopped = false;
    const reading = goal.map_status === "reading_sources";
    const timer = setInterval(async () => {
      const { data } = await supabase.from("goals").select("map_status, map_delayed").eq("id", goal.id).maybeSingle();
      if (stopped || !data) return;
      if (reading) {
        const { data: rows } = await supabase.from("sources").select(SOURCE_COLUMNS).eq("goal_id", goal.id).order("created_at");
        if (!stopped && rows) setSources(rows as SourceRow[]);
      }
      if (data.map_status !== goal.map_status) {
        stopped = true;
        clearInterval(timer);
        router.refresh();
      } else {
        setDelayed(data.map_delayed);
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

  if (goal.map_status === "reading_sources" || goal.map_status === "awaiting_expand") {
    const asking = goal.map_status === "awaiting_expand";
    return (
      <div className="mt-6 max-w-xl">
        {asking ? (
          <div className="rounded-2xl bg-surface-container-high p-5">
            <p className="text-title-m text-on-surface">{SHALLOW_QUESTION}</p>
            {!archived && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" disabled={isPending} onClick={() => run(() => answerExpand(goal.id, true))} className={button("filled")}>
                  Expand
                </button>
                <button type="button" disabled={isPending} onClick={() => run(() => answerExpand(goal.id, false))} className={button("outlined")}>
                  Keep it small
                </button>
              </div>
            )}
            {error && <p role="alert" className="mt-2 text-body-m text-on-negative">{error}</p>}
          </div>
        ) : (
          <p role="status" className="flex items-center gap-2 text-body-l text-on-surface">
            <Icon name="progress_activity" className="text-primary motion-safe:animate-spin" />
            Reading your sources…
          </p>
        )}
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
      </div>
    );
  }

  if (goal.map_status === "pending" || goal.map_status === "building_map") {
    return (
      <div role="status" className="mt-6 text-body-l text-on-surface">
        <p className="flex items-center gap-2">
          <Icon name="progress_activity" className="text-primary motion-safe:animate-spin" />
          Building your topic map…
        </p>
        {delayed && <p className="mt-1 text-body-m text-on-surface-variant">Processing is delayed. We&apos;ll keep trying.</p>}
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
        {error && <p role="alert" className="mt-2 text-body-m text-on-negative">{error}</p>}
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
        {error && <p role="alert" className="mt-2 text-body-m text-on-negative">{error}</p>}
      </div>
    );
  }

  return <>{children}</>;
}
