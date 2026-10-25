"""discover_sources: adds Wikipedia articles (and YouTube videos for Visual / Video learners)
to the top-level topics the learner's sources don't cover. Runs once per goal after its map
is ready; the sources it adds go through the normal ingestion pipeline as origin = 'auto'."""

import logging
import re
from collections.abc import Callable
from uuid import UUID

import psycopg
from psycopg import errors as pg_errors

from worker.config import Settings
from worker.discovery import quota, wikipedia, youtube
from worker.jobs import Job

log = logging.getLogger(__name__)

MAX_ARTICLES = 4
MAX_VIDEOS = 2
MIN_WORDS = 300
QUOTA_FLOOR = 5  # keep the last free requests of the day for the learner's own map and lessons
COVERED = 0.40  # the relevance at which a topic counts as covered (as for lessons)

_UNCOVERED_SQL = """
select t.id, t.title from subtopics t
where t.goal_id = %(goal)s and t.parent_id is null
  and not exists (
    select 1 from source_coverage c
    join sources s on s.id = c.source_id and s.status <> 'failed'
    join subtopics x on x.id = c.subtopic_id
    where (x.id = t.id or x.parent_id = t.id) and c.relevance >= %(covered)s)
order by t.position
"""


# As the web's goalTopic: search for the subject, not the learner's phrasing around it.
_LEADING_VERBS = re.compile(r"^(learn the basics of|learn about|learn|how to|understand|master)\s+", re.I)


def goal_topic(goal_title: str) -> str:
    """The subject of a goal: "Learn the basics of personal finance" -> "personal finance"."""
    title = goal_title.strip()
    return _LEADING_VERBS.sub("", title).strip() or title


class _Stop(Exception):
    """The goal can't take more sources (archived, quota)."""


class DiscoverHandler:
    def __init__(
        self,
        settings: Settings,
        *,
        wiki_search: Callable = wikipedia.search,
        yt_search: Callable = youtube.search,
        quota_left: Callable[[str], int | None] = quota.free_requests_left,
    ):
        self._s = settings
        self._wiki = wiki_search
        self._yt = yt_search
        self._quota = quota_left

    def run(self, conn: psycopg.Connection, job: Job) -> None:
        goal_id = UUID(str(job.payload["goal_id"]))
        only = job.payload.get("wikipedia_for")
        try:
            self._discover(conn, goal_id, UUID(only) if only else None)
        finally:
            self._done(conn, goal_id)

    def _discover(self, conn: psycopg.Connection, goal_id: UUID, wikipedia_for: UUID | None) -> None:
        if not self._s.discovery_enabled:
            return
        with conn.transaction():
            goal = conn.execute(
                "select g.user_id, g.title, g.status, g.map_status, coalesce(p.learning_style, 'reading') as style"
                " from goals g left join learning_prefs p on p.user_id = g.user_id where g.id = %s",
                (goal_id,),
            ).fetchone()
            if goal is None or goal["status"] != "active" or goal["map_status"] != "ready":
                return
            topics = conn.execute(_UNCOVERED_SQL, {"goal": goal_id, "covered": COVERED}).fetchall()
            if wikipedia_for is not None:
                top = conn.execute(
                    "select coalesce(parent_id, id) as id from subtopics where id = %s", (wikipedia_for,)
                ).fetchone()
                topics = [t for t in topics if top and t["id"] == top["id"]]
            urls = {r["url_or_file"] for r in conn.execute(
                "select url_or_file from sources where goal_id = %s and status <> 'failed'", (goal_id,)
            ).fetchall()}
            counts = {r["type"]: r["n"] for r in conn.execute(
                "select type, count(*) as n from sources where goal_id = %s and origin = 'auto' group by type",
                (goal_id,),
            ).fetchall()}

        videos_left = MAX_VIDEOS - counts.get("youtube", 0)
        articles_left = MAX_ARTICLES - counts.get("web", 0)
        want_videos = goal["style"] == "visual_video" and self._s.youtube_api_key and wikipedia_for is None
        try:
            for i, topic in enumerate(topics):
                query = f"{topic['title']} {goal_topic(goal['title'])}"
                if want_videos and i < MAX_VIDEOS and videos_left > 0:
                    ids = self._yt(query, api_key=self._s.youtube_api_key, api_url=self._s.youtube_api_url)
                    url = next((u for u in (f"https://www.youtube.com/watch?v={v}" for v in ids) if u not in urls), None)
                    if url:
                        self._add(conn, goal, goal_id, topic["id"], "youtube", url)
                        urls.add(url)
                        videos_left -= 1
                        continue
                if articles_left <= 0:
                    continue
                hits = self._wiki(query, api_url=self._s.wikipedia_api_url, user_agent=self._s.fetch_user_agent)
                url = next(
                    (u for u in (wikipedia.article_url(h.title, self._s.wikipedia_article_url) for h in hits
                                 if h.wordcount >= MIN_WORDS and not h.disambiguation) if u not in urls),
                    None,
                )
                if url:
                    self._add(conn, goal, goal_id, topic["id"], "web", url)
                    urls.add(url)
                    articles_left -= 1
        except _Stop as e:
            log.info("discovery for goal %s stopped: %s", goal_id, e)

    def _add(self, conn, goal, goal_id: UUID, topic_id: UUID, type_: str, url: str) -> None:
        if self._s.llm_provider == "openrouter" and self._s.openrouter_api_key:
            left = self._quota(self._s.openrouter_api_key)
            if left is not None and left < QUOTA_FLOOR:
                raise _Stop(f"only {left} free AI requests left today")
        try:
            with conn.transaction():
                conn.execute(
                    "insert into sources (user_id, goal_id, type, url_or_file, origin, discovered_for)"
                    " values (%s, %s, %s, %s, 'auto', %s)",
                    (goal["user_id"], goal_id, type_, url, topic_id),
                )
        except pg_errors.RaiseException as e:
            # goal_archived / goal_not_ready: the learner moved on.
            raise _Stop(str(e).splitlines()[0]) from e

    @staticmethod
    def _done(conn: psycopg.Connection, goal_id: UUID) -> None:
        with conn.transaction():
            conn.execute("update goals set discovery_status = 'done' where id = %s", (goal_id,))

    def on_retry(self, conn: psycopg.Connection, job: Job) -> None:
        self._done(conn, UUID(str(job.payload["goal_id"])))

    def on_permanent_failure(self, conn: psycopg.Connection, job: Job, message: str) -> None:
        self._done(conn, UUID(str(job.payload["goal_id"])))
