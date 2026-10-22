import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { PreferencesForm } from "@/components/preferences-form";
import { createClient } from "@/lib/supabase/server";
import { savePreferences } from "./actions";

async function Form() {
  await connection();
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/");
  const { data: prefs } = await supabase
    .from("learning_prefs")
    .select("preferred_format, level")
    .eq("user_id", data.user.id)
    .maybeSingle();
  return (
    <PreferencesForm
      action={savePreferences}
      format={prefs?.preferred_format ?? "text"}
      level={prefs?.level ?? "beginner"}
    />
  );
}

export default function OnboardingPage() {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <h1 className="mb-6 text-headline-m text-on-surface">How should we teach you?</h1>
      <Suspense fallback={<p>Loading...</p>}>
        <Form />
      </Suspense>
    </main>
  );
}
