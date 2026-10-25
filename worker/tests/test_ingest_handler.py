import json
import uuid
from pathlib import Path

import httpx
import pytest

from worker import jobs
from worker.config import Settings
from worker.ingest import messages
from worker.ingest.embed import FakeEmbedder
from worker.ingest.extract_youtube import Transcript
from worker.ingest.handler import PLAN_LIMITS, IngestHandler
from worker.ingest.mapping import MappingResponse
from worker.ingest.punctuate import PunctuationResponse
from worker.ingest.urls import content_hash
from worker.jobs import Job
from worker.llm import DEFAULT_FIXTURES_DIR, FakeLLM, LLMResult

FIXTURES = Path(__file__).parent / "fixtures"
ARTICLE = (FIXTURES / "sites" / "article.html").read_text(encoding="utf-8")
BAKING = "<html><head><title>Baking bread</title></head><body><article>" + "".join(
    f"<p>Knead the dough for ten minutes, then let the yeast rise in a warm place until it doubles. "
    f"Shape the loaf, score the crust and bake it in a hot oven until golden brown. Step {i}.</p>"
    for i in range(8)
) + "</article></body></html>"
VIDEO = "dQw4w9WgXcQ"


class Site:
    """MockTransport serving one HTML body for every URL; counts requests."""

    def __init__(self, body: str = ARTICLE, status: int = 200):
        self.calls = 0
        self.body, self.status = body, status
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request):
        self.calls += 1
        return httpx.Response(self.status, headers={"content-type": "text/html; charset=utf-8"}, text=self.body)


class NoRenderer:
    def render(self, url):
        raise AssertionError("renderer not expected")


class TimeoutRenderer:
    def render(self, url):
        raise TimeoutError("render timed out")


class Transcripts:
    def __init__(self, transcript=None, title="SQL video"):
        self.transcript, self._title = transcript, title
        self.calls = 0

    def fetch(self, video_id):
        self.calls += 1
        return self.transcript

    def title(self, video_id):
        return self._title


class Storage:
    def __init__(self, data: bytes = b""):
        self.data = data

    def download(self, path):
        return self.data


class SpyLLM:
    """Wraps FakeLLM; records schemas; can replace mapping responses or run a hook on each call."""

    def __init__(self, mapping_outputs=None, on_call=None):
        self.fake = FakeLLM(DEFAULT_FIXTURES_DIR)
        self.schemas = []
        self.mapping_outputs = list(mapping_outputs or [])
        self.on_call = on_call

    def parse(self, *, model, system, user, schema, max_tokens=16000):
        self.schemas.append(schema)
        if self.on_call:
            self.on_call(schema)
        if schema is MappingResponse and self.mapping_outputs:
            return LLMResult(self.mapping_outputs.pop(0), 10, 20, model)
        return self.fake.parse(model=model, system=system, user=user, schema=schema, max_tokens=max_tokens)


def handler(site=None, llm=None, embedder=None, renderer=None, transcripts=None, storage=None):
    return IngestHandler(
        llm=llm or FakeLLM(DEFAULT_FIXTURES_DIR),
        embedder=embedder or FakeEmbedder(),
        storage=storage or Storage(),
        renderer=renderer or NoRenderer(),
        transcripts=transcripts or Transcripts(),
        allow_private=True,
        transport=(site or Site()).transport,
    )


def job(sid) -> Job:
    return Job(id=sid, kind="ingest_source", payload={"source_id": str(sid)}, attempts=1, step=None)


def run_queued(db, h, sid):
    """Process the source's queued job through the real queue (failure and retry handling included)."""
    db.execute(
        "delete from jobs where status = 'queued' and payload->>'source_id' is distinct from %s", (str(sid),)
    )
    assert jobs.run_once(db, {"ingest_source": h}) is True


def source(db, sid):
    return db.execute("select * from sources where id = %s", (sid,)).fetchone()


def chunk_count(db, chash):
    return db.execute("select count(*) as n from source_chunks where content_hash = %s", (chash,)).fetchone()["n"]


def coverage(db, gid):
    rows = db.execute(
        "select s.title, c.state from subtopic_coverage c join subtopics s on s.id = c.subtopic_id where c.goal_id = %s",
        (gid,),
    ).fetchall()
    return {r["title"]: r["state"] for r in rows}


def transcript(minutes: float, generated=False, words="select rows from tables with where") -> Transcript:
    n = int(minutes * 60 / 4)
    return Transcript([(f"{words} part {i}", i * 4.0, 4.0) for i in range(n)], generated)


def test_plan_limits():
    assert (PLAN_LIMITS["free"].video_minutes, PLAN_LIMITS["free"].pdf_pages, PLAN_LIMITS["free"].tokens) == (
        90,
        150,
        60_000,
    )
    assert (PLAN_LIMITS["pro"].video_minutes, PLAN_LIMITS["pro"].pdf_pages, PLAN_LIMITS["pro"].tokens) == (
        240,
        600,
        250_000,
    )


