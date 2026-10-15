"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { GENERIC_ERROR, preferencesSchema, type ActionResult } from "@/lib/validation";

export async function savePreferences(formData: FormData): Promise<ActionResult> {
  const parsed = preferencesSchema.safeParse({
    preferred_format: formData.get("preferred_format"),
    level: formData.get("level"),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/");

  const { error } = await supabase
    .from("learning_prefs")
    .upsert({ user_id: data.user.id, ...parsed.data, format_chosen: true }, { onConflict: "user_id" });
  if (error) return { ok: false, error: GENERIC_ERROR };
  // The client navigates to /goals with a full page load (see PreferencesForm), so it never
  // reuses a cached "/goals redirects to /onboarding" router entry from before the save.
  return { ok: true };
}
