import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buildTree, type SubtopicRow, type TreeNode } from "@/lib/topic-tree";
import { MapStatus } from "./MapStatus";

// Temporary read-only view; replaced by the visual mind map.
function TopicList({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ol className="ml-5 list-decimal space-y-2">
      {nodes.map((n) => (
        <li key={n.id}>
          <p className="font-medium">{n.title}</p>
          {n.summary && <p className="text-sm opacity-70">{n.summary}</p>}
          {n.children.length > 0 && <TopicList nodes={n.children} />}
        </li>
      ))}
    </ol>
  );
}

async function TopicMapSlot({ goalId }: { goalId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("subtopics")
    .select("id, parent_id, title, summary, position, user_edited")
    .eq("goal_id", goalId);
  return (
    <nav aria-label="Topic map" className="mt-4">
      <TopicList nodes={buildTree((data ?? []) as SubtopicRow[])} />
    </nav>
  );
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
        {data.map_status === "ready" && <TopicMapSlot goalId={data.id} />}
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
