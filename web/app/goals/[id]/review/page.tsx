import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ReviewOverview } from "@/components/review-overview";
import { button } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";
import { QUIZ_ERROR_TEXT } from "@/lib/quiz";
import { createClient } from "@/lib/supabase/server";
import { loadReview } from "./load";

async function Review({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: goal } = await supabase.from("goals").select("id, title").eq("id", id).maybeSingle();
  if (!goal) notFound();
  const { tree, rows } = await loadReview(goal.id);
  return (
    <AppShell goalId={goal.id}>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        <div>
          <p className="text-body-m text-on-surface-variant [overflow-wrap:anywhere]">{goal.title}</p>
          <h1 className="mt-1 text-headline-m text-on-surface">Review</h1>
          <p className="mt-2 text-body-l text-on-surface-variant">
            See how each topic is going and practise what&apos;s due.
          </p>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-surface-container-high p-5 text-body-l text-on-surface">
            {QUIZ_ERROR_TEXT.nothing_to_review}
          </p>
        ) : (
          <ReviewOverview goalId={goal.id} tree={tree} rows={rows} />
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link href={`/goals/${goal.id}`} className={button("text")}>
            Back to map
          </Link>
          {rows.length > 0 && (
            <Link href={`/goals/${goal.id}/review/quiz`} className={button("filled")}>
              <Icon name="quiz" />
              Start review quiz
            </Link>
          )}
        </div>
      </main>
    </AppShell>
  );
}

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-on-surface-variant">Loading...</p>}>
      <Review params={params} />
    </Suspense>
  );
}
