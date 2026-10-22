import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { QuizRunner } from "@/components/quiz-runner";
import { ReviewOverview } from "@/components/review-overview";
import { TopBar } from "@/components/top-bar";
import { createClient } from "@/lib/supabase/server";
import { loadReview } from "../load";

async function ReviewQuiz({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: goal } = await supabase.from("goals").select("id").eq("id", id).maybeSingle();
  if (!goal) notFound();
  const { tree, rows } = await loadReview(goal.id);
  return (
    <>
      <TopBar close={{ href: `/goals/${goal.id}/review`, label: "Close quiz" }} title="Review quiz" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-10 sm:px-6">
        <QuizRunner
          goalId={goal.id}
          subtopicId={null}
          mode="review"
          title="Review quiz"
          overview={<ReviewOverview goalId={goal.id} tree={tree} rows={rows} />}
        />
      </main>
    </>
  );
}

export default function ReviewQuizPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-on-surface-variant">Loading...</p>}>
      <ReviewQuiz params={params} />
    </Suspense>
  );
}
