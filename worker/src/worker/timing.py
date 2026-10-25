"""Timing lines for a goal's preparation: grep "timing" in the worker log to see where time goes.

Each line is "timing <job kind> <goal or source id> +<seconds since the job started> <event> ..."."""

import logging
import threading
import time

log = logging.getLogger("worker.timing")
_job = threading.local()


def job_started(kind: str, ref: object) -> None:
    _job.kind, _job.ref, _job.t0 = kind, ref, time.monotonic()


def mark(event: str, **fields: object) -> None:
    t0 = getattr(_job, "t0", None)
    elapsed = time.monotonic() - t0 if t0 is not None else 0.0
    detail = " ".join([event, *(f"{k}={v}" for k, v in fields.items())])
    log.info("timing %s %s +%.1fs %s", getattr(_job, "kind", "-"), getattr(_job, "ref", "-"), elapsed, detail)


class Stopwatch:
    """with Stopwatch() as sw: ...; then sw.secs (rounded to 0.1 s)."""

    def __enter__(self) -> "Stopwatch":
        self._t0 = time.monotonic()
        self.secs = 0.0
        return self

    def __exit__(self, *exc: object) -> None:
        self.secs = round(time.monotonic() - self._t0, 1)
