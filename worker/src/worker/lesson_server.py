"""The lesson server: Next.js POSTs a lesson request and relays this NDJSON stream to the browser.

Only the web app calls it (bearer token). It binds to localhost by default. Each request
gets its own database connection, and one JSON event per line is flushed as soon as it exists.
"""

import hmac
import json
import logging
import sys
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import UUID

import psycopg

from worker.config import Settings
from worker.db import connect
from worker.ingest.embed import make_embedder
from worker.lessons.diagrams import MermaidValidator
from worker.lessons.generator import LessonGenerator
from worker.lessons.prompt import FORMATS
from worker.llm import make_llm

log = logging.getLogger("worker.lesson_server")

MAX_BODY = 4096


def _parse(raw: bytes) -> tuple[UUID, UUID, str, bool] | None:
    try:
        body = json.loads(raw)
        user_id = UUID(str(body["user_id"]))
        subtopic_id = UUID(str(body["subtopic_id"]))
        fmt = body["format"]
        refresh = body.get("refresh", False)
    except (ValueError, KeyError, TypeError):
        return None
    if fmt not in FORMATS or not isinstance(refresh, bool):
        return None
    return user_id, subtopic_id, fmt, refresh


def make_server(
    settings: Settings, generator: LessonGenerator, connect_fn: Callable[[], psycopg.Connection]
) -> ThreadingHTTPServer:
    expected = f"Bearer {settings.lesson_server_token or ''}".encode()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log.info("%s %s", self.address_string(), fmt % args)

        def _reply(self, status: int) -> None:
            self.send_response(status)
            self.send_header("content-length", "0")
            self.end_headers()

        def do_GET(self):
            self._reply(404)

        def do_POST(self):
            if self.path != "/lessons":
                return self._reply(404)
            given = self.headers.get("authorization", "").encode()
            if not settings.lesson_server_token or not hmac.compare_digest(given, expected):
                return self._reply(401)
            try:
                length = int(self.headers.get("content-length", "0"))
            except ValueError:
                return self._reply(400)
            if not 0 < length <= MAX_BODY:
                return self._reply(400)
            request = _parse(self.rfile.read(length))
            if request is None:
                return self._reply(400)

            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson")
            self.send_header("cache-control", "no-store")
            self.end_headers()
            conn = connect_fn()
            events = generator.generate(conn, *request)
            try:
                for event in events:
                    self.wfile.write(json.dumps(event).encode() + b"\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                log.info("client went away during a lesson stream")
            except Exception:
                log.exception("lesson stream failed")
                try:
                    self.wfile.write(json.dumps({"type": "error", "code": "failed"}).encode() + b"\n")
                except OSError:
                    pass
            finally:
                events.close()
                conn.close()

    server = ThreadingHTTPServer((settings.lesson_server_host, settings.lesson_server_port), Handler)
    server.daemon_threads = True
    return server


def main() -> None:
    logging.basicConfig(
        stream=sys.stdout, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    settings = Settings()
    if not settings.lesson_server_token:
        raise RuntimeError("LESSON_SERVER_TOKEN is required")
    generator = LessonGenerator(
        make_llm(settings), make_embedder(settings), MermaidValidator(settings.mermaid_js_path)
    )
    server = make_server(settings, generator, lambda: connect(settings))
    host, port = server.server_address[:2]
    log.info("lesson server started on http://%s:%s", host, port)
    sys.stdout.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
