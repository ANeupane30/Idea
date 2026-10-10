import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../(auth)/actions";

async function Gate({ children }: { children: React.ReactNode }) {
  await connection();
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/sign-in");
  const { data: prefs } = await supabase
    .from("learning_prefs")
    .select("user_id")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (!prefs) redirect("/onboarding");
  return <>{children}</>;
}

export default function GoalsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="flex items-center justify-end border-b border-zinc-200 p-3">
        <form action={signOut}>
          <button type="submit" className="rounded border border-zinc-400 px-3 py-1 text-sm">
            Sign out
          </button>
        </form>
      </header>
      <Suspense fallback={<p className="p-6">Loading...</p>}>
        <Gate>{children}</Gate>
      </Suspense>
    </>
  );
}
