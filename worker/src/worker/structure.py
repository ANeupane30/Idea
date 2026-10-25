"""A source's structure (headings, table of contents, chapters, outline items) and the
summary of a goal's sources that a map built from them follows."""

import re
from html import escape

from worker.ingest.types import Chunk, Heading

_SENTENCE_END = re.compile(r"(?<=[.!?])\s")
MAX_SENTENCE = 200
_MATCH_CHARS = 60


def first_sentence(text: str) -> str:
    text = " ".join(text.split())
    return _SENTENCE_END.split(text, maxsplit=1)[0][:MAX_SENTENCE]


def _norm(text: str) -> str:
    return " ".join(text.split()).casefold()


def fallback_headings(title: str | None, first_text: str) -> list[Heading]:
    """A source with no headings, chapters or items is one item (spec 4.1: a video without chapters)."""
    sentence = first_sentence(first_text)
    return [Heading(title or sentence[:120] or "This source", 1, sentence)] if sentence or title else []


def build_structure(headings: list[Heading], chunks: list[Chunk], *, outline: bool = False) -> list[dict]:
    """Stored on contents (shared between goals), so ids are local: H1… or, for outlines, O1…."""
    texts = [_norm(c.text) for c in chunks]
    items: list[dict] = []
    last = 0
    for n, h in enumerate(headings, start=1):
        needle = _norm(h.first_sentence)[:_MATCH_CHARS]
        found = next((c.position for c, t in zip(chunks, texts) if needle and needle in t), None)
        last = found if found is not None else last
        items.append({
            "id": f"{'O' if outline else 'H'}{n}",
            "title": h.title,
            "level": h.level,
            "first_sentence": h.first_sentence,
            "chunk_position": last,
        })
    return items


def structure_summary(
    sources: list[tuple[str, str, str | None, list[dict]]], max_chars: int = 32000
) -> tuple[str, dict[str, tuple[str, int]]]:
    """sources: (content_hash, type, title, structure) in the order the learner gave them.

    Returns the summary text (untrusted data, for the map prompt) and each item id's
    (content_hash, chunk_position). Items are numbered S<n>.<id>; the first outline keeps
    its bare O<n> ids. Items that don't fit in max_chars are dropped whole."""
    parts: list[str] = []
    refs: dict[str, tuple[str, int]] = {}
    size = 0
    bare_outline = True
    for n, (chash, type_, title, structure) in enumerate(sources, start=1):
        bare = type_ == "outline" and bare_outline
        bare_outline = bare_outline and not bare
        head = f'<source n="{n}" type="{escape(type_)}" title="{escape(title or "")}">\n'
        tail = "</source>\n"
        lines = []
        for item in structure or []:
            ref = item["id"] if bare else f"S{n}.{item['id']}"
            label = item["title"]
            if item.get("first_sentence") and _norm(item["first_sentence"]) != _norm(item["title"]):
                label = f"{label}: {item['first_sentence']}"
            line = f'<item id="{escape(ref)}" level="{int(item["level"])}">{escape(label)}</item>\n'
            if size + len(head) + len(tail) + sum(map(len, lines)) + len(line) > max_chars:
                break
            lines.append(line)
            refs[ref] = (chash, int(item["chunk_position"]))
        if not lines:
            if refs or size:
                break
            continue
        block = head + "".join(lines) + tail
        parts.append(block)
        size += len(block)
        if len(lines) < len(structure or []):
            break
    return "".join(parts), refs
