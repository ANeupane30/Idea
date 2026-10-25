import psycopg

from test_ingest_handler import handler as ingest_handler
from test_ingest_handler import job as ingest_job
from worker.ingest.embed import FakeEmbedder
from worker.lessons.diagrams import FakeDiagramValidator
from worker.lessons.generator import LessonGenerator
from worker.llm import DEFAULT_FIXTURES_DIR, FakeLLM, LLMResult

ARTICLE = "http://127.0.0.1/article.html"


class SpyLLM:
    """FakeLLM that counts streams; can fail after N pieces."""

    def __init__(self, fail_after: int | None = None):
        self.fake = FakeLLM(DEFAULT_FIXTURES_DIR)
        self.streams = 0
        self.fail_after = fail_after

    def parse(self, **kw):
        return self.fake.parse(**kw)

    def stream_text(self, *, model, system, user, max_tokens, on_usage):
        self.streams += 1
        pieces = list(self.fake.stream_text(model=model, system=system, user=user, max_tokens=max_tokens,
                                            on_usage=lambda r: None))
        if self.fail_after is None:
            done = False
            try:
                yield from pieces
                done = True
            finally:  # like the real client: a stream closed early is billed too
                on_usage(LLMResult(None, 100, 400 if done else 200, model))
            return
        text = "".join(pieces)
        cut = [i for i in range(len(text)) if text.startswith("</section>", i)][1] + len("</section>")
        yield text[:cut]
        on_usage(LLMResult(None, 50, 80, model))
        raise RuntimeError("stream dropped")


def gen(llm=None):
    return LessonGenerator(llm or SpyLLM(), FakeEmbedder(), FakeDiagramValidator())


def ready_topic(db, make_user, make_ready_goal, make_source, title="Joining tables", uid=None, url=ARTICLE):
    uid = uid or make_user()
    gid = make_ready_goal(uid)
    sid = make_source(uid, gid, url)
    ingest_handler().run(db, ingest_job(sid))
    tid = db.execute(
        "select id from subtopics where goal_id = %s and title = %s", (gid, title)
    ).fetchone()["id"]
    return uid, gid, tid


def run(g, db, uid, tid, fmt="visual", refresh=False):
    return list(g.generate(db, uid, tid, fmt, refresh))


def lessons(db, tid):
    return db.execute(
        "select * from lessons where subtopic_id = %s order by created_at, id", (tid,)
    ).fetchall()


