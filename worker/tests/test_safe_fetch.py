import ipaddress
import socket

import httpx
import pytest

from worker.ingest import messages, safe_fetch
from worker.ingest.safe_fetch import check_host_allowed, fetch_html
from worker.jobs import PermanentJobError

PUBLIC_IP = "93.184.216.34"


@pytest.fixture
def public_dns(monkeypatch):
    """Hostnames resolve to a public address; IP literals resolve to themselves."""
    real = socket.getaddrinfo

    def fake(host, *args, **kwargs):
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (PUBLIC_IP, 0))]
        return real(host, *args, **kwargs)

    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo", fake)


def html_response(body: str = "<html><body><p>hi</p></body></html>", status: int = 200) -> httpx.Response:
    return httpx.Response(status, headers={"content-type": "text/html; charset=utf-8"}, text=body)


def permanent_message(fn) -> str:
    with pytest.raises(PermanentJobError) as e:
        fn()
    return e.value.message


def fetch(url: str, handler) -> safe_fetch.FetchedPage:
    return fetch_html(url, allow_private=False, transport=httpx.MockTransport(handler))


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://169.254.169.254/latest",
        "http://[::1]/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://0.0.0.0/",
        "http://localhost/",
        "http://100.100.100.200/latest/meta-data/",
        "http://100.64.0.1/",
        "file:///etc/passwd",
        "ftp://example.com/",
    ],
)
def test_blocks_private_hosts(url):
    assert permanent_message(lambda: check_host_allowed(url, allow_private=False)) == messages.BLOCKED


def test_allow_private_for_tests():
    check_host_allowed("http://127.0.0.1/", allow_private=True)


def test_blocks_redirect_to_private(public_dns):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "public.test":
            return httpx.Response(302, headers={"location": "http://127.0.0.1/admin"})
        raise AssertionError("the private address must never be requested")

    assert permanent_message(lambda: fetch("https://public.test/", handler)) == messages.BLOCKED


def test_follows_relative_redirect(public_dns):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/old":
            return httpx.Response(301, headers={"location": "/new"})
        return html_response("<p>new</p>")

    page = fetch("https://public.test/old", handler)
    assert page.url == "https://public.test/new"
    assert "new" in page.html


def test_redirect_limit(public_dns):
    def handler(request: httpx.Request) -> httpx.Response:
        n = int(request.url.path.strip("/") or 0)
        return httpx.Response(302, headers={"location": f"/{n + 1}"})

    assert permanent_message(lambda: fetch("https://public.test/0", handler)) == messages.UNREACHABLE


def test_rejects_pdf_and_non_html(public_dns):
    def pdf(request):
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.7")

    def png(request):
        return httpx.Response(200, headers={"content-type": "image/png"}, content=b"\x89PNG")

    assert permanent_message(lambda: fetch("https://public.test/a.pdf", pdf)) == messages.IS_PDF
    assert permanent_message(lambda: fetch("https://public.test/a.png", png)) == messages.NOT_HTML


def test_body_cap(public_dns):
    def big(request):
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"a" * (6 * 1024 * 1024))

    assert permanent_message(lambda: fetch("https://public.test/", big)) == messages.TOO_LARGE


def test_4xx_permanent_5xx_retryable(public_dns):
    def not_found(request):
        return httpx.Response(404, text="nope")

    def unavailable(request):
        return httpx.Response(503, text="later")

    assert permanent_message(lambda: fetch("https://public.test/", not_found)) == messages.UNREACHABLE
    with pytest.raises(Exception) as e:
        fetch("https://public.test/", unavailable)
    assert not isinstance(e.value, PermanentJobError)


def test_connect_failure_permanent_read_timeout_retryable(public_dns):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    assert permanent_message(lambda: fetch("https://public.test/", refuse)) == messages.UNREACHABLE
    with pytest.raises(httpx.ReadTimeout):
        fetch("https://public.test/", slow)


def test_unknown_host_unreachable():
    msg = permanent_message(lambda: check_host_allowed("https://no-such-host.invalid/", allow_private=False))
    assert msg == messages.UNREACHABLE


def test_user_agent_is_descriptive_and_configurable(public_dns):
    """Sites such as Wikipedia reject generic bot user agents (403); they need a contact URL."""
    from worker.config import Settings

    seen = []

    def handler(request):
        seen.append(request.headers["user-agent"])
        return html_response()

    assert "+http" in Settings().fetch_user_agent
    fetch_html("https://public.test/", allow_private=False, transport=httpx.MockTransport(handler))
    fetch_html(
        "https://public.test/",
        allow_private=False,
        transport=httpx.MockTransport(handler),
        user_agent="MyApp/2.0 (+https://myapp.example)",
    )
    assert seen == [Settings().fetch_user_agent, "MyApp/2.0 (+https://myapp.example)"]
