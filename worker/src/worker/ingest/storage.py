"""Downloads uploaded PDFs from the Supabase Storage bucket `sources`."""

from typing import Protocol
from urllib.parse import quote

import httpx

from worker.ingest.extract_pdf import MAX_BYTES
from worker.ingest.messages import BAD_PDF
from worker.jobs import PermanentJobError

BUCKET = "sources"


class Storage(Protocol):
    def download(self, path: str) -> bytes: ...


class SupabaseStorage:
    def __init__(self, url: str, secret_key: str, transport: httpx.BaseTransport | None = None):
        self._url = url.rstrip("/")
        self._key = secret_key
        self._transport = transport

    def download(self, path: str) -> bytes:
        headers = {"authorization": f"Bearer {self._key}", "apikey": self._key}
        url = f"{self._url}/storage/v1/object/{BUCKET}/{quote(path)}"
        with httpx.Client(transport=self._transport, timeout=30.0) as client:
            with client.stream("GET", url, headers=headers) as r:
                if 400 <= r.status_code < 500:
                    raise PermanentJobError(BAD_PDF)
                r.raise_for_status()
                body = bytearray()
                for part in r.iter_bytes():
                    body.extend(part)
                    if len(body) > MAX_BYTES:
                        raise PermanentJobError(BAD_PDF)
                return bytes(body)
