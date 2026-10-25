"""A pasted syllabus, table of contents or lecture schedule: one segment per line; its
unindented items are the top-level topics, indented ones their children."""

import re

from worker.ingest.types import Extracted, Heading, Segment

ANCHOR_WORDS = 10
_MARKER = re.compile(r"^(\d+[.)]|[-*•]|#{1,2}\s|[A-Z][^a-z\s]{0,3}[.)]\s)\s*")
MAX_TITLE_LIKE = 80


def _title_like(line: str) -> bool:
    return len(line) <= MAX_TITLE_LIKE and not line.endswith(".")


def extract_outline(text: str) -> Extracted:
    segments: list[Segment] = []
    headings: list[Heading] = []
    for raw in text.splitlines():
        if not raw.strip():
            continue
        line = raw.strip()
        segments.append(Segment(line, {"anchor": " ".join(line.split()[:ANCHOR_WORDS])}))
        indented = raw[:1].isspace()
        marked = _MARKER.match(line)
        title = _MARKER.sub("", line, count=1).strip() if marked else line
        if not title:
            continue
        if not indented and (marked or _title_like(line)):
            headings.append(Heading(title, 1, title))
        elif indented and (marked or _title_like(line)):
            headings.append(Heading(title, 2, title))
    return Extracted(title=None, segments=segments, headings=headings)
