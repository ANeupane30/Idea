export type MasteryLabel = "strong" | "developing" | "weak";

export const LABEL_TEXT: Record<MasteryLabel, string> = { strong: "Strong", developing: "Developing", weak: "Weak" };

export const QUIZ_ERROR_TEXT: Record<string, string> = {
  no_sources: "Add a source that covers this topic to get questions.",
  exhausted: "You've seen all the questions for now. New ones are on the way. Try again in a minute.",
  quiz_limit: "You've reached today's limit for new questions. Try again tomorrow.",
  guest_quiz_limit: "Sign up free to get more questions.",
  nothing_to_review: "Take a topic quiz first, then come back for a review.",
  failed: "We couldn't prepare questions for this topic. Please try again.",
};

/** Database error message -> quiz error code. Guest codes first ("guest_x" contains "x"). */
export function mapQuizError(message: string): string {
  if (message.includes("guest_quiz_limit_reached")) return "guest_quiz_limit";
  if (message.includes("quiz_limit_reached")) return "quiz_limit";
  if (message.includes("nothing_to_review")) return "nothing_to_review";
  if (message.includes("no_sources")) return "no_sources";
  return "failed";
}

export type QuizResult<T> = { ok: true; data: T } | { ok: false; code: string };

export type Citation = { n: number; title: string; type: string; href: string | null; label: string };

export type QuizQuestion = {
  question_id: string;
  number: number;
  total: number;
  stem: string;
  options: string[];
  difficulty: number;
  subtopic_title: string;
};

export type NextQuestion =
  | QuizQuestion
  | { done: true }
  | { preparing: true }
  | { failed: true; error: string; subtopic_id: string }
  | { limit: "quiz_limit" | "guest_quiz_limit" }
  | { exhausted: true };

export type AnswerResult = {
  correct: boolean;
  correct_index: number;
  explanation: string;
  citations: Citation[];
  mastery: { score: number; label: MasteryLabel };
};

export type QuizSummary = {
  topics: { subtopic_id: string; title: string; correct: number; total: number; score: number; label: MasteryLabel }[];
  wrong: { subtopic_id: string; stem: string; correct_option: string; explanation: string; citations: Citation[] }[];
};
