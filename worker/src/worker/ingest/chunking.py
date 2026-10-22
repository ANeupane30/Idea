"""Cleaning and sentence-aligned chunking of extracted text."""

import math
import re

from worker.ingest.types import Chunk, Segment

TARGET_MIN, TARGET_MAX, HARD_MAX = 500, 650, 800
OVERLAP_MAX, TAIL_MERGE = 100, 150

_ZERO_WIDTH = re.compile("[​‌‍⁠﻿]")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


def clean_text(text: str) -> str:
    text = _ZERO_WIDTH.sub("", text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def clean_transcript_text(text: str) -> str:
    text = re.sub(r"\[[^\]]*\]", " ", _ZERO_WIDTH.sub("", text)).replace(">>", " ")
    return re.sub(r"\s+", " ", text).strip()


def _split_long(text: str) -> list[str]:
    """Split a unit over HARD_MAX at word boundaries into pieces of at most HARD_MAX."""
    pieces: list[str] = []
    words: list[str] = []
    chars = 0
    for word in text.split():
        added = len(word) + (1 if words else 0)
        if words and estimate_tokens("x" * (chars + added)) > HARD_MAX:
            pieces.append(" ".join(words))
            words, chars = [], 0
            added = len(word)
        words.append(word)
        chars += added
    if words:
        pieces.append(" ".join(words))
    return pieces


def _units(segments: list[Segment]) -> list[tuple[str, dict]]:
    units = []
    for seg in segments:
        for sentence in _SENTENCE_END.split(seg.text.strip()):
            sentence = sentence.strip()
            if not sentence:
                continue
            if estimate_tokens(sentence) > HARD_MAX:
                units.extend((piece, seg.location) for piece in _split_long(sentence))
            else:
                units.append((sentence, seg.location))
    return units


def _tokens(units: list[tuple[str, dict]]) -> int:
    return estimate_tokens(" ".join(u[0] for u in units))


def chunk_segments(segments: list[Segment]) -> list[Chunk]:
    groups: list[list[tuple[str, dict]]] = []
    cur: list[tuple[str, dict]] = []
    fresh = 0  # units in `cur` not already in the previous chunk (the overlap)

    def start_next(unit: tuple[str, dict]) -> None:
        nonlocal cur, fresh
        groups.append(cur)
        last = cur[-1]
        overlap = [last] if estimate_tokens(last[0]) <= OVERLAP_MAX else []
        cur = overlap if _tokens(overlap + [unit]) <= HARD_MAX else []
        fresh = 0

    for unit in _units(segments):
        if cur and fresh:
            grown = _tokens(cur + [unit])
            if (grown > TARGET_MAX and _tokens(cur) >= TARGET_MIN) or grown > HARD_MAX:
                start_next(unit)
        cur.append(unit)
        fresh += 1

    if fresh:
        new_units = cur[len(cur) - fresh :]
        if groups and _tokens(cur) < TAIL_MERGE and _tokens(groups[-1] + new_units) <= HARD_MAX:
            groups[-1] = groups[-1] + new_units
        else:
            groups.append(cur)

    chunks = []
    for pos, group in enumerate(groups):
        text = " ".join(u[0] for u in group)
        chunks.append(Chunk(pos, text, estimate_tokens(text), group[0][1]))
    return chunks
