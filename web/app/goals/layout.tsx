import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function Gate({ children }: { children: React.ReactNode }) {
  await connection();
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/");
  const { data: prefs } = await supabase
    .from("learning_prefs")
    .select("user_id")
    .eq("user_id", data.user.id)
    .maybeSingle();
  // No prefs yet: the start page asks for the level along with the first goal.
  if (!prefs) redirect("/");
  return <>{children}</>;
}

export default function GoalsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<p className="p-6 text-on-surface-variant">Loading...</p>}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}
