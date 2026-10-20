import uuid

from worker.lessons.content import LessonChunk
from worker.llm import DEFAULT_FIXTURES_DIR, FakeLLM, LLMRefusal, LLMResult
from worker.quiz.questions import QuestionDraft
from worker.quiz.validate import BATCH, Verdict, VerdictSet, validate_questions

CHUNKS = [LessonChunk(1, uuid.uuid4(), "Joins combine rows from related tables.", "SQL guide", "web", None, "")]


def draft(stem="What does a join do in SQL?"):
    return QuestionDraft(
        difficulty=1,
        stem=stem,
        options=["Combines rows", "Deletes rows", "Renames tables", "Creates indexes"],
        correct_index=0,
        explanation="Joins combine rows.",
        cite=[1],
    )


class SpyLLM:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.users = []

    def parse(self, *, model, system, user, schema, max_tokens=16000):
        self.users.append(user)
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return LLMResult(out, 10, 5, model)


def test_validate_marks_problems_and_bills():
    llm = SpyLLM([VerdictSet(verdicts=[Verdict(key="q1", ok=True, problem=""), Verdict(key="q2", ok=False, problem="two answers are correct")])])
    billed = []
    out = validate_questions(llm, [draft(), draft(), draft()], CHUNKS, billed.append)
    assert out == [None, "two answers are correct", "no verdict"]
    assert len(billed) == 1
    assert "<excerpt n=\"1\">" in llm.users[0]


def test_validate_batches():
    verdicts = lambda n: VerdictSet(verdicts=[Verdict(key=f"q{i + 1}", ok=True, problem="") for i in range(n)])
    llm = SpyLLM([verdicts(BATCH), verdicts(1)])
    billed = []
    assert validate_questions(llm, [draft() for _ in range(BATCH + 1)], CHUNKS, billed.append) == [None] * (BATCH + 1)
    assert len(billed) == 2 == len(llm.users)


def test_validate_refusal_fails_batch():
    llm = SpyLLM([LLMRefusal("no", 7, 1, "claude-haiku-4-5")])
    billed = []
    out = validate_questions(llm, [draft(), draft()], CHUNKS, billed.append)
    assert all(problem for problem in out)
    assert [b.input_tokens for b in billed] == [7]


def test_fake_verdicts():
    fake = FakeLLM(DEFAULT_FIXTURES_DIR)
    out = validate_questions(fake, [draft(), draft("BAD: which is right?")], CHUNKS, lambda r: None)
    assert out[0] is None and out[1]
