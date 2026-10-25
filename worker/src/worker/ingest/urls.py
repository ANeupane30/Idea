"""URL normalization (for dedupe), YouTube video ids and content hashes."""

import hashlib
import re
from typing import Literal
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit

TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src", "igshid", "si"}
DEFAULT_PORTS = {"http": 80, "https": 443}
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ID_PATHS = ("shorts", "embed", "live")


def _is_tracking(key: str) -> bool:
    return key.lower().startswith("utm_") or key.lower() in TRACKING_PARAMS


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = host
    if parts.port is not None and parts.port != DEFAULT_PORTS.get(scheme):
        netloc = f"{host}:{parts.port}"
    query = sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _is_tracking(k))
    return urlunsplit((scheme, netloc, parts.path or "/", urlencode(query), ""))


def url_key(url: str) -> str:
    """One key per page: tracking parameters, fragments and a trailing slash don't count."""
    key = normalize_url(url)
    parts = urlsplit(key)
    if parts.path not in ("", "/") and key.endswith("/"):
        key = key[:-1]
    return key


def is_youtube_host(host: str) -> bool:
    return host.lower() in YOUTUBE_HOSTS


def youtube_video_id(url: str) -> str | None:
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if not is_youtube_host(host):
        return None
    segments = [s for s in parts.path.split("/") if s]
    candidate = None
    if host == "youtu.be":
        candidate = segments[0] if segments else None
    elif segments == ["watch"]:
        candidate = (parse_qs(parts.query).get("v") or [None])[0]
    elif len(segments) >= 2 and segments[0] in _ID_PATHS:
        candidate = segments[1]
    return candidate if candidate and _VIDEO_ID.match(candidate) else None


def content_hash(kind: Literal["web", "youtube", "pdf"], key: str) -> str:
    """sha256 hex of "kind:key". For PDFs the key is the sha256 hex of the file bytes."""
    return hashlib.sha256(f"{kind}:{key}".encode()).hexdigest()
