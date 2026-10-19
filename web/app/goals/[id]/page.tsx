import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getViewer } from "@/components/site-header";
import { InfoChip } from "@/components/ui/chips";
import { createClient } from "@/lib/supabase/server";
import { addNextItems, SOURCE_COLUMNS, type CoverageState, type NodeCoverage, type RelevanceLabel, type SourceRow } from "@/lib/sources";
import { buildTree, type SubtopicRow } from "@/lib/topic-tree";
import { AddNext } from "./AddNext";
import { MapStatus } from "./MapStatus";
import type { MasteryRow } from "./StudyNext";
import { TopicMap, type Level } from "./TopicMap";
import { Workspace } from "./Workspace";

const LEVEL_TEXT: Record<Level, string> = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" };
const LEVEL_ICON = {
  beginner: "signal_cellular_alt_1_bar",
  intermediate: "signal_cellular_alt_2_bar",
  advanced: "signal_cellular_alt",
} as const;

const LEVELS = ["beginner", "intermediate", "advanced"] as const;

async function WorkspaceSlot({
  goalId,
  goalTitle,
  archived,
}: {
  goalId: string;
  goalTitle: string;
  archived: boolean;
}) {
  const supabase = await createClient();
  const [viewer, { data: rows }, { data: sourceRows }, { data: masteryRows }] = await Promise.all([
    getViewer(),
    supabase.from("subtopics").select("id, parent_id, title, summary, position, user_edited").eq("goal_id", goalId),
    supabase
      .from("sources")
      .select(SOURCE_COLUMNS)
      .eq("goal_id", goalId)
      .order("created_at", { ascending: false })
      .order("id"),
    supabase.rpc("goal_mastery", { p_goal_id: goalId }),
  ]);
  if (!viewer.id) return null;
  const sources = (sourceRows ?? []) as SourceRow[];
  const tree = buildTree((rows ?? []) as SubtopicRow[]);
  const coverage = sources.some((s) => s.status === "ready") ? await loadCoverage(goalId) : undefined;
  const mastery = Object.fromEntries(
    ((masteryRows ?? []) as MasteryRow[]).map((r) => [r.subtopic_id, { decayed: Number(r.decayed), label: r.label }]),
  );
  const hasAddNext = coverage ? addNextItems(tree, coverage).length > 0 : false;
  return (
    <Workspace
      goalId={goalId}
      userId={viewer.id}
      archived={archived}
      isGuest={viewer.isGuest}
      sources={sources}
      map={<TopicMap goalId={goalId} goalTitle={goalTitle} tree={tree} coverage={coverage} mastery={mastery} />}
      suggestions={
        coverage &&
        (hasAddNext ? (
          <AddNext goalTitle={goalTitle} tree={tree} coverage={coverage} />
        ) : (
          <p className="text-body-m text-on-surface-variant">Every topic is covered by your sources.</p>
        ))
      }
    />
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
  const level = LEVELS.find((l) => l === data.map_level) ?? null;
  return (
    <AppShell goalId={data.id}>
    <main className="mx-auto w-full max-w-[1800px] p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="min-w-0 text-headline-m text-on-surface [overflow-wrap:anywhere]">{data.title}</h1>
        {level && data.map_status === "ready" && (
          // The level the worker built this map for, not the learner's current level.
          <InfoChip icon={LEVEL_ICON[level]}>
            <span>
              <span className="sr-only">Built for: </span>
              {LEVEL_TEXT[level]}
            </span>
          </InfoChip>
        )}
      </div>
      <MapStatus goal={data}>
        {data.map_status === "ready" && (
          <WorkspaceSlot goalId={data.id} goalTitle={data.title} archived={data.status === "archived"} />
        )}
      </MapStatus>
    </main>
    </AppShell>
  );
}

export default function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Goal params={params} />
    </Suspense>
  );
}
