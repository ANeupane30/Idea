from test_lesson_generator import ARTICLE, ready_topic
from worker import jobs
from worker.config import Settings
from worker.ingest.embed import FakeEmbedder
from worker.jobs import Job
from worker.llm import DEFAULT_FIXTURES_DIR, FakeLLM, LLMResult
from worker.quiz.handler import PER_DIFFICULTY, QuizBankHandler
from worker.quiz.questions import QuestionSet


class SpyLLM:
    """FakeLLM whose question sets can be poisoned: bad[i] stems in call i get 'BAD' (fails validation)."""

    def __init__(self, bad=(0, 0)):
        self.fake = FakeLLM(DEFAULT_FIXTURES_DIR)
        self.bad = list(bad)
        self.sets = 0

    def parse(self, *, model, system, user, schema, max_tokens=16000):
        result = self.fake.parse(model=model, system=system, user=user, schema=schema, max_tokens=max_tokens)
        if schema is QuestionSet:
            n = self.bad[self.sets] if self.sets < len(self.bad) else 0
            self.sets += 1
            for q in result.output.questions[:n]:
                q.stem = "BAD " + q.stem
            return LLMResult(result.output, result.input_tokens, result.output_tokens, model)
        return result


def handler(llm=None):
    return QuizBankHandler(llm or FakeLLM(DEFAULT_FIXTURES_DIR), FakeEmbedder())


def queue(db, uid, tid, difficulty=None):
    db.execute("delete from jobs where status = 'queued'")
    db.execute(
        "insert into quiz_banks (subtopic_id, user_id) values (%s, %s) on conflict do nothing", (tid, uid)
    )
    return db.execute(
        "insert into jobs (kind, payload) values ('quiz_bank', jsonb_build_object('subtopic_id', %s::text,"
        " 'user_id', %s::text, 'difficulty', %s::int)) returning id",
        (str(tid), str(uid), difficulty),
    ).fetchone()["id"]


def job(jid, uid, tid, difficulty=None) -> Job:
    payload = {"subtopic_id": str(tid), "user_id": str(uid), "difficulty": difficulty}
    return Job(id=jid, kind="quiz_bank", payload=payload, attempts=1, step=None)


def questions(db, tid, status="active"):
    return db.execute(
        "select * from quiz_questions where subtopic_id = %s and status = %s order by difficulty, created_at", (tid, status)
    ).fetchall()


def bank(db, tid):
    return db.execute("select * from quiz_banks where subtopic_id = %s", (tid,)).fetchone()


def test_initial_bank(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    jid = queue(db, uid, tid)
    handler().run(db, job(jid, uid, tid))
    qs = questions(db, tid)
    assert PER_DIFFICULTY == 6
    assert [sum(1 for q in qs if q["difficulty"] == d) for d in (1, 2, 3)] == [6, 6, 6]
    assert all(q["citations"][0]["href"].startswith(ARTICLE) for q in qs)
    assert all(len(q["source_chunk_ids"]) == 1 for q in qs)
    assert bank(db, tid)["status"] == "ready"
    kinds = {r["kind"] for r in db.execute("select kind from usage_events where user_id = %s", (uid,)).fetchall()}
    assert {"quiz_gen", "validate"} <= kinds


def test_top_up_one_difficulty(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    handler().run(db, job(queue(db, uid, tid), uid, tid))
    handler().run(db, job(queue(db, uid, tid, 2), uid, tid, 2))
    qs = questions(db, tid)
    assert [sum(1 for q in qs if q["difficulty"] == d) for d in (1, 2, 3)] == [6, 12, 6]


def test_failed_validation_regenerates_then_rejects(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    llm = SpyLLM(bad=(2, 1))
    handler(llm).run(db, job(queue(db, uid, tid), uid, tid))
    assert llm.sets == 2  # one regeneration, for the 2 failures only
    assert len(questions(db, tid)) == 17
    rejected = questions(db, tid, "rejected")
    assert len(rejected) == 1 and rejected[0]["stem"].startswith("BAD")


def test_all_rejected_marks_failed(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    queue(db, uid, tid)
    assert jobs.run_once(db, {"quiz_bank": handler(SpyLLM(bad=(18, 18)))}) is True
    b = bank(db, tid)
    assert (b["status"], b["error"]) == ("failed", "failed")
    assert questions(db, tid) == []


def test_no_sources(db, make_user, make_ready_goal, make_source):
    uid, gid, _ = ready_topic(db, make_user, make_ready_goal, make_source)
    tid = db.execute(
        "select id from subtopics where goal_id = %s and title = 'Indexes and query performance'", (gid,)
    ).fetchone()["id"]
    queue(db, uid, tid)
    jobs.run_once(db, {"quiz_bank": handler()})
    b = bank(db, tid)
    assert (b["status"], b["error"]) == ("failed", "no_sources")


def test_other_users_topic_is_ignored(db, make_user, make_ready_goal, make_source):
    _, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    stranger = make_user()
    handler().run(db, job(None, stranger, tid))
    assert questions(db, tid) == []


def test_main_registers_quiz_bank():
    from worker import __main__ as main_mod

    handlers = main_mod.build_handlers(Settings(llm_provider="fake", embedder="fake", supabase_secret_key="key"))
    assert "quiz_bank" in handlers


def test_failed_top_up_keeps_a_working_bank_ready(db, make_user, make_ready_goal, make_source):
    from worker.llm import LLMRefusal

    class Refuses(SpyLLM):
        def parse(self, *, model, system, user, schema, max_tokens=16000):
            if schema is QuestionSet:
                raise LLMRefusal("refused", 10, 0, model)
            return super().parse(model=model, system=system, user=user, schema=schema, max_tokens=max_tokens)

    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    handler().run(db, job(queue(db, uid, tid), uid, tid))
    # A top-up that fails permanently (here: the model refuses)...
    queue(db, uid, tid, 2)
    jobs.run_once(db, {"quiz_bank": handler(Refuses())})
    # ...leaves the 18 working questions in a ready bank, so top-ups can be queued again.
    assert bank(db, tid)["status"] == "ready"
    assert len(questions(db, tid)) == 18
