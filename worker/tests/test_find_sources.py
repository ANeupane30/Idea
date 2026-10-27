import pytest

from worker.config import Settings
from worker.discovery.tavily import QuotaExhausted, TavilyHit
from worker.discovery.wikipedia import WikiHit
from worker.jobs import Job
from worker.prep.find import FindSourcesHandler, pick_candidates


def hit(url, score=0.5, video=None, raw=None):
    return TavilyHit(url, url.rsplit("/", 1)[-1] or url, score,
                     video if video is not None else ("youtube" in url or "youtu.be" in url), raw)


def test_pick_candidates_caps_domains_and_videos_and_sorts():
    hits = [hit(f"https://site{i}.example/a", 0.1 * i) for i in range(1, 6)]
    hits += [hit("https://site5.example/b", 0.95)]  # a second page from one domain
    hits += [hit(f"https://www.youtube.com/watch?v=v{i}", 0.6 + i / 100) for i in range(4)]
    picked = pick_candidates(hits, style="reading")
    urls = [h.url for h in picked]
    assert urls[0] == "https://site5.example/b"  # best score first; one page per domain
    assert "https://site5.example/a" not in urls
    assert sum(h.is_video for h in picked) == 2  # a Reading learner: at most 2 videos (Review Focus 6)
    assert len(picked) <= 8
    assert [h.score for h in picked] == sorted((h.score for h in picked), reverse=True)


def test_visual_learners_may_get_three_videos():
    hits = [hit(f"https://www.youtube.com/watch?v=v{i}", 0.9 - i / 100) for i in range(5)]
    hits += [hit("https://a.example/x", 0.1)]
    assert sum(h.is_video for h in pick_candidates(hits, style="visual_video")) == 3


def test_no_videos_when_asked():
    hits = [hit(f"https://www.youtube.com/watch?v=v{i}", 0.9) for i in range(3)]
    hits += [hit("https://youtu.be/v9", 0.8), hit("https://a.example/x", 0.1)]
    assert [h.url for h in pick_candidates(hits, style="visual_video", videos=False)] == ["https://a.example/x"]


def test_tracking_parameters_fragments_and_slashes_are_one_candidate():
    """Review Focus 9."""
    hits = [
        hit("https://a.example/x?utm_source=t&utm_medium=m#intro", 0.9),
        hit("https://a.example/x/", 0.8),
        hit("https://A.example/x", 0.7),
        hit("https://b.example/", 0.6),
    ]
    picked = pick_candidates(hits, style="reading")
    assert len(picked) == 2


