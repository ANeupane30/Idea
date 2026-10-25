"""Postgres-backed job queue.

Every state change runs in `with conn.transaction():`. On a plain connection
that commits; inside an outer transaction (as in the tests) it is a savepoint.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

import anthropic
import openai
import psycopg

from worker import timing

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 4
GENERIC_MESSAGE = "Something went wrong building this. Please try again."
# Rate limits that outlast the retries: on OpenRouter's free models, usually the daily quota.
AI_BUSY = "Our AI is busy right now. Try again later."


def is_rate_limited(error: BaseException) -> bool:
    return isinstance(error, (openai.RateLimitError, anthropic.RateLimitError))


def final_message(error: Exception, default: str) -> str:
    """The learner-facing message for a job that failed after its last retry."""
    return AI_BUSY if is_rate_limited(error) else default


@dataclass
class Job:
    id: UUID
    kind: str
    payload: dict
    attempts: int
    step: str | None


class PermanentJobError(Exception):
    """Raised by a handler for failures that retrying cannot fix."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Handler(Protocol):
    """A job handler.

    `run` is called with no transaction open. Handlers own their transactions: they
    group writes in short `with conn.transaction():` blocks (never `conn.commit()`)
    and must not hold one open across slow work such as an LLM call. A block that
    raises rolls back; blocks that already finished stay committed.
    """

    def run(self, conn: psycopg.Connection, job: Job) -> None: ...

    def on_retry(self, conn: psycopg.Connection, job: Job) -> None: ...

    def on_permanent_failure(self, conn: psycopg.Connection, job: Job, message: str) -> None: ...


_CLAIM_SQL = """
update jobs set status = 'running', attempts = attempts + 1, locked_at = now()
where id = (
  select id from jobs
  where (status = 'queued' and run_after <= now())
     or (status = 'running' and locked_at < now() - interval '10 minutes')
  order by created_at
  for update skip locked
  limit 1
)
returning *
"""


def claim(conn: psycopg.Connection) -> Job | None:
    with conn.transaction():
        r = conn.execute(_CLAIM_SQL).fetchone()
    if r is None:
        return None
    return Job(r["id"], r["kind"], r["payload"], r["attempts"], r["step"])


def complete(conn: psycopg.Connection, job: Job) -> None:
    with conn.transaction():
        conn.execute("update jobs set status = 'done', locked_at = null where id = %s", (job.id,))


def _mark_failed(conn: psycopg.Connection, job: Job, error: str) -> None:
    conn.execute(
        "update jobs set status = 'failed', last_error = %s, locked_at = null where id = %s",
        (error, job.id),
    )


PendingWrite = Callable[[psycopg.Connection], None]


def _apply_pending(conn: psycopg.Connection, writes: list[PendingWrite]) -> None:
    """Run writes a failed handler asked to persist (e.g. usage rows); one bad write can't block the rest."""
    for write in writes:
        try:
            with conn.transaction():
                write(conn)
        except Exception:
            log.exception("pending write failed")


def _fail_permanently(
    conn: psycopg.Connection,
    job: Job,
    last_error: str,
    message: str,
    handler: Handler,
    writes: list[PendingWrite] | None = None,
) -> None:
    # Status change commits on its own so a failing hook cannot undo it.
    with conn.transaction():
        _mark_failed(conn, job, last_error)
        _apply_pending(conn, writes or [])
    try:
        with conn.transaction():
            handler.on_permanent_failure(conn, job, message)
    except Exception:
        log.exception("on_permanent_failure hook failed for job %s", job.id)


def fail(conn: psycopg.Connection, job: Job, error: Exception, handler: Handler) -> None:
    # A handler may attach `pending_writes` to its exception: writes that must survive
    # the rollback of its own transaction. They commit together with the status change.
    writes = list(getattr(error, "pending_writes", []))
    if isinstance(error, PermanentJobError):
        _fail_permanently(conn, job, repr(error), error.message, handler, writes)
    elif job.attempts >= MAX_ATTEMPTS:
        _fail_permanently(conn, job, repr(error), final_message(error, GENERIC_MESSAGE), handler, writes)
    else:
        with conn.transaction():
            _apply_pending(conn, writes)
            conn.execute(
                "update jobs set status = 'queued', last_error = %s, locked_at = null,"
                " run_after = now() + make_interval(secs => 10 * power(2, %s))"
                " where id = %s",
                (repr(error), job.attempts, job.id),
            )
        try:
            with conn.transaction():
                handler.on_retry(conn, job)
        except Exception:
            log.exception("on_retry hook failed for job %s", job.id)


def run_once(conn: psycopg.Connection, handlers: dict[str, Handler]) -> bool:
    """Claim and process one job. Returns False when there was nothing to do."""
    job = claim(conn)
    if job is None:
        return False
    handler = handlers.get(job.kind)
    if handler is None:
        log.error("no handler for job kind %r (job %s)", job.kind, job.id)
        with conn.transaction():
            _mark_failed(conn, job, f"unknown job kind: {job.kind}")
        return True
    if job.attempts > MAX_ATTEMPTS:
        # A stale 'running' job reclaimed past its attempt budget: the worker
        # crashed on it repeatedly. Do not run it again.
        _fail_permanently(conn, job, "worker crashed repeatedly", GENERIC_MESSAGE, handler)
        return True
    timing.job_started(job.kind, job.payload.get("goal_id") or job.payload.get("source_id") or job.id)
    try:
        handler.run(conn, job)
    except Exception as e:
        log.warning("job %s (%s) failed on attempt %d: %r", job.id, job.kind, job.attempts, e)
        timing.mark("failed")
        fail(conn, job, e, handler)
    else:
        timing.mark("done")
        complete(conn, job)
    return True
