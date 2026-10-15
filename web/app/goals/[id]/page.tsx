import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SOURCE_COLUMNS, type SourceRow } from "@/lib/sources";
import { buildTree, type SubtopicRow } from "@/lib/topic-tree";
import { MapStatus } from "./MapStatus";
import { Sources } from "./Sources";
import { TopicMap, type Level } from "./TopicMap";

const LEVELS = ["beginner", "intermediate", "advanced"] as const;

async function TopicMapSlot({
  goalId,
  goalTitle,
  level,
}: {
  goalId: string;
  goalTitle: string;
  level: Level | null;
}) {
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("subtopics")
    .select("id, parent_id, title, summary, position, user_edited")
    .eq("goal_id", goalId);
  return <TopicMap goalTitle={goalTitle} level={level} tree={buildTree((rows ?? []) as SubtopicRow[])} />;
}

async function SourcesSlot({ goalId, archived }: { goalId: string; archived: boolean }) {
  const supabase = await createClient();
  const [{ data: auth }, { data: rows }] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from("sources")
      .select(SOURCE_COLUMNS)
      .eq("goal_id", goalId)
      .order("created_at", { ascending: false })
      .order("id"),
  ]);
  if (!auth.user) return null;
  return (
    <Sources goalId={goalId} userId={auth.user.id} archived={archived} sources={(rows ?? []) as SourceRow[]} />
  );
}

async function Goal({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase
    .from("goals")
    .select("id, title, status, map_status, map_delayed, clarifying_question, map_error, map_level")
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">{data.title}</h1>
      <MapStatus goal={data}>
        {data.map_status === "ready" && (
          <TopicMapSlot
            goalId={data.id}
            goalTitle={data.title}
            // The level the worker built this map for, not the learner's current level.
            level={LEVELS.find((l) => l === data.map_level) ?? null}
          />
        )}
        {data.map_status === "ready" && <SourcesSlot goalId={data.id} archived={data.status === "archived"} />}
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
