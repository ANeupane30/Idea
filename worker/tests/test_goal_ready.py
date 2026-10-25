"""User links read before the map exists wait for it; discovery waits for them."""

from uuid import UUID

from test_ingest_handler import Site, Transcripts, handler, job, source
from test_topic_map import FIXTURES, make_job

from worker import jobs
from worker.goal_ready import maybe_start_discovery, on_map_ready
from worker.ingest import messages
from worker.jobs import Job
from worker.llm import FakeLLM
from worker.topic_map import TopicMapHandler


def early_source(db, uid, gid, url, type="web", origin="user", discovered_for=None):
    """A source added at goal creation, before the map exists (as create_goal_with_sources does)."""
    db.execute("select set_config('app.creating_goal', %s, true)", (str(gid),))
    sid = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, origin, discovered_for)"
        " values (%s, %s, %s, %s, %s, %s) returning id",
        (uid, gid, type, url, origin, discovered_for),
    ).fetchone()["id"]
    db.execute("select set_config('app.creating_goal', '', true)")
    return sid


def queued_jobs(db, kind, key, value):
    return db.execute(
        "select payload from jobs where kind = %s and status = 'queued' and payload->>%s = %s",
        (kind, key, str(value)),
    ).fetchall()


def run_direct(db, h, sid):
    """Run the source's job directly, then drop its queued job (as the queue would on completion)."""
    h.run(db, job(sid))
    db.execute("delete from jobs where kind = 'ingest_source' and payload->>'source_id' = %s", (str(sid),))


def goal(db, gid):
    return db.execute("select * from goals where id = %s", (gid,)).fetchone()


def build_map(db, gid):
    TopicMapHandler(FakeLLM(FIXTURES)).run(db, make_job(gid))


def test_link_added_before_map_parks_at_awaiting_map(db, make_user, make_goal):
    uid = make_user()
    gid = make_goal(db, uid)
    sid = early_source(db, uid, gid, "http://127.0.0.1/article.html")
    handler().run(db, job(sid))
    s = source(db, sid)
    assert s["status"] == "awaiting_map" and s["step"] is None
    n = db.execute("select count(*) as n from source_chunks where content_hash = %s", (s["content_hash"],)).fetchone()
    assert n["n"] >= 1
    assert db.execute("select count(*) as n from source_coverage where source_id = %s", (sid,)).fetchone()["n"] == 0


def test_map_ready_requeues_waiting_sources_then_they_match(db, make_user, make_goal):
    uid = make_user()
    gid = make_goal(db, uid)
    sid = early_source(db, uid, gid, "http://127.0.0.1/article.html")
    site = Site()
    run_direct(db, handler(site), sid)
    calls = site.calls
    build_map(db, gid)
    assert goal(db, gid)["map_status"] == "ready"
    assert queued_jobs(db, "ingest_source", "source_id", sid)
    handler(site).run(db, job(sid))
    s = source(db, sid)
    assert s["status"] == "ready" and s["relevance_label"] == "high"
    assert site.calls == calls  # matched from the cached content, not fetched again


def test_discovery_waits_for_user_sources(db, make_user, make_goal):
    uid = make_user()
    gid = make_goal(db, uid)
    sid = early_source(db, uid, gid, "http://127.0.0.1/article.html")
    handler().run(db, job(sid))
    build_map(db, gid)
    assert goal(db, gid)["discovery_status"] == "waiting"
    assert not queued_jobs(db, "discover_sources", "goal_id", gid)
    handler().run(db, job(sid))  # matched: the last user source is done
    assert goal(db, gid)["discovery_status"] == "running"
    assert len(queued_jobs(db, "discover_sources", "goal_id", gid)) == 1


def test_goal_without_sources_starts_discovery_when_ready(db, make_user, make_goal):
    gid = make_goal(db, make_user())
    build_map(db, gid)
    assert goal(db, gid)["discovery_status"] == "running"
    assert len(queued_jobs(db, "discover_sources", "goal_id", gid)) == 1


def test_maybe_start_discovery_only_from_waiting(db, make_user, make_ready_goal):
    gid = make_ready_goal(make_user())
    with db.transaction():
        maybe_start_discovery(db, gid)
    assert goal(db, gid)["discovery_status"] == "none"
    assert not queued_jobs(db, "discover_sources", "goal_id", gid)


def test_clarifying_map_then_answer_matches_waiting_links(db, make_user, make_goal):
    uid = make_user()
    gid = make_goal(db, uid, title="SQL [clarify]")
    sid = early_source(db, uid, gid, "http://127.0.0.1/article.html")
    run_direct(db, handler(), sid)
    build_map(db, gid)
    assert goal(db, gid)["map_status"] == "clarifying"
    assert not queued_jobs(db, "ingest_source", "source_id", sid)
    db.execute(
        "update goals set clarification_answer = 'analytics', map_status = 'pending' where id = %s", (gid,)
    )
    build_map(db, gid)
    assert goal(db, gid)["map_status"] == "ready"
    assert queued_jobs(db, "ingest_source", "source_id", sid)


def test_failed_user_source_lets_discovery_start(db, make_user, make_goal):
    uid = make_user()
    gid = make_goal(db, uid)
    sid = early_source(db, uid, gid, "http://127.0.0.1/article.html")
    handler().run(db, job(sid))
    build_map(db, gid)
    h = handler()
    with db.transaction():
        h.on_permanent_failure(db, job(sid), "nope")
    assert goal(db, gid)["discovery_status"] == "running"


def test_failed_auto_source_is_deleted(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    sid = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, origin) values (%s, %s, 'web', %s, 'auto')"
        " returning id",
        (uid, gid, "http://127.0.0.1/auto.html"),
    ).fetchone()["id"]
    with db.transaction():
        handler().on_permanent_failure(db, job(sid), "nope")
    assert source(db, sid) is None


def test_duplicate_auto_source_is_deleted_silently(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    first = make_source(uid, gid, "http://127.0.0.1/article.html")
    handler().run(db, job(first))
    dup = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, origin) values (%s, %s, 'web', %s, 'auto')"
        " returning id",
        (uid, gid, "http://127.0.0.1/article.html"),
    ).fetchone()["id"]
    db.execute("delete from jobs where payload->>'source_id' is distinct from %s", (str(dup),))
    assert jobs.run_once(db, {"ingest_source": handler()}) is True
    assert source(db, dup) is None
    assert source(db, first)["status"] == "ready"


def test_failed_auto_video_requests_wikipedia_for_its_topic(db, make_user, make_ready_goal):
    uid = make_user()
    gid = make_ready_goal(uid)
    topic = db.execute("select id from subtopics where goal_id = %s order by position limit 1", (gid,)).fetchone()["id"]
    sid = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, origin, discovered_for)"
        " values (%s, %s, 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'auto', %s) returning id",
        (uid, gid, topic),
    ).fetchone()["id"]
    with db.transaction():
        handler(transcripts=Transcripts(None)).on_permanent_failure(db, job(sid), messages.NO_TRANSCRIPT)
    assert source(db, sid) is None
    payloads = [r["payload"] for r in queued_jobs(db, "discover_sources", "goal_id", gid)]
    assert payloads == [{"goal_id": str(gid), "wikipedia_for": str(topic)}]


def test_on_map_ready_is_safe_to_call_twice(db, make_user, make_goal):
    gid = make_goal(db, make_user())
    build_map(db, gid)
    with db.transaction():
        on_map_ready(db, UUID(str(gid)))
    assert len(queued_jobs(db, "discover_sources", "goal_id", gid)) == 1
