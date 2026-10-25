"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { dbErrorToMessage, GENERIC_ERROR, startSchema, type ActionResult } from "@/lib/validation";

/** The start page: saves the learner's level and style, creates their goal with any links, and opens its map. */
export async function startLearning(formData: FormData): Promise<ActionResult> {
  const parsed = startSchema.safeParse({
    title: formData.get("title"),
    level: formData.get("level"),
    learning_style: formData.get("learning_style") ?? undefined,
    links: formData.getAll("links").map(String),
    outline: formData.get("outline")?.toString() ?? null,
    intent: formData.get("intent") ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  // The proxy gives every visitor a session; none means the guest sign-in failed.
  if (!auth.user) return { ok: false, error: GENERIC_ERROR };

  const { data, error } = await supabase.rpc("create_goal_with_sources", {
    p_title: parsed.data.title,
    p_level: parsed.data.level,
    p_learning_style: parsed.data.learning_style,
    p_links: parsed.data.links,
    p_outline: parsed.data.outline,
  });
  if (error || !data) return { ok: false, error: dbErrorToMessage(error ?? { message: "" }) };
  redirect(`/goals/${data}`);
}
