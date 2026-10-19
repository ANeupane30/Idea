import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { QuizRunner } from "@/components/quiz-runner";
import { QUIZ_ERROR_TEXT } from "@/lib/quiz";
import { TopBar } from "@/components/top-bar";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f-]{36}$/i;

async function TopicQuiz({ params }: { params: Promise<{ id: string; subtopicId: string }> }) {
  await connection();
  const { id, subtopicId } = await params;
  if (!UUID.test(id) || !UUID.test(subtopicId)) notFound();
  const supabase = await createClient();
  const [{ data: topic }, { data: covering }] = await Promise.all([
    supabase.from("subtopics").select("id, title").eq("id", subtopicId).eq("goal_id", id).maybeSingle(),
    // Same rule as lessons: a ready, on-topic source covering this topic at 0.40 or more.
    supabase
      .from("source_coverage")
      .select("source_id, sources!inner(status, relevance_label)")
      .eq("subtopic_id", subtopicId)
      .gte("relevance", 0.4)
      .eq("sources.status", "ready")
      .neq("sources.relevance_label", "off_topic")
      .limit(1),
  ]);
  if (!topic) notFound();

  return (
    <>
    <TopBar close={{ href: `/goals/${id}/topics/${subtopicId}`, label: "Close quiz" }} title={`${topic.title} quiz`} />
    <main className="mx-auto w-full max-w-2xl px-4 pb-10 sm:px-6">
      {(covering ?? []).length > 0 ? (
        <QuizRunner goalId={id} subtopicId={subtopicId} mode="subtopic" />
      ) : (
        <p className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {QUIZ_ERROR_TEXT.no_sources}
        </p>
      )}
    </main>
    </>
  );
}

export default function TopicQuizPage({ params }: { params: Promise<{ id: string; subtopicId: string }> }) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <TopicQuiz params={params} />
    </Suspense>
  );
}
