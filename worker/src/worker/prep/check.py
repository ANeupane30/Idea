"""check_sources: vet a goal's read sources before any map is designed.

Found sources that don't pass are deleted; the best 4 that pass are kept. If the learner's own
sources don't pass, the learner decides (find sources for me, or use mine anyway)."""

import logging
from uuid import UUID

import psycopg

from worker.goal_ready import finish_reading, queue_job, search_again_or_fall_back, starting_point_map
from worker.ingest.extract_web import extract_markdown
from worker.jobs import Job
from worker.llm import LLM
from worker.prep.vet import MAX_TEXT, SourceForCheck, is_vetted, load_for_check, log_rejected, vet

log = logging.getLogger(__name__)

KEEP_FOUND = 4
MAX_VIDEOS = 2
MIN_VETTED = 2


class VetFoundHandler:
    """vet_found: check found pages from the text the search returned, while they're being read.

    Pages that pass are vetted; pages that don't are deleted. Whatever has no verdict (or no text)
    is left for check_sources, which then has little or nothing to ask the model."""

    def __init__(self, llm: LLM):
        self._llm = llm

    def run(self, conn: psycopg.Connection, job: Job) -> None:
        goal_id = UUID(str(job.payload["goal_id"]))
        with conn.transaction():
            goal = conn.execute(
                "select map_status, coalesce(intent, title) as intent from goals where id = %s", (goal_id,)
            ).fetchone()
            if goal is None or goal["map_status"] not in PRE_CHECK:
                return
            rows = conn.execute(
                "select id, coalesce(title, url_or_file) as title, url_or_file, type, prefetched from sources"
                " where goal_id = %s and origin = 'auto' and vetted is null and prefetched is not null"
                " order by created_at, id", (goal_id,),
            ).fetchall()
        to_check = [_from_text(r) for r in rows]
        verdicts = vet(self._llm, goal["intent"], to_check)  # no transaction open across the AI calls

        with conn.transaction():
            locked = conn.execute("select map_status from goals where id = %s for update", (goal_id,)).fetchone()
            if locked is None or locked["map_status"] not in PRE_CHECK:
                return
            for c in to_check:
                v = verdicts.get(c.id)
                if v is None:
                    continue  # check_sources asks again after reading
                if is_vetted(v):
                    conn.execute("update sources set vetted = true, vet_reason = %s where id = %s and vetted is null",
                                 (v.reason, c.id))
                else:
                    log_rejected(c.url, v)
                    conn.execute("delete from sources where id = %s and vetted is null", (c.id,))
            finish_reading(conn, goal_id)  # a deleted page may have been the last one in flight

    def on_retry(self, conn: psycopg.Connection, job: Job) -> None:
        pass

    def on_permanent_failure(self, conn: psycopg.Connection, job: Job, message: str) -> None:
        pass  # check_sources checks them after reading instead


PRE_CHECK = ("reading_sources", "checking_sources")


def _from_text(row) -> SourceForCheck:
    page = extract_markdown(None, row["prefetched"])
    return SourceForCheck(
        id=str(row["id"]),
        title=row["title"] or page.title or "",
        url=row["url_or_file"],
        type=row["type"],
        headings=[h.title for h in page.headings],
        text=" ".join(s.text for s in page.segments)[:MAX_TEXT],
    )


