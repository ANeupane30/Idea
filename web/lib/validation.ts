import { z } from "zod";

export type ActionResult = { ok: true } | { ok: false; error: string };

export const GENERIC_ERROR = "Something went wrong. Please try again.";
export const PASSWORD_TOO_SHORT = "Password must be at least 8 characters.";

export const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, PASSWORD_TOO_SHORT),
});

export const FORMATS = ["visual", "text", "examples", "summary"] as const;
export const LEVELS = ["beginner", "intermediate", "advanced"] as const;

export const preferencesSchema = z.object({
  preferred_format: z.enum(FORMATS, "Choose a format."),
  level: z.enum(LEVELS, "Choose a level."),
});

export const goalSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title can't be empty.")
    .max(120, "Keep the title under 120 characters."),
  description: z
    .string()
    .trim()
    .max(2000, "Keep the description under 2000 characters.")
    .optional(),
});

export function dbErrorToMessage(err: { message: string }): string {
  const m = err.message ?? "";
  if (m.includes("goal_limit_reached")) return "Free plan allows 2 active goals. Archive one to add another.";
  if (m.includes("map_not_editable")) return "The topic map can't be edited right now.";
  if (m.includes("max_depth_exceeded")) return "Topic maps can only be two levels deep.";
  if (m.includes("not_clarifying") || m.includes("not_failed"))
    return "This goal's topic map has already moved on. Refresh the page.";
  if (m.includes("invalid_answer")) return "Please write an answer of up to 1000 characters.";
  return GENERIC_ERROR;
}

export const MAP_STATUS_TEXT: Record<string, string> = {
  pending: "Building your topic map",
  clarifying: "Waiting for your answer",
  ready: "Ready",
  failed: "Couldn't build",
};
