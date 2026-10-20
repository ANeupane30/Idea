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
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
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
    render(<QuizRunner goalId="g" subtopicId="t" mode="subtopic" title="Joins quiz" overview={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Question 1 of 5")).toBeTruthy();
    expect(actions.startQuiz).toHaveBeenCalledTimes(2);
    expect(actions.retryQuizBank).not.toHaveBeenCalled();
  });

  it("shows the limit when nothing is left to serve", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion.mockResolvedValue({ ok: true, data: { limit: "guest_quiz_limit" } });
    render(<QuizRunner goalId="g" subtopicId="t" mode="subtopic" title="Joins quiz" overview={null} />);
    expect(await screen.findByText("Sign up free")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows no-sources for a bank that failed for lack of sources", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion.mockResolvedValue({
      ok: true,
      data: { failed: true, error: "no_sources", subtopic_id: "t" },
    });
    render(<QuizRunner goalId="g" subtopicId="t" mode="subtopic" title="Joins quiz" overview={null} />);
    expect(await screen.findByText("Add a source that covers this topic to get questions.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("retries the failed topic's bank in a review quiz", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion
      .mockResolvedValueOnce({ ok: true, data: { failed: true, error: "failed", subtopic_id: "topic-7" } })
      .mockResolvedValue({ ok: true, data: { ...QUESTION, total: 10 } });
    actions.retryQuizBank.mockResolvedValue({ ok: true, data: null });
    render(<QuizRunner goalId="g" subtopicId={null} mode="review" title="Review quiz" overview={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Question 1 of 10")).toBeTruthy();
    expect(actions.retryQuizBank).toHaveBeenCalledWith("topic-7");
  });

  it("marks a wrong answer and explains the right one", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion.mockResolvedValue({ ok: true, data: QUESTION });
    actions.answerQuestion.mockResolvedValue({
      ok: true,
      data: { correct: false, correct_index: 0, explanation: "Because.", citations: [], mastery: { score: 0.2, label: "weak" } },
    });
    render(<QuizRunner goalId="g" subtopicId="t" mode="subtopic" title="Joins quiz" overview={null} />);
    const bar = await screen.findByRole("progressbar", { name: "Quiz progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
    fireEvent.click(screen.getByRole("radio", { name: "b" }));
    fireEvent.click(screen.getByRole("button", { name: "Check answer" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "You chose B. Not quite. The correct answer is A: a.",
    );
    // The answer state is part of each option's description, not only colour and hidden badges.
    expect(screen.getByRole("radio", { name: "a" }).getAttribute("aria-describedby")).toBeTruthy();
    const describe = (name: string) =>
      document.getElementById(screen.getByRole("radio", { name }).getAttribute("aria-describedby")!)!.textContent;
    expect(describe("a")).toBe("Correct answer");
    expect(describe("b")).toBe("Not quite · your answer");
    expect(screen.getByRole("heading", { name: "Why A is right" })).toBeTruthy();
    expect(screen.getByText("Not quite · your answer")).toBeTruthy();
    expect(screen.getByText("Correct answer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review in lesson" }).getAttribute("href")).toBe("/goals/g/topics/t");
  });

  it("shows the score and refreshes the overview when done", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion.mockResolvedValue({ ok: true, data: { done: true } });
    actions.finishQuiz.mockResolvedValue({
      ok: true,
      data: { topics: [{ subtopic_id: "t", title: "Joins", correct: 4, total: 5, score: 0.8, label: "strong" }], wrong: [] },
    });
    render(<QuizRunner goalId="g" subtopicId="t" mode="subtopic" title="Joins quiz" overview={<p>overview</p>} />);
    expect(await screen.findByRole("heading", { name: "4 of 5" })).toBeTruthy();
    expect(screen.getByText("Nice work. Joins is now Strong.")).toBeTruthy();
    expect(screen.getByText("overview")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("starts a new review quiz from the review results", async () => {
    actions.startQuiz.mockResolvedValue({ ok: true, data: { quiz_id: "z1", preparing: false } });
    actions.nextQuestion
      .mockResolvedValueOnce({ ok: true, data: { done: true } })
      .mockResolvedValue({ ok: true, data: { ...QUESTION, total: 10 } });
    actions.finishQuiz.mockResolvedValue({
      ok: true,
      data: { topics: [{ subtopic_id: "t", title: "Joins", correct: 9, total: 10, score: 0.9, label: "strong" }], wrong: [] },
    });
    render(<QuizRunner goalId="g" subtopicId={null} mode="review" title="Review quiz" overview={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start review quiz" }));
    expect(await screen.findByText("Question 1 of 10")).toBeTruthy();
    expect(actions.startQuiz).toHaveBeenCalledTimes(2);
  });
});
