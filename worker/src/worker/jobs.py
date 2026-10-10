"""Postgres-backed job queue.

Every state change runs in `with conn.transaction():`. On a plain connection
that commits; inside an outer transaction (as in the tests) it is a savepoint.
"""

import logging
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

import psycopg

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 4
GENERIC_MESSAGE = "Something went wrong building this. Please try again."


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


def fail(conn: psycopg.Connection, job: Job, error: Exception, handler: Handler) -> None:
    permanent = isinstance(error, PermanentJobError)
    with conn.transaction():
        if permanent or job.attempts >= MAX_ATTEMPTS:
            message = error.message if isinstance(error, PermanentJobError) else GENERIC_MESSAGE
            _mark_failed(conn, job, repr(error))
            handler.on_permanent_failure(conn, job, message)
        else:
            conn.execute(
                "update jobs set status = 'queued', last_error = %s, locked_at = null,"
                " run_after = now() + make_interval(secs => 10 * power(2, %s))"
                " where id = %s",
                (repr(error), job.attempts, job.id),
            )
            handler.on_retry(conn, job)


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
    try:
        # Own transaction so a failing handler's partial writes are rolled back.
        with conn.transaction():
            handler.run(conn, job)
    except Exception as e:
        log.warning("job %s (%s) failed on attempt %d: %r", job.id, job.kind, job.attempts, e)
        fail(conn, job, e, handler)
    else:
        complete(conn, job)
    return True