def test_generates_and_stores_lesson(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    events = run(gen(), db, uid, tid)
    assert [e["type"] for e in events] == ["start", "section", "section", "done"]
    assert events[0]["sources"][0]["n"] == 1 and events[0]["sources"][0]["href"].startswith(ARTICLE)
    assert events[1]["index"] == 0 and events[1]["section"]["citations"] == [1]
    (row,) = lessons(db, tid)
    assert row["status"] == "ready" and str(row["id"]) == events[-1]["lesson_id"]
    assert len(row["body"]["sections"]) == 2
    src = row["body"]["sources"][0]
    assert src["n"] == 1 and src["title"].startswith("A practical guide to SQL")
    assert src["href"].startswith(ARTICLE)
    kinds = db.execute("select kind from usage_events where user_id = %s and kind = 'lesson'", (uid,)).fetchall()
    assert len(kinds) == 1


def test_second_request_returns_stored_lesson(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    llm = SpyLLM()
    run(gen(llm), db, uid, tid)
    events = run(gen(llm), db, uid, tid)
    assert [e["type"] for e in events] == ["lesson"]
    assert events[0]["lesson"]["format"] == "visual" and len(events[0]["lesson"]["body"]["sections"]) == 2
    assert llm.streams == 1


def test_reuses_lesson_with_same_cache_key(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    run(gen(), db, uid, tid)
    # Same content under another user's own link: the copy cites that user's source, not the first one's.
    other_url = f"{ARTICLE}?utm_source=other-user"
    other, _, other_tid = ready_topic(db, make_user, make_ready_goal, make_source, url=other_url)
    llm = SpyLLM()
    events = run(gen(llm), db, other, other_tid)
    assert [e["type"] for e in events] == ["lesson"]
    assert llm.streams == 0
    (row,) = lessons(db, other_tid)
    assert row["reused"] is True and row["user_id"] == other
    hrefs = [s["href"] for s in row["body"]["sources"]]
    assert hrefs and all(h.startswith(other_url) for h in hrefs)
    assert events[0]["lesson"]["body"]["sources"] == row["body"]["sources"]


def test_no_sources(db, make_user, make_ready_goal, make_source):
    uid, gid, _ = ready_topic(db, make_user, make_ready_goal, make_source)
    tid = db.execute(
        "select id from subtopics where goal_id = %s and title = 'Indexes and query performance'", (gid,)
    ).fetchone()["id"]
    assert run(gen(), db, uid, tid) == [{"type": "error", "code": "no_sources"}]
    assert lessons(db, tid) == []


def test_other_users_subtopic_not_found(db, make_user, make_ready_goal, make_source):
    _, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    stranger = make_user()
    assert run(gen(), db, stranger, tid) == [{"type": "error", "code": "not_found"}]
    assert lessons(db, tid) == []


def test_limits_map_to_codes(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    db.execute(
        "insert into lessons (user_id, subtopic_id, format, level, cache_key, status)"
        " select %s, %s, 'summary', 'beginner', 'x' || i, 'ready' from generate_series(1, 15) i",
        (uid, tid),
    )
    assert run(gen(), db, uid, tid) == [{"type": "error", "code": "lesson_limit"}]

    guest = make_user()
    db.execute("update auth.users set is_anonymous = true where id = %s", (guest,))
    _, _, gtid = ready_topic(db, make_user, make_ready_goal, make_source, uid=guest)
    db.execute(
        "insert into lessons (user_id, subtopic_id, format, level, cache_key, status)"
        " select %s, %s, 'summary', 'beginner', 'g' || i, 'ready' from generate_series(1, 5) i",
        (guest, gtid),
    )
    assert run(gen(), db, guest, gtid, fmt="text") == [{"type": "error", "code": "guest_lesson_limit"}]


def test_second_generation_is_in_progress(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    db.execute(
        "insert into lessons (user_id, subtopic_id, format, level, cache_key, status)"
        " values (%s, %s, 'visual', 'beginner', 'other', 'generating')",
        (uid, tid),
    )
    assert run(gen(), db, uid, tid) == [{"type": "error", "code": "in_progress"}]


def test_stale_generating_row_is_failed(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    db.execute(
        "insert into lessons (user_id, subtopic_id, format, level, cache_key, status, created_at)"
        " values (%s, %s, 'visual', 'beginner', 'old', 'generating', now() - interval '11 minutes')",
        (uid, tid),
    )
    events = run(gen(), db, uid, tid)
    assert events[-1]["type"] == "done"
    assert [r["status"] for r in lessons(db, tid)] == ["failed", "ready"]


def test_stream_error_marks_failed(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    events = run(gen(SpyLLM(fail_after=2)), db, uid, tid)
    assert [e["type"] for e in events] == ["start", "section", "section", "error"]
    assert events[-1]["code"] == "failed"
    (row,) = lessons(db, tid)
    assert row["status"] == "failed"
    n = db.execute("select count(*) as n from usage_events where user_id = %s and kind = 'lesson'", (uid,)).fetchone()["n"]
    assert n == 1


def test_refresh_regenerates(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    llm = SpyLLM()
    run(gen(llm), db, uid, tid)
    events = run(gen(llm), db, uid, tid, refresh=True)
    assert events[-1]["type"] == "done"
    assert llm.streams == 2
    assert [r["status"] for r in lessons(db, tid)] == ["ready", "ready"]


def test_new_coverage_marks_lessons_stale(db, make_user, make_ready_goal, make_source):
    uid, gid, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    llm = SpyLLM()
    run(gen(llm), db, uid, tid)
    second = make_source(uid, gid, f"{ARTICLE}?n=2")
    ingest_handler().run(db, ingest_job(second))
    assert lessons(db, tid)[0]["stale"] is True
    events = run(gen(llm), db, uid, tid)
    assert events[-1]["type"] == "done"
    assert llm.streams == 2


def test_disconnect_marks_failed(db, make_user, make_ready_goal, make_source):
    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    events = gen().generate(db, uid, tid, "visual", False)
    assert next(events)["type"] == "start"
    assert next(events)["type"] == "section"
    events.close()  # the client went away mid-stream, after receiving content
    (row,) = lessons(db, tid)
    assert row["status"] == "failed"
    assert row["delivered"] is True  # still counts toward the limit
    n = db.execute("select count(*) as n from usage_events where user_id = %s and kind = 'lesson'", (uid,)).fetchone()["n"]
    assert n == 1  # and the partial stream is billed


def test_uses_real_connection_without_open_transaction():
    """Statements run in their own transactions (no implicit one left open)."""
    from worker.config import Settings
    from worker.db import connect

    conn = connect(Settings())
    try:
        import uuid

        list(gen().generate(conn, uuid.uuid4(), uuid.uuid4(), "visual", False))
        assert conn.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
    finally:
        conn.close()


def test_rate_limit_ends_the_lesson_with_busy(db, make_user, make_ready_goal, make_source):
    from test_jobs import _rate_limit_error

    class RateLimited(SpyLLM):
        def stream_text(self, **kw):
            raise _rate_limit_error()
            yield  # pragma: no cover

    uid, _, tid = ready_topic(db, make_user, make_ready_goal, make_source)
    events = run(gen(RateLimited()), db, uid, tid)
    assert events[-1] == {"type": "error", "code": "busy"}
