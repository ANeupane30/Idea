from uuid import UUID

import pytest

from worker.config import Settings
from worker.discovery.handler import DiscoverHandler
from worker.discovery.wikipedia import WikiHit
from worker.jobs import Job


class Wiki:
    """Stub search: one good hit per query unless told otherwise; records queries."""

    def __init__(self, hits=None):
        self.queries = []
        self.hits = hits

    def __call__(self, query, *, api_url, user_agent, transport=None):
        self.queries.append(query)
        if self.hits is not None:
            return self.hits(query) if callable(self.hits) else self.hits
        topic = query.rsplit(" SQL", 1)[0]
        return [WikiHit(f"{topic} article", 800, False)]


class Tube:
    def __init__(self, ids=None):
        self.queries = []
        self.ids = ids

    def __call__(self, query, *, api_key, api_url, transport=None):
        self.queries.append(query)
        return self.ids if self.ids is not None else [f"vid{len(self.queries):08d}"]


def settings(**kw):
    return Settings(_env_file=None, llm_provider="fake", **kw)


def make_handler(wiki=None, tube=None, quota=None, **kw):
    return DiscoverHandler(settings(**kw), wiki_search=wiki or Wiki(), yt_search=tube or Tube(),
                           quota_left=quota or (lambda key: None))


def job(gid, **extra) -> Job:
    return Job(id=gid, kind="discover_sources", payload={"goal_id": str(gid), **extra}, attempts=1, step=None)


def tops(db, gid):
    return db.execute(
        "select id, title from subtopics where goal_id = %s and parent_id is null order by position", (gid,)
    ).fetchall()


def auto_sources(db, gid):
    return db.execute(
        "select s.type, s.url_or_file, t.title as topic from sources s left join subtopics t on t.id = s.discovered_for"
        " where s.goal_id = %s and s.origin = 'auto' order by t.position nulls last, s.url_or_file",
        (gid,),
    ).fetchall()


def status(db, gid):
    return db.execute("select discovery_status from goals where id = %s", (gid,)).fetchone()["discovery_status"]


def cover(db, uid, gid, subtopic_id, relevance=0.9):
    sid = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, status) values (%s, %s, 'web', %s, 'ready')"
        " returning id",
        (uid, gid, f"https://covered.example/{subtopic_id}"),
    ).fetchone()["id"]
    db.execute(
        "insert into source_coverage (source_id, subtopic_id, relevance, reason) values (%s, %s, %s, 'r')",
        (sid, subtopic_id, relevance),
    )


def style(db, uid, value):
    db.execute(
        "insert into learning_prefs (user_id, learning_style) values (%s, %s)"
        " on conflict (user_id) do update set learning_style = excluded.learning_style",
        (uid, value),
    )


@pytest.fixture
def goal(db, make_user, make_ready_goal):
    uid = make_user()
    gid = make_ready_goal(uid, title="Learn SQL")
    db.execute("update goals set discovery_status = 'running' where id = %s", (gid,))
    return uid, gid


def test_adds_one_article_per_uncovered_topic_up_to_four(db, goal):
    uid, gid = goal
    wiki = Wiki()
    make_handler(wiki).run(db, job(gid))
    names = [t["title"] for t in tops(db, gid)]
    rows = auto_sources(db, gid)
    assert [r["type"] for r in rows] == ["web"] * 4
    assert [r["topic"] for r in rows] == names[:4]
    assert rows[0]["url_or_file"] == "https://en.wikipedia.org/wiki/" + (names[0] + " article").replace(" ", "_")
    assert wiki.queries[0] == f"{names[0]} SQL"  # the goal's subject, without "Learn"
    assert status(db, gid) == "done"


