"""find_sources: search the web (Tavily) for learning material on the goal's intent, and read the
best candidates. Without a Tavily key, at the monthly quota, or with no results, Wikipedia."""

import logging
from collections.abc import Callable
from urllib.parse import urlsplit
from uuid import UUID

import psycopg

from worker.config import Settings
from worker.discovery import tavily, wikipedia
from worker.discovery.tavily import QuotaExhausted, TavilyHit
from worker.goal_ready import finish_reading, starting_point_map
from worker.ingest.urls import url_key
from worker.jobs import Job

log = logging.getLogger(__name__)

MAX_CANDIDATES = 8
MAX_VIDEOS = {"visual_video": 3}
DEFAULT_MAX_VIDEOS = 2
WIKI_CANDIDATES = 4
MIN_WORDS = 300


def _domain(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.").removeprefix("m.")
    return "youtube" if host in ("youtube.com", "youtu.be") else host


def pick_candidates(hits: list[TavilyHit], *, style: str, limit: int = MAX_CANDIDATES, exclude: set[str] = frozenset()) -> list[TavilyHit]:
    max_videos = MAX_VIDEOS.get(style, DEFAULT_MAX_VIDEOS)
    picked: list[TavilyHit] = []
    seen = set(exclude)
    per_domain: dict[str, int] = {}
    for h in sorted(hits, key=lambda h: h.score, reverse=True):
        key = url_key(h.url)
        domain = _domain(h.url)
        cap = max_videos if domain == "youtube" else 1
        if key in seen or per_domain.get(domain, 0) >= cap:
            continue
        if h.is_video and sum(p.is_video for p in picked) >= max_videos:
            continue
        seen.add(key)
        per_domain[domain] = per_domain.get(domain, 0) + 1
        picked.append(h)
        if len(picked) == limit:
            break
    return picked


class FindSourcesHandler:
    def __init__(
        self,
        settings: Settings,
        *,
        tavily_search: Callable = tavily.search_many,
        wiki_search: Callable = wikipedia.search,
    ):
        self._s = settings
        self._tavily = tavily_search
        self._wiki = wiki_search

    def run(self, conn: psycopg.Connection, job: Job) -> None:
        goal_id = UUID(str(job.payload["goal_id"]))
        with conn.transaction():
            goal = conn.execute(
                "select g.user_id, g.title, g.map_status, g.search_subject, g.search_queries, g.search_round,"
                " coalesce(p.learning_style, 'reading') as style"
                " from goals g left join learning_prefs p on p.user_id = g.user_id where g.id = %s",
                (goal_id,),
            ).fetchone()
            if goal is None or goal["map_status"] != "finding_sources":
                return
            existing = {url_key(r["url_or_file"]) for r in conn.execute(
                "select url_or_file from sources where goal_id = %s and status <> 'failed' and type <> 'outline'"
                " and type <> 'pdf'", (goal_id,),
            ).fetchall()}
        subject = goal["search_subject"] or goal["title"]
        queries = list(goal["search_queries"] or []) or [subject]

        candidates: list[tuple[str, str, float | None, str | None]] = []  # (type, url, score, page text)
        reason = None
        if goal["search_round"] >= 1:
            reason = "too few sources passed"
        elif not self._s.tavily_api_key:
            reason = "no Tavily key"
        else:
            try:
                hits = self._tavily(conn, queries, api_key=self._s.tavily_api_key,
                                    monthly_credits=self._s.tavily_monthly_credits, url=self._s.tavily_url)
                picked = pick_candidates(hits, style=goal["style"], exclude=existing)
                candidates = [("youtube" if h.is_video else "web", h.url, h.score, h.raw_content) for h in picked]
                if not candidates:
                    reason = "no usable Tavily results"
            except QuotaExhausted as e:
                reason = f"Tavily quota ({e})"
        if reason:
            log.info("search fallback for goal %s: %s", goal_id, reason)
            hits = self._wiki(subject, api_url=self._s.wikipedia_api_url, user_agent=self._s.fetch_user_agent)
            urls = [wikipedia.article_url(h.title, self._s.wikipedia_article_url) for h in hits
                    if h.wordcount >= MIN_WORDS and not h.disambiguation]
            candidates = [("web", u, None, None) for u in urls if url_key(u) not in existing][:WIKI_CANDIDATES]

        with conn.transaction():
            locked = conn.execute("select map_status from goals where id = %s for update", (goal_id,)).fetchone()
            if locked is None or locked["map_status"] != "finding_sources":
                return
            if not candidates and not existing:
                starting_point_map(conn, goal_id)  # nothing to learn from
                return
            # Sources join a goal that has no map yet the same way the learner's own do at creation.
            conn.execute("select set_config('app.creating_goal', %s, true)", (str(goal_id),))
            for type_, url, score, text in candidates:
                conn.execute(
                    "insert into sources (user_id, goal_id, type, url_or_file, origin, found_for_goal, search_score,"
                    " prefetched) values (%s, %s, %s, %s, 'auto', true, %s, %s)",
                    (goal["user_id"], goal_id, type_, url, score, text if type_ == "web" else None),
                )
            conn.execute("select set_config('app.creating_goal', '', true)")
            conn.execute(
                "update goals set map_status = 'reading_sources', reading_started_at = now() where id = %s", (goal_id,)
            )
            if not candidates:
                finish_reading(conn, goal_id)  # what the goal already has was read before

    def on_retry(self, conn: psycopg.Connection, job: Job) -> None:
        pass

    def on_permanent_failure(self, conn: psycopg.Connection, job: Job, message: str) -> None:
        """Search broke: carry on with a starting-point map rather than leave the goal waiting."""
        goal_id = UUID(str(job.payload["goal_id"]))
        with conn.transaction():
            locked = conn.execute("select map_status from goals where id = %s for update", (goal_id,)).fetchone()
            if locked is not None and locked["map_status"] == "finding_sources":
                starting_point_map(conn, goal_id)
