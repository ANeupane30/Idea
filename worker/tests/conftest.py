import functools
import http.server
import threading
import uuid
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb

from worker.config import Settings
from worker.db import connect


class _Rollback(Exception):
    pass


@pytest.fixture
def db():
    """A connection inside an outer transaction that is rolled back after the test.

    Code under test uses `with conn.transaction():` blocks, which psycopg turns
    into savepoints while this outer block is open, so nothing escapes.
    """
    conn = connect(Settings())
    try:
        try:
            with conn.transaction():
                yield conn
                raise _Rollback
        except _Rollback:
            pass
    finally:
        conn.close()


@pytest.fixture
def make_user(db):
    def _make_user(db_=None, plan="free"):
        conn = db_ or db
        user_id = uuid.uuid4()
        conn.execute(
            "insert into auth.users (id, email) values (%s, %s)",
            (user_id, f"{user_id}@example.com"),
        )
        if plan != "free":
            conn.execute("update public.users set plan = %s where id = %s", (plan, user_id))
        return user_id

    return _make_user


@pytest.fixture
def make_goal(db):
    def _make_goal(db_, user_id, title="Learn SQL", **cols):
        conn = db_ or db
        cols = {"title": title, "user_id": user_id, **cols}
        names = ", ".join(cols)
        marks = ", ".join(["%s"] * len(cols))
        values = [Jsonb(v) if isinstance(v, dict) else v for v in cols.values()]
        row = conn.execute(
            f"insert into public.goals ({names}) values ({marks}) returning id", values
        ).fetchone()
        return row["id"]

    return _make_goal


TOPIC_MAP_FIXTURE = Path(__file__).parent / "fixtures" / "fake_llm" / "topic_map.json"


@pytest.fixture
def make_ready_goal(db, make_goal):
    """A goal whose map is ready, with the fake LLM's SQL topic map as its subtopics."""

    def _make_ready_goal(user_id, title="Learn SQL"):
        import json

        gid = make_goal(db, user_id, title=title, map_status="ready", map_level="beginner")
        topics = json.loads(TOPIC_MAP_FIXTURE.read_text(encoding="utf-8"))["subtopics"]
        for pos, t in enumerate(topics):
            parent = db.execute(
                "insert into subtopics (goal_id, title, summary, position) values (%s, %s, %s, %s) returning id",
                (gid, t["title"], t["summary"], pos),
            ).fetchone()["id"]
            for cpos, c in enumerate(t["children"]):
                db.execute(
                    "insert into subtopics (goal_id, parent_id, title, summary, position) values (%s, %s, %s, %s, %s)",
                    (gid, parent, c["title"], c["summary"], cpos),
                )
        return gid

    return _make_ready_goal


@pytest.fixture
def make_source(db):
    def _make_source(user_id, goal_id, url_or_file, type="web", file_name=None):
        return db.execute(
            "insert into sources (user_id, goal_id, type, url_or_file, file_name)"
            " values (%s, %s, %s, %s, %s) returning id",
            (user_id, goal_id, type, url_or_file, file_name),
        ).fetchone()["id"]

    return _make_source


SITES_DIR = Path(__file__).parent / "fixtures" / "sites"


@pytest.fixture(scope="session")
def site_server():
    """Serves tests/fixtures/sites on 127.0.0.1; yields the base URL."""

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(SITES_DIR))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
