import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { TopBar } from "@/components/top-bar";
import { createClient } from "@/lib/supabase/server";
import { FORMATS, type Format, type Lesson } from "@/lib/lessons";
import { LessonView } from "./LessonView";

const UUID = /^[0-9a-f-]{36}$/i;

async function Topic({ params }: { params: Promise<{ id: string; subtopicId: string }> }) {
  await connection();
  const { id, subtopicId } = await params;
  if (!UUID.test(id) || !UUID.test(subtopicId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();

  const [{ data: topic }, { data: goal }, { data: prefs }, { data: rows }, { data: covering }] = await Promise.all([
    supabase.from("subtopics").select("id, title, summary").eq("id", subtopicId).eq("goal_id", id).maybeSingle(),
    supabase.from("goals").select("id, title").eq("id", id).maybeSingle(),
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
  ]);
  if (!topic || !goal) notFound();

  const lessons: Partial<Record<Format, Lesson>> = {};
  for (const row of (rows ?? []) as Lesson[]) lessons[row.format] ??= row;
  const preferred = FORMATS.find((f) => f === prefs?.preferred_format) ?? "text";

  return (
    <>
    <TopBar back={{ href: `/goals/${goal.id}`, label: "Back to your map" }} title={topic.title} />
    <main className="mx-auto w-full max-w-3xl px-4 pb-10 sm:px-6">
      {topic.summary && <p className="mt-2 text-on-surface-variant">{topic.summary}</p>}
      <LessonView
        goalId={goal.id}
        goalTitle={goal.title}
        subtopic={{ id: topic.id, title: topic.title }}
        preferredFormat={preferred}
        formatChosen={prefs?.format_chosen ?? false}
        initialLessons={lessons}
        hasSources={(covering ?? []).length > 0}
      />
    </main>
    </>
  );
}

export default function TopicPage({ params }: { params: Promise<{ id: string; subtopicId: string }> }) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Topic params={params} />
    </Suspense>
  );
}