def test_skips_covered_topics_including_via_children(db, goal):
    uid, gid = goal
    t = tops(db, gid)
    cover(db, uid, gid, t[0]["id"])
    child = db.execute("select id from subtopics where parent_id is not null and goal_id = %s limit 1", (gid,)).fetchone()
    parent = db.execute("select parent_id from subtopics where id = %s", (child["id"],)).fetchone()["parent_id"]
    cover(db, uid, gid, child["id"])
    cover(db, uid, gid, t[5]["id"], relevance=0.2)  # off-topic coverage doesn't count
    make_handler().run(db, job(gid))
    topics = [r["topic"] for r in auto_sources(db, gid)]
    assert t[0]["title"] not in topics
    assert next(x["title"] for x in t if x["id"] == parent) not in topics
    assert len(topics) == 4


def test_skips_disambiguation_short_and_duplicate_hits(db, goal):
    uid, gid = goal
    db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, status) values (%s, %s, 'web', %s, 'ready')",
        (uid, gid, "https://en.wikipedia.org/wiki/Taken"),
    )
    hits = [WikiHit("Short", 299, False), WikiHit("Thing (disambiguation)", 900, True), WikiHit("Taken", 900, False),
            WikiHit("Good one", 300, False)]
    make_handler(Wiki(hits=hits)).run(db, job(gid))
    urls = [r["url_or_file"] for r in auto_sources(db, gid)]
    assert urls == ["https://en.wikipedia.org/wiki/Good_one"]  # the same article isn't added twice


def test_visual_learner_gets_two_videos_then_articles(db, goal):
    uid, gid = goal
    style(db, uid, "visual_video")
    tube = Tube()
    make_handler(tube=tube, youtube_api_key="k").run(db, job(gid))
    rows = auto_sources(db, gid)
    names = [t["title"] for t in tops(db, gid)]
    assert [r["type"] for r in rows] == ["youtube", "youtube", "web", "web", "web", "web"]
    assert [r["topic"] for r in rows] == names[:6]
    assert rows[0]["url_or_file"] == "https://www.youtube.com/watch?v=vid00000001"
    assert len(tube.queries) == 2


def test_no_youtube_key_means_no_videos(db, goal):
    uid, gid = goal
    style(db, uid, "visual_video")
    tube = Tube()
    make_handler(tube=tube).run(db, job(gid))
    assert tube.queries == []
    assert {r["type"] for r in auto_sources(db, gid)} == {"web"}


def test_reading_learner_gets_no_videos(db, goal):
    uid, gid = goal
    style(db, uid, "reading")
    tube = Tube()
    make_handler(tube=tube, youtube_api_key="k").run(db, job(gid))
    assert tube.queries == []


def test_wikipedia_for_payload_only_searches_that_topic(db, goal):
    uid, gid = goal
    style(db, uid, "visual_video")
    t = tops(db, gid)
    wiki, tube = Wiki(), Tube()
    make_handler(wiki, tube, youtube_api_key="k").run(db, job(gid, wikipedia_for=str(t[1]["id"])))
    assert tube.queries == []
    assert wiki.queries == [f"{t[1]['title']} SQL"]
    assert [r["topic"] for r in auto_sources(db, gid)] == [t[1]["title"]]


def test_wikipedia_for_a_child_searches_its_top_level_topic(db, goal):
    uid, gid = goal
    child = db.execute(
        "select c.id, p.title as parent from subtopics c join subtopics p on p.id = c.parent_id where c.goal_id = %s limit 1",
        (gid,),
    ).fetchone()
    wiki = Wiki()
    make_handler(wiki).run(db, job(gid, wikipedia_for=str(child["id"])))
    assert wiki.queries == [f"{child['parent']} SQL"]


def test_caps_count_existing_auto_sources(db, goal):
    uid, gid = goal
    for i in range(3):
        db.execute(
            "insert into sources (user_id, goal_id, type, url_or_file, origin, status)"
            " values (%s, %s, 'web', %s, 'auto', 'ready')",
            (uid, gid, f"https://en.wikipedia.org/wiki/Old{i}"),
        )
    make_handler().run(db, job(gid))
    assert len([r for r in auto_sources(db, gid) if "Old" not in r["url_or_file"]]) == 1


