"""YouTube extraction from transcripts (manual English captions preferred). No speech-to-text."""

import math
import re
from dataclasses import dataclass
from typing import Protocol

import httpx
from youtube_transcript_api import (
    AgeRestricted,
    InvalidVideoId,
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
    VideoUnplayable,
    YouTubeTranscriptApi,
)

from worker.ingest.messages import NO_TRANSCRIPT
from worker.ingest.types import Extracted, Heading, Segment
from worker.jobs import PermanentJobError

LANGUAGES = ["en", "en-US", "en-GB"]
OEMBED_URL = "https://www.youtube.com/oembed"
VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
_CHAPTER = re.compile(r"^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+?)\s*$")


def parse_chapters(description: str | None) -> list[tuple[float, str]]:
    """YouTube's chapter convention: lines starting with a timestamp; at least 3, the first at 0:00."""
    chapters = []
    for line in (description or "").splitlines():
        m = _CHAPTER.match(line)
        if m:
            parts = [int(p) for p in m.group(1).split(":")]
            seconds = sum(v * 60**i for i, v in enumerate(reversed(parts)))
            chapters.append((float(seconds), m.group(2)))
    if len(chapters) < 3 or chapters[0][0] != 0:
        return []
    return chapters
_NO_TRANSCRIPT_ERRORS = (
    TranscriptsDisabled,
    NoTranscriptFound,
    VideoUnavailable,
    InvalidVideoId,
    AgeRestricted,
    VideoUnplayable,
)


@dataclass
class Transcript:
    snippets: list[tuple[str, float, float]]  # (text, start, duration)
    is_generated: bool


class TranscriptSource(Protocol):
    def fetch(self, video_id: str) -> Transcript | None: ...

    def title(self, video_id: str) -> str | None: ...

    def description(self, video_id: str) -> str | None: ...


class YouTubeTranscriptSource:
    """Network errors and IP blocks raise (the job retries); a video with no transcript returns None."""

    def __init__(self, api=None, transport: httpx.BaseTransport | None = None, api_key: str | None = None):
        self._api = api or YouTubeTranscriptApi()
        self._transport = transport
        self._api_key = api_key

    def description(self, video_id: str) -> str | None:
        """The video's description (for its chapters); needs a YouTube Data API key."""
        if not self._api_key:
            return None
        try:
            with httpx.Client(transport=self._transport, timeout=10.0) as client:
                r = client.get(VIDEOS_URL, params={"part": "snippet", "id": video_id, "key": self._api_key})
                r.raise_for_status()
                items = r.json().get("items") or []
                desc = items[0]["snippet"].get("description") if items else None
                return desc if isinstance(desc, str) else None
        except (httpx.HTTPError, ValueError, KeyError):
            return None

    def fetch(self, video_id: str) -> Transcript | None:
        try:
            listing = self._api.list(video_id)
        except _NO_TRANSCRIPT_ERRORS:
            return None
        try:
            transcript = listing.find_manually_created_transcript(LANGUAGES)
        except NoTranscriptFound:
            try:
                transcript = listing.find_generated_transcript(LANGUAGES)
            except NoTranscriptFound:
                return None
        fetched = transcript.fetch()
        return Transcript([(s.text, s.start, s.duration) for s in fetched.snippets], transcript.is_generated)

    def title(self, video_id: str) -> str | None:
        try:
            with httpx.Client(transport=self._transport, timeout=10.0) as client:
                r = client.get(
                    OEMBED_URL,
                    params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
                )
                r.raise_for_status()
                title = r.json().get("title")
                return title if isinstance(title, str) and title.strip() else None
        except (httpx.HTTPError, ValueError):
            return None


def extract_youtube(video_id: str, source: TranscriptSource) -> Extracted:
    transcript = source.fetch(video_id)
    if transcript is None or not transcript.snippets:
        raise PermanentJobError(NO_TRANSCRIPT)
    segments = [Segment(text, {"timestamp_start": start}) for text, start, _ in transcript.snippets]
    _, last_start, last_duration = transcript.snippets[-1]
    describe = getattr(source, "description", None)
    chapters = parse_chapters(describe(video_id) if describe else None)
    headings = [
        Heading(title, 1, next((t for t, start, _ in transcript.snippets if start >= at), ""))
        for at, title in chapters
    ]
    return Extracted(
        headings=headings,
        title=source.title(video_id),
        segments=segments,
        duration_s=math.ceil(last_start + last_duration),
        auto_captions=transcript.is_generated,
    )
