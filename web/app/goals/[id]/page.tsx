import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { SubtopicRow } from "@/lib/topic-tree";
import { MapStatus } from "./MapStatus";
import { TopicMapEditor } from "./TopicMapEditor";

async function TopicMapSlot({ goalId, readOnly }: { goalId: string; readOnly: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("subtopics")
    .select("id, parent_id, title, summary, position, user_edited")
    .eq("goal_id", goalId);
  return <TopicMapEditor goalId={goalId} rows={(data ?? []) as SubtopicRow[]} readOnly={readOnly} />;
}

async function Goal({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase
    .from("goals")
    .select("id, title, status, map_status, map_delayed, clarifying_question, map_error")
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">{data.title}</h1>
      <MapStatus goal={data}>
        {data.map_status === "ready" && <TopicMapSlot goalId={data.id} readOnly={data.status !== "active"} />}
      </MapStatus>
    </main>
  );
}

export default function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Goal params={params} />
    </Suspense>
  );
}
