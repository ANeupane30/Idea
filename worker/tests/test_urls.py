import pytest

from worker.ingest.urls import content_hash, is_youtube_host, normalize_url, youtube_video_id


def test_normalize_strips_tracking():
    assert normalize_url("HTTPS://Example.com:443/a?utm_source=x&b=2&a=1#frag") == "https://example.com/a?a=1&b=2"
    assert normalize_url("http://example.com") == "http://example.com/"
    assert normalize_url("https://example.com/p?fbclid=1&gclid=2&si=3&q=1") == "https://example.com/p?q=1"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("http://EXAMPLE.com:80/x", "http://example.com/x"),
        ("https://example.com:8443/x", "https://example.com:8443/x"),
        ("https://example.com/x#section", "https://example.com/x"),
        ("https://example.com/x?utm_medium=a&utm_campaign=b", "https://example.com/x"),
        ("https://example.com/x?mc_cid=1&mc_eid=2&ref=3&ref_src=4&igshid=5", "https://example.com/x"),
        ("https://example.com/x?b=2&a=1&a=0", "https://example.com/x?a=0&a=1&b=2"),
        ("https://example.com/Path/Case", "https://example.com/Path/Case"),
        ("  https://example.com/x  ", "https://example.com/x"),
    ],
)
def test_normalize_rules(raw, expected):
    assert normalize_url(raw) == expected


@pytest.mark.parametrize(
    "url",
    [
        "https://youtu.be/dQw4w9WgXcQ?si=abc",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
        "https://m.youtube.com/shorts/dQw4w9WgXcQ",
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "https://youtube.com/live/dQw4w9WgXcQ",
        "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
)
def test_youtube_ids(url):
    assert youtube_video_id(url) == "dQw4w9WgXcQ"


@pytest.mark.parametrize(
    "url",
    ["https://www.youtube.com/playlist?list=PL1", "https://example.com/watch?v=x", "https://youtu.be/"],
)
def test_youtube_no_id(url):
    assert youtube_video_id(url) is None


def test_is_youtube_host():
    assert is_youtube_host("WWW.YouTube.com")
    assert is_youtube_host("youtu.be")
    assert not is_youtube_host("notyoutube.com")


def test_content_hash_stable():
    h = content_hash("web", "https://example.com/")
    assert h == content_hash("web", "https://example.com/")
    assert len(h) == 64 and all(c in "0123456789abcdef" for c in h)
    assert content_hash("web", "abc") != content_hash("youtube", "abc")
