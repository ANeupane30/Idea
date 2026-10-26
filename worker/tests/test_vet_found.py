"""Found pages are checked from the text the search returned, while they're being read, so the
check after reading has little or nothing left to do (time to map, target 30 s)."""

from test_find_sources import Tavily, finding, handler as find_handler, hit, job as find_job  # noqa: F401
from test_goal_ready import LONG, goal, jobs_for, run_direct, source
from test_ingest_handler import Site, handler
from test_prefetched import MARKDOWN
from test_prep_check import check_job

from worker.jobs import Job
from worker.llm import DEFAULT_FIXTURES_DIR, FakeLLM
from worker.prep.check import CheckSourcesHandler, VetFoundHandler

OFFTOPIC = MARKDOWN.replace("# Growing plants in code", "# An offtopic page about cooking")


def vet_job(gid) -> Job:
    return Job(id=gid, kind="vet_found", payload={"goal_id": str(gid)}, attempts=1, step=None)


class NoCheckLLM(FakeLLM):
    def parse(self, *, schema, **kw):
        assert schema.__name__ != "VerdictBatch", "sources were already checked"
        return super().parse(schema=schema, **kw)


def found(db, gid):
    return {r["url_or_file"]: r["id"] for r in db.execute(
        "select id, url_or_file from sources where goal_id = %s", (gid,)).fetchall()}


def test_finding_pages_with_text_queues_their_check(db, finding):
    _, gid = finding
    find_handler(tavily=Tavily([hit("https://a.example/x", 0.9, raw=MARKDOWN)])).run(db, find_job(gid))
    assert len(jobs_for(db, "vet_found", gid)) == 1


def test_found_pages_are_checked_while_they_are_read(db, finding):
    _, gid = finding
    find_handler(tavily=Tavily([hit("https://a.example/x", 0.9, raw=MARKDOWN),
                                hit("https://b.example/y", 0.8, raw=OFFTOPIC),
                                hit("https://c.example/z", 0.7)])).run(db, find_job(gid))
    ids = found(db, gid)
    VetFoundHandler(FakeLLM(DEFAULT_FIXTURES_DIR)).run(db, vet_job(gid))
    assert source(db, ids["https://a.example/x"])["vetted"] is True
    assert source(db, ids["https://b.example/y"]) is None  # off topic: gone
    assert source(db, ids["https://c.example/z"])["vetted"] is None  # no text: checked after reading
    assert goal(db, gid)["map_status"] == "reading_sources"


def test_the_check_after_reading_skips_what_was_checked(db, finding):
    _, gid = finding
    find_handler(tavily=Tavily([hit("http://127.0.0.1/a.html", 0.9, raw=MARKDOWN),
                                hit("http://127.0.0.2/b.html", 0.8, raw=MARKDOWN)])).run(db, find_job(gid))
    VetFoundHandler(FakeLLM(DEFAULT_FIXTURES_DIR)).run(db, vet_job(gid))
    for sid in found(db, gid).values():
        run_direct(db, handler(Site(LONG)), sid)
    assert goal(db, gid)["map_status"] == "checking_sources"
    CheckSourcesHandler(NoCheckLLM(DEFAULT_FIXTURES_DIR)).run(db, check_job(gid))
    assert goal(db, gid)["map_status"] == "building_map"


def test_deleting_the_last_page_in_flight_moves_the_goal_on(db, finding):
    _, gid = finding
    find_handler(tavily=Tavily([hit("http://127.0.0.1/a.html", 0.9, raw=MARKDOWN),
                                hit("http://127.0.0.2/b.html", 0.8, raw=OFFTOPIC)])).run(db, find_job(gid))
    ids = found(db, gid)
    run_direct(db, handler(Site(LONG)), ids["http://127.0.0.1/a.html"])  # one read, one still queued
    VetFoundHandler(FakeLLM(DEFAULT_FIXTURES_DIR)).run(db, vet_job(gid))
    assert goal(db, gid)["map_status"] == "checking_sources"
