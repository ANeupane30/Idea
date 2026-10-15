"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { detectLinkType, isUploadPath, linkSchema } from "@/lib/sources";
import { dbErrorToMessage, GENERIC_ERROR, type ActionResult } from "@/lib/validation";

const CANT_ADD = "That link or file can't be added.";

export async function addLinkSource(goalId: string, url: string): Promise<ActionResult> {
  const parsed = linkSchema.safeParse(url);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: GENERIC_ERROR };

  const { error } = await supabase.from("sources").insert({
    goal_id: goalId,
    user_id: auth.user.id,
    type: detectLinkType(parsed.data),
    url_or_file: parsed.data,
  });
  if (error) return { ok: false, error: dbErrorToMessage(error) };
  revalidatePath(`/goals/${goalId}`);
  return { ok: true };
}

/** Registers a PDF the browser already uploaded to the user's folder in the `sources` bucket. */
export async function addPdfSource(goalId: string, path: string, fileName: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: GENERIC_ERROR };
  if (typeof path !== "string" || typeof fileName !== "string" || !isUploadPath(auth.user.id, path)) {
    return { ok: false, error: CANT_ADD };
  }

  const { error } = await supabase.from("sources").insert({
    goal_id: goalId,
    user_id: auth.user.id,
    type: "pdf",
    url_or_file: path,
    file_name: fileName.slice(0, 255) || "document.pdf",
  });
  if (error) return { ok: false, error: dbErrorToMessage(error) };
  revalidatePath(`/goals/${goalId}`);
  return { ok: true };
}

export async function retrySource(goalId: string, sourceId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("retry_source", { p_source_id: sourceId });
  if (error) {
    if (error.message.includes("not_failed")) return { ok: false, error: "This source is already being processed." };
    return { ok: false, error: dbErrorToMessage(error) };
  }
  revalidatePath(`/goals/${goalId}`);
  return { ok: true };
}
