import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { QuizRunner } from "@/components/quiz-runner";
import { createClient } from "@/lib/supabase/server";

async function Review({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: goal } = await supabase.from("goals").select("id, title").eq("id", id).maybeSingle();
  if (!goal) notFound();
  return (
    <AppShell goalId={goal.id}>
    <main className="mx-auto w-full max-w-2xl p-4 sm:p-6">
      <Link
        href={`/goals/${goal.id}`}
        className="text-sm font-medium text-zinc-600 underline-offset-4 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Back to your map
      </Link>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Review quiz</p>
      <h1 className="mt-1 text-2xl font-semibold text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-50">{goal.title}</h1>
      <QuizRunner goalId={goal.id} subtopicId={null} mode="review" />
    </main>
    </AppShell>
  );
}

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Review params={params} />
    </Suspense>
  );
}
