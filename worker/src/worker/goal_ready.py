"""What happens once a goal's map exists: waiting user sources get matched, then discovery runs.

Discovery waits until the learner's own sources are matched, so it only fills topics they don't cover.
"""

from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

_IN_FLIGHT = ("queued", "processing", "awaiting_map")


def _user_sources_in_flight(conn: psycopg.Connection, goal_id: UUID) -> bool:
    row = conn.execute(
        "select exists (select 1 from sources where goal_id = %s and origin = 'user' and status = any(%s)) as busy",
        (goal_id, list(_IN_FLIGHT)),
    ).fetchone()
    return bool(row["busy"])


def _start_discovery(conn: psycopg.Connection, goal_id: UUID) -> None:
    conn.execute("update goals set discovery_status = 'running' where id = %s", (goal_id,))
    conn.execute(
        "insert into jobs (kind, payload) values ('discover_sources', %s)", (Jsonb({"goal_id": str(goal_id)}),)
    )


def on_map_ready(conn: psycopg.Connection, goal_id: UUID) -> None:
    """Call inside the transaction that made the map ready."""
    waiting = conn.execute(
        "select id from sources where goal_id = %s and status = 'awaiting_map'", (goal_id,)
    ).fetchall()
    for row in waiting:
        conn.execute(
            "insert into jobs (kind, payload) values ('ingest_source', %s)",
            (Jsonb({"source_id": str(row["id"])}),),
        )
    status = conn.execute(
        "select discovery_status from goals where id = %s for update", (goal_id,)
    ).fetchone()["discovery_status"]
    if status != "none":
        return
    if _user_sources_in_flight(conn, goal_id):
        conn.execute("update goals set discovery_status = 'waiting' where id = %s", (goal_id,))
    else:
        _start_discovery(conn, goal_id)


def maybe_start_discovery(conn: psycopg.Connection, goal_id: UUID) -> None:
    """Call when a user source becomes ready or fails: starts discovery once none are left in flight."""
    row = conn.execute("select discovery_status from goals where id = %s for update", (goal_id,)).fetchone()
    if row is None or row["discovery_status"] != "waiting":
        return
    if not _user_sources_in_flight(conn, goal_id):
        _start_discovery(conn, goal_id)
