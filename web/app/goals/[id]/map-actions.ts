"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  dbErrorToMessage,
  GENERIC_ERROR,
  subtopicSummarySchema,
  subtopicTitleSchema,
  type ActionResult,
} from "@/lib/validation";

const UUID = /^[0-9a-f-]{36}$/i;

async function goalIdOf(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
  const { data } = await supabase.from("subtopics").select("goal_id").eq("id", id).maybeSingle();
  return data?.goal_id as string | undefined;
}

async function finish(supabase: Awaited<ReturnType<typeof createClient>>, goalId: string | undefined, error: { message: string } | null): Promise<ActionResult> {
  if (error) return { ok: false, error: dbErrorToMessage(error) };
  if (goalId) revalidatePath(`/goals/${goalId}`);
  return { ok: true };
}

export async function renameSubtopic(id: string, title: string): Promise<ActionResult> {
  if (!UUID.test(id)) return { ok: false, error: GENERIC_ERROR };
  const parsed = subtopicTitleSchema.safeParse(title);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
  const supabase = await createClient();
  const goalId = await goalIdOf(supabase, id);
  const { error } = await supabase.from("subtopics").update({ title: parsed.data }).eq("id", id);
  return finish(supabase, goalId, error);
}

export async function addSubtopic(
  goalId: string,
  parentId: string | null,
  title: string,
  summary?: string,
): Promise<ActionResult> {
  if (!UUID.test(goalId) || (parentId !== null && !UUID.test(parentId))) return { ok: false, error: GENERIC_ERROR };
  const t = subtopicTitleSchema.safeParse(title);
  if (!t.success) return { ok: false, error: t.error.issues[0]?.message ?? GENERIC_ERROR };
  const s = subtopicSummarySchema.safeParse(summary);
  if (!s.success) return { ok: false, error: s.error.issues[0]?.message ?? GENERIC_ERROR };
  const supabase = await createClient();
  let q = supabase.from("subtopics").select("position").eq("goal_id", goalId);
  q = parentId ? q.eq("parent_id", parentId) : q.is("parent_id", null);
  const { data: siblings, error: readError } = await q;
  if (readError) return { ok: false, error: dbErrorToMessage(readError) };
  const position = (siblings ?? []).reduce((max, r) => Math.max(max, r.position + 1), 0);
  const { error } = await supabase.from("subtopics").insert({
    goal_id: goalId,
    parent_id: parentId,
    title: t.data,
    summary: s.data ? s.data : null,
    position,
  });
  return finish(supabase, goalId, error);
}

export async function deleteSubtopic(id: string): Promise<ActionResult> {
  if (!UUID.test(id)) return { ok: false, error: GENERIC_ERROR };
  const supabase = await createClient();
  const goalId = await goalIdOf(supabase, id);
  const { error } = await supabase.from("subtopics").delete().eq("id", id);
  return finish(supabase, goalId, error);
}

export async function moveSubtopic(id: string, parentId: string | null, position: number): Promise<ActionResult> {
  if (!UUID.test(id) || (parentId !== null && !UUID.test(parentId)) || !Number.isInteger(position) || position < 0)
    return { ok: false, error: GENERIC_ERROR };
  const supabase = await createClient();
  const goalId = await goalIdOf(supabase, id);
  const { error } = await supabase.rpc("move_subtopic", { p_id: id, p_parent_id: parentId, p_position: position });
  return finish(supabase, goalId, error);
}
