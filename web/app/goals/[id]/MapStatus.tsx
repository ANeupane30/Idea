"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { button, field } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";
import { createBrowserClient } from "@/lib/supabase/client";
import { answerClarification, retryTopicMap } from "../actions";

export type MapGoal = {
  id: string;
  status: string;
  map_status: string;
  map_delayed: boolean;
  clarifying_question: string | null;
  map_error: string | null;
};

export function MapStatus({ goal, children }: { goal: MapGoal; children?: React.ReactNode }) {
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
    if (goal.map_status !== "pending") return;
    const supabase = createBrowserClient();
    let stopped = false;
    const timer = setInterval(async () => {
      const { data } = await supabase.from("goals").select("map_status, map_delayed").eq("id", goal.id).maybeSingle();
      if (stopped || !data) return;
      if (data.map_status !== "pending") {
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

  if (goal.map_status === "pending") {
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
