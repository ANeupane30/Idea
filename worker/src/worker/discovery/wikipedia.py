"""Wikipedia's search API (free, no key; it asks for a descriptive User-Agent)."""

import logging
import re
from dataclasses import dataclass
from urllib.parse import quote

import httpx2 as httpx

log = logging.getLogger(__name__)

_TAGS = re.compile(r"<[^>]+>")


@dataclass
class WikiHit:
    title: str
    wordcount: int
    disambiguation: bool


def _is_disambiguation(title: str, snippet: str) -> bool:
    # list=search can't return pageprops, so use the title convention and the standard opening line.
    return title.endswith("(disambiguation)") or "may refer to" in _TAGS.sub("", snippet).lower()


def search(query: str, *, api_url: str, user_agent: str, transport=None) -> list[WikiHit]:
    params = {
        "action": "query", "list": "search", "srsearch": query, "srlimit": "5",
        "srprop": "wordcount|snippet", "format": "json", "formatversion": "2",
    }
    try:
        with httpx.Client(timeout=15, transport=transport, headers={"User-Agent": user_agent}) as client:
            r = client.get(api_url, params=params)
        r.raise_for_status()
        results = r.json()["query"]["search"]
        return [
            WikiHit(h["title"], int(h.get("wordcount", 0)), _is_disambiguation(h["title"], h.get("snippet", "")))
            for h in results
        ]
    except Exception as e:  # noqa: BLE001 - discovery is best effort; the map works without it
        log.warning("Wikipedia search failed for %r: %s", query, type(e).__name__)
        return []


def article_url(title: str, template: str) -> str:
    return template.format(title=quote(title.replace(" ", "_"), safe="_()"))
