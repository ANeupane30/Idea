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


# ------------------------------------------------------------ stage 2: reading the learner's sources

SHALLOW_WORDS = 1500
SHALLOW_ITEMS = 3
READING_TIMEOUT = "5 minutes"
WORDS_PER_TOKEN = 0.75


def is_shallow(total_words: int, top_level_items: int, outline_top_items: int) -> bool:
    """Too little to build a curriculum from. An outline with 3+ items is never shallow."""
    if outline_top_items >= SHALLOW_ITEMS:
        return False
    return total_words < SHALLOW_WORDS or top_level_items < SHALLOW_ITEMS


def _top_level(items: list[dict]) -> int:
    """Items at a source's shallowest level; a lone page title (one H1) counts its sections instead."""
    if not items:
        return 0
    levels = sorted({int(i["level"]) for i in items})
    first = sum(1 for i in items if int(i["level"]) == levels[0])
    if first == 1 and len(levels) > 1:
        return sum(1 for i in items if int(i["level"]) == levels[1])
    return first


def _queue_map(conn: psycopg.Connection, goal_id: UUID) -> None:
    conn.execute(
        "insert into jobs (kind, payload) values ('topic_map', %s)", (Jsonb({"goal_id": str(goal_id)}),)
    )


def finish_reading(conn: psycopg.Connection, goal_id: UUID, *, force: bool = False) -> bool:
    """Once the learner's sources are read (or failed): ask about shallow material, or build the map.

    Call inside a transaction. With force (the reading timeout), sources still in flight are left
    behind. Returns whether the goal moved on."""
    goal = conn.execute("select map_status from goals where id = %s for update", (goal_id,)).fetchone()
    if goal is None or goal["map_status"] != "reading_sources":
        return False
    if not force:
        busy = conn.execute(
            "select exists (select 1 from sources where goal_id = %s and origin = 'user'"
            " and status in ('queued', 'processing')) as busy",
            (goal_id,),
        ).fetchone()["busy"]
        if busy:
            return False
    read = conn.execute(
        "select s.type, c.token_count, c.structure from sources s join contents c on c.content_hash = s.content_hash"
        " where s.goal_id = %s and s.origin = 'user' and s.status = 'awaiting_map'",
        (goal_id,),
    ).fetchall()
    if not read:
        # Nothing could be read: a map from the goal alone, as if the learner had chosen Expand.
        conn.execute("update goals set map_status = 'building_map', expand = true where id = %s", (goal_id,))
        _queue_map(conn, goal_id)
        return True
    words = int(sum(r["token_count"] for r in read) * WORDS_PER_TOKEN)
    top = sum(_top_level(r["structure"] or []) for r in read)
    outline_top = sum(
        sum(1 for i in (r["structure"] or []) if int(i["level"]) == 1) for r in read if r["type"] == "outline"
    )
    if is_shallow(words, top, outline_top):
        conn.execute("update goals set map_status = 'awaiting_expand' where id = %s", (goal_id,))
    else:
        conn.execute("update goals set map_status = 'building_map' where id = %s", (goal_id,))
        _queue_map(conn, goal_id)
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
