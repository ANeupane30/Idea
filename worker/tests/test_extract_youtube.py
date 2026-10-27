import httpx
import pytest
from youtube_transcript_api import IpBlocked, NoTranscriptFound, RequestBlocked, TranscriptsDisabled

from worker.ingest import messages
from worker.ingest import extract_youtube as yt
from worker.ingest.extract_youtube import Transcript, YouTubeTranscriptSource, extract_youtube
from worker.jobs import PermanentJobError


class Snippet:
    def __init__(self, text, start, duration):
        self.text, self.start, self.duration = text, start, duration


class FakeTranscript:
    def __init__(self, snippets, is_generated):
        self.snippets = snippets
        self.is_generated = is_generated

    def fetch(self):
        return self


class FakeList:
    def __init__(self, manual=None, generated=None):
        self.manual, self.generated = manual, generated

    def find_manually_created_transcript(self, langs):
        if self.manual is None:
            raise NoTranscriptFound("vid", langs, None)
        return self.manual

    def find_generated_transcript(self, langs):
        if self.generated is None:
            raise NoTranscriptFound("vid", langs, None)
        return self.generated


class FakeApi:
    def __init__(self, listing=None, error=None):
        self.listing, self.error = listing, error

    def list(self, video_id):
        if self.error:
            raise self.error
        return self.listing


def oembed(title="A video"):
    return httpx.MockTransport(lambda r: httpx.Response(200, json={"title": title}))


def test_youtube_prefers_manual():
    manual = FakeTranscript([Snippet("Manual.", 0.0, 1.0)], is_generated=False)
    generated = FakeTranscript([Snippet("auto", 0.0, 1.0)], is_generated=True)
    src = YouTubeTranscriptSource(api=FakeApi(FakeList(manual, generated)), transport=oembed())
    t = src.fetch("dQw4w9WgXcQ")
    assert t == Transcript([("Manual.", 0.0, 1.0)], is_generated=False)


def test_youtube_falls_back_to_generated():
    generated = FakeTranscript([Snippet("auto", 0.0, 1.0)], is_generated=True)
    src = YouTubeTranscriptSource(api=FakeApi(FakeList(None, generated)), transport=oembed())
    assert src.fetch("dQw4w9WgXcQ").is_generated is True


def test_youtube_none_when_no_transcript():
    assert YouTubeTranscriptSource(api=FakeApi(FakeList()), transport=oembed()).fetch("dQw4w9WgXcQ") is None
    disabled = FakeApi(error=TranscriptsDisabled("dQw4w9WgXcQ"))
    assert YouTubeTranscriptSource(api=disabled, transport=oembed()).fetch("dQw4w9WgXcQ") is None


@pytest.mark.parametrize("error", [RequestBlocked("dQw4w9WgXcQ"), IpBlocked("dQw4w9WgXcQ")])
def test_youtube_block_fails_at_once_and_pauses_videos(monkeypatch, error):
    monkeypatch.setattr(yt, "_blocked_until", 0.0)
    assert not yt.youtube_blocked()
    src = YouTubeTranscriptSource(api=FakeApi(error=error), transport=oembed())
    with pytest.raises(PermanentJobError) as e:
        src.fetch("dQw4w9WgXcQ")
    assert e.value.message == messages.YOUTUBE_BLOCKED
    assert yt.youtube_blocked()
    assert not yt.youtube_blocked(now=yt._blocked_until)


def test_youtube_title_from_oembed():
    src = YouTubeTranscriptSource(api=FakeApi(FakeList()), transport=oembed("SQL in 10 minutes"))
    assert src.title("dQw4w9WgXcQ") == "SQL in 10 minutes"
    failing = httpx.MockTransport(lambda r: httpx.Response(404))
    assert YouTubeTranscriptSource(api=FakeApi(FakeList()), transport=failing).title("x") is None


class StaticSource:
    def __init__(self, transcript, title="Video title"):
        self.transcript, self._title = transcript, title

    def fetch(self, video_id):
        return self.transcript

    def title(self, video_id):
        return self._title


def test_youtube_segments_and_duration():
    out = extract_youtube("vid", StaticSource(Transcript([("hi", 0.0, 2.0), ("there", 2.0, 3.5)], False)))
    assert [s.text for s in out.segments] == ["hi", "there"]
    assert [s.location for s in out.segments] == [{"timestamp_start": 0.0}, {"timestamp_start": 2.0}]
    assert out.duration_s == 6
    assert out.title == "Video title"
    assert out.auto_captions is False


def test_no_transcript():
    with pytest.raises(PermanentJobError) as e:
        extract_youtube("vid", StaticSource(None))
    assert e.value.message == messages.NO_TRANSCRIPT
