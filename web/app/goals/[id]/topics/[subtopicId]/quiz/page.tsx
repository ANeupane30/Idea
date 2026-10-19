import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { QuizRunner } from "@/components/quiz-runner";
import { ReviewOverview } from "@/components/review-overview";
import { QUIZ_ERROR_TEXT } from "@/lib/quiz";
import { TopBar } from "@/components/top-bar";
import { createClient } from "@/lib/supabase/server";
import { loadReview } from "../../../review/load";

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
  const { tree, rows } = await loadReview(id);

  return (
    <>
    <TopBar close={{ href: `/goals/${id}/topics/${subtopicId}`, label: "Close quiz" }} title={`${topic.title} quiz`} />
    <main className="mx-auto w-full max-w-2xl px-4 pb-10 sm:px-6">
      {(covering ?? []).length > 0 ? (
        <QuizRunner
          goalId={id}
          subtopicId={subtopicId}
          mode="subtopic"
          title={`${topic.title} quiz`}
          overview={<ReviewOverview goalId={id} tree={tree} rows={rows} />}
        />
      ) : (
        <p className="mt-6 rounded-2xl bg-surface-container-high p-5 text-body-l text-on-surface">
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
