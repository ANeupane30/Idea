"""Web extraction: trafilatura, with a headless Chromium fallback for pages that need JavaScript."""

from typing import Protocol
import re
from urllib.parse import urljoin, urlsplit

import httpx
import lxml.html
import trafilatura

from worker.config import DEFAULT_USER_AGENT
from worker.ingest import safe_fetch
from worker.ingest.chunking import clean_text
from worker.ingest.messages import NO_TEXT, PAYWALLED
from worker.ingest.types import Extracted, Heading, Segment
from worker.jobs import PermanentJobError
from worker.structure import first_sentence

MIN_TEXT_CHARS = 200
RENDER_TIMEOUT_MS = 20_000
IDLE_WAIT_MS = 5_000
ANCHOR_WORDS = 10
_SKIPPED_RESOURCES = {"image", "media", "font"}


class Renderer(Protocol):
    def render(self, url: str) -> str: ...


class PlaywrightRenderer:
    """Renders a page in headless (sandboxed) Chromium without letting it reach private networks.

    Chromium never fetches anything itself: every request of every page and frame goes
    through `context.route`, which fetches it one hop at a time (redirects off) and runs
    the same host check on the URL and on each redirect target. Service workers, whose
    requests would skip routing, are blocked, and WebSockets are never connected.
    """

    def __init__(self, allow_private: bool):
        self._allow_private = allow_private
        self.aborted: list[str] = []

    def _route(self, route) -> None:
        request = route.request
        if request.resource_type in _SKIPPED_RESOURCES:
            route.abort()
            return
        url = request.url
        if url.startswith(("data:", "blob:")):
            route.continue_()
            return
        try:
            for _ in range(safe_fetch.MAX_REDIRECTS + 1):
                safe_fetch.check_host_allowed(url, self._allow_private)
                response = route.fetch(url=url, max_redirects=0, timeout=safe_fetch.TIMEOUT_S * 1000)
                location = response.headers.get("location")
                if 300 <= response.status < 400 and location:
                    url = urljoin(url, location)
                    continue
                route.fulfill(response=response)
                return
            route.abort("blockedbyclient")
        except PermanentJobError:
            self.aborted.append(url)
            route.abort("blockedbyclient")
        except Exception:
            route.abort("failed")

    def render(self, url: str) -> str:
        safe_fetch.check_host_allowed(url, self._allow_private)
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(chromium_sandbox=True)
            try:
                context = browser.new_context(
                    accept_downloads=False, java_script_enabled=True, service_workers="block"
                )
                context.route("**/*", self._route)
                context.route_web_socket("**/*", lambda ws: ws.close())
                page = context.new_page()
                page.goto(url, wait_until="load", timeout=RENDER_TIMEOUT_MS)
                # Give scripts time to fetch and render content, but don't wait forever on
                # pages whose network never goes idle (polling, hung requests).
                try:
                    page.wait_for_load_state("networkidle", timeout=IDLE_WAIT_MS)
                except PlaywrightTimeoutError:
                    pass
                return page.content()
            finally:
                browser.close()


def _text(html: str) -> str:
    return clean_text(
        trafilatura.extract(html, output_format="txt", include_comments=False, favor_recall=True) or ""
    )


def _title(html: str) -> str | None:
    meta = trafilatura.extract_metadata(html)
    return meta.title if meta and meta.title else None


# Course platforms whose pages are login-walled: a short page there is the sign-in or sales page.
GATED_HOSTS = ("udemy.com", "coursera.org", "edx.org", "oreilly.com", "skillshare.com", "pluralsight.com")
GATED_PATHS = {"linkedin.com": "/learning"}
GATED_MAX_WORDS = 300
_PASSWORD_FIELD = re.compile(r"""<input\b[^>]*\btype\s*=\s*["']?password\b""", re.I)


def _host_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def looks_gated(url: str, html: str, text: str) -> bool:
    """A page we can't learn from without logging in: a short page on a course platform, or any
    short page that is mostly a sign-in form."""
    if len(text.split()) >= GATED_MAX_WORDS:
        return False
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if any(_host_matches(host, d) for d in GATED_HOSTS):
        return True
    if any(_host_matches(host, d) and parts.path.startswith(p) for d, p in GATED_PATHS.items()):
        return True
    return bool(_PASSWORD_FIELD.search(html))


# Section headings that are never topics.
_BOILERPLATE = {"contents", "references", "see also", "external links", "further reading", "notes", "navigation menu"}


def _headings(html: str) -> list[Heading]:
    """H1-H3 in document order, each with the first sentence of the text that follows it."""
    try:
        root = lxml.html.fromstring(html)
    except (ValueError, lxml.etree.ParserError):
        return []
    out: list[Heading] = []
    for el in root.iter("h1", "h2", "h3"):
        title = " ".join(el.text_content().split())
        if not title or title.casefold().rstrip(":") in _BOILERPLATE:
            continue
        following = ""
        for sib in el.itersiblings():
            if sib.tag in ("h1", "h2", "h3"):
                break
            following = " ".join(sib.text_content().split())
            if following:
                break
        out.append(Heading(title, int(el.tag[1]), first_sentence(following)))
    return out


def extract_web(
    url: str,
    *,
    allow_private: bool,
    renderer: Renderer,
    transport: httpx.BaseTransport | None = None,
    user_agent: str = DEFAULT_USER_AGENT,
) -> Extracted:
    page = safe_fetch.fetch_html(url, allow_private=allow_private, transport=transport, user_agent=user_agent)
    html = page.html
    text = _text(html)
    if len(text) < MIN_TEXT_CHARS:
        html = renderer.render(page.url)
        text = _text(html)
    # After rendering: a JavaScript page may have content once it runs.
    if looks_gated(str(page.url), html, text):
        raise PermanentJobError(PAYWALLED)
    if len(text) < MIN_TEXT_CHARS:
        raise PermanentJobError(NO_TEXT)
    # trafilatura's text output puts one paragraph per line.
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    segments = [Segment(p, {"anchor": " ".join(p.split()[:ANCHOR_WORDS])}) for p in paragraphs]
    return Extracted(title=_title(html), segments=segments, headings=_headings(html))
