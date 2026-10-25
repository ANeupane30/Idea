import time

import pytest
from test_goal_ready import LONG, early_source, goal, queued_jobs, run_direct, source
from test_ingest_handler import BAKING, Site, handler, job

from worker.config import Settings
from worker.discovery.gaps import FillGapsHandler, gap_queries
from worker.discovery.tavily import QuotaExhausted, TavilyHit
from worker.discovery.wikipedia import WikiHit
from worker.goal_ready import finish_matching, sweep_matching_deadlines
from worker.jobs import Job


def test_gap_queries_follow_the_time_budget():
    assert gap_queries(remaining_s=200, uncovered=6) == 4
    assert gap_queries(remaining_s=60, uncovered=6) == 4
    assert gap_queries(remaining_s=59, uncovered=6) == 2
    assert gap_queries(remaining_s=20, uncovered=6) == 2
    assert gap_queries(remaining_s=19, uncovered=6) == 0
    assert gap_queries(remaining_s=200, uncovered=1) == 1


@pytest.fixture
def matching(db, make_user, make_ready_goal):
    """A goal whose map was written and whose sources are all matched (none in flight)."""
    uid = make_user()
    gid = make_ready_goal(uid)
    db.execute(
        "update goals set map_status = 'matching_sources', prep_started_at = now(), search_subject = 'SQL',"
        " intent = 'Learn SQL' where id = %s", (gid,),
    )
    db.execute("delete from jobs where payload->>'goal_id' = %s", (str(gid),))
    return uid, gid


def gjob(gid, n=4):
    return Job(id=gid, kind="fill_gaps", payload={"goal_id": str(gid), "queries": n}, attempts=1, step=None)


def test_matching_with_uncovered_topics_starts_the_gap_phase(db, matching):
    _, gid = matching
    with db.transaction():
        finish_matching(db, gid)
    g = goal(db, gid)
    assert g["map_status"] == "matching_sources" and g["gap_deadline"] is not None
    (payload,) = [r["payload"] for r in queued_jobs(db, "fill_gaps", "goal_id", gid)]
    assert payload["queries"] == 4


def test_late_preparation_gets_no_gap_phase(db, matching):
    _, gid = matching
    db.execute("update goals set prep_started_at = now() - interval '290 seconds' where id = %s", (gid,))
    with db.transaction():
        finish_matching(db, gid)
    assert goal(db, gid)["map_status"] == "ready"


def test_a_covered_map_is_ready_without_gaps(db, matching):
    uid, gid = matching
    tops = db.execute("select id from subtopics where goal_id = %s and parent_id is null", (gid,)).fetchall()
    db.execute("select set_config('app.creating_goal', %s, true)", (str(gid),))
    sid = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, status) values (%s, %s, 'web', 'https://c.example/', 'ready')"
        " returning id", (uid, gid),
    ).fetchone()["id"]
    for t in tops:
        db.execute("insert into source_coverage (source_id, subtopic_id, relevance, reason) values (%s, %s, 0.9, 'r')",
                   (sid, t["id"]))
    with db.transaction():
        finish_matching(db, gid)
    assert goal(db, gid)["map_status"] == "ready"


def test_ready_after_the_gap_phase(db, matching):
    _, gid = matching
    db.execute("update goals set gap_deadline = now() + interval '45 seconds' where id = %s", (gid,))
    with db.transaction():
        finish_matching(db, gid)
    assert goal(db, gid)["map_status"] == "ready"


def test_logs_map_coverage(db, matching, caplog):
    _, gid = matching
    with caplog.at_level("INFO", logger="worker.goal_ready"):
        with db.transaction():
            finish_matching(db, gid)
    assert "map coverage: 0/6" in caplog.text


def test_sweep_makes_stalled_goals_ready(db, matching):
    """Review Focus 4: the gap job died; the deadline passes."""
    _, gid = matching
    db.execute("update goals set gap_deadline = now() - interval '1 second' where id = %s", (gid,))
    assert sweep_matching_deadlines(db) == 1
    assert goal(db, gid)["map_status"] == "ready"


# ------------------------------------------------------------ fill_gaps


class Tavily:
    def __init__(self, per_query=None, raises=None, delay=0.0):
        self.per_query, self.raises, self.delay = per_query, raises, delay
        self.queries = []

    def __call__(self, conn, queries, *, api_key, monthly_credits, url, transport=None):
        if self.raises:
            raise self.raises
        self.queries.extend(queries)
        time.sleep(self.delay)  # stands for the concurrent requests
        if self.per_query is not None:
            return [self.per_query(q) for q in queries]
        return [[TavilyHit(f"https://t{i}.example/{abs(hash(q)) % 1000}", q, 0.9, False)] for i, q in enumerate(queries)]


class Wiki:
    def __init__(self):
        self.queries = []

    def __call__(self, query, *, api_url, user_agent, transport=None):
        self.queries.append(query)
        return [WikiHit(f"{query} page", 900, False)]


