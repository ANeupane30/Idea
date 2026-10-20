"use server";

import { createClient } from "@/lib/supabase/server";
import {
  mapQuizError,
  type AnswerResult,
  type NextQuestion,
  type QuizResult,
  type QuizSummary,
} from "@/lib/quiz";

/** Calls a quiz RPC as the signed-in user (guests included); errors become quiz codes. */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<QuizResult<T>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, code: mapQuizError(error.message) };
  return { ok: true, data: data as T };
}

export async function startQuiz(goalId: string, subtopicId: string | null) {
  return rpc<{ quiz_id: string; preparing: boolean }>("start_quiz", {
    p_goal_id: goalId,
    ...(subtopicId ? { p_subtopic_id: subtopicId } : {}),
  });
}

export async function nextQuestion(quizId: string) {
  return rpc<NextQuestion>("next_question", { p_quiz_id: quizId });
}

export async function answerQuestion(quizId: string, questionId: string, chosen: number) {
  return rpc<AnswerResult>("answer_question", { p_quiz_id: quizId, p_question_id: questionId, p_chosen: chosen });
}

export async function flagQuestion(questionId: string) {
  return rpc<null>("flag_question", { p_question_id: questionId });
}

export async function finishQuiz(quizId: string) {
  return rpc<QuizSummary>("finish_quiz", { p_quiz_id: quizId });
}

export async function retryQuizBank(subtopicId: string) {
  return rpc<null>("retry_quiz_bank", { p_subtopic_id: subtopicId });
}
