"""Fixture site for the e2e tests: serves site/ statically, plus fake Wikipedia and Tavily search APIs.

Only searches containing "Discoverme" find anything, so goals in other specs get no automatic
sources. Tavily finds two articles (copies of sql-article.html) and one off-topic page, each on
its own loopback address, since automatic sources are picked one per domain. Pages under /learn/
answer slowly, so the "Reading" stage lasts long enough to see (and to reload during). The
"Discoverme..." word of the query is added to each URL, so a goal titled with a fresh token gets
pages the worker hasn't read before (it reuses what it has read).
"""

import functools
import http.server
import json
import re
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SITE = Path(__file__).parent / "site"
PORT = 8765
HOSTS = ("127.0.0.1", "127.0.0.2", "127.0.0.3")
HIT = {"ns": 0, "title": "Fixture SQL joins", "pageid": 1, "wordcount": 900, "snippet": "Joins combine rows"}
LEARN_DELAY_S = 6

ARTICLE = (SITE / "sql-article.html").read_text(encoding="utf-8")
ARTICLE_TITLE = "A practical guide to SQL: SELECT, WHERE and JOIN"
LEARN = {
    "joins.html": ARTICLE.replace(ARTICLE_TITLE, "Discoverme guide one: SQL joins"),
    "queries.html": ARTICLE.replace(ARTICLE_TITLE, "Discoverme guide two: SQL queries"),
    "offtopic.html": ARTICLE.replace(ARTICLE_TITLE, "An offtopic page about gardening").replace(
        "<article>", "<article><p>This offtopic page is about gardening, not databases.</p>", 1
    ),
}
TAVILY_HITS = [
    {"url": f"http://127.0.0.1:{PORT}/learn/offtopic.html", "title": "An offtopic page about gardening", "score": 0.95},
    {"url": f"http://127.0.0.2:{PORT}/learn/joins.html", "title": "Discoverme guide one: SQL joins", "score": 0.9},
    {"url": f"http://127.0.0.3:{PORT}/learn/queries.html", "title": "Discoverme guide two: SQL queries", "score": 0.8},
]


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path == "/w/api.php":
            query = parse_qs(parts.query).get("srsearch", [""])[0]
            hits = [HIT] if "Discoverme" in query else []
            return self._json({"batchcomplete": True, "query": {"search": hits}})
        name = parts.path.removeprefix("/learn/")
        if parts.path.startswith("/learn/") and name in LEARN:
            time.sleep(LEARN_DELAY_S)
            body = LEARN[name].encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/tavily/search":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        query = json.loads(self.rfile.read(length) or b"{}").get("query", "")
        token = re.search(r"Discoverme\w*", query)
        hits = [{**h, "url": f"{h['url']}?v={token.group(0)}"} for h in TAVILY_HITS] if token else []
        return self._json({"query": query, "results": hits})


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=str(SITE))
    servers = [http.server.ThreadingHTTPServer((host, PORT), handler) for host in HOSTS]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    servers[0].serve_forever()
