import logging


def test_http_client_request_lines_are_not_logged():
    """Request lines carry query strings, and some APIs (YouTube) take their key there."""
    from worker.log_setup import configure_logging

    configure_logging()
    for name in ("httpx", "httpx2", "httpcore"):
        assert not logging.getLogger(name).isEnabledFor(logging.INFO)
