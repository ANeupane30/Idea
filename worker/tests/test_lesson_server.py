import http.client
import json
import threading
import uuid

import pytest

from worker import lesson_server
from worker.config import Settings

TOKEN = "test-token"


class StubGenerator:
    def __init__(self, events, gate: threading.Event | None = None):
        self.events = events
        self.gate = gate
        self.calls = []

    def generate(self, conn, user_id, subtopic_id, fmt, refresh):
        self.calls.append((user_id, subtopic_id, fmt, refresh))
        for i, event in enumerate(self.events):
            if i == 2 and self.gate is not None:
                assert self.gate.wait(5), "client never read the first line"
            yield event


class FakeConn:
    closed = False

    def close(self):
        self.closed = True


@pytest.fixture
def serve():
    servers = []

    def _serve(generator):
        conns = []

        def connect():
            conns.append(FakeConn())
            return conns[-1]

        server = lesson_server.make_server(
            Settings(lesson_server_token=TOKEN, lesson_server_port=0), generator, connect
        )
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return server.server_address[1], conns

    yield _serve
    for s in servers:
        s.shutdown()
        s.server_close()


def post(port, body, token=TOKEN, path="/lessons"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {"content-type": "application/json"}
    if token is not None:
        headers["authorization"] = f"Bearer {token}"
    c.request("POST", path, body=data, headers=headers)
    return c.getresponse()


def valid_body():
    return {"user_id": str(uuid.uuid4()), "subtopic_id": str(uuid.uuid4()), "format": "visual", "refresh": False}


def test_requires_token(serve):
    port, _ = serve(StubGenerator([]))
    assert post(port, valid_body(), token=None).status == 401
    assert post(port, valid_body(), token="wrong").status == 401


@pytest.mark.parametrize(
    "body",
    [
        b"{not json",
        {**valid_body(), "format": "audio"},
        {**valid_body(), "subtopic_id": "x"},
        {**valid_body(), "refresh": "yes"},
        b"{" + b'"a":"' + b"x" * 5000 + b'"}',
    ],
)
def test_rejects_bad_bodies(serve, body):
    port, _ = serve(StubGenerator([]))
    assert post(port, body).status == 400


def test_streams_ndjson(serve):
    gate = threading.Event()
    events = [{"type": "section", "index": 0}, {"type": "section", "index": 1}, {"type": "done", "lesson_id": "x"}]
    gen = StubGenerator(events, gate)
    port, conns = serve(gen)
    body = valid_body()
    resp = post(port, body)
    assert resp.status == 200
    assert resp.getheader("content-type") == "application/x-ndjson"
    first = json.loads(resp.readline())
    assert first == events[0]
    gate.set()  # the generator only produces event 3 after we've read line 1
    rest = [json.loads(line) for line in resp.read().splitlines() if line.strip()]
    assert rest == events[1:]
    assert gen.calls == [(uuid.UUID(body["user_id"]), uuid.UUID(body["subtopic_id"]), "visual", False)]
    assert conns and conns[0].closed


def test_unknown_path_404(serve):
    port, _ = serve(StubGenerator([]))
    assert post(port, valid_body(), path="/other").status == 404


def test_main_requires_token(monkeypatch):
    monkeypatch.delenv("LESSON_SERVER_TOKEN", raising=False)
    monkeypatch.setattr(lesson_server, "Settings", lambda: Settings(lesson_server_token=None))
    with pytest.raises(RuntimeError, match="LESSON_SERVER_TOKEN"):
        lesson_server.main()
