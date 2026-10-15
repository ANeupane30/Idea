import re

from worker.ingest.chunking import (
    HARD_MAX,
    TARGET_MIN,
    chunk_segments,
    clean_text,
    clean_transcript_text,
    estimate_tokens,
)
from worker.ingest.types import Segment


def sentence(i: int, words: int = 16) -> str:
    # ~20 estimated tokens: 16 short words plus a period.
    return "Word " + " ".join(f"w{i}x{j}" for j in range(words - 1)) + "."


def article(sentences: int, per_segment: int = 5) -> list[Segment]:
    segs = []
    for s in range(0, sentences, per_segment):
        text = " ".join(sentence(i) for i in range(s, min(s + per_segment, sentences)))
        segs.append(Segment(text, {"anchor": f"para {s}"}))
    return segs


def test_estimate_tokens():
    assert estimate_tokens("") == 1
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("abcde") == 2


def test_clean_text():
    assert clean_text("a​  b\n\n\nc") == "a b\n\nc"
    assert clean_text("  x\t y \n") == "x y"


def test_clean_transcript():
    assert clean_transcript_text("[Music] >> hello  there") == "hello there"
    assert clean_transcript_text("[Applause]") == ""


def test_chunks_within_bounds():
    segs = article(300)
    total = sum(estimate_tokens(s.text) for s in segs)
    assert total > 5000
    chunks = chunk_segments(segs)
    assert [c.position for c in chunks] == list(range(len(chunks)))
    for c in chunks[:-1]:
        assert TARGET_MIN <= c.token_count <= HARD_MAX, c.token_count
    assert chunks[0].location == {"anchor": "para 0"}
    assert all(c.token_count == estimate_tokens(c.text) for c in chunks)


def test_chunks_split_on_sentences():
    for c in chunk_segments(article(300)):
        assert c.text.startswith("Word "), c.text[:30]
        assert c.text.endswith(".")


def test_overlap():
    chunks = chunk_segments(article(300))
    for prev, nxt in zip(chunks, chunks[1:]):
        last = re.findall(r"Word [^.]*\.", prev.text)[-1]
        assert nxt.text.startswith(last)


def test_long_unit_split():
    words = " ".join(f"word{i}" for i in range(2000))  # ~3,000+ tokens, no punctuation
    chunks = chunk_segments([Segment(words + ".", {"page": 1})])
    assert len(chunks) > 1
    assert all(c.token_count <= HARD_MAX for c in chunks)
    joined = " ".join(c.text for c in chunks).split()
    assert all(w.startswith("word") for w in joined)
    assert all(c.location == {"page": 1} for c in chunks)


def test_tail_merge():
    # Enough for one full chunk plus a short remainder of 3 sentences (~60 tokens).
    chunks = chunk_segments(article(30))
    assert len(chunks) == 1 or chunks[-1].token_count >= 150


def test_unpunctuated_transcript_chunks():
    segs = [
        Segment(" ".join(f"word{i}w{j}" for j in range(6 + i % 5)), {"timestamp_start": i * 2.0})
        for i in range(1200)
    ]
    chunks = chunk_segments(segs)
    assert len(chunks) > 5
    for c in chunks[:-1]:
        assert TARGET_MIN <= c.token_count <= HARD_MAX, c.token_count
    assert all("timestamp_start" in c.location for c in chunks)
    assert chunks[1].location["timestamp_start"] > 0


def test_short_document_one_chunk():
    chunks = chunk_segments([Segment("One. Two is here. Three.", {"anchor": "One."})])
    assert len(chunks) == 1
    assert chunks[0].text == "One. Two is here. Three."
