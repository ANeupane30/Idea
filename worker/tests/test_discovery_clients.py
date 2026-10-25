import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx2 as httpx
import pytest

from worker.config import Settings
from worker.discovery import quota, wikipedia, youtube

FIXTURES = Path(__file__).parent / "fixtures" / "discovery"
UA = "LearningPlatform/1.0 (+https://example.test)"


class Recorder:
    def __init__(self, fixture=None, status=200, body=None):
        self.requests = []
        self.status = status
        self.body = body if body is not None else (FIXTURES / fixture).read_text(encoding="utf-8") if fixture else ""
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request):
        self.requests.append(request)
        return httpx.Response(self.status, text=self.body, headers={"content-type": "application/json"})

    def params(self):
        return {k: v[0] for k, v in parse_qs(urlsplit(str(self.requests[0].url)).query).items()}


def test_wikipedia_search_request_and_parsing():
    rec = Recorder("wiki_search.json")
    hits = wikipedia.search("Emergency fund Learn personal finance", api_url="https://en.wikipedia.org/w/api.php",
                            user_agent=UA, transport=rec.transport)
    p = rec.params()
    assert p["action"] == "query" and p["list"] == "search" and p["srlimit"] == "5"
    assert p["srsearch"] == "Emergency fund Learn personal finance"
    assert p["format"] == "json" and p["formatversion"] == "2"
    assert rec.requests[0].headers["user-agent"] == UA
    assert [(h.title, h.wordcount, h.disambiguation) for h in hits] == [
        ("Emergency fund", 227, False),
        ("Fund (disambiguation)", 120, True),
        ("Mercury", 900, True),
        ("Personal finance", 4545, False),
    ]


@pytest.mark.parametrize("status,body", [(429, "{}"), (500, "oops"), (200, "not json"), (200, "{}")])
def test_wikipedia_errors_return_nothing(status, body):
    rec = Recorder(status=status, body=body)
    assert wikipedia.search("x", api_url="https://w.test/api.php", user_agent=UA, transport=rec.transport) == []


def test_article_url():
    default = Settings(_env_file=None).wikipedia_article_url
    assert wikipedia.article_url("Emergency fund", default) == "https://en.wikipedia.org/wiki/Emergency_fund"
    assert wikipedia.article_url("C++ (language)", default) == "https://en.wikipedia.org/wiki/C%2B%2B_(language)"
    assert wikipedia.article_url("A B", "http://127.0.0.1:8765/wiki/{title}.html") == "http://127.0.0.1:8765/wiki/A_B.html"


def test_youtube_search_request_and_parsing():
    rec = Recorder("youtube_search.json")
    ids = youtube.search("Budgeting Learn finance", api_key="k", api_url="https://www.googleapis.com/youtube/v3/search",
                         transport=rec.transport)
    assert ids == ["abcDEF12345", "zyxWVU98765"]
    p = rec.params()
    assert p == {
        "part": "snippet", "q": "Budgeting Learn finance", "key": "k", "type": "video",
        "videoCaption": "closedCaption", "videoDuration": "medium", "relevanceLanguage": "en",
        "safeSearch": "strict", "maxResults": "5",
    }


@pytest.mark.parametrize("status,body", [(403, "{}"), (200, "nope"), (200, '{"items": [{"id": {}}]}')])
def test_youtube_errors_return_nothing(status, body):
    rec = Recorder(status=status, body=body)
    assert youtube.search("x", api_key="k", api_url="https://y.test", transport=rec.transport) == []


def test_free_requests_left():
    rec = Recorder("openrouter_key.json")
    assert quota.free_requests_left("sk-or-x", transport=rec.transport) == 4
    assert str(rec.requests[0].url) == "https://openrouter.ai/api/v1/key"
    assert rec.requests[0].headers["authorization"] == "Bearer sk-or-x"


@pytest.mark.parametrize("status,body", [(401, "{}"), (200, "{}"), (200, json.dumps({"data": {}})), (200, "x")])
def test_free_requests_left_unknown(status, body):
    assert quota.free_requests_left("k", transport=Recorder(status=status, body=body).transport) is None


def test_discovery_settings_defaults():
    s = Settings(_env_file=None)
    assert s.discovery_enabled is True
    assert s.wikipedia_api_url == "https://en.wikipedia.org/w/api.php"
    assert s.youtube_api_key is None
    assert s.youtube_api_url == "https://www.googleapis.com/youtube/v3/search"
