import { z } from "zod";
import { linkSchema, OUTLINE_MAX } from "@/lib/sources";

export type ActionResult = { ok: true } | { ok: false; error: string };

export const GENERIC_ERROR = "Something went wrong. Please try again.";
export const PASSWORD_TOO_SHORT = "Password must be at least 8 characters.";

export const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, PASSWORD_TOO_SHORT),
});

export const FORMATS = ["visual", "text", "examples", "summary"] as const;
export const LEVELS = ["beginner", "intermediate", "advanced"] as const;

export const LEARNING_STYLES = ["visual_video", "reading", "hands_on"] as const;
export type LearningStyle = (typeof LEARNING_STYLES)[number];

export const STYLE_LABELS: Record<LearningStyle, string> = {
  visual_video: "Visual / Video",
  reading: "Documentation & Reading",
  hands_on: "Hands-On / Building",
};

/** The default lesson format for a learning style (as public.style_format). */
export function styleFormat(style: LearningStyle): (typeof FORMATS)[number] {
  return style === "visual_video" ? "visual" : style === "hands_on" ? "examples" : "text";
}

const styleSchema = z.enum(LEARNING_STYLES, "Choose how you like to learn.");

export const preferencesSchema = z.object({
  learning_style: styleSchema,
  level: z.enum(LEVELS, "Choose a level."),
});

export const MAX_START_LINKS = 3;
export const TOO_MANY_LINKS = "Add up to 3 links.";

/** The start form. "Pick for me" (intent=pick) submits without the learner's sources. */
export const startSchema = z
  .object({
    title: goalTitle(),
    level: z.enum(LEVELS, "Choose how much you already know."),
    learning_style: styleSchema.default("reading"),
    links: z.array(z.string()).default([]),
    outline: z.string().nullish(),
    intent: z.string().optional(),
  })
  .transform((v) => {
    const pick = v.intent === "pick";
    return {
      ...v,
      links: pick ? [] : v.links.filter((l) => l.trim() !== ""),
      outline: pick || !v.outline?.trim() ? null : v.outline,
    };
  })
  .pipe(
    z.object({
      title: z.string(),
      level: z.enum(LEVELS),
      learning_style: styleSchema,
      links: z.array(linkSchema).max(MAX_START_LINKS, TOO_MANY_LINKS),
      outline: z.string().max(OUTLINE_MAX, "Outlines can be up to 20,000 characters.").nullable(),
      intent: z.string().optional(),
    }),
  );

function goalTitle() {
  return z.string().trim().min(1, "Title can't be empty.").max(120, "Keep the title under 120 characters.");
}

export const goalSchema = z.object({
  title: goalTitle(),
  description: z
    .string()
    .trim()
    .max(2000, "Keep the description under 2000 characters.")
    .optional(),
});

export const GUEST_GOAL_LIMIT = "Sign up free to save your progress and add more goals.";

export const GUEST_SOURCE_LIMIT = "Sign up free to add more sources.";

export function dbErrorToMessage(err: { message: string }): string {
  const m = err.message ?? "";
  // Guest errors first: "guest_x_limit_reached" also contains "x_limit_reached".
  if (m.includes("guest_goal_limit_reached")) return GUEST_GOAL_LIMIT;
  if (m.includes("guest_source_limit_reached")) return GUEST_SOURCE_LIMIT;
  if (m.includes("source_attempt_limit_reached"))
    return "You've tried adding sources too many times today. Try again tomorrow.";
  if (m.includes("source_limit_reached")) return "You've reached today's limit for new sources. Try again tomorrow.";
  if (m.includes("goal_not_ready")) return "Wait for your topic map to finish before adding sources.";
  if (m.includes("goal_archived")) return "Unarchive this goal to add sources.";
  if (m.includes("invalid_source")) return "That link or file can't be added.";
  if (m.includes("goal_limit_reached")) return "Free plan allows 2 active goals. Archive one to add another.";
  if (m.includes("not_clarifying") || m.includes("not_failed") || m.includes("goal_not_awaiting_expand"))
    return "This goal's topic map has already moved on. Refresh the page.";
  if (m.includes("invalid_answer")) return "Please write an answer of up to 1000 characters.";
  if (m.includes("too_many_links")) return TOO_MANY_LINKS;
  return GENERIC_ERROR;
}

export const MAP_STATUS_TEXT: Record<string, string> = {
  pending: "Building your topic map",
  clarifying: "Waiting for your answer",
  ready: "Ready",
  failed: "Couldn't build",
};
