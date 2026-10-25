import { describe, expect, it } from "vitest";
import { LABEL_TEXT, mapQuizError, QUIZ_ERROR_TEXT } from "@/lib/quiz";

describe("quiz copy and errors", () => {
  it("has the exact copy for every code", () => {
    expect(QUIZ_ERROR_TEXT).toEqual({
      no_sources: "Add a source that covers this topic to get questions.",
      exhausted: "You've seen all the questions for now. New ones are on the way. Try again in a minute.",
      quiz_limit: "You've reached today's limit for new questions. Try again tomorrow.",
      guest_quiz_limit: "Sign up free to get more questions.",
      nothing_to_review: "Take a topic quiz first, then come back for a review.",
      failed: "We couldn't prepare questions for this topic. Please try again.",
      busy: "Our AI is busy right now. Try again later.",
    });
    expect(LABEL_TEXT).toEqual({ strong: "Strong", developing: "Developing", weak: "Weak" });
  });

  it("maps database errors to codes", () => {
    expect(mapQuizError("guest_quiz_limit_reached")).toBe("guest_quiz_limit");
    expect(mapQuizError("quiz_limit_reached")).toBe("quiz_limit");
    expect(mapQuizError("nothing_to_review")).toBe("nothing_to_review");
    expect(mapQuizError("no_sources")).toBe("no_sources");
    expect(mapQuizError("not_current_question")).toBe("failed");
    expect(mapQuizError("something else")).toBe("failed");
  });
});
