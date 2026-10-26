"""Pages found by Tavily come with their text, so they're read without fetching or rendering
(time to map, target 30 s)."""

import json

from test_find_sources import Tavily, finding, handler as find_handler, hit  # noqa: F401 (fixture)
from test_ingest_handler import NoRenderer, Site, handler, job, source
from test_tavily import Recorder, run as tavily_run

from worker.ingest.extract_web import extract_markdown

MARKDOWN = "\n".join([
    "# Growing plants in code",
    "",
    "L-systems describe how a plant grows, one rewriting step at a time. " * 6,
    "",
    "## Rewriting rules",
    "",
    "Each rule replaces a symbol with a string of symbols. " * 6,
    "",
    "![diagram](x.png)",
    "## Drawing with a turtle",
    "A turtle reads the string and draws branches. " * 6,
])


def test_extract_markdown_keeps_headings_and_paragraphs():
    ex = extract_markdown("Growing plants", MARKDOWN)
    assert ex.title == "Growing plants"
    assert [(h.title, h.level) for h in ex.headings] == [
        ("Growing plants in code", 1), ("Rewriting rules", 2), ("Drawing with a turtle", 2)]
    assert ex.headings[1].first_sentence.startswith("Each rule replaces a symbol")
    assert len(ex.segments) == 3 and not any(s.text.startswith(("#", "!")) for s in ex.segments)


def test_tavily_asks_for_page_text_and_returns_it(db):
    body = json.dumps({"results": [{"url": "https://a.example/x", "title": "X", "score": 0.9, "raw_content": MARKDOWN}]})
    rec = Recorder(body=body)
    (h,) = tavily_run(db, rec)
    assert json.loads(rec.requests[0].content)["include_raw_content"] == "markdown"
    assert h.raw_content == MARKDOWN


def test_found_pages_keep_their_text(db, finding):
    _, gid = finding
    find_handler(tavily=Tavily([hit("https://a.example/x", 0.9, raw=MARKDOWN), hit("https://b.example/y", 0.8)])).run(
        db, __import__("test_find_sources").job(gid))
    rows = {r["url_or_file"]: r["prefetched"] for r in db.execute(
        "select url_or_file, prefetched from sources where goal_id = %s", (gid,)).fetchall()}
    assert rows == {"https://a.example/x": MARKDOWN, "https://b.example/y": None}


def test_a_page_with_text_is_read_without_fetching(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "https://a.example/x")
    db.execute("update sources set prefetched = %s where id = %s", (MARKDOWN, sid))
    site = Site()
    handler(site=site, renderer=NoRenderer()).run(db, job(sid))
    assert site.calls == 0
    s = source(db, sid)
    assert s["status"] == "ready" and s["title"] == "Growing plants in code"


def test_gap_pages_keep_their_text(db, make_user, make_ready_goal):
    from test_gaps import fill

    uid = make_user()
    gid = make_ready_goal(uid)
    db.execute("update goals set search_subject = 'SQL' where id = %s", (gid,))

    class WithText:
        def __call__(self, conn, queries, **kw):
            return [[hit(f"https://t{i}.example/p", 0.9, raw=MARKDOWN)] for i, _ in enumerate(queries)]

    fill(db, gid, n=1, tavily=WithText())
    (row,) = db.execute("select prefetched from sources where goal_id = %s and origin = 'auto'", (gid,)).fetchall()
    assert row["prefetched"] == MARKDOWN
