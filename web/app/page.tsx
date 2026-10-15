import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { SiteHeader, SiteHeaderFallback } from "@/components/site-header";
import { StartForm } from "@/components/start-form";
import { createClient } from "@/lib/supabase/server";
import { startLearning } from "./start-actions";

async function Start() {
  await connection();
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) {
    const [{ data: goal }, { data: prefs }] = await Promise.all([
      supabase.from("goals").select("id").limit(1).maybeSingle(),
      supabase.from("learning_prefs").select("user_id").eq("user_id", data.user.id).maybeSingle(),
    ]);
    // /goals sends users without prefs here, so only go there when it won't send them back.
    if (goal && prefs) redirect("/goals");
  }
  return <StartForm action={startLearning} />;
}

export default function Home() {
  return (
    <>
      <Suspense fallback={<SiteHeaderFallback />}>
        <SiteHeader />
      </Suspense>
      <main className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center sm:py-16">
        <div className="w-full max-w-2xl rounded-3xl border border-zinc-200 bg-white p-6 shadow-xl shadow-zinc-950/5 sm:p-10 max-sm:px-5 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/30">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
            Free to try, no account needed
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl dark:text-zinc-50">
            What do you want to learn?
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            Tell us your goal and we&apos;ll design a step-by-step map of the topics to learn, in the
            right order for you.
          </p>
          <div className="mt-8">
            <Suspense fallback={<p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>}>
              <Start />
            </Suspense>
          </div>
        </div>
      </main>
    </>
  );
}
