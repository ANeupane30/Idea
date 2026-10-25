import httpx  # the HTTP library the web fetcher (safe_fetch) uses
import pymupdf

from worker.ingest.extract_outline import extract_outline
from worker.ingest.extract_pdf import extract_pdf
from worker.ingest.extract_web import extract_web
from worker.ingest.extract_youtube import Transcript, extract_youtube, parse_chapters
from worker.ingest.types import Chunk, Heading
from worker.structure import build_structure, first_sentence, structure_summary

PARA = "An inner join keeps the rows that match in both tables. It is the most common join in everyday queries."
PAGE = (
    "<html><head><title>Joins</title></head><body><article>"
    "<h1>SQL joins</h1><p>Joins combine rows from two tables using a related column between them.</p>"
    f"<h2>Inner joins</h2><p>{PARA}</p>"
    "<h2>Outer joins</h2><p>A left outer join keeps every row from the left table, matched or not, and fills gaps.</p>"
    "<h3>Full outer joins</h3><p>A full outer join keeps every row from both tables, matched or unmatched.</p>"
    "<h2>References</h2><p>Some book, 2020, and a second source that should never become a topic heading.</p>"
    "</article></body></html>"
)


class NoRenderer:
    def render(self, url):
        raise AssertionError("not expected")


def test_first_sentence():
    assert first_sentence(PARA) == "An inner join keeps the rows that match in both tables."
    assert first_sentence("  no stop here  ") == "no stop here"
    assert len(first_sentence("x" * 500)) == 200


def test_web_headings_in_order_without_boilerplate():
    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=PAGE)
    )
    out = extract_web("http://127.0.0.1/joins.html", allow_private=True, renderer=NoRenderer(), transport=transport)
    assert [(h.title, h.level) for h in out.headings] == [
        ("SQL joins", 1), ("Inner joins", 2), ("Outer joins", 2), ("Full outer joins", 3),
    ]
    assert out.headings[1].first_sentence == "An inner join keeps the rows that match in both tables."


def test_pdf_toc_headings():
    doc = pymupdf.open()
    for text in ["Chapter one text. It continues here. ", "Chapter two text. More words. "]:
        doc.new_page().insert_text((72, 72), text * 3)
    doc.set_toc([[1, "Chapter one", 1], [2, "A section", 1], [3, "Too deep", 2], [1, "Chapter two", 2]])
    out = extract_pdf(doc.tobytes(), max_pages=10)
    assert [(h.title, h.level) for h in out.headings] == [("Chapter one", 1), ("A section", 2), ("Chapter two", 1)]
    assert out.headings[2].first_sentence.startswith("Chapter two text.")


def test_pdf_without_toc_has_no_headings():
    from pathlib import Path

    out = extract_pdf((Path(__file__).parent / "fixtures" / "sql_basics.pdf").read_bytes(), max_pages=10)
    assert out.headings == []


def test_parse_chapters():
    desc = "My video\n0:00 Intro\n2:15 Joins explained\n1:02:03 Wrap up\nnot a chapter 3:00"
    assert parse_chapters(desc) == [(0.0, "Intro"), (135.0, "Joins explained"), (3723.0, "Wrap up")]
    assert parse_chapters("0:00 Only one") == []  # YouTube needs at least 3 chapters starting at 0:00
    assert parse_chapters(None) == []


class Source:
    def __init__(self, description=None):
        self._d = description

    def fetch(self, video_id):
        return Transcript([("intro words here", 0.0, 4.0), ("now joins", 135.0, 4.0), ("bye", 3723.0, 2.0)], False)

    def title(self, video_id):
        return "SQL video"

    def description(self, video_id):
        return self._d


def test_youtube_chapters_become_headings():
    out = extract_youtube("abc", Source("0:00 Intro\n2:15 Joins explained\n1:02:03 Wrap up"))
    assert [h.title for h in out.headings] == ["Intro", "Joins explained", "Wrap up"]
    assert out.headings[1].first_sentence == "now joins"


def test_youtube_without_description_has_no_headings():
    assert extract_youtube("abc", Source(None)).headings == []


OUTLINE = "1. Basics\n  - Tables\n2. Joins\n3. Indexes"


