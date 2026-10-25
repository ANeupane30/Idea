import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getViewer } from "@/components/site-header";
import { createClient } from "@/lib/supabase/server";
import { FORMATS, type Format, type Lesson } from "@/lib/lessons";
import { isPreparing } from "@/lib/prep";
import { buildTree, type SubtopicRow } from "@/lib/topic-tree";
import { LessonView } from "./LessonView";

const UUID = /^[0-9a-f-]{36}$/i;

async function Topic({ params }: { params: Promise<{ id: string; subtopicId: string }> }) {
  await connection();
  const { id, subtopicId } = await params;
  if (!UUID.test(id) || !UUID.test(subtopicId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();

  const [{ data: topic }, { data: goal }, { data: prefs }, { data: rows }, { data: covering }, { data: all }, { data: reading }, viewer] =
    await Promise.all([
    supabase.from("subtopics").select("id, title, summary").eq("id", subtopicId).eq("goal_id", id).maybeSingle(),
    supabase.from("goals").select("id, title, map_status").eq("id", id).maybeSingle(),
    supabase
      .from("learning_prefs")
      .select("preferred_format, format_chosen")
      .eq("user_id", auth.user?.id ?? "")
      .maybeSingle(),
    supabase
      .from("lessons")
      .select("id, format, stale, created_at, body")
      .eq("subtopic_id", subtopicId)
      .eq("status", "ready")
      .order("created_at", { ascending: false }),
    // Same rule as the generator: a ready, on-topic source covering this topic at 0.40 or more.
    supabase
      .from("source_coverage")
      .select("source_id, sources!inner(status, relevance_label)")
      .eq("subtopic_id", subtopicId)
      .gte("relevance", 0.4)
      .eq("sources.status", "ready")
      .neq("sources.relevance_label", "off_topic")
      .limit(1),
    supabase.from("subtopics").select("id, parent_id, title, summary, position, user_edited").eq("goal_id", id),
    // A source still being read (and not set aside by the check) may yet cover this topic.
    supabase
      .from("sources")
      .select("id")
      .eq("goal_id", id)
      .in("status", ["queued", "processing", "awaiting_map"])
      .or("vetted.is.null,vetted.eq.true")
      .limit(1),
    getViewer(),
  ]);
  if (!topic || !goal) notFound();

  const lessons: Partial<Record<Format, Lesson>> = {};
  for (const row of (rows ?? []) as Lesson[]) lessons[row.format] ??= row;
  const preferred = FORMATS.find((f) => f === prefs?.preferred_format) ?? "text";

  const tree = buildTree((all ?? []) as SubtopicRow[]);
  const index = tree.findIndex((n) => n.id === topic.id);
  const title = index >= 0 ? `${index + 1} ${topic.title}` : topic.title;

  return (
    <LessonView
      userId={viewer.id}
      title={title}
      summary={topic.summary}
      goalId={goal.id}
      goalTitle={goal.title}
      subtopic={{ id: topic.id, title: topic.title }}
      preferredFormat={preferred}
      formatChosen={prefs?.format_chosen ?? false}
      initialLessons={lessons}
      hasSources={(covering ?? []).length > 0}
      sourcesPending={isPreparing(goal.map_status) || (reading ?? []).length > 0}
    />
  );
}

export default function TopicPage({ params }: { params: Promise<{ id: string; subtopicId: string }> }) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Topic params={params} />
    </Suspense>
  );
}
