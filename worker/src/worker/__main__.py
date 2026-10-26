import logging
import threading
import time
from collections.abc import Callable

import psycopg

from worker.log_setup import configure_logging
from worker.config import Settings
from worker.db import connect
from worker.discovery.gaps import FillGapsHandler
from worker.goal_ready import sweep
from worker.ingest.embed import make_embedder
from worker.ingest.extract_web import PlaywrightRenderer
from worker.ingest.extract_youtube import YouTubeTranscriptSource
from worker.ingest.handler import IngestHandler
from worker.ingest.storage import SupabaseStorage
from worker.jobs import Handler, run_once
from worker.llm import make_llm
from worker.prep.check import CheckSourcesHandler, VetFoundHandler
from worker.prep.find import FindSourcesHandler
from worker.prep.understand import UnderstandHandler
from worker.quiz.handler import QuizBankHandler
from worker.topic_map import TopicMapHandler

log = logging.getLogger("worker")

RECONNECT_BACKOFF_START_S = 2.0
RECONNECT_BACKOFF_MAX_S = 30.0


def _close_quietly(conn: psycopg.Connection | None) -> None:
    if conn is None:
        return
    try:
        conn.close()
    except Exception:
        log.exception("error closing database connection")


def serve(
    connect_fn: Callable[[], psycopg.Connection],
    handlers: dict[str, Handler],
    poll_interval_s: float,
    sleep: Callable[[float], None] = time.sleep,
    run: Callable[[psycopg.Connection, dict[str, Handler]], bool] = run_once,
    sweep: Callable[[psycopg.Connection], int] | None = None,
) -> None:
    """Process jobs forever. A lost database connection is replaced, with backoff."""
    conn: psycopg.Connection | None = None
    backoff = RECONNECT_BACKOFF_START_S

    def reconnect_later() -> None:
        nonlocal conn, backoff
        _close_quietly(conn)
        conn = None
        log.warning("reconnecting to the database in %.0fs", backoff)
        sleep(backoff)
        backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX_S)

    try:
        while True:
            try:
                if conn is None or conn.closed:
                    conn = connect_fn()
                if sweep is not None:
                    try:
                        sweep(conn)
                    except psycopg.OperationalError:
                        raise
                    except Exception:
                        log.exception("periodic sweep failed")
                        conn.rollback()
                idle = not run(conn, handlers)
                backoff = RECONNECT_BACKOFF_START_S
            except psycopg.OperationalError:
                log.exception("database connection error in worker loop")
                reconnect_later()
                continue
            except Exception:
                log.exception("unexpected error in worker loop")
                try:
                    conn.rollback()
                except psycopg.OperationalError:
                    log.exception("rollback failed; the connection is unusable")
                    reconnect_later()
                    continue
                except Exception:
                    log.exception("rollback failed; reconnecting")
                    _close_quietly(conn)
                    conn = None
                idle = True
            if idle:
                sleep(poll_interval_s)
    finally:
        _close_quietly(conn)


def build_handlers(settings: Settings) -> dict[str, Handler]:
    if not settings.supabase_secret_key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required (to download uploaded PDFs)")
    llm = make_llm(settings)
    ingest = IngestHandler(
        llm=llm,
        embedder=make_embedder(settings),
        storage=SupabaseStorage(settings.supabase_url, settings.supabase_secret_key),
        renderer=PlaywrightRenderer(settings.fetch_allow_private_hosts),
        transcripts=YouTubeTranscriptSource(api_key=settings.youtube_api_key),
        allow_private=settings.fetch_allow_private_hosts,
        user_agent=settings.fetch_user_agent,
    )
    quiz_bank = QuizBankHandler(llm, make_embedder(settings))
    return {
        "topic_map": TopicMapHandler(llm),
        "ingest_source": ingest,
        "quiz_bank": quiz_bank,
        "fill_gaps": FillGapsHandler(settings),
        # Jobs queued before the gap phase existed (staging) run as gap searches.
        "discover_sources": FillGapsHandler(settings),
        "understand_goal": UnderstandHandler(llm),
        "find_sources": FindSourcesHandler(settings),
        "check_sources": CheckSourcesHandler(llm),
        "vet_found": VetFoundHandler(llm),
    }


def main() -> None:
    configure_logging()
    settings = Settings()
    n = max(1, settings.worker_concurrency)
    log.info("worker started (provider=%s, threads=%s)", settings.llm_provider, n)
    # One connection and one set of handlers per thread (the page renderer isn't thread-safe); the
    # embedding model is shared. Jobs are claimed with skip locked, so threads never take the same one.
    threads = [
        threading.Thread(
            target=serve,
            args=(lambda: connect(settings), build_handlers(settings), settings.poll_interval_s),
            name=f"jobs-{i}",
            daemon=True,
        )
        for i in range(n)
    ]
    # The timeouts sweep on a thread of its own, so a slow job never holds them up.
    threads.append(threading.Thread(
        target=serve,
        args=(lambda: connect(settings), {}, settings.poll_interval_s),
        kwargs={"sweep": sweep, "run": lambda conn, handlers: False},
        name="sweep",
        daemon=True,
    ))
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
