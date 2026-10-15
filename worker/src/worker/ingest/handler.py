"""The ingest_source job: dedupe -> extract -> clean -> chunk -> embed -> map -> ready.

Like the topic map job, no transaction stays open across slow work (fetching,
extraction, embedding, LLM calls). Each step's state is committed on its own, so the
UI sees live progress and a retry resumes from the shared chunk cache. Every
statement runs inside `with conn.transaction():`; a bare execute would open an
implicit transaction that never commits.
"""

import hashlib
import logging
from dataclasses import dataclass
from uuid import UUID

import numpy as np
import psycopg
from psycopg import errors as pg_errors

from worker.ingest import messages
from worker.ingest.chunking import chunk_segments, clean_text, clean_transcript_text, estimate_tokens
from worker.ingest.embed import Embedder
from worker.ingest.embeddings import ensure_subtopic_embeddings
from worker.ingest.extract_pdf import extract_pdf
from worker.ingest.extract_web import Renderer, extract_web
from worker.ingest.extract_youtube import TranscriptSource, extract_youtube
from worker.ingest.mapping import (
    BATCH,
    MODEL as MAPPING_MODEL,
    MappingResponse,
    ShortlistItem,
    build_mapping_prompt,
    repair_user,
    validate_mapping,
)
from worker.ingest.punctuate import repair_punctuation
from worker.ingest.storage import Storage
from worker.ingest.types import Extracted, Segment
from worker.ingest.urls import content_hash, normalize_url, youtube_video_id
from worker.jobs import Job, PermanentJobError
from worker.llm import LLM, LLMOutputError, LLMRefusal, LLMResult, record_usage

log = logging.getLogger(__name__)


@dataclass
class Limits:
    video_minutes: int
    pdf_pages: int
    tokens: int


PLAN_LIMITS = {
    "free": Limits(video_minutes=90, pdf_pages=150, tokens=60_000),
    "pro": Limits(video_minutes=240, pdf_pages=600, tokens=250_000),
}

_TOP_K = 3


def _check_caps(limits: Limits, duration_s: int | None, page_count: int | None, tokens: int | None) -> None:
    if duration_s is not None and duration_s > limits.video_minutes * 60:
        raise PermanentJobError(messages.VIDEO_TOO_LONG.format(n=limits.video_minutes))
    if page_count is not None and page_count > limits.pdf_pages:
        raise PermanentJobError(messages.TOO_MANY_PAGES.format(n=limits.pdf_pages))
    if tokens is not None and tokens > limits.tokens:
        raise PermanentJobError(messages.TOO_LONG)


