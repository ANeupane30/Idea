"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { dbErrorToMessage, GENERIC_ERROR, goalSchema, LEVELS, type ActionResult } from "@/lib/validation";

const levelSchema = z.enum(LEVELS, "Choose how much you already know.");

/** The start page: saves the learner's level, creates their goal, and opens its map. */
export async function startLearning(formData: FormData): Promise<ActionResult> {
  const goal = goalSchema.safeParse({ title: formData.get("title") });
  if (!goal.success) return { ok: false, error: goal.error.issues[0]?.message ?? GENERIC_ERROR };
  const level = levelSchema.safeParse(formData.get("level"));
  if (!level.success) return { ok: false, error: level.error.issues[0]?.message ?? GENERIC_ERROR };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  // The proxy gives every visitor a session; none means the guest sign-in failed.
  if (!auth.user) return { ok: false, error: GENERIC_ERROR };

  // The format question isn't asked yet. preferred_format is left out so a new row
  // gets the column default ('text') and an existing choice is kept.
  const { error: prefsError } = await supabase
    .from("learning_prefs")
    .upsert({ user_id: auth.user.id, level: level.data }, { onConflict: "user_id" });
  if (prefsError) return { ok: false, error: GENERIC_ERROR };

  const { data, error } = await supabase
    .from("goals")
    .insert({ user_id: auth.user.id, title: goal.data.title })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: dbErrorToMessage(error ?? { message: "" }) };
  redirect(`/goals/${data.id}`);
}
