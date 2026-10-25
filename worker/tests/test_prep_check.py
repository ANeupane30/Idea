import threading

import psycopg
import pytest
from test_goal_ready import LONG, early_source, found_source, goal, jobs_for, reading_goal, run_direct, source
from test_ingest_handler import BAKING, Site, handler, job

from worker.config import Settings
from worker.db import connect
from worker.jobs import MAX_ATTEMPTS, Job
from worker.llm import DEFAULT_FIXTURES_DIR, FakeLLM
from worker.prep.check import CheckSourcesHandler


def check_job(gid) -> Job:
    return Job(id=gid, kind="check_sources", payload={"goal_id": str(gid)}, attempts=1, step=None)


def read(db, sid, page=LONG):
    run_direct(db, handler(Site(page)), sid)
    assert source(db, sid)["status"] == "awaiting_map"


def set_status(db, gid, status="checking_sources"):
    db.execute("update goals set map_status = %s where id = %s", (status, gid))
    db.execute("delete from jobs where payload->>'goal_id' = %s", (str(gid),))


def check(db, gid):
    CheckSourcesHandler(FakeLLM(DEFAULT_FIXTURES_DIR)).run(db, check_job(gid))


def offtopic_page(title="An offtopic page"):
    return LONG.replace("<title>Long</title>", f"<title>{title}</title>")


@pytest.fixture
def ckgoal(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    return uid, gid


def test_all_vetted_builds_the_map_with_the_best_four(db, ckgoal):
    uid, gid = ckgoal
    sids = [found_source(db, uid, gid, f"http://127.0.0.1/p{i}.html?x={i}", score=0.1 * i) for i in range(1, 7)]
    for sid in sids:
        db.execute("update goals set map_status = 'reading_sources' where id = %s", (gid,))
        read(db, sid)
    set_status(db, gid)
    check(db, gid)
    kept = db.execute("select search_score from sources where goal_id = %s order by search_score desc", (gid,)).fetchall()
    assert [round(r["search_score"], 1) for r in kept] == [0.6, 0.5, 0.4, 0.3]
    assert all(source(db, s)["vetted"] for s in sids[2:])
    assert goal(db, gid)["map_status"] == "building_map"
    assert len(jobs_for(db, "topic_map", gid)) == 1


def test_unvetted_found_source_is_deleted(db, ckgoal):
    uid, gid = ckgoal
    good = [found_source(db, uid, gid, f"http://127.0.0.1/g{i}.html?x={i}", 0.9) for i in range(2)]
    bad = found_source(db, uid, gid, "http://127.0.0.1/off.html", 0.95)
    for sid in good:
        read(db, sid)
    read(db, bad, offtopic_page())
    set_status(db, gid)
    check(db, gid)
    assert source(db, bad) is None
    assert goal(db, gid)["map_status"] == "building_map"


def test_unvetted_user_source_asks_the_learner(db, ckgoal):
    uid, gid = ckgoal
    sid = early_source(db, uid, gid, "http://127.0.0.1/off.html")
    read(db, sid, offtopic_page())
    set_status(db, gid)
    check(db, gid)
    s = source(db, sid)
    assert s["vetted"] is False and s["vet_reason"] == "This doesn't teach the goal."
    assert goal(db, gid)["map_status"] == "awaiting_source_decision"


def test_too_few_found_sources_search_again_once(db, ckgoal):
    uid, gid = ckgoal
    sid = found_source(db, uid, gid, "http://127.0.0.1/one.html")
    read(db, sid)
    set_status(db, gid)
    check(db, gid)
    g = goal(db, gid)
    assert g["map_status"] == "finding_sources" and g["search_round"] == 1
    assert len(jobs_for(db, "find_sources", gid)) == 1
    assert source(db, sid)["vetted"] is True  # kept for the map


def test_too_few_after_the_second_round_still_builds_from_what_passed(db, ckgoal):
    uid, gid = ckgoal
    db.execute("update goals set search_round = 1 where id = %s", (gid,))
    sid = found_source(db, uid, gid, "http://127.0.0.1/one.html")
    read(db, sid)
    set_status(db, gid)
    check(db, gid)
    assert goal(db, gid)["map_status"] == "building_map"


def test_nothing_passing_after_the_second_round_is_a_starting_point(db, ckgoal):
    uid, gid = ckgoal
    db.execute("update goals set search_round = 1 where id = %s", (gid,))
    bad = found_source(db, uid, gid, "http://127.0.0.1/off.html")
    read(db, bad, offtopic_page())
    set_status(db, gid)
    check(db, gid)
    g = goal(db, gid)
    assert g["map_status"] == "building_map" and g["map_note"] == "starting_point"


def test_one_vetted_user_source_is_enough(db, ckgoal):
    uid, gid = ckgoal
    sid = early_source(db, uid, gid, "http://127.0.0.1/mine.html")
    read(db, sid)
    set_status(db, gid)
    check(db, gid)
    assert goal(db, gid)["map_status"] == "building_map"


def test_not_checking_is_a_no_op(db, make_user, make_ready_goal):
    gid = make_ready_goal(make_user())
    check(db, gid)
    assert goal(db, gid)["map_status"] == "ready"


def test_two_threads_finishing_the_last_sources_queue_one_check(make_user, make_goal):
    """Review Focus 5, with real concurrent connections (committed, cleaned up after)."""
    from worker.goal_ready import finish_reading

    setup = connect(Settings())
    setup.autocommit = True
    uid = make_user(setup)
    gid = make_goal(setup, uid, map_status="reading_sources")
    try:
        barrier = threading.Barrier(2)
        results = []

        def finish():
            c = connect(Settings())
            try:
                barrier.wait()
                with c.transaction():
                    results.append(finish_reading(c, gid))
            finally:
                c.close()

        threads = [threading.Thread(target=finish) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        n = setup.execute(
            "select count(*) as n from jobs where payload->>'goal_id' = %s", (str(gid),)
        ).fetchone()["n"]
        assert sorted(results) == [False, True] and n == 1  # one acted, one job (here: search again)
    finally:
        setup.execute("delete from jobs where payload->>'goal_id' = %s", (str(gid),))
        setup.execute("delete from auth.users where id = %s", (uid,))
        setup.close()


def test_a_crashing_ingest_still_fails_the_source_and_moves_on(db, ckgoal):
    """Review Focus 8: an unexpected error on every attempt ends in a permanent failure."""
    from worker import jobs

    uid, gid = ckgoal
    sid = early_source(db, uid, gid, "http://127.0.0.1/crash.html")

    class Crashes:
        def run(self, conn, job):
            raise RuntimeError("boom")

        on_retry = handler().on_retry
        on_permanent_failure = handler().on_permanent_failure

    db.execute("delete from jobs where status = 'queued' and payload->>'source_id' is distinct from %s", (str(sid),))
    db.execute("update jobs set attempts = %s where payload->>'source_id' = %s", (MAX_ATTEMPTS - 1, str(sid)))
    assert jobs.run_once(db, {"ingest_source": Crashes()}) is True
    assert source(db, sid)["status"] == "failed"
    assert goal(db, gid)["map_status"] == "awaiting_source_decision"


def test_main_registers_check_sources():
    from worker import __main__ as main

    handlers = main.build_handlers(Settings(_env_file=None, llm_provider="fake", embedder="fake", supabase_secret_key="k"))
    assert isinstance(handlers["check_sources"], CheckSourcesHandler)
    assert BAKING and psycopg