def fill(db, gid, n=4, tavily=None, wiki=None, key="tvly"):
    s = Settings(_env_file=None, tavily_api_key=key, llm_provider="fake")
    FillGapsHandler(s, tavily_search=tavily or Tavily(), wiki_search=wiki or Wiki()).run(db, gjob(gid, n))


def auto_sources(db, gid):
    return db.execute(
        "select s.url_or_file, s.type, t.title as topic from sources s left join subtopics t on t.id = s.discovered_for"
        " where s.goal_id = %s and s.origin = 'auto' order by t.position", (gid,),
    ).fetchall()


def test_fill_gaps_searches_uncovered_topics_with_the_subject_and_style(db, matching):
    _, gid = matching
    tav = Tavily()
    fill(db, gid, n=2, tavily=tav)
    tops = [r["title"] for r in db.execute(
        "select title from subtopics where goal_id = %s and parent_id is null order by position", (gid,)).fetchall()]
    assert tav.queries == [f"{tops[0]} SQL tutorial", f"{tops[1]} SQL tutorial"]
    rows = auto_sources(db, gid)
    assert [r["topic"] for r in rows] == tops[:2]


def test_fill_gaps_respects_the_goal_caps(db, matching):
    uid, gid = matching
    db.execute("select set_config('app.creating_goal', %s, true)", (str(gid),))
    for i in range(3):
        db.execute(
            "insert into sources (user_id, goal_id, type, url_or_file, origin, found_for_goal, status, vetted)"
            " values (%s, %s, 'web', %s, 'auto', true, 'ready', true)", (uid, gid, f"https://found{i}.example/"),
        )
    fill(db, gid, n=4)
    assert len([r for r in auto_sources(db, gid) if r["topic"]]) == 1  # 3 found + 1 gap = 4 web pages


def test_fill_gaps_falls_back_to_wikipedia(db, matching):
    _, gid = matching
    wiki = Wiki()
    fill(db, gid, n=1, tavily=Tavily(raises=QuotaExhausted("x")), wiki=wiki)
    assert len(wiki.queries) == 1 and wiki.queries[0].endswith(" SQL")
    assert auto_sources(db, gid)[0]["url_or_file"].startswith("https://en.wikipedia.org/wiki/")


def test_fill_gaps_with_nothing_found_is_ready_at_once(db, matching):
    """Review Focus 10: no waiting for the deadline."""
    _, gid = matching
    db.execute("update goals set gap_deadline = now() + interval '45 seconds' where id = %s", (gid,))
    fill(db, gid, n=2, tavily=Tavily(per_query=lambda q: []), wiki=type("W", (), {"__call__": lambda *a, **k: []})())
    assert goal(db, gid)["map_status"] == "ready"


def test_gap_sources_failing_the_check_make_the_goal_ready(db, matching):
    """Review Focus 10: the last gap source is deleted by vetting, so the map is ready before the deadline."""
    uid, gid = matching
    db.execute("update goals set gap_deadline = now() + interval '45 seconds' where id = %s", (gid,))
    db.execute("select set_config('app.creating_goal', %s, true)", (str(gid),))
    sid = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, origin) values (%s, %s, 'web', 'http://127.0.0.1/o.html', 'auto')"
        " returning id", (uid, gid),
    ).fetchone()["id"]
    run_direct(db, handler(Site(LONG.replace("<title>Long</title>", "<title>An offtopic page</title>"))), sid)
    assert source(db, sid) is None
    assert goal(db, gid)["map_status"] == "ready"


def test_late_user_source_failing_the_check_is_not_used(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    sid = make_source(uid, gid, "http://127.0.0.1/off.html")
    handler(Site(LONG.replace("<title>Long</title>", "<title>An offtopic page</title>"))).run(db, job(sid))
    s = source(db, sid)
    assert s["status"] == "ready" and s["vetted"] is False and s["vet_reason"]
    assert db.execute("select count(*) as n from source_coverage where source_id = %s", (sid,)).fetchone()["n"] == 0


def test_use_it_anyway_matches_the_source(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    sid = make_source(uid, gid, "http://127.0.0.1/off.html")
    page = LONG.replace("<title>Long</title>", "<title>An offtopic page</title>")
    handler(Site(page)).run(db, job(sid))
    db.execute("update sources set vetted = true, status = 'queued' where id = %s", (sid,))  # use_source_anyway
    handler(Site(page)).run(db, job(sid))
    assert source(db, sid)["status"] == "ready"
    assert BAKING


def test_discover_sources_jobs_are_handled_by_fill_gaps():
    from worker import __main__ as main

    handlers = main.build_handlers(Settings(_env_file=None, llm_provider="fake", embedder="fake", supabase_secret_key="k"))
    assert isinstance(handlers["fill_gaps"], FillGapsHandler)
    assert isinstance(handlers["discover_sources"], FillGapsHandler)
