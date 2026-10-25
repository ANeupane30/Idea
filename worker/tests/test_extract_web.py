import httpx
import pytest

from pathlib import Path
from worker.ingest import extract_web as extract_web_module
from worker.ingest import messages
from worker.ingest.extract_web import PlaywrightRenderer, extract_web
from worker.jobs import PermanentJobError

SITES_DIR = Path(__file__).parent / "fixtures" / "sites"


def serve_file(name: str) -> httpx.MockTransport:
    body = (SITES_DIR / name).read_text(encoding="utf-8")
    return httpx.MockTransport(
        lambda request: httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=body)
    )


class SpyRenderer:
    def __init__(self, html: str):
        self.html = html
        self.calls: list[str] = []

    def render(self, url: str) -> str:
        self.calls.append(url)
        return self.html


class FailRenderer:
    def render(self, url: str) -> str:
        raise AssertionError("renderer must not be used for a readable page")


def test_extract_article():
    out = extract_web(
        "http://127.0.0.1/article.html",
        allow_private=True,
        renderer=FailRenderer(),
        transport=serve_file("article.html"),
    )
    assert out.title == "A practical guide to SQL: SELECT, WHERE and JOIN"
    assert len(out.segments) >= 5
    assert all(s.location["anchor"] and len(s.location["anchor"].split()) <= 10 for s in out.segments)
    text = " ".join(s.text for s in out.segments)
    assert "WHERE" in text
    assert "newsletter" not in text  # boilerplate dropped


def test_js_page_falls_back_to_renderer():
    spy = SpyRenderer((SITES_DIR / "article.html").read_text(encoding="utf-8"))
    out = extract_web(
        "http://127.0.0.1/js_only.html", allow_private=True, renderer=spy, transport=serve_file("js_only.html")
    )
    assert spy.calls == ["http://127.0.0.1/js_only.html"]
    assert "WHERE" in " ".join(s.text for s in out.segments)


def test_no_text():
    with pytest.raises(PermanentJobError) as e:
        extract_web(
            "http://127.0.0.1/empty.html",
            allow_private=True,
            renderer=SpyRenderer("<html><body></body></html>"),
            transport=serve_file("empty.html"),
        )
    assert e.value.message == messages.NO_TEXT


def test_renderer_runs_javascript(site_server):
    html = PlaywrightRenderer(allow_private=True).render(f"{site_server}/js_only.html")
    assert "Filtering with WHERE keeps only the rows" in html


def test_renderer_aborts_private_subrequests(site_server, monkeypatch):
    def allow_only_loopback(url: str, allow_private: bool) -> None:
        if "10.255.255.1" in url:
            raise PermanentJobError(messages.BLOCKED)

    monkeypatch.setattr(extract_web_module.safe_fetch, "check_host_allowed", allow_only_loopback)
    renderer = PlaywrightRenderer(allow_private=False)
    html = renderer.render(f"{site_server}/js_only.html")
    assert "Filtering with WHERE keeps only the rows" in html
    assert any("10.255.255.1" in u for u in renderer.aborted)


def test_renderer_blocks_private_page():
    with pytest.raises(PermanentJobError) as e:
        PlaywrightRenderer(allow_private=False).render("http://127.0.0.1:9/")
    assert e.value.message == messages.BLOCKED


def _block_localhost(monkeypatch):
    """127.0.0.1 is allowed (the fixture server); the name "localhost" stands in for a private host."""

    def check(url: str, allow_private: bool) -> None:
        from urllib.parse import urlsplit

        if urlsplit(url).hostname == "localhost":
            raise PermanentJobError(messages.BLOCKED)

    monkeypatch.setattr(extract_web_module.safe_fetch, "check_host_allowed", check)


def test_renderer_blocks_navigation_redirect_to_private(site_server, monkeypatch):
    _block_localhost(monkeypatch)
    renderer = PlaywrightRenderer(allow_private=False)
    html = renderer.render(f"{site_server}/js_redirect.html")
    assert "TOPSECRET" not in html
    assert any("localhost" in u for u in renderer.aborted)


def test_renderer_blocks_subrequest_redirect_to_private(site_server, monkeypatch):
    _block_localhost(monkeypatch)
    renderer = PlaywrightRenderer(allow_private=False)
    html = renderer.render(f"{site_server}/js_fetch_redirect.html")
    assert "Start page." in html
    assert "TOPSECRET" not in html
    assert any("localhost" in u for u in renderer.aborted)


# ------------------------------------------------------------ paywalls and sign-in walls

from worker.ingest.extract_web import looks_gated  # noqa: E402

SHORT_TEXT = " ".join(["word"] * 120)
LONG_TEXT = " ".join(["word"] * 400)
SIGN_IN = (
    "<html><head><title>Sign in</title></head><body><main><h1>Sign in to continue</h1>"
    f"<p>{SHORT_TEXT}</p><form><input type='email' name='e'><input type=\"PASSWORD\" name='p'></form></main></body></html>"
)


def test_short_course_page_is_gated():
    assert looks_gated("https://www.udemy.com/course/x/", "<html></html>", SHORT_TEXT)
    assert looks_gated("https://coursera.org/learn/y", "<html></html>", SHORT_TEXT)
    assert looks_gated("https://www.linkedin.com/learning/z", "<html></html>", SHORT_TEXT)


def test_long_course_article_is_not_gated():
    assert not looks_gated("https://www.coursera.org/articles/what-is-sql", "<html></html>", LONG_TEXT)


def test_linkedin_outside_learning_is_not_gated_by_host():
    assert not looks_gated("https://www.linkedin.com/in/someone", "<html></html>", SHORT_TEXT)


def test_short_page_with_a_password_field_is_gated_anywhere():
    assert looks_gated("https://example.org/members", SIGN_IN, SHORT_TEXT)
    assert not looks_gated("https://example.org/members", SIGN_IN, LONG_TEXT)


def test_lookalike_host_is_not_gated():
    assert not looks_gated("https://notudemy.com/course/x", "<html></html>", SHORT_TEXT)


def test_extract_web_raises_paywalled_for_a_sign_in_page():
    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=SIGN_IN)
    )
    with pytest.raises(PermanentJobError) as e:
        extract_web("http://127.0.0.1/members", allow_private=True, renderer=SpyRenderer(SIGN_IN), transport=transport)
    assert e.value.message == messages.PAYWALLED
    assert messages.PAYWALLED == (
        "We can't read this page, it needs a login. Paste the course's syllabus or table of contents instead."
    )


def test_headings_skip_comments_between_a_heading_and_its_text():
    """Seen on staging: a comment after a heading crashed extraction (HtmlComment has no text)."""
    from worker.ingest.extract_web import _headings

    (h,) = _headings("<html><body><h2>Growth</h2><!-- ad --><p>Plants grow from seeds.</p></body></html>")
    assert h.title == "Growth" and h.first_sentence == "Plants grow from seeds."
