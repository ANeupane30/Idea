import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
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
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <Link
        href={`/goals/${goal.id}`}
        className="text-sm font-medium text-zinc-600 underline-offset-4 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Back to your map
      </Link>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
        {goal.title}
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-zinc-900 [overflow-wrap:anywhere] sm:text-3xl dark:text-zinc-50">
        {topic.title}
      </h1>
      {topic.summary && <p className="mt-2 text-zinc-600 dark:text-zinc-400">{topic.summary}</p>}
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
  );
}

export default function TopicPage({ params }: { params: Promise<{ id: string; subtopicId: string }> }) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Topic params={params} />
    </Suspense>
  );
}