def test_stops_when_quota_below_floor(db, goal):
    uid, gid = goal
    h = DiscoverHandler(Settings(_env_file=None, llm_provider="openrouter", openrouter_api_key="k"),
                        wiki_search=Wiki(), yt_search=Tube(), quota_left=lambda key: 4)
    h.run(db, job(gid))
    assert auto_sources(db, gid) == []
    assert status(db, gid) == "done"


def test_quota_at_floor_still_adds(db, goal):
    uid, gid = goal
    h = DiscoverHandler(Settings(_env_file=None, llm_provider="openrouter", openrouter_api_key="k"),
                        wiki_search=Wiki(), yt_search=Tube(), quota_left=lambda key: 5)
    h.run(db, job(gid))
    assert len(auto_sources(db, gid)) == 4


def test_archived_goal_stops_quietly(db, goal):
    uid, gid = goal

    def archive_then_hit(query):
        db.execute("update goals set status = 'archived' where id = %s", (gid,))
        return [WikiHit("Anything", 900, False)]

    make_handler(Wiki(hits=archive_then_hit)).run(db, job(gid))
    assert auto_sources(db, gid) == []
    assert status(db, gid) == "done"


def test_search_errors_finish_done(db, goal):
    uid, gid = goal
    make_handler(Wiki(hits=[]), Tube(ids=[])).run(db, job(gid))
    assert auto_sources(db, gid) == []
    assert status(db, gid) == "done"


def test_disabled_or_not_ready_finishes_done(db, goal, make_goal, make_user):
    uid, gid = goal
    wiki = Wiki()
    make_handler(wiki, discovery_enabled=False).run(db, job(gid))
    assert wiki.queries == [] and status(db, gid) == "done"
    pending = make_goal(db, make_user())
    make_handler(wiki).run(db, job(pending))
    assert wiki.queries == [] and status(db, pending) == "done"


def test_auto_sources_skip_guest_limit(db, make_ready_goal):
    import uuid

    gid_user = uuid.uuid4()
    db.execute("insert into auth.users (id, is_anonymous) values (%s, true)", (gid_user,))
    gid = make_ready_goal(gid_user)
    for i in range(3):
        db.execute(
            "insert into sources (user_id, goal_id, type, url_or_file) values (%s, %s, 'web', %s)",
            (gid_user, gid, f"https://mine.example/{i}"),
        )
    make_handler().run(db, job(gid))
    assert len(auto_sources(db, gid)) == 4


def test_failure_hooks_mark_done(db, goal):
    uid, gid = goal
    h = make_handler()
    with db.transaction():
        h.on_retry(db, job(gid))
    assert status(db, gid) == "done"
    db.execute("update goals set discovery_status = 'running' where id = %s", (gid,))
    with db.transaction():
        h.on_permanent_failure(db, job(gid), "x")
    assert status(db, gid) == "done"


def test_main_registers_discover_sources(monkeypatch):
    from worker import __main__ as main

    handlers = main.build_handlers(Settings(_env_file=None, llm_provider="fake", embedder="fake", supabase_secret_key="k"))
    assert isinstance(handlers["discover_sources"], DiscoverHandler)


def test_discovered_for_is_a_top_level_topic(db, goal):
    uid, gid = goal
    make_handler().run(db, job(gid))
    parents = db.execute(
        "select t.parent_id from sources s join subtopics t on t.id = s.discovered_for where s.goal_id = %s",
        (gid,),
    ).fetchall()
    assert parents and all(p["parent_id"] is None for p in parents)
    assert isinstance(gid, UUID)


def test_goal_topic_strips_learning_phrases():
    from worker.discovery.handler import goal_topic

    assert goal_topic("Learn the basics of personal finance") == "personal finance"
    assert goal_topic("Learn about Roman history") == "Roman history"
    assert goal_topic("learn SQL") == "SQL"
    assert goal_topic("How to bake bread") == "bake bread"
    assert goal_topic("Understand statistics") == "statistics"
    assert goal_topic("Master chess openings") == "chess openings"
    assert goal_topic("SQL") == "SQL"

