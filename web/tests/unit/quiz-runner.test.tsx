// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  startQuiz: vi.fn(),
  nextQuestion: vi.fn(),
  answerQuestion: vi.fn(),
  flagQuestion: vi.fn(),
  finishQuiz: vi.fn(),
  retryQuizBank: vi.fn(),
}));
vi.mock("@/app/goals/[id]/quiz-actions", () => actions);
vi.mock("next/link", () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));

import { QuizRunner } from "@/components/quiz-runner";

const QUESTION = {
  question_id: "q1",
  number: 1,
  total: 5,
  stem: "What does a join do?",
  options: ["a", "b", "c", "d"],
  difficulty: 1,
  subtopic_title: "Joins",
};

beforeEach(() => Object.values(actions).forEach((f) => f.mockReset()));
afterEach(cleanup);

describe("QuizRunner", () => {
  it("starts the quiz again when the first start failed", async () => {
    actions.startQuiz
      .mockResolvedValueOnce({ ok: false, code: "failed" })
      .mockResolvedValueOnce({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion.mockResolvedValue({ ok: true, data: QUESTION });
    render(<QuizRunner goalId="g" subtopicId="t" mode="subtopic" />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Question 1 of 5")).toBeTruthy();
    expect(actions.startQuiz).toHaveBeenCalledTimes(2);
    expect(actions.retryQuizBank).not.toHaveBeenCalled();
  });

  it("shows the limit when nothing is left to serve", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion.mockResolvedValue({ ok: true, data: { limit: "guest_quiz_limit" } });
    render(<QuizRunner goalId="g" subtopicId="t" mode="subtopic" />);
    expect(await screen.findByText("Sign up free")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows no-sources for a bank that failed for lack of sources", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion.mockResolvedValue({
      ok: true,
      data: { failed: true, error: "no_sources", subtopic_id: "t" },
    });
    render(<QuizRunner goalId="g" subtopicId="t" mode="subtopic" />);
    expect(await screen.findByText("Add a source that covers this topic to get questions.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("retries the failed topic's bank in a review quiz", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion
      .mockResolvedValueOnce({ ok: true, data: { failed: true, error: "failed", subtopic_id: "topic-7" } })
      .mockResolvedValue({ ok: true, data: { ...QUESTION, total: 10 } });
    actions.retryQuizBank.mockResolvedValue({ ok: true, data: null });
    render(<QuizRunner goalId="g" subtopicId={null} mode="review" />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Question 1 of 10")).toBeTruthy();
    expect(actions.retryQuizBank).toHaveBeenCalledWith("topic-7");
  });
});
