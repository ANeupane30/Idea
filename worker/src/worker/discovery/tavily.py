"""Tavily web search (free tier: 1,000 credits a month; a basic search costs 1).

Credits are counted per month in search_usage, so the worker stops calling Tavily at the
limit and falls back to Wikipedia instead of being refused mid-goal."""

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx2 as httpx
import psycopg

log = logging.getLogger(__name__)

TAVILY_URL = "https://api.tavily.com/search"
EXCLUDED_DOMAINS = [
    "pinterest.com", "facebook.com", "instagram.com", "tiktok.com", "x.com",
    "twitter.com", "quora.com", "amazon.com", "medium.com/tag",
]
MAX_RESULTS = 8
TIMEOUT_S = 10.0
WARN_AT = 0.8
_VIDEO_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}


@dataclass(frozen=True)
class TavilyHit:
    url: str
    title: str
    score: float
    is_video: bool


class QuotaExhausted(Exception):
    """Tavily's monthly credits are used up (by our count, or Tavily said so)."""


def _month():
    return datetime.now(timezone.utc).date().replace(day=1)


def _used(conn: psycopg.Connection) -> int:
    with conn.transaction():
        row = conn.execute("select credits from search_usage where month = %s", (_month(),)).fetchone()
    return row["credits"] if row else 0


def _count(conn: psycopg.Connection, limit: int) -> None:
    with conn.transaction():
        row = conn.execute(
            "insert into search_usage (month, credits) values (%s, 1)"
            " on conflict (month) do update set credits = search_usage.credits + 1"
            " returning credits, warned",
            (_month(),),
        ).fetchone()
        if not row["warned"] and row["credits"] >= WARN_AT * limit:
            conn.execute("update search_usage set warned = true where month = %s", (_month(),))
            log.warning("tavily quota 80%% used: %s/%s", row["credits"], limit)


def _fetch(query: str, *, api_key: str, url: str, transport) -> list[TavilyHit] | None:
    """One HTTP search, no database access (safe in threads). None if it failed."""
    body = {
        "query": query,
        "search_depth": "basic",
        "max_results": MAX_RESULTS,
        "exclude_domains": EXCLUDED_DOMAINS,
    }
    try:
        with httpx.Client(timeout=TIMEOUT_S, transport=transport) as client:
            r = client.post(url, json=body, headers={"Authorization": f"Bearer {api_key}"})
    except httpx.HTTPError as e:
        log.warning("Tavily search failed: %s", type(e).__name__)
        return None
    if r.status_code in (429, 432):
        raise QuotaExhausted(f"Tavily answered {r.status_code}")
    if r.status_code != 200:
        log.warning("Tavily search failed: HTTP %s", r.status_code)
        return None
    try:
        return [
            TavilyHit(h["url"], h.get("title") or h["url"], float(h.get("score") or 0),
                      (urlsplit(h["url"]).hostname or "").lower() in _VIDEO_HOSTS)
            for h in r.json()["results"]
        ]
    except (ValueError, KeyError, TypeError):
        log.warning("Tavily answered with an unexpected body")
        return []


def search(
    conn: psycopg.Connection,
    query: str,
    *,
    api_key: str,
    monthly_credits: int,
    url: str = TAVILY_URL,
    transport=None,
) -> list[TavilyHit]:
    return search_many(conn, [query], api_key=api_key, monthly_credits=monthly_credits, url=url, transport=transport)


def search_each(
    conn: psycopg.Connection,
    queries: list[str],
    *,
    api_key: str,
    monthly_credits: int,
    url: str = TAVILY_URL,
    transport=None,
) -> list[list[TavilyHit]]:
    """Several searches at once, results per query (empty where one failed)."""
    if _used(conn) >= monthly_credits:
        raise QuotaExhausted("monthly Tavily credits used up")
    with ThreadPoolExecutor(max_workers=max(1, len(queries))) as pool:
        results = list(pool.map(lambda q: _fetch(q, api_key=api_key, url=url, transport=transport), queries))
    for found in results:
        if found is not None:
            _count(conn, monthly_credits)
    return [found or [] for found in results]


def search_many(
    conn: psycopg.Connection,
    queries: list[str],
    *,
    api_key: str,
    monthly_credits: int,
    url: str = TAVILY_URL,
    transport=None,
) -> list[TavilyHit]:
    """Several searches at once: the quota is checked first, the requests run in parallel with no
    database access, then each answered search is counted. Hits are returned in query order."""
    per_query = search_each(conn, queries, api_key=api_key, monthly_credits=monthly_credits, url=url,
                            transport=transport)
    return [h for hits in per_query for h in hits]
