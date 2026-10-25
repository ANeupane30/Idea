import psycopg
import pytest

from worker import __main__ as main_mod


class _Stop(BaseException):
    """Ends the otherwise endless serve loop."""


class FakeConn:
    def __init__(self, rollback_error=None):
        self.closed = False
        self.rollback_error = rollback_error
        self.rollbacks = 0

    def rollback(self):
        self.rollbacks += 1
        if self.rollback_error:
            raise self.rollback_error

    def close(self):
        self.closed = True


def _serve(outcomes, conns):
    """Run serve with scripted run_once outcomes; returns (sleeps, connections made)."""
    made, sleeps = [], []
    script = list(outcomes)

    def connect():
        c = conns.pop(0) if conns else FakeConn()
        made.append(c)
        return c

    def run(conn, handlers):
        out = script.pop(0) if script else _Stop()
        if isinstance(out, BaseException):
            raise out
        return out

    with pytest.raises(_Stop):
        main_mod.serve(connect, {}, poll_interval_s=0.5, sleep=sleeps.append, run=run)
    return sleeps, made


def test_operational_error_reconnects_with_doubling_backoff():
    err = psycopg.OperationalError("server closed the connection")
    sleeps, made = _serve([err] * 5 + [True], [])
    assert sleeps == [2, 4, 8, 16, 30]
    assert len(made) == 6
    assert all(c.closed for c in made)  # including the last one, closed on exit


def test_backoff_resets_after_a_successful_run():
    err = psycopg.OperationalError("down")
    sleeps, _ = _serve([err, err, False, err], [])
    assert sleeps == [2, 4, 0.5, 2]


def test_failed_rollback_reconnects_instead_of_exiting():
    bad = FakeConn(rollback_error=psycopg.OperationalError("gone"))
    sleeps, made = _serve([RuntimeError("boom"), True], [bad])
    assert bad.rollbacks == 1 and bad.closed
    assert sleeps == [2]
    assert len(made) == 2


def test_other_errors_roll_back_and_keep_the_connection():
    good = FakeConn()
    sleeps, made = _serve([RuntimeError("boom"), True], [good])
    assert good.rollbacks == 1
    assert sleeps == [0.5]
    assert made == [good]


def test_serve_sweeps_before_each_run_and_survives_sweep_errors():
    calls = []

    def sweep(conn):
        calls.append(conn)
        if len(calls) == 1:
            raise RuntimeError("sweep failed")
        return 0

    script = [True, True]

    def run(conn, handlers):
        if not script:
            raise _Stop()
        return script.pop(0)

    with pytest.raises(_Stop):
        main_mod.serve(lambda: FakeConn(), {}, poll_interval_s=0.5, sleep=lambda s: None, run=run, sweep=sweep)
    assert len(calls) == 3
