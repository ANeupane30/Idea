import logging
import sys
import time

from worker.config import Settings
from worker.db import connect
from worker.jobs import Handler, run_once

log = logging.getLogger("worker")

# Later tasks register handlers here, keyed by job kind.
HANDLERS: dict[str, Handler] = {}


def main() -> None:
    logging.basicConfig(
        stream=sys.stdout, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    settings = Settings()
    log.info("worker started (provider=%s)", settings.llm_provider)
    with connect(settings) as conn:
        while True:
            try:
                idle = not run_once(conn, HANDLERS)
            except Exception:
                log.exception("unexpected error in worker loop")
                conn.rollback()
                idle = True
            if idle:
                time.sleep(settings.poll_interval_s)


if __name__ == "__main__":
    main()
