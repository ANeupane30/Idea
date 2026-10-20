"""PDF extraction with PyMuPDF, run in a child process with a time limit (untrusted files)."""

import multiprocessing
import queue as queue_module
from collections.abc import Callable

from worker.ingest.messages import BAD_PDF, ENCRYPTED, SCANNED, TOO_MANY_PAGES
from worker.ingest.types import Extracted, Segment
from worker.jobs import PermanentJobError

MAX_BYTES = 25 * 1024 * 1024
TIMEOUT_S = 60.0
MIN_CHARS_PER_PAGE = 20


def _parse_in_child(data: bytes, max_pages: int, out) -> None:
    """Child process: puts ("ok", title, page_texts, page_count) or ("err", reason) on `out`."""
    try:
        import pymupdf

        doc = pymupdf.open(stream=data, filetype="pdf")
        if doc.needs_pass:
            out.put(("err", "encrypted"))
            return
        if doc.page_count > max_pages:
            out.put(("err", "too_many_pages"))
            return
        texts = [page.get_text() for page in doc]
        title = (doc.metadata or {}).get("title") or None
        out.put(("ok", title, texts, doc.page_count))
    except Exception:
        out.put(("err", "bad"))


def extract_pdf(
    data: bytes,
    max_pages: int,
    *,
    timeout_s: float = TIMEOUT_S,
    target: Callable = _parse_in_child,
) -> Extracted:
    if len(data) > MAX_BYTES:
        raise PermanentJobError(BAD_PDF)
    ctx = multiprocessing.get_context("spawn")
    out = ctx.Queue()
    proc = ctx.Process(target=target, args=(data, max_pages, out), daemon=True)
    proc.start()
    try:
        result = out.get(timeout=timeout_s)
    except queue_module.Empty:
        result = ("err", "bad")
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(5)
        out.close()

    if result[0] == "err":
        reason = result[1]
        if reason == "encrypted":
            raise PermanentJobError(ENCRYPTED)
        if reason == "too_many_pages":
            raise PermanentJobError(TOO_MANY_PAGES.format(n=max_pages))
        raise PermanentJobError(BAD_PDF)

    _, title, texts, page_count = result
    if page_count == 0 or sum(len(t.strip()) for t in texts) / page_count < MIN_CHARS_PER_PAGE:
        raise PermanentJobError(SCANNED)
    segments = [Segment(t, {"page": i + 1}) for i, t in enumerate(texts) if t.strip()]
    return Extracted(title=title, segments=segments, page_count=page_count)
