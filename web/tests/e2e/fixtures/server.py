"""Fixture site for the e2e tests: serves site/ statically, plus a fake Wikipedia search API.

/w/api.php answers like Wikipedia's list=search. Only searches containing "Discoverme" find
anything (the fixture article), so goals in other specs get no automatic sources.
"""

import functools
import http.server
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SITE = Path(__file__).parent / "site"
HIT = {"ns": 0, "title": "Fixture SQL joins", "pageid": 1, "wordcount": 900, "snippet": "Joins combine rows"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path == "/w/api.php":
            query = parse_qs(parts.query).get("srsearch", [""])[0]
            hits = [HIT] if "Discoverme" in query else []
            body = json.dumps({"batchcomplete": True, "query": {"search": hits}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), functools.partial(Handler, directory=str(SITE)))
    server.serve_forever()
