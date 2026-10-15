"""Fetching user-supplied URLs without reaching private networks (SSRF protection).

Every hop, including each redirect, is resolved and checked before it is requested.
Known gap: a host that re-resolves between the check and the connect (DNS rebinding)
is not pinned; see the Phase 2 follow-ups.
"""

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from worker.ingest.messages import BLOCKED, IS_PDF, NOT_HTML, TOO_LARGE, UNREACHABLE
from worker.jobs import PermanentJobError

MAX_REDIRECTS = 5
MAX_BYTES = 5 * 1024 * 1024
TIMEOUT_S = 15.0
HTML_TYPES = ("text/html", "application/xhtml+xml")
USER_AGENT = "Mozilla/5.0 (compatible; LearningPlatformBot/1.0)"


@dataclass
class FetchedPage:
    url: str
    html: str


def _is_public(addr: str) -> bool:
    ip = ipaddress.ip_address(addr.split("%")[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def check_host_allowed(url: str, allow_private: bool) -> None:
    """Only http(s) URLs whose host resolves only to public addresses (unless allow_private)."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PermanentJobError(BLOCKED)
    if allow_private:
        return
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        raise PermanentJobError(UNREACHABLE)
    if not infos or not all(_is_public(info[4][0]) for info in infos):
        raise PermanentJobError(BLOCKED)


def _read_capped(response: httpx.Response) -> bytes:
    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise PermanentJobError(TOO_LARGE)
    body = bytearray()
    for part in response.iter_bytes():
        body.extend(part)
        if len(body) > MAX_BYTES:
            raise PermanentJobError(TOO_LARGE)
    return bytes(body)


def fetch_html(url: str, *, allow_private: bool, transport: httpx.BaseTransport | None = None) -> FetchedPage:
    """GET an HTML page. 4xx, DNS and connect failures are permanent; 5xx and read timeouts retry."""
    with httpx.Client(
        transport=transport,
        follow_redirects=False,
        timeout=TIMEOUT_S,
        headers={"user-agent": USER_AGENT, "accept": "text/html,application/xhtml+xml"},
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            check_host_allowed(url, allow_private)
            try:
                with client.stream("GET", url) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise PermanentJobError(UNREACHABLE)
                        url = urljoin(url, location)
                        continue
                    if 400 <= response.status_code < 500:
                        raise PermanentJobError(UNREACHABLE)
                    response.raise_for_status()
                    ctype = response.headers.get("content-type", "text/html").split(";")[0].strip().lower()
                    if ctype == "application/pdf":
                        raise PermanentJobError(IS_PDF)
                    if ctype not in HTML_TYPES:
                        raise PermanentJobError(NOT_HTML)
                    body = _read_capped(response)
                    encoding = response.charset_encoding or "utf-8"
                    return FetchedPage(url, body.decode(encoding, errors="replace"))
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.UnsupportedProtocol, httpx.InvalidURL):
                raise PermanentJobError(UNREACHABLE)
        raise PermanentJobError(UNREACHABLE)