def test_web_source_ready(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    sid = make_source(uid, gid, "http://127.0.0.1/article.html")
    handler().run(db, job(sid))
    s = source(db, sid)
    assert s["status"] == "ready" and s["step"] is None
    assert s["title"] == "A practical guide to SQL: SELECT, WHERE and JOIN"
    assert s["relevance_label"] == "high"
    assert s["relevance_reason"]
    assert chunk_count(db, s["content_hash"]) >= 1
    cov = coverage(db, gid)
    assert cov["Joining tables"] == "covered"
    assert cov["Indexes and query performance"] == "gap"


def test_steps_recorded(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    sid = make_source(uid, gid, "http://127.0.0.1/article.html")
    seen = []

    class StepEmbedder(FakeEmbedder):
        def embed_passages(self, texts):
            seen.append(source(db, sid)["step"])
            return super().embed_passages(texts)

    llm = SpyLLM(on_call=lambda schema: seen.append(source(db, sid)["step"]))
    handler(llm=llm, embedder=StepEmbedder()).run(db, job(sid))
    assert seen[0] == "embedding"
    assert seen[-1] == "mapping"
    assert source(db, sid)["status"] == "ready"


def test_reuses_chunks_across_users(db, make_user, make_ready_goal, make_source):
    a, b = make_user(), make_user()
    ga, gb = make_ready_goal(a), make_ready_goal(b)
    sa = make_source(a, ga, "http://127.0.0.1/article.html")
    handler().run(db, job(sa))
    chash = source(db, sa)["content_hash"]
    before = chunk_count(db, chash)

    site = Site()
    sb = make_source(b, gb, "http://127.0.0.1/article.html?utm_source=newsletter")
    handler(site=site).run(db, job(sb))
    assert site.calls == 0
    s = source(db, sb)
    assert s["status"] == "ready" and s["content_hash"] == chash
    assert s["title"] == "A practical guide to SQL: SELECT, WHERE and JOIN"
    assert chunk_count(db, chash) == before


def test_cached_chunks_from_another_embedding_model_are_reembedded(db, make_user, make_ready_goal, make_source):
    """Vectors from different models aren't comparable: a cache hit under a new model re-embeds the chunks."""
    import hashlib

    class OtherModelEmbedder(FakeEmbedder):
        model = "other-model-384"

        def _one(self, text):
            # Same idea, different vector space (salted buckets).
            vec = [0.0] * 384
            for word in __import__("re").findall(r"[a-z]{3,}", text.lower()):
                vec[int(hashlib.sha1(b"salt" + word.encode()).hexdigest(), 16) % 384] += 1.0
            norm = sum(x * x for x in vec) ** 0.5 or 1.0
            return [x / norm for x in vec]

    a, b = make_user(), make_user()
    sa = make_source(a, make_ready_goal(a), "http://127.0.0.1/article.html")
    handler().run(db, job(sa))
    chash = source(db, sa)["content_hash"]
    before = chunk_count(db, chash)

    site = Site()
    sb = make_source(b, make_ready_goal(b), "http://127.0.0.1/article.html")
    handler(site=site, embedder=OtherModelEmbedder()).run(db, job(sb))
    s = source(db, sb)
    assert site.calls == 0
    assert (s["status"], s["relevance_label"]) == ("ready", "high")
    model = db.execute("select embed_model from contents where content_hash = %s", (chash,)).fetchone()["embed_model"]
    assert model == "other-model-384"
    assert chunk_count(db, chash) == before


def test_duplicate_in_goal_fails(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    first = make_source(uid, gid, "http://127.0.0.1/article.html")
    handler().run(db, job(first))
    second = make_source(uid, gid, "http://127.0.0.1/article.html?utm_source=x#top")
    run_queued(db, handler(), second)
    s = source(db, second)
    assert (s["status"], s["error"]) == ("failed", messages.DUPLICATE)
    assert source(db, first)["status"] == "ready"


def test_cached_content_still_checks_plan_caps(db, make_user, make_ready_goal, make_source):
    db.execute(
        "insert into contents (content_hash, type, title, token_count, duration_s, embed_model)"
        " values (%s, 'youtube', 'Long video', 50000, %s, 'fake-hash-384') on conflict do nothing",
        (content_hash("youtube", VIDEO), 3 * 3600),
    )
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), f"https://youtu.be/{VIDEO}", type="youtube")
    transcripts = Transcripts(transcript(1))
    run_queued(db, handler(transcripts=transcripts), sid)
    s = source(db, sid)
    assert (s["status"], s["error"]) == ("failed", messages.VIDEO_TOO_LONG.format(n=90))
    assert transcripts.calls == 0


def test_video_cap_fresh(db, make_user, make_ready_goal, make_source):
    free = make_user()
    sid = make_source(free, make_ready_goal(free), f"https://www.youtube.com/watch?v={VIDEO}", type="youtube")
    run_queued(db, handler(transcripts=Transcripts(transcript(100))), sid)
    assert source(db, sid)["error"] == messages.VIDEO_TOO_LONG.format(n=90)

    pro = make_user(plan="pro")
    sid = make_source(pro, make_ready_goal(pro), f"https://www.youtube.com/watch?v={VIDEO}", type="youtube")
    run_queued(db, handler(transcripts=Transcripts(transcript(100))), sid)
    s = source(db, sid)
    assert s["status"] == "ready", s["error"]
    first = db.execute(
        "select timestamp_start from source_chunks where content_hash = %s order by position limit 1",
        (s["content_hash"],),
    ).fetchone()
    assert first["timestamp_start"] == 0


def test_not_a_video(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "https://www.youtube.com/playlist?list=PL1", type="youtube")
    run_queued(db, handler(), sid)
    assert source(db, sid)["error"] == messages.NOT_A_VIDEO


def test_pdf_source(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), f"{uid}/{uuid.uuid4()}.pdf", type="pdf", file_name="notes.pdf")
    handler(storage=Storage((FIXTURES / "sql_basics.pdf").read_bytes())).run(db, job(sid))
    s = source(db, sid)
    assert s["status"] == "ready"
    assert s["title"] == "SQL basics"
    pages = db.execute(
        "select page from source_chunks where content_hash = %s", (s["content_hash"],)
    ).fetchall()
    assert pages and all(p["page"] for p in pages)


