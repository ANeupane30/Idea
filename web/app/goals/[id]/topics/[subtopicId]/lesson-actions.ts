"use server";

import { createClient } from "@/lib/supabase/server";
import { FORMATS, type Format } from "@/lib/lessons";
import { GENERIC_ERROR, type ActionResult } from "@/lib/validation";

const isFormat = (f: unknown): f is Format => typeof f === "string" && (FORMATS as readonly string[]).includes(f);

/** The learner picked how they like to learn (asked on their first lesson). */
export async function chooseFormat(format: Format): Promise<ActionResult> {
  if (!isFormat(format)) return { ok: false, error: GENERIC_ERROR };
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: GENERIC_ERROR };
  const { error } = await supabase
    .from("learning_prefs")
    .update({ preferred_format: format, format_chosen: true })
    .eq("user_id", auth.user.id);
  return error ? { ok: false, error: GENERIC_ERROR } : { ok: true };
}

/** Logged for future format inference (spec: format_events). */
export async function logFormatSwitch(subtopicId: string, from: Format, to: Format): Promise<ActionResult> {
  if (!isFormat(from) || !isFormat(to) || from === to) return { ok: false, error: GENERIC_ERROR };
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: GENERIC_ERROR };
  const { error } = await supabase
    .from("format_events")
    .insert({ user_id: auth.user.id, subtopic_id: subtopicId, from_format: from, to_format: to });
  return error ? { ok: false, error: GENERIC_ERROR } : { ok: true };
}
