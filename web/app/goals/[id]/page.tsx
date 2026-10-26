import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getViewer } from "@/components/site-header";
import { InfoChip } from "@/components/ui/chips";
import { createClient } from "@/lib/supabase/server";
import { isPreparing, topicsReady } from "@/lib/prep";
import {
  mainReference,
  SOURCE_COLUMNS,
  type CoverageState,
  type MainReferenceRow,
  type NodeCoverage,
  type RelevanceLabel,
  type SourceRow,
} from "@/lib/sources";
import { buildTree, type SubtopicRow } from "@/lib/topic-tree";
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

const STARTING_POINT_NOTE =
  "We couldn't find good learning material for this goal, so this map is a starting point. Add your own sources to improve it.";

/** Main topics with a source, out of all of them (while lessons are prepared). */
async function topicCounts(goalId: string): Promise<{ ready: number; total: number }> {
  const supabase = await createClient();
  const [{ data: tops }, { data: states }] = await Promise.all([
    supabase.from("subtopics").select("id").eq("goal_id", goalId).is("parent_id", null),
    supabase.from("subtopic_coverage").select("subtopic_id, state").eq("goal_id", goalId),
  ]);
  return topicsReady(tops ?? [], states ?? []);
}

async function WorkspaceSlot({
  goalId,
  goalTitle,
  archived,
  startingPoint,
  openAddSource,
}: {
  goalId: string;
  goalTitle: string;
  archived: boolean;
  startingPoint: boolean;
  openAddSource: boolean;
}) {
  const supabase = await createClient();
  const [viewer, { data: rows }, { data: sourceRows }, { data: masteryRows }, { data: refRows }] = await Promise.all([
    getViewer(),
    supabase.from("subtopics").select("id, parent_id, title, summary, position, user_edited").eq("goal_id", goalId),
    supabase
      .from("sources")
      .select(SOURCE_COLUMNS)
      .eq("goal_id", goalId)
      .order("created_at", { ascending: false })
      .order("id"),
    supabase.rpc("goal_mastery", { p_goal_id: goalId }),
    supabase.rpc("goal_main_references", { p_goal_id: goalId }),
  ]);
  if (!viewer.id) return null;
  const mainReferences = Object.fromEntries(
    ((refRows ?? []) as (MainReferenceRow & { subtopic_id: string })[]).map((r) => [r.subtopic_id, mainReference(r)]),
  );
  const sources = (sourceRows ?? []) as SourceRow[];
  const tree = buildTree((rows ?? []) as SubtopicRow[]);
  const coverage = sources.some((s) => s.status === "ready") ? await loadCoverage(goalId) : undefined;
  const mastery = Object.fromEntries(
    ((masteryRows ?? []) as MasteryRow[]).map((r) => [r.subtopic_id, { decayed: Number(r.decayed), label: r.label }]),
  );
  return (
    <Workspace
      goalId={goalId}
      userId={viewer.id}
      archived={archived}
      isGuest={viewer.isGuest}
      sources={sources}
      openAddSource={openAddSource}
      notice={
        startingPoint && (
          <p className="mt-3 rounded-2xl bg-surface-container-high p-4 text-body-m text-on-surface">{STARTING_POINT_NOTE}</p>
        )
      }
      map={<TopicMap
          goalId={goalId}
          goalTitle={goalTitle}
          tree={tree}
          coverage={coverage}
          mastery={mastery}
          mainReferences={mainReferences}
        />}
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

type PageProps = { params: Promise<{ id: string }>; searchParams: Promise<{ add?: string }> };

async function Goal({ params, searchParams }: PageProps) {
  await connection();
  const { id } = await params;
  const { add } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase
    .from("goals")
    .select("id, title, status, map_status, map_delayed, clarifying_question, map_error, map_level, map_note")
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  const level = LEVELS.find((l) => l === data.map_level) ?? null;
  // Before the map is shown, MapStatus lists the sources being read and counts the topics ready.
  const preparing = isPreparing(data.map_status) || data.map_status === "awaiting_source_decision";
  const [{ data: prepRows }, topics] = await Promise.all([
    preparing
      ? supabase.from("sources").select(SOURCE_COLUMNS).eq("goal_id", data.id).order("created_at")
      : Promise.resolve({ data: null }),
    data.map_status === "matching_sources" ? topicCounts(data.id) : Promise.resolve(null),
  ]);
  const prepSources = (prepRows ?? []) as SourceRow[];
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
      <MapStatus goal={data} sources={prepSources} topics={topics}>
        {data.map_status === "ready" && (
          <WorkspaceSlot
            goalId={data.id}
            goalTitle={data.title}
            archived={data.status === "archived"}
            startingPoint={data.map_note === "starting_point"}
            openAddSource={add === "source"}
          />
        )}
      </MapStatus>
    </main>
    </AppShell>
  );
}

export default function GoalPage({ params, searchParams }: PageProps) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Goal params={params} searchParams={searchParams} />
    </Suspense>
  );
}
