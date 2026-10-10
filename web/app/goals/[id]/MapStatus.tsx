"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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

  useEffect(() => {
    if (goal.map_status !== "pending") return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [goal.map_status, router]);

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
      <div role="status" className="mt-4">
        <p>Building your topic map…</p>
        {goal.map_delayed && <p className="text-sm text-zinc-600">Processing is delayed. We&apos;ll keep trying.</p>}
      </div>
    );
  }

  if (goal.map_status === "clarifying") {
    return (
      <div className="mt-4">
        <p className="font-medium">{goal.clarifying_question}</p>
        {archived ? (
          <p className="mt-2 text-sm text-zinc-600">Unarchive this goal to answer.</p>
        ) : (
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => answerClarification(goal.id, answer));
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              Your answer
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                maxLength={1000}
                rows={3}
                className="rounded border border-zinc-400 p-2"
              />
            </label>
            <button type="submit" disabled={isPending} className="self-start rounded bg-zinc-900 px-3 py-1 text-white">
              Submit answer
            </button>
          </form>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  if (goal.map_status === "failed") {
    return (
      <div className="mt-4">
        <p role="alert" className="text-red-700">
          {goal.map_error ?? "We couldn't build your topic map."}
        </p>
        {!archived && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => retryTopicMap(goal.id))}
            className="mt-2 rounded border border-zinc-400 px-3 py-1"
          >
            Try again
          </button>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  return <>{children}</>;
}
