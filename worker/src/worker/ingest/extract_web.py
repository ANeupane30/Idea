"""Web extraction: trafilatura, with a headless Chromium fallback for pages that need JavaScript."""

from typing import Protocol

import httpx
import trafilatura

from worker.ingest import safe_fetch
from worker.ingest.chunking import clean_text
from worker.ingest.messages import NO_TEXT
from worker.ingest.types import Extracted, Segment
from worker.jobs import PermanentJobError

MIN_TEXT_CHARS = 200
RENDER_TIMEOUT_MS = 20_000
IDLE_WAIT_MS = 5_000
ANCHOR_WORDS = 10
_SKIPPED_RESOURCES = {"image", "media", "font"}


class Renderer(Protocol):
    def render(self, url: str) -> str: ...


class PlaywrightRenderer:
    """Renders a page in headless Chromium. Every request it makes passes the same host check."""

    def __init__(self, allow_private: bool):
        self._allow_private = allow_private
        self.aborted: list[str] = []

    def _route(self, route) -> None:
        request = route.request
        if request.resource_type in _SKIPPED_RESOURCES:
            route.abort()
            return
        if request.url.startswith(("data:", "blob:")):
            route.continue_()
            return
        try:
            safe_fetch.check_host_allowed(request.url, self._allow_private)
        except PermanentJobError:
            self.aborted.append(request.url)
            route.abort("blockedbyclient")
            return
        route.continue_()

    def render(self, url: str) -> str:
        safe_fetch.check_host_allowed(url, self._allow_private)
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch()
            try:
                context = browser.new_context(accept_downloads=False, java_script_enabled=True)
                page = context.new_page()
                page.route("**/*", self._route)
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


def extract_web(
    url: str, *, allow_private: bool, renderer: Renderer, transport: httpx.BaseTransport | None = None
) -> Extracted:
    page = safe_fetch.fetch_html(url, allow_private=allow_private, transport=transport)
    html = page.html
    text = _text(html)
    if len(text) < MIN_TEXT_CHARS:
        html = renderer.render(page.url)
        text = _text(html)
        if len(text) < MIN_TEXT_CHARS:
            raise PermanentJobError(NO_TEXT)
    # trafilatura's text output puts one paragraph per line.
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    segments = [Segment(p, {"anchor": " ".join(p.split()[:ANCHOR_WORDS])}) for p in paragraphs]
    return Extracted(title=_title(html), segments=segments)
