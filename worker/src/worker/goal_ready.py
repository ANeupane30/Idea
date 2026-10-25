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


def on_map_written(conn: psycopg.Connection, goal_id: UUID) -> None:
    """Call inside the transaction that wrote the map. Its sources are matched before it's shown:
    the goal waits in matching_sources, or is ready at once with nothing to match."""
    # The learner's sources that didn't pass the check are kept, but not used ("Not used").
    conn.execute(
        "update sources set status = 'ready', step = null where goal_id = %s and status = 'awaiting_map'"
        " and vetted = false",
        (goal_id,),
    )
    waiting = conn.execute(
        "select id from sources where goal_id = %s and status = 'awaiting_map'", (goal_id,)
    ).fetchall()
    for row in waiting:
        conn.execute(
            "insert into jobs (kind, payload) values ('ingest_source', %s)",
            (Jsonb({"source_id": str(row["id"])}),),
        )
    if waiting:
        conn.execute("update goals set map_status = 'matching_sources' where id = %s", (goal_id,))
    else:
        _ready(conn, goal_id)


def finish_matching(conn: psycopg.Connection, goal_id: UUID) -> None:
    """Call when one of the goal's sources was matched (or failed): the map is ready once none are left."""
    goal = conn.execute("select map_status from goals where id = %s for update", (goal_id,)).fetchone()
    if goal is None or goal["map_status"] != "matching_sources":
        return
    busy = conn.execute(
        "select exists (select 1 from sources where goal_id = %s"
        " and status in ('queued', 'processing', 'awaiting_map')) as busy",
        (goal_id,),
    ).fetchone()["busy"]
    if not busy:
        _ready(conn, goal_id)


def _ready(conn: psycopg.Connection, goal_id: UUID) -> None:
    conn.execute("update goals set map_status = 'ready' where id = %s", (goal_id,))
    _start_discovery_if_new(conn, goal_id)


def _start_discovery_if_new(conn: psycopg.Connection, goal_id: UUID) -> None:
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


# ------------------------------------------------------------ sources first: once the sources are read

READING_TIMEOUT = "5 minutes"


def _queue(conn: psycopg.Connection, kind: str, goal_id: UUID) -> None:
    conn.execute("insert into jobs (kind, payload) values (%s, %s)", (kind, Jsonb({"goal_id": str(goal_id)})))


def starting_point_map(conn: psycopg.Connection, goal_id: UUID) -> None:
    """No usable material: a map from the intent, labelled a starting point on the page."""
    conn.execute(
        "update goals set map_status = 'building_map', map_note = 'starting_point', expand = true where id = %s",
        (goal_id,),
    )
    _queue(conn, "topic_map", goal_id)


def search_again_or_fall_back(conn: psycopg.Connection, goal_id: UUID) -> None:
    """Too little found material: one more search round with plainer queries, then a starting point."""
    goal = conn.execute("select search_round, coalesce(search_subject, title) as subject from goals where id = %s",
                        (goal_id,)).fetchone()
    if goal["search_round"] < 1:
        subject = goal["subject"]
        conn.execute(
            "update goals set search_round = 1, search_queries = %s, map_status = 'finding_sources' where id = %s",
            (Jsonb([f"{subject} tutorial", f"{subject} course"]), goal_id),
        )
        _queue(conn, "find_sources", goal_id)
    else:
        starting_point_map(conn, goal_id)


def finish_reading(conn: psycopg.Connection, goal_id: UUID, *, force: bool = False) -> bool:
    """Once a goal's sources are read (or failed): check them before any map.

    Call inside a transaction. The status is re-read under the goal lock, so of two concurrent calls
    only one acts. With force (the reading timeout), sources still in flight are left behind.
    Returns whether the goal moved on."""
    goal = conn.execute("select map_status from goals where id = %s for update", (goal_id,)).fetchone()
    if goal is None or goal["map_status"] != "reading_sources":
        return False
    if not force:
        busy = conn.execute(
            "select exists (select 1 from sources where goal_id = %s and status in ('queued', 'processing')) as busy",
            (goal_id,),
        ).fetchone()["busy"]
        if busy:
            return False
    read = conn.execute(
        "select exists (select 1 from sources where goal_id = %s and status = 'awaiting_map') as read", (goal_id,)
    ).fetchone()["read"]
    if read:
        conn.execute("update goals set map_status = 'checking_sources' where id = %s", (goal_id,))
        _queue(conn, "check_sources", goal_id)
        return True
    has_own = conn.execute(
        "select exists (select 1 from sources where goal_id = %s and origin = 'user') as own", (goal_id,)
    ).fetchone()["own"]
    if has_own:
        # None of the learner's own sources could be read: they decide what happens next.
        conn.execute("update goals set map_status = 'awaiting_source_decision' where id = %s", (goal_id,))
    else:
        search_again_or_fall_back(conn, goal_id)
    return True


def sweep_reading_timeouts(conn: psycopg.Connection) -> int:
    """Goals that have been reading for 5 minutes move on with what was read. Returns how many moved."""
    moved = 0
    with conn.transaction():
        stale = conn.execute(
            "select id from goals where map_status = 'reading_sources'"
            f" and reading_started_at <= now() - interval '{READING_TIMEOUT}'"
        ).fetchall()
        for row in stale:
            moved += finish_reading(conn, row["id"], force=True)
    return moved
