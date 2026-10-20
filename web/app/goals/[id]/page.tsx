import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SOURCE_COLUMNS, type CoverageState, type NodeCoverage, type RelevanceLabel, type SourceRow } from "@/lib/sources";
import { addNextItems } from "@/lib/sources";
import { buildTree, type SubtopicRow } from "@/lib/topic-tree";
import { AddNext } from "./AddNext";
import { GoalWorkspace } from "./GoalWorkspace";
import { MapStatus } from "./MapStatus";
import { Sources } from "./Sources";
import { StudyNext, type MasteryRow } from "./StudyNext";
import { TopicMap, type Level } from "./TopicMap";

const LEVELS = ["beginner", "intermediate", "advanced"] as const;

async function TopicMapSlot({
  goalId,
  goalTitle,
  level,
  sources,
}: {
  goalId: string;
  goalTitle: string;
  level: Level | null;
  sources: React.ReactNode;
}) {
  const supabase = await createClient();
  const [{ data: rows }, { count: readySources }] = await Promise.all([
    supabase.from("subtopics").select("id, parent_id, title, summary, position, user_edited").eq("goal_id", goalId),
    supabase
      .from("sources")
      .select("id", { count: "exact", head: true })
      .eq("goal_id", goalId)
      .eq("status", "ready"),
  ]);
  const tree = buildTree((rows ?? []) as SubtopicRow[]);
  const [coverage, { data: masteryRows }] = await Promise.all([
    readySources ? loadCoverage(goalId) : Promise.resolve(undefined),
    supabase.rpc("goal_mastery", { p_goal_id: goalId }),
  ]);
  const rowsByTopic = (masteryRows ?? []) as MasteryRow[];
  const mastery = Object.fromEntries(rowsByTopic.map((r) => [r.subtopic_id, { decayed: Number(r.decayed), label: r.label }]));
  const hasAddNext = coverage ? addNextItems(tree, coverage).length > 0 : false;
  const suggestions = (
    <>
      <StudyNext goalId={goalId} tree={tree} rows={rowsByTopic} />
      {coverage ? (
        <AddNext goalTitle={goalTitle} tree={tree} coverage={coverage} />
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Add a link, video or PDF to see which topics it covers.</p>
      )}
      {coverage && !hasAddNext && rowsByTopic.length === 0 && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Every topic is covered by your sources.</p>
      )}
    </>
  );
  return (
    <GoalWorkspace sources={sources} suggestions={suggestions}>
      <TopicMap goalId={goalId} goalTitle={goalTitle} level={level} tree={tree} coverage={coverage} mastery={mastery} />
    </GoalWorkspace>
  );
}

type CoverageRow = {
  subtopic_id: string;
  reason: string;
  sources: { title: string | null; file_name: string | null; url_or_file: string; relevance_label: RelevanceLabel };
};

/** Each subtopic's state, plus the ready, on-topic sources that cover it (best first). */
async function loadCoverage(goalId: string): Promise<Record<string, NodeCoverage>> {
  const supabase = await createClient();
  const [{ data: states }, { data: rows }] = await Promise.all([
    supabase.from("subtopic_coverage").select("subtopic_id, state").eq("goal_id", goalId),
    supabase
      .from("source_coverage")
      .select("subtopic_id, reason, sources!inner(title, file_name, url_or_file, relevance_label)")
      .eq("sources.goal_id", goalId)
      .eq("sources.status", "ready")
      .neq("sources.relevance_label", "off_topic")
      .gte("relevance", 0.4)
      .order("relevance", { ascending: false }),
  ]);
  const coverage: Record<string, NodeCoverage> = {};
  for (const s of (states ?? []) as { subtopic_id: string; state: CoverageState }[]) {
    coverage[s.subtopic_id] = { state: s.state, sources: [] };
  }
  for (const r of (rows ?? []) as unknown as CoverageRow[]) {
    coverage[r.subtopic_id]?.sources.push({
      title: r.sources.title ?? r.sources.file_name ?? r.sources.url_or_file,
      label: r.sources.relevance_label,
      reason: r.reason,
    });
  }
  return coverage;
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
    <main className="mx-auto w-full max-w-[1800px] p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">{data.title}</h1>
      <MapStatus goal={data}>
        {data.map_status === "ready" && (
          <TopicMapSlot
            goalId={data.id}
            goalTitle={data.title}
            // The level the worker built this map for, not the learner's current level.
            level={LEVELS.find((l) => l === data.map_level) ?? null}
            sources={<SourcesSlot goalId={data.id} archived={data.status === "archived"} />}
          />
        )}
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
