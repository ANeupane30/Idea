"""fill_gaps: one search per uncovered topic, just before the map is shown (time-boxed).

Runs once the map is shown (or, for goals queued before, while matching_sources). Tavily first (Wikipedia without a key or at the quota).
The best new candidate per topic is added; it is read, checked and matched like any source, and
the goal is ready once they're done or at its gap deadline (the sweep)."""

import logging
from collections.abc import Callable
from uuid import UUID

import psycopg
from psycopg import errors as pg_errors

from worker.config import Settings
from worker.discovery import quota, tavily, wikipedia
from worker.discovery.handler import COVERED, UNCOVERED_SQL
from worker.discovery.tavily import QuotaExhausted
from worker.jobs import Job
from worker.ingest.urls import url_key

log = logging.getLogger(__name__)

MAX_QUERIES = 4
MAX_WEB = 4
MAX_VIDEOS = 2
QUOTA_FLOOR = 5  # keep the last free AI requests of the day for the learner's own lessons
STYLE_WORD = {"reading": "tutorial", "visual_video": "video lesson", "hands_on": "example"}
MIN_WORDS = 300


def gap_queries(*, remaining_s: float, uncovered: int) -> int:
    """How many gap searches the preparation budget allows."""
    n = 4 if remaining_s >= 60 else 2 if remaining_s >= 20 else 0
    return min(n, uncovered)


class FillGapsHandler:
    def __init__(
        self,
        settings: Settings,
        *,
        tavily_search: Callable = tavily.search_each,
        wiki_search: Callable = wikipedia.search,
        quota_left: Callable[[str], int | None] = quota.free_requests_left,
    ):
        self._s = settings
        self._tavily = tavily_search
        self._wiki = wiki_search
        self._quota = quota_left

    def run(self, conn: psycopg.Connection, job: Job) -> None:
        from worker.goal_ready import finish_matching  # import here: goal_ready imports this module's job name

        goal_id = UUID(str(job.payload["goal_id"]))
        n = int(job.payload.get("queries") or MAX_QUERIES)
        with conn.transaction():
            goal = conn.execute(
                "select g.user_id, g.title, g.map_status, coalesce(g.search_subject, g.title) as subject,"
                " coalesce(p.learning_style, 'reading') as style"
                " from goals g left join learning_prefs p on p.user_id = g.user_id where g.id = %s", (goal_id,),
            ).fetchone()
            if goal is None or goal["map_status"] not in ("matching_sources", "ready"):
                return
            topics = conn.execute(UNCOVERED_SQL, {"goal": goal_id, "covered": COVERED}).fetchall()[:n]
            have = conn.execute(
                "select url_or_file, type from sources where goal_id = %s and status <> 'failed' and origin = 'auto'",
                (goal_id,),
            ).fetchall()
            urls = {url_key(r["url_or_file"]) for r in conn.execute(
                "select url_or_file from sources where goal_id = %s and status <> 'failed'", (goal_id,)).fetchall()}
        web_left = MAX_WEB - sum(r["type"] == "web" for r in have)
        videos_left = (MAX_VIDEOS if self._s.find_videos else 0) - sum(r["type"] == "youtube" for r in have)
        word = STYLE_WORD.get(goal["style"], "tutorial")

        added = 0
        if topics and (web_left > 0 or videos_left > 0) and not self._ai_quota_low():
            per_topic = self._search(conn, [f"{t['title']} {goal['subject']} {word}" for t in topics],
                                     [f"{t['title']} {goal['subject']}" for t in topics])
            for topic, hits in zip(topics, per_topic):
                for type_, url, text in hits:
                    if url_key(url) in urls or (type_ == "web" and web_left <= 0) or (type_ == "youtube" and videos_left <= 0):
                        continue
                    if not self._add(conn, goal, goal_id, topic["id"], type_, url, text):
                        break
                    urls.add(url_key(url))
                    added += 1
                    web_left -= type_ == "web"
                    videos_left -= type_ == "youtube"
                    break
        if not added:
            with conn.transaction():
                finish_matching(conn, goal_id)  # nothing to wait for: ready now

    def _ai_quota_low(self) -> bool:
        if self._s.llm_provider != "openrouter" or not self._s.openrouter_api_key:
            return False
        left = self._quota(self._s.openrouter_api_key)
        return left is not None and left < QUOTA_FLOOR

    def _search(self, conn, tavily_queries: list[str], wiki_queries: list[str]) -> list[list[tuple[str, str, str | None]]]:
        """Candidates (type, url, page text if the search returned it) per topic, best first."""
        if self._s.tavily_api_key:
            try:
                results = self._tavily(conn, tavily_queries, api_key=self._s.tavily_api_key,
                                       monthly_credits=self._s.tavily_monthly_credits, url=self._s.tavily_url)
                return [[("youtube" if h.is_video else "web", h.url, None if h.is_video else h.raw_content)
                         for h in sorted(hits, key=lambda h: -h.score)]
                        for hits in results]
            except QuotaExhausted as e:
                log.info("search fallback (gaps): Tavily quota (%s)", e)
        out = []
        for q in wiki_queries:
            hits = self._wiki(q, api_url=self._s.wikipedia_api_url, user_agent=self._s.fetch_user_agent)
            out.append([("web", wikipedia.article_url(h.title, self._s.wikipedia_article_url), None) for h in hits
                        if h.wordcount >= MIN_WORDS and not h.disambiguation])
        return out

    @staticmethod
    def _add(conn, goal, goal_id: UUID, topic_id: UUID, type_: str, url: str, text: str | None = None) -> bool:
        try:
            with conn.transaction():
                conn.execute("select set_config('app.creating_goal', %s, true)", (str(goal_id),))
                conn.execute(
                    "insert into sources (user_id, goal_id, type, url_or_file, origin, discovered_for, prefetched)"
                    " values (%s, %s, %s, %s, 'auto', %s, %s)",
                    (goal["user_id"], goal_id, type_, url, topic_id, text),
                )
                conn.execute("select set_config('app.creating_goal', '', true)")
            return True
        except pg_errors.RaiseException as e:
            log.info("gap source not added for goal %s: %s", goal_id, str(e).splitlines()[0])  # e.g. archived
            return False

    def on_retry(self, conn: psycopg.Connection, job: Job) -> None:
        pass

    def on_permanent_failure(self, conn: psycopg.Connection, job: Job, message: str) -> None:
        from worker.goal_ready import mark_ready_if_matching

        with conn.transaction():
            mark_ready_if_matching(conn, UUID(str(job.payload["goal_id"])))
