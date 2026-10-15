import time
from pathlib import Path

import httpx
import pytest

from worker.ingest import messages
from worker.ingest.extract_pdf import extract_pdf
from worker.ingest.storage import SupabaseStorage
from worker.jobs import PermanentJobError

FIXTURES = Path(__file__).parent / "fixtures"


def pdf(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def message(fn) -> str:
    with pytest.raises(PermanentJobError) as e:
        fn()
    return e.value.message


def slow_child(data, max_pages, queue):
    time.sleep(120)


def test_pdf_pages():
    out = extract_pdf(pdf("sql_basics.pdf"), max_pages=150)
    assert [s.location for s in out.segments] == [{"page": 1}, {"page": 2}, {"page": 3}]
    assert out.page_count == 3
    assert out.title == "SQL basics"
    assert "Joining tables" in out.segments[2].text


def test_pdf_scanned():
    assert message(lambda: extract_pdf(pdf("scanned.pdf"), max_pages=150)) == messages.SCANNED


def test_pdf_encrypted():
    assert message(lambda: extract_pdf(pdf("encrypted.pdf"), max_pages=150)) == messages.ENCRYPTED


def test_pdf_too_many_pages():
    assert message(lambda: extract_pdf(pdf("sql_basics.pdf"), max_pages=2)) == messages.TOO_MANY_PAGES.format(n=2)


def test_pdf_garbage():
    assert message(lambda: extract_pdf(b"not a pdf", max_pages=150)) == messages.BAD_PDF


def test_pdf_too_big():
    assert message(lambda: extract_pdf(b"%PDF" + b"0" * (25 * 1024 * 1024), max_pages=150)) == messages.BAD_PDF


def test_pdf_runs_in_child():
    started = time.monotonic()
    msg = message(lambda: extract_pdf(pdf("sql_basics.pdf"), max_pages=150, timeout_s=1, target=slow_child))
    assert msg == messages.BAD_PDF
    assert time.monotonic() - started < 10


def test_storage_download():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        return httpx.Response(200, content=b"%PDF-data")

    storage = SupabaseStorage("http://supabase.test", "secret", transport=httpx.MockTransport(handler))
    assert storage.download("user/file.pdf") == b"%PDF-data"
    assert seen == {"url": "http://supabase.test/storage/v1/object/sources/user/file.pdf", "auth": "Bearer secret"}


def test_storage_missing_file_is_permanent():
    storage = SupabaseStorage("http://supabase.test", "k", transport=httpx.MockTransport(lambda r: httpx.Response(404)))
    assert message(lambda: storage.download("u/missing.pdf")) == messages.BAD_PDF


def test_storage_server_error_retries():
    storage = SupabaseStorage("http://supabase.test", "k", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    with pytest.raises(httpx.HTTPStatusError):
        storage.download("u/f.pdf")
