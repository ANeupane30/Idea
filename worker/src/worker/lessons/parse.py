"""Parsing the model's tagged lesson output into sections, as the stream arrives."""

import re
from dataclasses import dataclass

_SECTION = re.compile(r"<section>(.*?)</section>", re.S)
_MARKDOWN = re.compile(r"<markdown>(.*?)</markdown>", re.S)
_MERMAID = re.compile(r"<mermaid>(.*?)</mermaid>", re.S)
_CITE = re.compile(r"<cite>(.*?)</cite>", re.S)
_FENCE = re.compile(r"^```(?:mermaid)?\s*|\s*```$")


@dataclass
class Section:
    markdown: str
    mermaid: str | None
    citations: list[int]

    def to_json(self) -> dict:
        return {"markdown": self.markdown, "mermaid": self.mermaid, "citations": self.citations}


def parse_section(raw: str, n_chunks: int) -> Section | None:
    """One section's inner text. None if it has no markdown or no valid citation (1..n_chunks)."""
    md = _MARKDOWN.search(raw)
    markdown = md.group(1).strip() if md else ""
    if not markdown:
        return None
    cite = _CITE.search(raw)
    citations: list[int] = []
    for number in re.findall(r"\d+", cite.group(1) if cite else ""):
        n = int(number)
        if 1 <= n <= n_chunks and n not in citations:
            citations.append(n)
    if not citations:
        return None
    mm = _MERMAID.search(raw)
    mermaid = _FENCE.sub("", mm.group(1).strip()).strip() if mm else ""
    return Section(markdown, mermaid or None, citations)


class SectionStream:
    """Feed text as it streams; get back each section as soon as its closing tag arrives."""

    def __init__(self, n_chunks: int):
        self._n = n_chunks
        self._buffer = ""

    def feed(self, text: str) -> list[Section]:
        self._buffer += text
        sections: list[Section] = []
        end = 0
        for match in _SECTION.finditer(self._buffer):
            section = parse_section(match.group(1), self._n)
            if section is not None:
                sections.append(section)
            end = match.end()
        self._buffer = self._buffer[end:]
        return sections

    def finish(self) -> list[Section]:
        """An unclosed trailing section is incomplete, so it is dropped."""
        self._buffer = ""
        return []
