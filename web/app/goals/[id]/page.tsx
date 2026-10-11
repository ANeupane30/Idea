import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buildTree, type SubtopicRow } from "@/lib/topic-tree";
import { MapStatus } from "./MapStatus";
import { TopicMap } from "./TopicMap";

const LEVELS = ["beginner", "intermediate", "advanced"] as const;

async function TopicMapSlot({ goalId, goalTitle }: { goalId: string; goalTitle: string }) {
  const supabase = await createClient();
  const [{ data: rows }, { data: auth }] = await Promise.all([
    supabase
      .from("subtopics")
      .select("id, parent_id, title, summary, position, user_edited")
      .eq("goal_id", goalId),
    supabase.auth.getUser(),
  ]);
  const { data: prefs } = auth.user
    ? await supabase.from("learning_prefs").select("level").eq("user_id", auth.user.id).maybeSingle()
    : { data: null };
  const level = LEVELS.find((l) => l === prefs?.level) ?? null;
  return <TopicMap goalTitle={goalTitle} level={level} tree={buildTree((rows ?? []) as SubtopicRow[])} />;
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
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">{data.title}</h1>
      <MapStatus goal={data}>
        {data.map_status === "ready" && <TopicMapSlot goalId={data.id} goalTitle={data.title} />}
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
