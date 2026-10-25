"""User links read before the map exists wait for it; discovery waits for them."""

from uuid import UUID

from test_ingest_handler import Site, Transcripts, handler, job, source
from test_topic_map import FIXTURES, make_job

from worker import jobs
from worker.goal_ready import maybe_start_discovery, on_map_written
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
    assert goal(db, gid)["map_status"] == "matching_sources"  # shown once its sources are matched
    assert queued_jobs(db, "ingest_source", "source_id", sid)
    handler(site).run(db, job(sid))
    assert goal(db, gid)["map_status"] == "ready"
    s = source(db, sid)
    assert s["status"] == "ready" and s["relevance_label"] == "high"
    assert site.calls == calls  # matched from the cached content, not fetched again


def test_discovery_waits_for_user_sources(db, make_user, make_goal):
    uid = make_user()
    gid = make_goal(db, uid)
    sid = early_source(db, uid, gid, "http://127.0.0.1/article.html")
    handler().run(db, job(sid))
    build_map(db, gid)
    assert goal(db, gid)["discovery_status"] == "none"  # nothing is looked for until matching ends
    assert not queued_jobs(db, "discover_sources", "goal_id", gid)
    handler().run(db, job(sid))  # matched: the last source is done, so the map is ready
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
    # A source with structure means no clarifying question (the map follows it); without one the
    # goal can still clarify, and its waiting links must get matched afterwards.
    db.execute("update contents set structure = '[]' where content_hash = %s", (source(db, sid)["content_hash"],))
    build_map(db, gid)
    assert goal(db, gid)["map_status"] == "clarifying"
    assert not queued_jobs(db, "ingest_source", "source_id", sid)
    db.execute(
        "update goals set clarification_answer = 'analytics', map_status = 'pending' where id = %s", (gid,)
    )
    build_map(db, gid)
    assert goal(db, gid)["map_status"] == "matching_sources"
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


def test_on_map_written_is_safe_to_call_twice(db, make_user, make_goal):
    gid = make_goal(db, make_user())
    build_map(db, gid)
    with db.transaction():
        on_map_written(db, UUID(str(gid)))
    assert len(queued_jobs(db, "discover_sources", "goal_id", gid)) == 1


# ------------------------------------------------------------ sources first: reading


from worker.goal_ready import finish_reading, sweep_reading_timeouts  # noqa: E402

LONG = "<html><head><title>Long</title></head><body><article>" + "".join(
    f"<h2>Part {i}</h2><p>" + " ".join(["Joins combine rows from related tables in SQL queries."] * 60) + "</p>"
    for i in range(1, 6)
) + "</article></body></html>"


def reading_goal(db, make_goal, uid, minutes_ago=0):
    gid = make_goal(db, uid, map_status="reading_sources")
    db.execute(
        "update goals set reading_started_at = now() - make_interval(mins => %s), intent = 'Learn SQL joins',"
        " search_subject = 'SQL joins' where id = %s",
        (minutes_ago, gid),
    )
    db.execute("delete from jobs where payload->>'goal_id' = %s", (str(gid),))
    return gid


def found_source(db, uid, gid, url, score=0.5):
    db.execute("select set_config('app.creating_goal', %s, true)", (str(gid),))
    sid = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, origin, found_for_goal, search_score)"
        " values (%s, %s, 'web', %s, 'auto', true, %s) returning id",
        (uid, gid, url, score),
    ).fetchone()["id"]
    db.execute("select set_config('app.creating_goal', '', true)")
    return sid


def jobs_for(db, kind, gid):
    return queued_jobs(db, kind, "goal_id", gid)


def test_finish_reading_waits_for_sources_in_flight(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    early_source(db, uid, gid, "http://127.0.0.1/a.html")
    found_source(db, uid, gid, "http://127.0.0.1/b.html")
    with db.transaction():
        assert finish_reading(db, gid) is False
    assert goal(db, gid)["map_status"] == "reading_sources"


def test_read_sources_go_on_to_the_check(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    sid = early_source(db, uid, gid, "http://127.0.0.1/long.html")
    run_direct(db, handler(Site(LONG)), sid)
    assert source(db, sid)["status"] == "awaiting_map"
    assert goal(db, gid)["map_status"] == "checking_sources"
    assert len(jobs_for(db, "check_sources", gid)) == 1


def test_found_sources_count_too(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    sid = found_source(db, uid, gid, "http://127.0.0.1/long.html")
    run_direct(db, handler(Site(LONG)), sid)
    assert goal(db, gid)["map_status"] == "checking_sources"


def test_a_found_source_failing_last_still_moves_the_goal_on(db, make_user, make_goal):
    """Review Focus 3: every candidate failed to read (they are deleted), so search again."""
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    sid = found_source(db, uid, gid, "http://127.0.0.1/gone.html")
    with db.transaction():
        handler().on_permanent_failure(db, job(sid), "nope")
    g = goal(db, gid)
    assert source(db, sid) is None
    assert g["map_status"] == "finding_sources" and g["search_round"] == 1
    assert g["search_queries"] == ["SQL joins tutorial", "SQL joins course"]
    assert len(jobs_for(db, "find_sources", gid)) == 1


def test_found_sources_failing_on_the_second_round_give_a_starting_point(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    db.execute("update goals set search_round = 1 where id = %s", (gid,))
    sid = found_source(db, uid, gid, "http://127.0.0.1/gone.html")
    with db.transaction():
        handler().on_permanent_failure(db, job(sid), "nope")
    g = goal(db, gid)
    assert g["map_status"] == "building_map" and g["map_note"] == "starting_point"
    assert len(jobs_for(db, "topic_map", gid)) == 1


def test_the_learners_sources_all_failing_ask_them(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    bad = early_source(db, uid, gid, "http://127.0.0.1/bad.html")
    with db.transaction():
        handler().on_permanent_failure(db, job(bad), "We couldn't open this link.")
    assert goal(db, gid)["map_status"] == "awaiting_source_decision"


def test_one_read_and_one_failed_source_go_on_to_the_check(db, make_user, make_goal):
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    good = early_source(db, uid, gid, "http://127.0.0.1/long.html")
    bad = early_source(db, uid, gid, "http://127.0.0.1/bad.html")
    run_direct(db, handler(Site(LONG)), good)
    assert goal(db, gid)["map_status"] == "reading_sources"  # the other one is still queued
    with db.transaction():
        handler().on_permanent_failure(db, job(bad), "nope")
    assert goal(db, gid)["map_status"] == "checking_sources"


def test_two_finish_reading_calls_queue_one_check(db, make_user, make_goal):
    """Review Focus 5: the status is re-read under the goal lock."""
    uid = make_user()
    gid = reading_goal(db, make_goal, uid)
    sid = early_source(db, uid, gid, "http://127.0.0.1/long.html")
    run_direct(db, handler(Site(LONG)), sid)
    with db.transaction():
        assert finish_reading(db, gid) is False  # already moved on
    assert len(jobs_for(db, "check_sources", gid)) == 1


def test_sweep_moves_goals_reading_for_five_minutes(db, make_user, make_goal):
    uid = make_user()
    old = reading_goal(db, make_goal, uid, minutes_ago=6)
    early_source(db, uid, old, "http://127.0.0.1/slow.html")  # still queued: nothing read
    fresh = reading_goal(db, make_goal, make_user(), minutes_ago=4)
    with db.transaction():
        moved = sweep_reading_timeouts(db)
    assert moved == 1
    assert goal(db, old)["map_status"] == "awaiting_source_decision"
    assert goal(db, fresh)["map_status"] == "reading_sources"
