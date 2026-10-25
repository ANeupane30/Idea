"""Data passed between the ingestion steps."""

from dataclasses import dataclass, field


@dataclass
class Segment:
    """A piece of extracted text and where it came from: {"anchor"}, {"timestamp_start"} or {"page"}."""

    text: str
    location: dict


@dataclass
class Heading:
    """A heading, chapter or outline item, with the first sentence under it (to find its chunk)."""

    title: str
    level: int
    first_sentence: str


@dataclass
class Extracted:
    title: str | None
    segments: list[Segment]
    duration_s: int | None = None
    page_count: int | None = None
    auto_captions: bool = False
    headings: list[Heading] = field(default_factory=list)


@dataclass
class Chunk:
    position: int
    text: str
    token_count: int
    location: dict
