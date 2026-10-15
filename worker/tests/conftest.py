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
