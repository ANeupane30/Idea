"""Dead ends found by the final review of the sources-first branch."""

import json

from test_find_sources import Tavily, Wiki, hit
from test_goal_ready import LONG, early_source, found_source, goal, jobs_for, reading_goal, run_direct, source
from test_ingest_handler import BAKING, Site, handler, job
from test_prep_check import check, offtopic_page

from worker.config import Settings
from worker.discovery.wikipedia import WikiHit
from worker.goal_ready import finish_reading, search_again_or_fall_back, sweep
from worker.jobs import Job
from worker.prep.find import FindSourcesHandler
from worker.prep.understand import _move_on


def find(db, gid, tavily=None, wiki=None):
    s = Settings(_env_file=None, tavily_api_key="k")
    FindSourcesHandler(s, tavily_search=tavily or Tavily([hit("http://127.0.0.1/a.html", 0.9),
                                                          hit("http://127.0.0.2/b.html", 0.8)]),
                       wiki_search=wiki or Wiki([])).run(
        db, Job(id=gid, kind="find_sources", payload={"goal_id": str(gid)}, attempts=1, step=None))


def decide(db, uid, gid, choice):
    db.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid)}),))
    db.execute("select public.answer_source_decision(%s, %s)", (gid, choice))
    db.execute("delete from jobs where payload->>'goal_id' = %s", (str(gid),))


def test_find_after_a_rejected_own_source_builds_the_map(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    own = early_source(db, uid, gid, "http://127.0.0.1/off.html")
    run_direct(db, handler(Site(offtopic_page())), own)
    check(db, gid)
    assert goal(db, gid)["map_status"] == "awaiting_source_decision"

    decide(db, uid, gid, "find")
    s = source(db, own)
    assert s["status"] == "ready" and s["vetted"] is False  # shown as "Not used"
    find(db, gid)
    for r in db.execute("select id from sources where goal_id = %s and origin = 'auto'", (gid,)).fetchall():
        run_direct(db, handler(Site(LONG)), r["id"])
    check(db, gid)
    assert goal(db, gid)["map_status"] == "building_map"


def test_find_after_unreadable_own_sources_falls_back_instead_of_asking_again(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    own = early_source(db, uid, gid, "http://127.0.0.1/wall.html")
    db.execute("update sources set status = 'failed', error = 'x' where id = %s", (own,))
    with db.transaction():
        finish_reading(db, gid)
    decide(db, uid, gid, "find")
    find(db, gid, tavily=Tavily([hit("http://127.0.0.1/a.html", 0.9)]))
    a = db.execute("select id from sources where goal_id = %s and origin = 'auto'", (gid,)).fetchone()["id"]
    db.execute("update sources set status = 'failed', error = 'x' where id = %s", (a,))
    with db.transaction():
        finish_reading(db, gid)
    assert goal(db, gid)["map_status"] != "awaiting_source_decision"


def test_a_weak_auto_source_matched_last_still_moves_the_goal_on(db, make_user, make_ready_goal):
    uid = make_user()
    gid = make_ready_goal(uid)
    db.execute("update goals set map_status = 'matching_sources', gap_deadline = null,"
               " prep_started_at = now() - interval '10 minutes' where id = %s", (gid,))
    sid = found_source(db, uid, gid, "http://127.0.0.1/bread.html")
    db.execute("update sources set vetted = true where id = %s", (sid,))
    handler(site=Site(BAKING)).run(db, job(sid))
    assert source(db, sid) is None
    assert goal(db, gid)["map_status"] == "ready"


def test_sweep_moves_on_a_matching_goal_with_nothing_in_flight(db, make_user, make_ready_goal):
    uid = make_user()
    gid = make_ready_goal(uid)
    db.execute("update goals set map_status = 'matching_sources', gap_deadline = null,"
               " prep_started_at = now() - interval '10 minutes' where id = %s", (gid,))
    sweep(db)
    assert goal(db, gid)["map_status"] == "ready"


def test_a_new_reading_phase_gets_its_own_timer(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid, minutes_ago=6)
    own = early_source(db, uid, gid, "http://127.0.0.1/slow.html")
    db.execute("update sources set status = 'failed', error = 'x' where id = %s", (own,))
    with db.transaction():
        finish_reading(db, gid)
    decide(db, uid, gid, "find")
    find(db, gid)
    assert goal(db, gid)["map_status"] == "reading_sources"
    sweep(db)  # the candidates are still queued
    assert goal(db, gid)["map_status"] == "reading_sources"


def test_an_own_link_failing_during_understanding_still_asks_the_learner(db, make_user, make_goal):
    uid = make_user()
    gid = make_goal(db, uid, map_status="understanding")
    db.execute("delete from jobs where payload->>'goal_id' = %s", (str(gid),))
    own = early_source(db, uid, gid, "http://127.0.0.1/wall.html")
    db.execute("update sources set status = 'failed', error = 'paywall' where id = %s", (own,))
    with db.transaction():
        _move_on(db, gid, "i", "s", ["q"])
    assert goal(db, gid)["map_status"] == "awaiting_source_decision"


def test_no_new_candidates_goes_straight_on_to_the_check(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    kept = found_source(db, uid, gid, "http://127.0.0.1/a.html")
    run_direct(db, handler(Site(LONG)), kept)
    db.execute("update sources set vetted = true where id = %s", (kept,))
    db.execute("update goals set map_status = 'finding_sources' where id = %s", (gid,))
    find(db, gid, tavily=Tavily([hit("http://127.0.0.1/a.html", 0.9)]))
    assert goal(db, gid)["map_status"] == "checking_sources"


def test_too_few_passing_tries_wikipedia(db, make_user, make_goal):
    """Spec §8: when too few found sources pass, the fallback is Wikipedia."""
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    with db.transaction():
        search_again_or_fall_back(db, gid)
    assert goal(db, gid)["search_round"] == 1 and len(jobs_for(db, "find_sources", gid)) == 1
    tav, wiki = Tavily(), Wiki([WikiHit("SQL join", 900, False)])
    find(db, gid, tavily=tav, wiki=wiki)
    assert tav.calls == [] and wiki.queries == ["SQL joins"]
    assert goal(db, gid)["map_status"] == "reading_sources"
