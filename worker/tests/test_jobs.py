from datetime import timedelta
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from worker import jobs
from worker.jobs import Job, PermanentJobError

GENERIC = "Something went wrong building this. Please try again."


@pytest.fixture(autouse=True)
def empty_queue(db):
    db.execute("delete from jobs")


def add_job(db, kind="k", **cols):
    cols = {"kind": kind, **cols}
    names = ", ".join(cols)
    marks = ", ".join(
        "now() + interval '1 hour'" if v == "FUTURE" else "now() - interval '11 minutes'" if v == "STALE" else "%s"
        for v in cols.values()
    )
    values = [Jsonb(v) if isinstance(v, dict) else v for v in cols.values() if v not in ("FUTURE", "STALE")]
    return db.execute(f"insert into jobs ({names}) values ({marks}) returning id", values).fetchone()["id"]


def row(db, job_id):
    return db.execute("select * from jobs where id = %s", (job_id,)).fetchone()


def seconds_from_now(db, ts):
    return db.execute("select extract(epoch from (%s::timestamptz - now())) as s", (ts,)).fetchone()["s"]


class Recorder:
    def __init__(self, raises=None):
        self.raises = raises
        self.calls = []

    def run(self, conn, job):
        self.calls.append(("run", job.id))
        if self.raises:
            raise self.raises

    def on_retry(self, conn, job):
        self.calls.append(("retry", job.id))

    def on_permanent_failure(self, conn, job, message):
        self.calls.append(("permanent", job.id, message))


def test_claim_returns_oldest_due_job_and_marks_running(db):
    older = add_job(db, created_at=db.execute("select now() - interval '1 minute' as t").fetchone()["t"])
    add_job(db)
    job = jobs.claim(db)
    assert job.id == older
    r = row(db, older)
    assert r["status"] == "running"
    assert r["attempts"] == 1 and job.attempts == 1
    assert r["locked_at"] is not None


def test_claim_skips_future_run_after(db):
    add_job(db, run_after="FUTURE")
    assert jobs.claim(db) is None


def test_claim_reclaims_stale_running_job(db):
    jid = add_job(db, status="running", attempts=1, locked_at="STALE")
    job = jobs.claim(db)
    assert job.id == jid and job.attempts == 2


def test_fail_retryable_requeues_with_backoff(db):
    jid = add_job(db, status="running", attempts=1)
    h = Recorder()
    jobs.fail(db, Job(jid, "k", {}, 1, None), RuntimeError("boom"), h)
    r = row(db, jid)
    assert r["status"] == "queued"
    assert 17 <= seconds_from_now(db, r["run_after"]) <= 23
    assert "boom" in r["last_error"]
    assert h.calls == [("retry", jid)]


def test_fail_after_max_attempts_is_permanent(db):
    jid = add_job(db, status="running", attempts=jobs.MAX_ATTEMPTS)
    h = Recorder()
    jobs.fail(db, Job(jid, "k", {}, jobs.MAX_ATTEMPTS, None), RuntimeError("boom"), h)
    assert row(db, jid)["status"] == "failed"
    assert h.calls == [("permanent", jid, GENERIC)]


def test_permanent_error_fails_immediately(db):
    jid = add_job(db, status="running", attempts=1)
    h = Recorder()
    jobs.fail(db, Job(jid, "k", {}, 1, None), PermanentJobError("x"), h)
    assert row(db, jid)["status"] == "failed"
    assert h.calls == [("permanent", jid, "x")]


def test_run_once_runs_handler_and_completes(db):
    jid = add_job(db, kind="ok")
    h = Recorder()
    assert jobs.run_once(db, {"ok": h}) is True
    assert row(db, jid)["status"] == "done"
    assert h.calls == [("run", jid)]


def test_run_once_handler_error_requeues(db):
    jid = add_job(db, kind="bad")
    h = Recorder(raises=RuntimeError("boom"))
    assert jobs.run_once(db, {"bad": h}) is True
    assert row(db, jid)["status"] == "queued"
    assert h.calls == [("run", jid), ("retry", jid)]


def test_run_once_unknown_kind_fails_permanently(db):
    jid = add_job(db, kind="nope")
    assert jobs.run_once(db, {}) is True
    r = row(db, jid)
    assert r["status"] == "failed"
    assert "nope" in r["last_error"]


def test_run_once_returns_false_when_empty(db):
    assert jobs.run_once(db, {}) is False


def test_job_dataclass_fields():
    j = Job(uuid4(), "k", {}, 0, None)
    assert j.step is None


def test_fixtures_make_user_and_goal_enqueue_topic_map(db, make_user, make_goal):
    uid = make_user(db, "pro")
    gid = make_goal(db, uid, title="Learn Rust")
    plan = db.execute("select plan from public.users where id = %s", (uid,)).fetchone()["plan"]
    assert plan == "pro"
    job = jobs.claim(db)
    assert job.kind == "topic_map" and job.payload == {"goal_id": str(gid)}
