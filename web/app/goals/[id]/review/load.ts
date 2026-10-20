import { createClient } from "@/lib/supabase/server";
import { buildTree, type SubtopicRow, type TreeNode } from "@/lib/topic-tree";
import type { MasteryRow } from "../StudyNext";

/** A goal's topics and per-topic mastery, for the Review hub and quiz results. */
export async function loadReview(goalId: string): Promise<{ tree: TreeNode[]; rows: MasteryRow[] }> {
  const supabase = await createClient();
  const [{ data: subtopics }, { data: mastery }] = await Promise.all([
    supabase.from("subtopics").select("id, parent_id, title, summary, position, user_edited").eq("goal_id", goalId),
    supabase.rpc("goal_mastery", { p_goal_id: goalId }),
  ]);
  return {
    tree: buildTree((subtopics ?? []) as SubtopicRow[]),
    rows: ((mastery ?? []) as MasteryRow[]).map((r) => ({ ...r, decayed: Number(r.decayed) })),
  };
}
