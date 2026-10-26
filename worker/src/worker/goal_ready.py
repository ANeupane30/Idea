"""A goal's preparation after its sources are read: the check, the map, matching, the gap phase, ready."""

import logging
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from worker.discovery.gaps import gap_queries
from worker.discovery.handler import COVERED, UNCOVERED_SQL

log = logging.getLogger(__name__)

PREP_BUDGET_S = 300  # a goal's preparation budget (spec: 5 minutes)
GAP_PHASE_S = 45  # hard cap on the gap phase







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
    if busy:
        return
    g = conn.execute(
        "select gap_deadline, extract(epoch from now() - coalesce(prep_started_at, now())) as elapsed"
        " from goals where id = %s", (goal_id,),
    ).fetchone()
    uncovered = len(conn.execute(UNCOVERED_SQL, {"goal": goal_id, "covered": COVERED}).fetchall())
    total = conn.execute(
        "select count(*) as n from subtopics where goal_id = %s and parent_id is null", (goal_id,)
    ).fetchone()["n"]
    log.info("map coverage: %s/%s topics (goal %s)", total - uncovered, total, goal_id)
    if g["gap_deadline"] is None and uncovered:
        n = gap_queries(remaining_s=PREP_BUDGET_S - float(g["elapsed"]), uncovered=uncovered)
        if n:
            conn.execute(
                "update goals set gap_deadline = now() + make_interval(secs => %s) where id = %s",
                (GAP_PHASE_S, goal_id),
            )
            conn.execute(
                "insert into jobs (kind, payload) values ('fill_gaps', %s)",
                (Jsonb({"goal_id": str(goal_id), "queries": n}),),
            )
    # The map is shown now; gap sources (if searched for) are read and matched after, like any late source.
    _ready(conn, goal_id)


def _ready(conn: psycopg.Connection, goal_id: UUID) -> None:
    conn.execute("update goals set map_status = 'ready' where id = %s", (goal_id,))


def mark_ready_if_matching(conn: psycopg.Connection, goal_id: UUID) -> bool:
    moved = conn.execute(
        "update goals set map_status = 'ready' where id = %s and map_status = 'matching_sources' returning id",
        (goal_id,),
    ).fetchone()
    return moved is not None


def sweep_matching_deadlines(conn: psycopg.Connection) -> int:
    """Goals past their gap deadline are shown with what they have (gap sources keep matching after).

    Also a backstop: a goal still matching with nothing in flight and no gap phase moves on."""
    with conn.transaction():
        idle = conn.execute(
            "select id from goals g where map_status = 'matching_sources' and gap_deadline is null"
            " and not exists (select 1 from sources s where s.goal_id = g.id"
            " and s.status in ('queued', 'processing', 'awaiting_map'))"
        ).fetchall()
        for row in idle:
            finish_matching(conn, row["id"])
        rows = conn.execute(
            "update goals set map_status = 'ready' where map_status = 'matching_sources'"
            " and gap_deadline <= now() returning id"
        ).fetchall()
    return len(rows)


def sweep(conn: psycopg.Connection) -> int:
    """The worker's periodic sweep: reading timeouts and gap deadlines."""
    return sweep_reading_timeouts(conn) + sweep_matching_deadlines(conn)






# ------------------------------------------------------------ sources first: once the sources are read

READING_TIMEOUT = "5 minutes"


def queue_job(conn: psycopg.Connection, kind: str, goal_id: UUID) -> None:
    """Queue a job for a goal (payload {goal_id})."""
    conn.execute("insert into jobs (kind, payload) values (%s, %s)", (kind, Jsonb({"goal_id": str(goal_id)})))


def starting_point_map(conn: psycopg.Connection, goal_id: UUID) -> None:
    """No usable material: a map from the intent, labelled a starting point on the page."""
    conn.execute(
        "update goals set map_status = 'building_map', map_note = 'starting_point', expand = true where id = %s",
        (goal_id,),
    )
    queue_job(conn, "topic_map", goal_id)


def search_again_or_fall_back(conn: psycopg.Connection, goal_id: UUID) -> None:
    """Too little found material: one more round from Wikipedia (spec §8), then a starting point."""
    goal = conn.execute("select search_round from goals where id = %s", (goal_id,)).fetchone()
    if goal["search_round"] < 1:
        conn.execute("update goals set search_round = 1, map_status = 'finding_sources' where id = %s", (goal_id,))
        queue_job(conn, "find_sources", goal_id)
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
        queue_job(conn, "check_sources", goal_id)
        return True
    ask = conn.execute(
        "select source_choice is null and exists (select 1 from sources s where s.goal_id = g.id and s.origin = 'user')"
        " as ask from goals g where id = %s", (goal_id,),
    ).fetchone()["ask"]
    if ask:
        # None of the learner's own sources could be read: they decide what happens next (once).
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