def test_outline_items():
    out = extract_outline(OUTLINE)
    assert [(h.title, h.level) for h in out.headings] == [("Basics", 1), ("Tables", 2), ("Joins", 1), ("Indexes", 1)]
    assert [s.text for s in out.segments] == ["1. Basics", "- Tables", "2. Joins", "3. Indexes"]
    assert out.title is None


def test_outline_headings_without_markers():
    out = extract_outline("Week 1: Budgets\nWeek 2: Saving money\nThis line is a sentence that ends with a period.")
    assert [h.title for h in out.headings if h.level == 1] == ["Week 1: Budgets", "Week 2: Saving money"]


def chunk(pos, text):
    return Chunk(position=pos, text=text, token_count=10, location={})


def test_build_structure_resolves_chunks():
    chunks = [chunk(0, "Intro text. Joins combine rows."), chunk(1, PARA + " More."), chunk(2, "Other stuff.")]
    headings = [
        Heading("SQL joins", 1, "Joins combine rows."),
        Heading("Inner joins", 2, "An inner join keeps the rows that match in both tables."),
        Heading("Lost", 2, "This sentence is nowhere."),
    ]
    items = build_structure(headings, chunks)
    assert [(i["id"], i["chunk_position"]) for i in items] == [("H1", 0), ("H2", 1), ("H3", 1)]
    assert items[1] == {"id": "H2", "title": "Inner joins", "level": 2,
                        "first_sentence": "An inner join keeps the rows that match in both tables.", "chunk_position": 1}
    assert [i["id"] for i in build_structure(headings, chunks, outline=True)] == ["O1", "O2", "O3"]
    assert build_structure([Heading("x", 1, "nowhere")], chunks)[0]["chunk_position"] == 0


def test_structure_summary_ids_order_and_refs():
    outline = [{"id": "O1", "title": "Tables", "level": 1, "first_sentence": "Tables", "chunk_position": 0},
               {"id": "O2", "title": "Joins & keys", "level": 1, "first_sentence": "Joins", "chunk_position": 1}]
    web = [{"id": "H1", "title": "Inner joins", "level": 2, "first_sentence": "An inner join keeps rows.", "chunk_position": 3}]
    text, refs = structure_summary([("hash-o", "outline", None, outline), ("hash-w", "web", "Joins <guide>", web)])
    assert refs == {"O1": ("hash-o", 0), "O2": ("hash-o", 1), "S2.H1": ("hash-w", 3)}
    assert text.index('id="O1"') < text.index('id="O2"') < text.index('id="S2.H1"')
    assert "Joins &amp; keys" in text and "Joins &lt;guide&gt;" in text
    assert "An inner join keeps rows." in text


def test_structure_summary_truncates_whole_items():
    items = [{"id": f"H{i}", "title": f"Heading number {i}", "level": 1, "first_sentence": "s" * 50, "chunk_position": i}
             for i in range(1, 50)]
    text, refs = structure_summary([("h", "web", "T", items)], max_chars=600)
    assert len(text) <= 600
    assert list(refs) == [f"S1.H{i}" for i in range(1, len(refs) + 1)]
    assert 0 < len(refs) < 49
    assert text.count("<item") == len(refs)


def test_handler_ingests_an_outline_without_fetching(db, make_user, make_goal):
    from test_goal_ready import run_direct
    from test_ingest_handler import Site, handler

    uid = make_user()
    gid = make_goal(db, uid)
    db.execute("select set_config('app.creating_goal', %s, true)", (str(gid),))
    sid = db.execute(
        "insert into sources (user_id, goal_id, type, url_or_file, outline_text)"
        " values (%s, %s, 'outline', 'outline', %s) returning id",
        (uid, gid, OUTLINE),
    ).fetchone()["id"]
    site = Site()
    run_direct(db, handler(site), sid)
    assert site.calls == 0
    row = db.execute(
        "select s.status, c.type, c.structure from sources s join contents c on c.content_hash = s.content_hash"
        " where s.id = %s",
        (sid,),
    ).fetchone()
    assert row["status"] == "awaiting_map" and row["type"] == "outline"
    assert [i["id"] for i in row["structure"]] == ["O1", "O2", "O3", "O4"]