def test_auto_captions_repaired_and_billed(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), f"https://youtu.be/{VIDEO}", type="youtube")
    llm = SpyLLM()
    handler(llm=llm, transcripts=Transcripts(transcript(5, generated=True))).run(db, job(sid))
    assert PunctuationResponse in llm.schemas
    kinds = {
        r["kind"] for r in db.execute("select kind from usage_events where user_id = %s", (uid,)).fetchall()
    }
    assert {"ingest", "map"} <= kinds
    assert source(db, sid)["status"] == "ready"


def test_off_topic_source(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    sid = make_source(uid, gid, "http://127.0.0.1/bread.html")
    handler(site=Site(BAKING)).run(db, job(sid))
    s = source(db, sid)
    assert s["status"] == "ready"
    assert s["relevance_label"] == "off_topic"
    assert set(coverage(db, gid).values()) == {"gap"}


def test_mapping_repair_then_fail(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "http://127.0.0.1/article.html")
    empty = MappingResponse(results=[])
    run_queued(db, handler(llm=SpyLLM(mapping_outputs=[empty, empty])), sid)
    s = source(db, sid)
    assert (s["status"], s["error"]) == ("failed", messages.MAPPING_FAILED)
    n = db.execute(
        "select count(*) as n from usage_events where user_id = %s and kind = 'map'", (uid,)
    ).fetchone()["n"]
    assert n == 2


def test_mapping_refusal_fails_with_mapping_message_and_bills(db, make_user, make_ready_goal, make_source):
    from worker.llm import LLMRefusal

    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "http://127.0.0.1/article.html")

    class Refuses(SpyLLM):
        def parse(self, *, model, system, user, schema, max_tokens=16000):
            if schema is MappingResponse:
                raise LLMRefusal("We couldn't build a topic map for this goal. Try rewording it.", 12, 3, model)
            return super().parse(model=model, system=system, user=user, schema=schema, max_tokens=max_tokens)

    run_queued(db, handler(llm=Refuses()), sid)
    s = source(db, sid)
    assert (s["status"], s["error"]) == ("failed", messages.MAPPING_FAILED)
    n = db.execute(
        "select count(*) as n from usage_events where user_id = %s and kind = 'map'", (uid,)
    ).fetchone()["n"]
    assert n == 1


def test_heartbeat_keeps_job_claimed(db, make_user, make_ready_goal, make_source):
    """Each step refreshes the job's lock, so a long job isn't reclaimed by another worker."""
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "http://127.0.0.1/article.html")
    db.execute(
        "update jobs set status = 'running', locked_at = now() - interval '20 minutes'"
        " where payload->>'source_id' = %s",
        (str(sid),),
    )
    handler().run(db, job(sid))
    stale = db.execute(
        "select locked_at < now() - interval '10 minutes' as stale from jobs where payload->>'source_id' = %s",
        (str(sid),),
    ).fetchone()["stale"]
    assert stale is False


