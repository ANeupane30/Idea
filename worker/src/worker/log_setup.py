"""Logging for the worker and the lesson server."""

import logging
import sys

# HTTP clients log each request's full URL at INFO; some APIs (YouTube) take their key in it.
QUIET = ("httpx", "httpx2", "httpcore")


def configure_logging() -> None:
    logging.basicConfig(
        stream=sys.stdout, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    for name in QUIET:
        logging.getLogger(name).setLevel(logging.WARNING)
