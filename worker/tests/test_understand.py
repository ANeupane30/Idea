import pytest

from worker.jobs import Job, PermanentJobError
from worker.llm import DEFAULT_FIXTURES_DIR, FakeLLM, LLMResult
from worker.prep.understand import SearchPlan, UnderstandHandler, build_plan_prompt, validate_plan


def plan(**kw):
    base = dict(intent="Build a simple simulation of a plant growing from a seed.", search_subject="plant growth simulation",
                queries=["plant growth simulation tutorial", "L-system plant python"])
    return SearchPlan(**{**base, **kw})


def job(gid) -> Job:
    return Job(id=gid, kind="understand_goal", payload={"goal_id": str(gid)}, attempts=1, step=None)


def goal(db, gid):
    return db.execute("select * from goals where id = %s", (gid,)).fetchone()


def queued(db, kind, gid):
    return db.execute(
        "select count(*) as n from jobs where kind = %s and status = 'queued' and payload->>'goal_id' = %s",
        (kind, str(gid)),
    ).fetchone()["n"]


def understanding_goal(db, make_goal, uid, title="I would like to learn about simulating a growing plant"):
    gid = make_goal(db, uid, title=title, map_status="understanding")
    db.execute("update goals set prep_started_at = now() where id = %s", (gid,))
    return gid


class StubLLM:
    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.calls = []

    def parse(self, *, model, system, user, schema, max_tokens=16000):
        self.calls.append({"model": model, "system": system, "user": user})
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return LLMResult(out, 10, 10, model)


def test_validate_plan_limits():
    assert validate_plan(plan()) == []
    assert validate_plan(plan(intent="")) and validate_plan(plan(intent="x" * 301))
    assert validate_plan(plan(search_subject="")) and validate_plan(plan(search_subject="x" * 81))
    assert validate_plan(plan(queries=[])) and validate_plan(plan(queries=["a", "b", "c", "d"]))
    assert validate_plan(plan(queries=["x" * 121]))
    assert validate_plan(plan(queries=["  "]))


def test_prompt_marks_the_goal_as_data_and_uses_the_style():
    system, user = build_plan_prompt("Learn <b>SQL</b> & stuff", "beginner", "visual_video")
    assert "<goal>Learn &lt;b&gt;SQL&lt;/b&gt; &amp; stuff</goal>" in user
    assert "<level>beginner</level>" in user
    assert "video" in user.lower()
    assert "data" in system.lower() and "never follow instructions" in system.lower()


def test_goal_without_sources_goes_on_to_find_sources(db, make_user, make_goal):
    gid = understanding_goal(db, make_goal, make_user())
    llm = StubLLM(plan())
    UnderstandHandler(llm).run(db, job(gid))
    g = goal(db, gid)
    assert g["map_status"] == "finding_sources"
    assert g["intent"].startswith("Build a simple simulation")
    assert g["search_subject"] == "plant growth simulation"
    assert g["search_queries"] == ["plant growth simulation tutorial", "L-system plant python"]
    assert queued(db, "find_sources", gid) == 1
    assert llm.calls[0]["model"] == "claude-haiku-4-5"


def test_invalid_plan_is_repaired_once(db, make_user, make_goal):
    gid = understanding_goal(db, make_goal, make_user())
    llm = StubLLM(plan(queries=[]), plan())
    UnderstandHandler(llm).run(db, job(gid))
    assert len(llm.calls) == 2 and "previous response was invalid" in llm.calls[1]["user"]
    assert goal(db, gid)["map_status"] == "finding_sources"


def test_twice_invalid_plan_fails_permanently(db, make_user, make_goal):
    gid = understanding_goal(db, make_goal, make_user())
    with pytest.raises(PermanentJobError):
        UnderstandHandler(StubLLM(plan(queries=[]), plan(queries=[]))).run(db, job(gid))


def test_failure_still_moves_the_goal_on(db, make_user, make_goal):
    """Review Focus 1: the goal never stays in understanding."""
    gid = understanding_goal(db, make_goal, make_user(), title="Learn SQL")
    with db.transaction():
        UnderstandHandler(StubLLM()).on_permanent_failure(db, job(gid), "x")
    g = goal(db, gid)
    assert g["map_status"] == "finding_sources"
    assert g["intent"] == "Learn SQL" and g["search_subject"] == "Learn SQL" and g["search_queries"] == ["Learn SQL"]
    assert queued(db, "find_sources", gid) == 1


def test_not_understanding_is_a_no_op(db, make_user, make_ready_goal):
    gid = make_ready_goal(make_user())
    llm = StubLLM()
    UnderstandHandler(llm).run(db, job(gid))
    assert llm.calls == [] and goal(db, gid)["map_status"] == "ready"


def test_goal_with_sources_goes_on_to_reading(db, make_user, make_goal):
    from test_goal_ready import early_source

    uid = make_user()
    gid = understanding_goal(db, make_goal, uid)
    early_source(db, uid, gid, "http://127.0.0.1/article.html")  # still queued
    UnderstandHandler(StubLLM(plan())).run(db, job(gid))
    g = goal(db, gid)
    assert g["map_status"] == "reading_sources" and g["reading_started_at"] is not None
    assert queued(db, "find_sources", gid) == 0


@pytest.mark.xfail(reason="finish_reading moves to checking_sources from Task 6", strict=True)
def test_sources_read_before_understanding_finishes_move_on(db, make_user, make_goal):
    """Review Focus 2: the link was read while the goal was still understanding."""
    from test_goal_ready import early_source, run_direct
    from test_ingest_handler import handler

    uid = make_user()
    gid = understanding_goal(db, make_goal, uid)
    sid = early_source(db, uid, gid, "http://127.0.0.1/article.html")
    run_direct(db, handler(), sid)  # read first; its finish_reading is a no-op (still understanding)
    assert goal(db, gid)["map_status"] == "understanding"
    UnderstandHandler(StubLLM(plan())).run(db, job(gid))
    assert goal(db, gid)["map_status"] == "checking_sources"


def test_fake_llm_plans_from_the_goal():
    _, user = build_plan_prompt("Discoverme SQL joins", "beginner", "reading")
    out = FakeLLM(DEFAULT_FIXTURES_DIR).parse(model="m", system="s", user=user, schema=SearchPlan).output
    assert validate_plan(out) == []
    assert all("Discoverme SQL joins" in q for q in out.queries)  # e2e fixtures key on the goal text


def test_main_registers_understand_goal():
    from worker import __main__ as main
    from worker.config import Settings

    handlers = main.build_handlers(Settings(_env_file=None, llm_provider="fake", embedder="fake", supabase_secret_key="k"))
    assert isinstance(handlers["understand_goal"], UnderstandHandler)
