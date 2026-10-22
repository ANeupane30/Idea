"""What a lesson is built from: the topic's best chunks from on-topic sources, and their citations."""

import hashlib
import json
from dataclasses import dataclass
from urllib.parse import quote
from uuid import UUID

import psycopg

from worker.ingest.urls import youtube_video_id

MAX_CHUNKS = 12
MAX_TOKENS = 8000
MIN_RELEVANCE = 0.40


@dataclass
class LessonChunk:
    n: int
    chunk_id: UUID
    text: str
    source_title: str
    source_type: str
    href: str | None
    label: str


def source_json(c: LessonChunk) -> dict:
    """How a lesson or question cites a chunk: this user's source title and link."""
    return {
        "n": c.n,
        "chunk_id": str(c.chunk_id),
        "title": c.source_title,
        "type": c.source_type,
        "href": c.href,
        "label": c.label,
    }


def citation_href(source_type: str, url_or_file: str, anchor: str | None, timestamp_start: float | None) -> str | None:
    if source_type == "web":
        return f"{url_or_file}#:~:text={quote(anchor, safe='')}" if anchor else url_or_file
    if source_type == "youtube":
        video_id = youtube_video_id(url_or_file)
        if not video_id:
            return None
        return f"https://www.youtube.com/watch?v={video_id}&t={int(timestamp_start or 0)}s"
    return None  # PDFs live in a private bucket


def citation_label(source_type: str, page: int | None, timestamp_start: float | None) -> str:
    if source_type == "youtube" and timestamp_start is not None:
        seconds = int(timestamp_start)
        return f"at {seconds // 60}:{seconds % 60:02d}"
    if source_type == "pdf" and page is not None:
        return f"page {page}"
    return ""


def cache_key(chunk_ids: list[UUID], summary: str, fmt: str, level: str) -> str:
    payload = json.dumps([sorted(str(c) for c in chunk_ids), summary, fmt, level])
    return hashlib.sha256(payload.encode()).hexdigest()


_SQL = """
with covering as (
  select s.id as source_id, coalesce(s.title, s.file_name, s.url_or_file) as title, s.type, s.url_or_file,
         s.content_hash, c.relevance
  from source_coverage c join sources s on s.id = c.source_id
  where c.subtopic_id = %(tid)s and c.relevance >= %(min)s and s.status = 'ready'
    and s.relevance_label <> 'off_topic'
)
select cv.source_id, cv.title, cv.type, cv.url_or_file, ch.id, ch.text, ch.token_count, ch.anchor, ch.page,
       ch.timestamp_start
from covering cv
join source_chunks ch on ch.content_hash = cv.content_hash
join subtopic_embeddings e on e.subtopic_id = %(tid)s and e.embed_model = %(model)s
order by cv.relevance desc, cv.source_id, ch.embedding <=> e.embedding
"""


def select_chunks(conn: psycopg.Connection, subtopic_id: UUID, embed_model: str) -> list[LessonChunk]:
    """Round-robin across covering sources (best source first), best chunks first, within the caps."""
    with conn.transaction():
        rows = conn.execute(_SQL, {"tid": subtopic_id, "min": MIN_RELEVANCE, "model": embed_model}).fetchall()
    per_source: dict[UUID, list[dict]] = {}
    for r in rows:
        per_source.setdefault(r["source_id"], []).append(r)
    queues = list(per_source.values())

    picked: list[dict] = []
    tokens = 0
    while queues and len(picked) < MAX_CHUNKS:
        for queue in list(queues):
            if len(picked) >= MAX_CHUNKS:
                break
            row = queue.pop(0)
            if not queue:
                queues.remove(queue)
            if tokens + row["token_count"] > MAX_TOKENS:
                queues = []
                break
            picked.append(row)
            tokens += row["token_count"]

    return [
        LessonChunk(
            n=i + 1,
            chunk_id=r["id"],
            text=r["text"],
            source_title=r["title"],
            source_type=r["type"],
            href=citation_href(r["type"], r["url_or_file"], r["anchor"], r["timestamp_start"]),
            label=citation_label(r["type"], r["page"], r["timestamp_start"]),
        )
        for i, r in enumerate(picked)
    ]