class IngestHandler:
    def __init__(
        self,
        llm: LLM,
        embedder: Embedder,
        storage: Storage,
        renderer: Renderer,
        transcripts: TranscriptSource,
        allow_private: bool,
        transport=None,  # httpx transport for web fetches; tests only
    ):
        self._llm = llm
        self._embedder = embedder
        self._storage = storage
        self._renderer = renderer
        self._transcripts = transcripts
        self._allow_private = allow_private
        self._transport = transport

    # ------------------------------------------------------------ helpers

    @staticmethod
    def _heartbeat(conn: psycopg.Connection, source_id: UUID) -> None:
        """Refresh the running job's lock so a long ingest isn't reclaimed by another worker."""
        conn.execute(
            "update jobs set locked_at = now() where status = 'running' and kind = 'ingest_source'"
            " and payload->>'source_id' = %s",
            (str(source_id),),
        )

    def _set_step(self, conn: psycopg.Connection, source_id: UUID, step: str) -> None:
        with conn.transaction():
            conn.execute(
                "update sources set step = %s where id = %s and status = 'processing'", (step, source_id)
            )
            self._heartbeat(conn, source_id)

    def _bill(self, conn: psycopg.Connection, source_id: UUID, user_id: UUID, kind: str):
        # Each call's usage commits right away, so it survives a later failure.
        def bill(result: LLMResult) -> None:
            record_usage(conn, user_id, kind, result)
            with conn.transaction():
                self._heartbeat(conn, source_id)

        return bill

    # ------------------------------------------------------------ the job

    def run(self, conn: psycopg.Connection, job: Job) -> None:
        source_id = UUID(str(job.payload["source_id"]))

        # 1. Claim the source.
        with conn.transaction():
            src = conn.execute(
                "select s.*, u.plan, coalesce(a.is_anonymous, false) as guest, g.title as goal_title"
                " from sources s join users u on u.id = s.user_id join goals g on g.id = s.goal_id"
                " left join auth.users a on a.id = s.user_id where s.id = %s",
                (source_id,),
            ).fetchone()
            if src is None or src["status"] not in ("queued", "processing"):
                return
            conn.execute(
                "update sources set status = 'processing', step = 'extracting', delayed = false where id = %s",
                (source_id,),
            )
        limits = PLAN_LIMITS["pro" if src["plan"] == "pro" and not src["guest"] else "free"]

        # 2. Dedupe: the content hash, unique per goal among live sources.
        kind, key, pdf_bytes = self._identify(src)
        chash = content_hash(kind, key)
        try:
            with conn.transaction():
                conn.execute("update sources set content_hash = %s where id = %s", (chash, source_id))
        except pg_errors.UniqueViolation:
            raise PermanentJobError(messages.DUPLICATE)

        # 3. Shared cache, or 4. extract + clean + chunk + embed.
        with conn.transaction():
            content = conn.execute("select * from contents where content_hash = %s", (chash,)).fetchone()
        if content is not None:
            _check_caps(limits, content["duration_s"], content["page_count"], content["token_count"])
            title = content["title"]
            if content["embed_model"] != self._embedder.model:
                self._reembed(conn, src["id"], chash)
        else:
            title = self._ingest(conn, src, kind, key, pdf_bytes, chash, limits)

        # 5. Map, 6. write.
        self._map(conn, src, chash, title)

    def _identify(self, src) -> tuple[str, str, bytes | None]:
        if src["type"] == "web":
            return "web", normalize_url(src["url_or_file"]), None
        if src["type"] == "youtube":
            video_id = youtube_video_id(src["url_or_file"])
            if video_id is None:
                raise PermanentJobError(messages.NOT_A_VIDEO)
            return "youtube", video_id, None
        data = self._storage.download(src["url_or_file"])
        return "pdf", hashlib.sha256(data).hexdigest(), data

    def _extract(self, src, kind: str, key: str, pdf_bytes: bytes | None, limits: Limits) -> Extracted:
        if kind == "web":
            return extract_web(
                src["url_or_file"], allow_private=self._allow_private, renderer=self._renderer, transport=self._transport
            )
        if kind == "youtube":
            extracted = extract_youtube(key, self._transcripts)
            # Before any punctuation repair is paid for.
            _check_caps(limits, extracted.duration_s, None, None)
            return extracted
        return extract_pdf(pdf_bytes, max_pages=limits.pdf_pages)

    def _clean(self, conn: psycopg.Connection, src, extracted: Extracted) -> list[Segment]:
        if src["type"] != "youtube":
            segments = [Segment(clean_text(s.text), s.location) for s in extracted.segments]
            return [s for s in segments if s.text]
        segments = [Segment(clean_transcript_text(s.text), s.location) for s in extracted.segments]
        segments = [s for s in segments if s.text]
        if extracted.auto_captions:
            texts = repair_punctuation(self._llm, [s.text for s in segments], self._bill(conn, src["id"], src["user_id"], "ingest"))
            segments = [Segment(t, s.location) for t, s in zip(texts, segments)]
        return segments

    def _ingest(self, conn, src, kind, key, pdf_bytes, chash, limits) -> str | None:
        extracted = self._extract(src, kind, key, pdf_bytes, limits)
        segments = self._clean(conn, src, extracted)
        tokens = sum(estimate_tokens(s.text) for s in segments)
        _check_caps(limits, extracted.duration_s, extracted.page_count, tokens)

        self._set_step(conn, src["id"], "chunking")
        chunks = chunk_segments(segments)
        if not chunks:
            raise PermanentJobError(messages.NO_TEXT)

        self._set_step(conn, src["id"], "embedding")
        vectors = self._embedder.embed_passages([c.text for c in chunks])

        with conn.transaction():
            inserted = conn.execute(
                "insert into contents (content_hash, type, title, token_count, duration_s, page_count, embed_model)"
                " values (%s, %s, %s, %s, %s, %s, %s) on conflict do nothing returning content_hash",
                (chash, kind, extracted.title, tokens, extracted.duration_s, extracted.page_count, self._embedder.model),
            ).fetchone()
            if inserted is not None:  # another worker may have stored the same content meanwhile
                with conn.cursor() as cur:
                    cur.executemany(
                        "insert into source_chunks (content_hash, position, text, token_count, embedding,"
                        " timestamp_start, page, anchor) values (%s, %s, %s, %s, %s, %s, %s, %s)",
                        [
                            (
                                chash,
                                c.position,
                                c.text,
                                c.token_count,
                                np.asarray(v, dtype=np.float32),
                                c.location.get("timestamp_start"),
                                c.location.get("page"),
                                c.location.get("anchor"),
                            )
                            for c, v in zip(chunks, vectors)
                        ],
                    )
        return extracted.title

    def _reembed(self, conn: psycopg.Connection, source_id: UUID, chash: str) -> None:
        """Cached chunks embedded by another model aren't comparable with this model's vectors."""
        self._set_step(conn, source_id, "embedding")
        with conn.transaction():
            chunks = conn.execute(
                "select id, text from source_chunks where content_hash = %s order by position", (chash,)
            ).fetchall()
        vectors = self._embedder.embed_passages([c["text"] for c in chunks])
        with conn.transaction():
            with conn.cursor() as cur:
                cur.executemany(
                    "update source_chunks set embedding = %s where id = %s",
                    [(np.asarray(v, dtype=np.float32), c["id"]) for c, v in zip(chunks, vectors)],
                )
            conn.execute(
                "update contents set embed_model = %s where content_hash = %s", (self._embedder.model, chash)
            )

    # ------------------------------------------------------------ mapping

    def _shortlist(self, conn: psycopg.Connection, goal_id: UUID, chash: str) -> list[tuple[UUID, ShortlistItem]]:
        with conn.transaction():
            rows = conn.execute(
                "select s.id, s.title, s.summary, x.text, x.sim from subtopics s"
                " join subtopic_embeddings e on e.subtopic_id = s.id and e.embed_model = %s"
                " cross join lateral (select c.text, 1 - (c.embedding <=> e.embedding) as sim from source_chunks c"
                "   where c.content_hash = %s order by c.embedding <=> e.embedding limit %s) x"
                " where s.goal_id = %s"
                " order by coalesce((select p.position from subtopics p where p.id = s.parent_id), s.position),"
                "   s.parent_id nulls first, s.position, x.sim desc",
                (self._embedder.model, chash, _TOP_K, goal_id),
            ).fetchall()
        grouped: dict[UUID, dict] = {}
        for r in rows:
            g = grouped.setdefault(r["id"], {"title": r["title"], "summary": r["summary"], "chunks": [], "best": 0.0})
            g["chunks"].append(r["text"])
            g["best"] = max(g["best"], float(r["sim"]))
        shortlisted = [(sid, g) for sid, g in grouped.items() if g["best"] >= self._embedder.shortlist_min]
        return [
            (sid, ShortlistItem(f"s{i + 1}", g["title"], g["summary"], g["chunks"]))
            for i, (sid, g) in enumerate(shortlisted)
        ]

    def _rate(self, conn, source_id, user_id, goal_title: str, batch: list[ShortlistItem]) -> MappingResponse:
        bill = self._bill(conn, source_id, user_id, "map")
        system, user = build_mapping_prompt(goal_title, batch)
        keys = [item.key for item in batch]
        prompt = user
        for _ in range(2):  # one call plus one repair
            try:
                result = self._llm.parse(model=MAPPING_MODEL, system=system, user=prompt, schema=MappingResponse)
            except LLMOutputError as e:
                if e.input_tokens or e.output_tokens:
                    bill(LLMResult(None, e.input_tokens, e.output_tokens, e.model or MAPPING_MODEL))
                errors = [f"no valid structured output was returned ({e})"]
            except LLMRefusal as e:
                if e.input_tokens or e.output_tokens:
                    bill(LLMResult(None, e.input_tokens, e.output_tokens, e.model or MAPPING_MODEL))
                raise PermanentJobError(messages.MAPPING_FAILED) from e
            else:
                bill(result)
                errors = validate_mapping(result.output, keys)
                if not errors:
                    return result.output
            prompt = repair_user(user, errors)
        raise PermanentJobError(messages.MAPPING_FAILED)

    def _map(self, conn: psycopg.Connection, src, chash: str, title: str | None) -> None:
        source_id = src["id"]
        self._set_step(conn, source_id, "mapping")
        ensure_subtopic_embeddings(conn, self._embedder, src["goal_id"])
        shortlist = self._shortlist(conn, src["goal_id"], chash)

        rows: list[tuple[UUID, float, str]] = []
        for start in range(0, len(shortlist), BATCH):
            batch = shortlist[start : start + BATCH]
            ids = {item.key: sid for sid, item in batch}
            resp = self._rate(conn, source_id, src["user_id"], src["goal_title"], [item for _, item in batch])
            rows.extend((ids[r.key], round(r.relevance, 2), r.reason.strip()) for r in resp.results)

        top = max(rows, key=lambda r: r[1], default=None)
        relevance = top[1] if top else 0.0
        with conn.transaction():
            locked = conn.execute(
                "select status from sources where id = %s for update", (source_id,)
            ).fetchone()
            if locked is None or locked["status"] != "processing":
                log.info("source %s changed during ingestion; not writing", source_id)
                return
            conn.execute("delete from source_coverage where source_id = %s", (source_id,))
            with conn.cursor() as cur:
                cur.executemany(
                    "insert into source_coverage (source_id, subtopic_id, relevance, reason) values (%s, %s, %s, %s)",
                    [(source_id, sid, rel, reason) for sid, rel, reason in rows],
                )
            conn.execute(
                "update sources set status = 'ready', step = null, delayed = false, error = null,"
                " relevance = %s, relevance_label = public.relevance_label(%s::numeric), relevance_reason = %s,"
                " title = coalesce(%s, file_name, url_or_file) where id = %s",
                (relevance, relevance, top[2] if top else None, title, source_id),
            )
            # New coverage: the covered topics' lessons are out of date (shown as "Refresh lesson?").
            conn.execute("select public.mark_lessons_stale(%s)", (source_id,))

    # ------------------------------------------------------------ hooks

    def on_retry(self, conn: psycopg.Connection, job: Job) -> None:
        with conn.transaction():
            conn.execute(
                "update sources set delayed = true where id = %s", (UUID(str(job.payload["source_id"])),)
            )

    def on_permanent_failure(self, conn: psycopg.Connection, job: Job, message: str) -> None:
        with conn.transaction():
            conn.execute(
                "update sources set status = 'failed', error = %s, step = null, delayed = false where id = %s",
                (message, UUID(str(job.payload["source_id"]))),
            )
