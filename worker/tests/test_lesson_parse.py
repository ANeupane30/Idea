from worker.lessons.parse import Section, SectionStream, parse_section

TEXT = """Here is your lesson.
<section>
<markdown>
## Joins

A join combines rows from two tables.
</markdown>
<mermaid>
graph TD; A[orders] --> B[customers]
</mermaid>
<cite>1</cite>
</section>
<section>
<markdown>An inner join keeps matching rows only.</markdown>
<cite>1, 2</cite>
</section>
"""


def test_parse_streams_sections():
    stream = SectionStream(n_chunks=2)
    got: list[tuple[int, Section]] = []
    for i in range(0, len(TEXT), 7):
        piece = TEXT[i : i + 7]
        for section in stream.feed(piece):
            got.append((i, section))
    assert stream.finish() == []
    assert len(got) == 2
    first, second = got[0][1], got[1][1]
    assert first.markdown.startswith("## Joins")
    assert first.mermaid == "graph TD; A[orders] --> B[customers]"
    assert first.citations == [1]
    assert second.mermaid is None and second.citations == [1, 2]
    # Each section is emitted as soon as its closing tag arrives, not at the end.
    assert got[0][0] < TEXT.index("<section>", TEXT.index("</section>")) + 7
    assert first.to_json() == {"markdown": first.markdown, "mermaid": first.mermaid, "citations": [1]}


def test_parse_drops_bad_citations():
    raw = "<markdown>Text</markdown><cite>0, 2, 9, 2</cite>"
    assert parse_section(raw, n_chunks=3).citations == [2]
    assert parse_section("<markdown>Text</markdown><cite>x</cite>", n_chunks=3) is None
    assert parse_section("<markdown>Text</markdown>", n_chunks=3) is None
    assert parse_section("<markdown>  </markdown><cite>1</cite>", n_chunks=3) is None


def test_parse_strips_code_fences_in_mermaid():
    raw = "<markdown>T</markdown><mermaid>```mermaid\ngraph TD; A-->B\n```</mermaid><cite>1</cite>"
    assert parse_section(raw, n_chunks=1).mermaid == "graph TD; A-->B"


def test_parse_empty_is_error():
    stream = SectionStream(n_chunks=3)
    assert stream.feed("I can't help with that.") == []
    assert stream.finish() == []