def test_transient_error_marks_delayed(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "http://127.0.0.1/empty.html")
    empty = (FIXTURES / "sites" / "empty.html").read_text(encoding="utf-8")
    run_queued(db, handler(site=Site(empty), renderer=TimeoutRenderer()), sid)
    s = source(db, sid)
    assert (s["status"], s["delayed"]) == ("processing", True)
    j = db.execute("select status from jobs where payload->>'source_id' = %s", (str(sid),)).fetchone()
    assert j["status"] == "queued"


def test_source_deleted_mid_run(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "http://127.0.0.1/article.html")

    def delete(schema):
        if schema is MappingResponse:
            db.execute("delete from sources where id = %s", (sid,))

    handler(llm=SpyLLM(on_call=delete)).run(db, job(sid))
    assert source(db, sid) is None
    n = db.execute("select count(*) as n from source_coverage where source_id = %s", (sid,)).fetchone()["n"]
    assert n == 0


def test_archived_goal_skips_write(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    gid = make_ready_goal(uid)
    sid = make_source(uid, gid, "http://127.0.0.1/article.html")

    def fail_source(schema):
        if schema is MappingResponse:
            db.execute("update sources set status = 'failed', error = 'x' where id = %s", (sid,))

    handler(llm=SpyLLM(on_call=fail_source)).run(db, job(sid))
    assert source(db, sid)["status"] == "failed"


def test_retry_resumes_from_cache(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "http://127.0.0.1/article.html")
    empty = MappingResponse(results=[])
    run_queued(db, handler(llm=SpyLLM(mapping_outputs=[empty, empty])), sid)
    assert source(db, sid)["status"] == "failed"

    db.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(uid)}),))
    db.execute("select public.retry_source(%s)", (sid,))
    site = Site()
    run_queued(db, handler(site=site), sid)
    assert site.calls == 0
    assert source(db, sid)["status"] == "ready"


def test_permanent_failure_hook(db, make_user, make_ready_goal, make_source):
    uid = make_user()
    sid = make_source(uid, make_ready_goal(uid), "http://127.0.0.1/article.html")
    db.execute("update sources set status = 'processing', step = 'mapping', delayed = true where id = %s", (sid,))
    handler().on_permanent_failure(db, job(sid), "Nope.")
    s = source(db, sid)
    assert (s["status"], s["error"], s["step"], s["delayed"]) == ("failed", "Nope.", None, False)


def test_commits_each_step_and_leaves_no_transaction_open():
    """On real connections (no outer test transaction): another connection sees live steps and the result."""
    import psycopg

    from worker.db import connect

    a, b = connect(Settings()), connect(Settings())
    uid = uuid.uuid4()
    url = f"http://127.0.0.1/article.html?commit_test={uid}"
    try:
        with a.transaction():
            a.execute("insert into auth.users (id, email) values (%s, %s)", (uid, f"{uid}@example.com"))
            gid = a.execute(
                "insert into goals (user_id, title, map_status) values (%s, 'Learn SQL', 'ready') returning id", (uid,)
            ).fetchone()["id"]
            a.execute(
                "insert into subtopics (goal_id, title, summary, position) values (%s, 'Joining tables',"
                " 'Combine rows from related tables using inner and left joins.', 0)",
                (gid,),
            )
            sid = a.execute(
                "insert into sources (user_id, goal_id, type, url_or_file) values (%s, %s, 'web', %s) returning id",
                (uid, gid, url),
            ).fetchone()["id"]
        seen = []

        def committed_step():
            row = b.execute("select step from sources where id = %s", (sid,)).fetchone()
            b.rollback()
            seen.append(row["step"])

        class StepEmbedder(FakeEmbedder):
            def embed_passages(self, texts):
                committed_step()
                return super().embed_passages(texts)

        llm = SpyLLM(on_call=lambda schema: committed_step())
        handler(llm=llm, embedder=StepEmbedder()).run(a, job(sid))

        assert a.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
        assert seen[0] == "embedding" and seen[-1] == "mapping"
        row = b.execute("select status, relevance_label from sources where id = %s", (sid,)).fetchone()
        assert (row["status"], row["relevance_label"]) == ("ready", "high")
    finally:
        a.rollback()
        b.rollback()
        with a.transaction():
            a.execute("delete from contents where content_hash = %s", (content_hash("web", url),))
            a.execute("delete from auth.users where id = %s", (uid,))
        a.close()
        b.close()


def test_main_registers_ingest(monkeypatch):
    from worker import __main__ as main_mod

    handlers = main_mod.build_handlers(
        Settings(llm_provider="fake", embedder="fake", supabase_secret_key="key")
    )
    assert set(handlers) == {"topic_map", "ingest_source", "quiz_bank", "discover_sources"}
    with pytest.raises(RuntimeError, match="SUPABASE_SECRET_KEY"):
        main_mod.build_handlers(Settings(llm_provider="fake", embedder="fake", supabase_secret_key=None))


def test_not_found_source_is_noop(db):
    handler().run(db, job(uuid.uuid4()))

