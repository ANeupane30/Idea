import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getViewer, SiteHeader, SiteHeaderFallback } from "@/components/site-header";
import { StartForm } from "@/components/start-form";
import { createClient } from "@/lib/supabase/server";
import { startLearning } from "./start-actions";

async function Start() {
  const viewer = await getViewer();
  if (viewer.id) {
    const supabase = await createClient();
    const [{ data: goal }, { data: prefs }] = await Promise.all([
      supabase.from("goals").select("id").limit(1).maybeSingle(),
      supabase.from("learning_prefs").select("user_id").eq("user_id", viewer.id).maybeSingle(),
    ]);
    // /goals sends users without prefs here, so only go there when it won't send them back.
    if (goal && prefs) redirect("/goals");
  }
  return (
    <StartForm
      action={startLearning}
      note={
        viewer.isGuest ? (
          <p className="text-center text-body-m text-on-surface-variant">
            No account needed. Add articles, videos and PDFs once your map is ready.
          </p>
        ) : null
      }
    />
  );
}

export default function Home() {
  return (
    <>
      <Suspense fallback={<SiteHeaderFallback />}>
        <SiteHeader />
      </Suspense>
      <main className="flex flex-1 justify-center px-4 pt-[12vh] pb-16 sm:pt-[18vh]">
        <div className="flex w-full max-w-2xl flex-col items-center gap-8">
          <h1 className="text-center text-display-s text-on-surface max-sm:text-[32px] max-sm:leading-10">
            What do you want to learn?
          </h1>
          <Suspense fallback={<p className="text-body-m text-on-surface-variant">Loading...</p>}>
            <Start />
          </Suspense>
        </div>
      </main>
    </>
  );
}
