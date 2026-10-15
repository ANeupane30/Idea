"""YouTube extraction from transcripts (manual English captions preferred). No speech-to-text."""

import math
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
from worker.ingest.types import Extracted, Segment
from worker.jobs import PermanentJobError

LANGUAGES = ["en", "en-US", "en-GB"]
OEMBED_URL = "https://www.youtube.com/oembed"
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


class YouTubeTranscriptSource:
    """Network errors and IP blocks raise (the job retries); a video with no transcript returns None."""

    def __init__(self, api=None, transport: httpx.BaseTransport | None = None):
        self._api = api or YouTubeTranscriptApi()
        self._transport = transport

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
    return Extracted(
        title=source.title(video_id),
        segments=segments,
        duration_s=math.ceil(last_start + last_duration),
        auto_captions=transcript.is_generated,
    )
