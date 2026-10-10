import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MapStatus } from "./MapStatus";

type Subtopic = { id: string; parent_id: string | null; title: string; position: number };

// Read-only for now; Task 9 swaps in the editor here.
async function TopicMapSlot({ goalId }: { goalId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("subtopics")
    .select("id, parent_id, title, position")
    .eq("goal_id", goalId)
    .order("position");
  const rows = (data ?? []) as Subtopic[];
  const children = (pid: string | null) => rows.filter((r) => r.parent_id === pid);
  return (
    <ul className="mt-4 list-disc pl-6">
      {children(null).map((t) => (
        <li key={t.id}>
          <span>{t.title}</span>
          {children(t.id).length > 0 && (
            <ul className="list-disc pl-6">
              {children(t.id).map((c) => (
                <li key={c.id}>{c.title}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
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
        <TopicMapSlot goalId={data.id} />
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