class CheckSourcesHandler:
    def __init__(self, llm: LLM):
        self._llm = llm

    def run(self, conn: psycopg.Connection, job: Job) -> None:
        goal_id = UUID(str(job.payload["goal_id"]))
        with conn.transaction():
            goal = conn.execute(
                "select map_status, coalesce(intent, title) as intent from goals where id = %s", (goal_id,)
            ).fetchone()
            if goal is None or goal["map_status"] != "checking_sources":
                return
            pending = [r["id"] for r in conn.execute(
                "select id from sources where goal_id = %s and status = 'awaiting_map' and vetted is null"
                " order by created_at, id", (goal_id,),
            ).fetchall()]
            to_check = load_for_check(conn, pending)
        verdicts = vet(self._llm, goal["intent"], to_check)  # no transaction open across the AI calls

        with conn.transaction():
            locked = conn.execute("select map_status from goals where id = %s for update", (goal_id,)).fetchone()
            if locked is None or locked["map_status"] != "checking_sources":
                return
            for sid in pending:
                v = verdicts.get(str(sid))
                origin = conn.execute("select origin, url_or_file from sources where id = %s", (sid,)).fetchone()
                if origin is None:
                    continue
                if origin["origin"] == "auto":
                    if is_vetted(v):
                        conn.execute("update sources set vetted = true, vet_reason = %s where id = %s", (v.reason, sid))
                    else:
                        log_rejected(origin["url_or_file"], v)
                        conn.execute("delete from sources where id = %s", (sid,))
                elif v is None:
                    # No reliable verdict for the learner's own source: don't block them on it.
                    log.info("no verdict for source %s; treating it as usable", sid)
                    conn.execute("update sources set vetted = true where id = %s", (sid,))
                else:
                    conn.execute("update sources set vetted = %s, vet_reason = %s where id = %s",
                                 (is_vetted(v), v.reason, sid))
            self._keep_best_found(conn, goal_id)
            self._decide(conn, goal_id)

    @staticmethod
    def _keep_best_found(conn: psycopg.Connection, goal_id: UUID) -> None:
        found = conn.execute(
            "select id, type from sources where goal_id = %s and found_for_goal and vetted"
            " order by search_score desc nulls last, created_at, id", (goal_id,),
        ).fetchall()
        kept, videos = 0, 0
        for r in found:
            is_video = r["type"] == "youtube"
            if kept < KEEP_FOUND and not (is_video and videos >= MAX_VIDEOS):
                kept += 1
                videos += is_video
            else:
                conn.execute("delete from sources where id = %s", (r["id"],))

    @staticmethod
    def _decide(conn: psycopg.Connection, goal_id: UUID) -> None:
        c = conn.execute(
            "select count(*) filter (where status = 'awaiting_map' and origin = 'user' and vetted = false) as rejected_own,"
            " count(*) filter (where status = 'awaiting_map' and vetted) as vetted,"
            " bool_or(origin = 'user') as has_own,"
            " (select search_round from goals where id = %(g)s) as round,"
            " (select source_choice from goals where id = %(g)s) as choice"
            " from sources where goal_id = %(g)s",
            {"g": goal_id},
        ).fetchone()
        counts_own = c["has_own"] and c["choice"] is None  # after "find", only found material counts
        if c["rejected_own"] and c["choice"] is None:
            conn.execute("update goals set map_status = 'awaiting_source_decision' where id = %s", (goal_id,))
        elif not counts_own and c["vetted"] < MIN_VETTED and c["round"] < 1:
            search_again_or_fall_back(conn, goal_id)  # found material only, and too little of it passed
        elif c["vetted"] == 0:
            starting_point_map(conn, goal_id)
        else:
            _build(conn, goal_id)

    def on_retry(self, conn: psycopg.Connection, job: Job) -> None:
        pass

    def on_permanent_failure(self, conn: psycopg.Connection, job: Job, message: str) -> None:
        """The check itself broke: build from what was read rather than leave the goal waiting."""
        goal_id = UUID(str(job.payload["goal_id"]))
        with conn.transaction():
            moved = conn.execute(
                "update goals set map_status = 'building_map' where id = %s and map_status = 'checking_sources'"
                " returning id", (goal_id,),
            ).fetchone()
            if moved:
                conn.execute("update sources set vetted = true where goal_id = %s and status = 'awaiting_map'"
                             " and vetted is null", (goal_id,))
                queue_job(conn, "topic_map", goal_id)


def _build(conn: psycopg.Connection, goal_id: UUID) -> None:
    conn.execute("update goals set map_status = 'building_map' where id = %s", (goal_id,))
    queue_job(conn, "topic_map", goal_id)
