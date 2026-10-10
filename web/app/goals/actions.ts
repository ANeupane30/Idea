"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { dbErrorToMessage, GENERIC_ERROR, goalSchema, type ActionResult } from "@/lib/validation";

export async function createGoal(formData: FormData): Promise<ActionResult> {
  const description = formData.get("description");
  const parsed = goalSchema.safeParse({
    title: formData.get("title"),
    description: typeof description === "string" && description.trim() ? description : undefined,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/sign-in");

  const { data, error } = await supabase
    .from("goals")
    .insert({
      user_id: auth.user.id,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: dbErrorToMessage(error ?? { message: "" }) };
  redirect(`/goals/${data.id}`);
}

export async function setGoalStatus(goalId: string, status: "active" | "archived"): Promise<ActionResult> {
  if (status !== "active" && status !== "archived") return { ok: false, error: GENERIC_ERROR };
  const supabase = await createClient();
  const { error } = await supabase.from("goals").update({ status }).eq("id", goalId);
  if (error) return { ok: false, error: dbErrorToMessage(error) };
  revalidatePath("/goals");
  return { ok: true };
}
