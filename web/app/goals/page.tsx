import { Suspense } from "react";
import { connection } from "next/server";
import { AppShell } from "@/components/app-shell";
import { GoalLists, NewGoalForm } from "@/components/goals-ui";
import { createClient } from "@/lib/supabase/server";
import { MAP_STATUS_TEXT } from "@/lib/validation";
import { createGoal, setGoalStatus } from "./actions";

async function Lists() {
  await connection();
  const supabase = await createClient();
  const { data } = await supabase
    .from("goals")
    .select("id, title, status, map_status")
    .order("created_at", { ascending: true });
  const rows = (data ?? []).map((g) => ({
    id: g.id as string,
    title: g.title as string,
    status: g.status as string,
    statusText: MAP_STATUS_TEXT[g.map_status as string] ?? "",
  }));
  return (
    <GoalLists
      active={rows.filter((g) => g.status === "active")}
      archived={rows.filter((g) => g.status === "archived")}
      action={setGoalStatus}
    />
  );
}

export default function GoalsPage() {
  return (
    <AppShell>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8 sm:px-6">
        <h1 className="text-headline-m text-on-surface">Your goals</h1>
        <section aria-labelledby="new-h" className="flex flex-col gap-4 rounded-2xl bg-surface-container-low p-6">
          <h2 id="new-h" className="text-title-l text-on-surface">
            New goal
          </h2>
          <NewGoalForm action={createGoal} />
        </section>
        <Suspense fallback={<p className="text-on-surface-variant">Loading...</p>}>
          <Lists />
        </Suspense>
      </main>
    </AppShell>
  );
}
