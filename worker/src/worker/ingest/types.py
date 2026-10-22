"""Data passed between the ingestion steps."""

from dataclasses import dataclass


@dataclass
class Segment:
    """A piece of extracted text and where it came from: {"anchor"}, {"timestamp_start"} or {"page"}."""

    text: str
    location: dict


@dataclass
class Extracted:
    title: str | None
    segments: list[Segment]
    duration_s: int | None = None
    page_count: int | None = None
    auto_captions: bool = False


@dataclass
class Chunk:
    position: int
    text: str
    token_count: int
    location: dict