def test_one_copy_of_a_paper_on_two_sites():
    paper = "L-Py: An L-System Simulation Framework for Modeling Plant Architecture Development"
    hits = [
        TavilyHit("https://pmc.ncbi.nlm.nih.gov/articles/PMC1", f"{paper} - PMC", 0.9, False),
        TavilyHit("https://www.frontiersin.org/articles/1", f"Frontiers | {paper}", 0.8, False),
        TavilyHit("https://a.example/x", "Tutorial", 0.7, False),
        TavilyHit("https://b.example/y", "Tutorial", 0.6, False),  # short titles aren't compared
    ]
    assert [h.url for h in pick_candidates(hits, style="reading")] == [
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC1", "https://a.example/x", "https://b.example/y"]


def test_at_most_eight():
    hits = [hit(f"https://site{i}.example/a", 0.5) for i in range(20)]
    assert len(pick_candidates(hits, style="reading")) == 8


# ------------------------------------------------------------ the handler


class Tavily:
    def __init__(self, hits=None, raises=None):
        self.hits, self.raises = hits, raises
        self.calls = []

    def __call__(self, conn, queries, *, api_key, monthly_credits, url, transport=None):
        self.calls.append(list(queries))
        if self.raises:
            raise self.raises
        return self.hits if self.hits is not None else [
            hit(f"https://site{i}.example/lesson", 0.9 - i / 100) for i in range(12)
        ]


class Wiki:
    def __init__(self, hits=None):
        self.hits = hits
        self.queries = []

    def __call__(self, query, *, api_url, user_agent, transport=None):
        self.queries.append(query)
        return self.hits if self.hits is not None else [
            WikiHit("Plant growth", 900, False), WikiHit("L-system", 1200, False),
            WikiHit("Growth (disambiguation)", 50, True), WikiHit("Stub", 100, False),
        ]


def job(gid) -> Job:
    return Job(id=gid, kind="find_sources", payload={"goal_id": str(gid)}, attempts=1, step=None)


@pytest.fixture
def finding(db, make_user, make_goal):
    uid = make_user()
    gid = make_goal(db, uid, title="I would like to learn about simulating a growing plant", map_status="finding_sources")
    db.execute(
        "update goals set intent = 'Simulate a plant growing', search_subject = 'plant growth simulation',"
        " search_queries = '[\"plant growth simulation tutorial\", \"L-system tutorial\"]'::jsonb,"
        " prep_started_at = now() where id = %s",
        (gid,),
    )
    return uid, gid


def handler(tavily=None, wiki=None, videos_blocked=False, **kw):
    s = Settings(_env_file=None, tavily_api_key=kw.pop("key", "tvly-test"), **kw)
    return FindSourcesHandler(s, tavily_search=tavily or Tavily(), wiki_search=wiki or Wiki(),
                              videos_blocked=lambda: videos_blocked)


def sources(db, gid):
    return db.execute(
        "select url_or_file, type, origin, found_for_goal, search_score, status from sources where goal_id = %s"
        " order by search_score desc nulls last, url_or_file",
        (gid,),
    ).fetchall()


def goal(db, gid):
    return db.execute("select * from goals where id = %s", (gid,)).fetchone()


def jobs_of(db, kind, gid):
    return db.execute(
        "select count(*) as n from jobs where kind = %s and payload->>'goal_id' = %s", (kind, str(gid))
    ).fetchone()["n"]


def test_finds_eight_candidates_and_reads_them(db, finding):
    _, gid = finding
    tav = Tavily()
    handler(tav).run(db, job(gid))
    rows = sources(db, gid)
    assert len(rows) == 8
    assert all(r["origin"] == "auto" and r["found_for_goal"] and r["status"] == "queued" for r in rows)
    assert rows[0]["search_score"] == pytest.approx(0.9)
    assert tav.calls == [["plant growth simulation tutorial", "L-system tutorial"]]
    g = goal(db, gid)
    assert g["map_status"] == "reading_sources" and g["reading_started_at"] is not None


def test_videos_are_youtube_sources(db, finding):
    _, gid = finding
    hits = [hit("https://www.youtube.com/watch?v=abcDEF12345", 0.9), hit("https://a.example/x", 0.5)]
    handler(Tavily(hits=hits), find_videos=True).run(db, job(gid))
    assert [r["type"] for r in sources(db, gid)] == ["youtube", "web"]


def test_no_videos_unless_turned_on(db, finding):
    _, gid = finding
    hits = [hit("https://www.youtube.com/watch?v=abcDEF12345", 0.9), hit("https://a.example/x", 0.5)]
    handler(Tavily(hits=hits)).run(db, job(gid))
    assert [r["type"] for r in sources(db, gid)] == ["web"]


def test_no_videos_while_youtube_blocks_the_worker(db, finding):
    _, gid = finding
    hits = [hit("https://www.youtube.com/watch?v=abcDEF12345", 0.9), hit("https://a.example/x", 0.5)]
    handler(Tavily(hits=hits), videos_blocked=True, find_videos=True).run(db, job(gid))
    assert [r["type"] for r in sources(db, gid)] == ["web"]


@pytest.mark.parametrize(
    "case", ["quota", "no_key", "no_hits"],
)
def test_falls_back_to_wikipedia(db, finding, case, caplog):
    _, gid = finding
    tav = Tavily(raises=QuotaExhausted("x")) if case == "quota" else Tavily(hits=[])
    wiki = Wiki()
    h = handler(tav, wiki, key=None) if case == "no_key" else handler(tav, wiki)
    with caplog.at_level("INFO", logger="worker.prep.find"):
        h.run(db, job(gid))
    assert "search fallback" in caplog.text
    assert wiki.queries == ["plant growth simulation"]
    urls = [r["url_or_file"] for r in sources(db, gid)]
    assert urls == ["https://en.wikipedia.org/wiki/L-system", "https://en.wikipedia.org/wiki/Plant_growth"]
    assert goal(db, gid)["map_status"] == "reading_sources"


def test_nothing_anywhere_builds_a_starting_point_map(db, finding):
    _, gid = finding
    handler(Tavily(hits=[]), Wiki(hits=[])).run(db, job(gid))
    g = goal(db, gid)
    assert g["map_status"] == "building_map" and g["map_note"] == "starting_point" and g["expand"] is True
    assert jobs_of(db, "topic_map", gid) == 1
    assert sources(db, gid) == []


def test_skips_urls_the_goal_already_has(db, finding):
    uid, gid = finding
    db.execute("select set_config('app.creating_goal', %s, true)", (str(gid),))
    db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file) values (%s, %s, 'web', 'https://site0.example/lesson/')",
        (uid, gid),
    )
    handler().run(db, job(gid))
    found = [r["url_or_file"] for r in sources(db, gid) if r["origin"] == "auto"]
    assert "https://site0.example/lesson" not in found and len(found) == 8


def test_not_finding_is_a_no_op(db, make_user, make_ready_goal):
    gid = make_ready_goal(make_user())
    tav = Tavily()
    handler(tav).run(db, job(gid))
    assert tav.calls == []


def test_main_registers_find_sources():
    from worker import __main__ as main

    handlers = main.build_handlers(Settings(_env_file=None, llm_provider="fake", embedder="fake", supabase_secret_key="k"))
    assert isinstance(handlers["find_sources"], FindSourcesHandler)
