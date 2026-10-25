"""YouTube Data API search (free Google key, about 100 searches a day)."""

import logging

import httpx2 as httpx

log = logging.getLogger(__name__)


def search(query: str, *, api_key: str, api_url: str, transport=None) -> list[str]:
    params = {
        "part": "snippet", "q": query, "key": api_key, "type": "video",
        # Captioned, 4-20 minute videos: no transcript-less videos or hours-long streams.
        "videoCaption": "closedCaption", "videoDuration": "medium",
        "relevanceLanguage": "en", "safeSearch": "strict", "maxResults": "5",
    }
    try:
        with httpx.Client(timeout=15, transport=transport) as client:
            r = client.get(api_url, params=params)
        r.raise_for_status()
        return [item["id"]["videoId"] for item in r.json()["items"]]
    except Exception as e:  # noqa: BLE001 - best effort, as for Wikipedia
        log.warning("YouTube search failed: %s", type(e).__name__)
        return []
