import json
from datetime import datetime, timezone
from pathlib import Path

import httpx2 as httpx
import pytest

from worker.config import Settings
from worker.discovery import tavily
from worker.discovery.tavily import EXCLUDED_DOMAINS, QuotaExhausted, TavilyHit

FIXTURE = (Path(__file__).parent / "fixtures" / "discovery" / "tavily_search.json").read_text(encoding="utf-8")


class Recorder:
    def __init__(self, status=200, body=FIXTURE):
        self.requests = []
        self.status, self.body = status, body
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request):
        self.requests.append(request)
        return httpx.Response(self.status, text=self.body, headers={"content-type": "application/json"})


def month(db):
    return datetime.now(timezone.utc).date().replace(day=1)


def usage(db):
    row = db.execute("select credits, warned from search_usage where month = %s", (month(db),)).fetchone()
    return (row["credits"], row["warned"]) if row else (0, False)


@pytest.fixture(autouse=True)
def clean_usage(db):
    db.execute("delete from search_usage")


def run(db, rec, query="plant growth simulation tutorial", limit=1000):
    return tavily.search(db, query, api_key="tvly-test", monthly_credits=limit, transport=rec.transport)


def test_request_shape(db):
    rec = Recorder()
    run(db, rec)
    req = rec.requests[0]
    assert req.method == "POST" and str(req.url) == "https://api.tavily.com/search"
    assert req.headers["authorization"] == "Bearer tvly-test"
    body = json.loads(req.content)
    assert body["query"] == "plant growth simulation tutorial"
    assert body["search_depth"] == "basic" and body["max_results"] == 8
    assert body["exclude_domains"] == EXCLUDED_DOMAINS
    assert EXCLUDED_DOMAINS == ["pinterest.com", "facebook.com", "instagram.com", "tiktok.com", "x.com",
                                "twitter.com", "quora.com", "amazon.com", "medium.com/tag"]


def test_parses_hits_and_marks_videos(db):
    hits = run(db, Recorder())
    assert hits[0].url == "https://realpython.com/procedural-plants/?utm_source=tavily#intro"  # the PDF is left out
    assert [h.is_video for h in hits] == [False, True, True]


def test_custom_url(db):
    rec = Recorder()
    tavily.search(db, "q", api_key="k", monthly_credits=10, url="http://127.0.0.1:8765/tavily/search", transport=rec.transport)
    assert str(rec.requests[0].url) == "http://127.0.0.1:8765/tavily/search"


@pytest.mark.parametrize("status", [429, 432])
def test_quota_responses_raise(db, status):
    with pytest.raises(QuotaExhausted):
        run(db, Recorder(status=status, body="{}"))


def test_tracked_quota_at_limit_raises_without_calling(db):
    db.execute("insert into search_usage (month, credits) values (%s, 1000)", (month(db),))
    rec = Recorder()
    with pytest.raises(QuotaExhausted):
        run(db, rec)
    assert rec.requests == []


def test_server_error_returns_nothing(db):
    assert run(db, Recorder(status=500, body="oops")) == []
    assert usage(db) == (0, False)


def test_credits_counted(db):
    run(db, Recorder())
    run(db, Recorder())
    assert usage(db) == (2, False)


def test_warns_once_at_80_percent(db, caplog):
    db.execute("insert into search_usage (month, credits) values (%s, 799)", (month(db),))
    with caplog.at_level("WARNING", logger="worker.discovery.tavily"):
        run(db, Recorder())
    assert "tavily quota 80% used: 800/1000" in caplog.text
    assert usage(db) == (800, True)
    caplog.clear()
    with caplog.at_level("WARNING", logger="worker.discovery.tavily"):
        run(db, Recorder())
    assert "tavily quota" not in caplog.text


def test_settings_defaults():
    s = Settings(_env_file=None)
    assert s.tavily_api_key is None
    assert s.tavily_monthly_credits == 1000
    assert s.tavily_url == "https://api.tavily.com/search"
    assert s.worker_concurrency == 3


def test_search_many_runs_queries_concurrently_and_counts_each(db):
    import time

    class Slow(Recorder):
        def _handle(self, request):
            time.sleep(0.3)
            return super()._handle(request)

    rec = Slow()
    t = time.monotonic()
    hits = tavily.search_many(db, ["a", "b", "c"], api_key="k", monthly_credits=1000, transport=rec.transport)
    assert time.monotonic() - t < 0.8
    assert len(rec.requests) == 3 and len(hits) == 9
    assert usage(db) == (3, False)


def test_search_many_checks_the_quota_first(db):
    db.execute("insert into search_usage (month, credits) values (%s, 1000)", (month(db),))
    with pytest.raises(QuotaExhausted):
        tavily.search_many(db, ["a"], api_key="k", monthly_credits=1000, transport=Recorder().transport)


def test_search_many_quota_response_raises(db):
    with pytest.raises(QuotaExhausted):
        tavily.search_many(db, ["a", "b"], api_key="k", monthly_credits=1000, transport=Recorder(status=432, body="{}").transport)


def test_pdf_links_are_left_out(db):
    """Seen on staging: PDF results took candidate slots, then failed ("upload the file instead")."""
    body = json.dumps({"results": [
        {"url": "https://a.example/handbook.pdf", "title": "Handbook", "score": 0.9},
        {"url": "https://b.example/files/Protocol.PDF?dl=1", "title": "Protocol", "score": 0.8},
        {"url": "https://c.example/guide", "title": "Guide", "score": 0.7},
    ]})
    hits = run(db, Recorder(body=body))
    assert [h.url for h in hits] == ["https://c.example/guide"]
