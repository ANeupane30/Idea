"""Generating a lesson: pick chunks, reuse a cached lesson or stream a new one, section by section.

Like the ingest job, no transaction stays open across slow work (the model stream,
diagram checks). Every statement runs inside `with conn.transaction():`.
"""

import logging
from collections.abc import Iterator
from uuid import UUID

import psycopg

from worker.jobs import is_rate_limited
from psycopg import errors as pg_errors
from psycopg.types.json import Jsonb

from worker.ingest.embed import Embedder
from worker.ingest.embeddings import ensure_subtopic_embeddings
from worker.lessons.content import LessonChunk, cache_key, select_chunks, source_json
from worker.lessons.diagrams import DiagramValidator, check_diagrams
from worker.lessons.parse import SectionStream
from worker.lessons.prompt import build_lesson_prompt
from worker.llm import LLM, LLMResult, record_usage

log = logging.getLogger(__name__)

MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 16000


def _error(code: str) -> dict:
    return {"type": "error", "code": code}


def _rebased_body(body: dict, chunks: list[LessonChunk]) -> dict | None:
    """A cached lesson's sections, with citations rebuilt from this user's chunks (their own titles
    and links). None when the cached citations can't all be matched: then a fresh lesson is made."""
    mine = {str(c.chunk_id): c for c in chunks}
    rebased = []
    for src in body.get("sources", []):
        chunk = mine.get(src.get("chunk_id", ""))
        if chunk is None:
            return None
        rebased.append({**source_json(chunk), "n": src["n"]})
    return {"sections": body["sections"], "sources": rebased}


def _lesson_json(row) -> dict:
    return {
        "id": str(row["id"]),
        "format": row["format"],
        "stale": row["stale"],
        "created_at": row["created_at"].isoformat(),
        "body": row["body"],
    }


class LessonGenerator:
    def __init__(self, llm: LLM, embedder: Embedder, validator: DiagramValidator):
        self._llm = llm
        self._embedder = embedder
        self._validator = validator

    def generate(self, conn: psycopg.Connection, user_id: UUID, subtopic_id: UUID, fmt: str, refresh: bool) -> Iterator[dict]:
        # 1. The topic must belong to this user.
        with conn.transaction():
            topic = conn.execute(
                "select s.id, s.title, s.summary, s.goal_id, g.user_id from subtopics s"
                " join goals g on g.id = s.goal_id where s.id = %s",
                (subtopic_id,),
            ).fetchone()
            prefs = conn.execute("select level from learning_prefs where user_id = %s", (user_id,)).fetchone()
        if topic is None or topic["user_id"] != user_id:
            yield _error("not_found")
            return
        level = prefs["level"] if prefs else "beginner"

        # 2. A ready, current lesson is served as is.
        if not refresh:
            with conn.transaction():
                current = conn.execute(
                    "select * from lessons where subtopic_id = %s and format = %s and status = 'ready'"
                    " order by created_at desc limit 1",
                    (subtopic_id, fmt),
                ).fetchone()
            if current is not None and not current["stale"]:
                yield {"type": "lesson", "lesson": _lesson_json(current)}
                return

        # 3. Inputs.
        ensure_subtopic_embeddings(conn, self._embedder, topic["goal_id"])
        chunks = select_chunks(conn, subtopic_id, self._embedder.model)
        if not chunks:
            yield _error("no_sources")
            return
        key = cache_key([c.chunk_id for c in chunks], topic["summary"] or topic["title"], fmt, level)
        sources = [source_json(c) for c in chunks]

        # 4. Identical inputs reuse a current lesson (not a generation). A refresh always regenerates.
        # The copy keeps the shared content (sections) but cites this user's own sources.
        reused_body = None
        with conn.transaction():
            cached = None if refresh else conn.execute(
                "select body, model from lessons where cache_key = %s and status = 'ready' and not stale"
                " order by created_at desc limit 1",
                (key,),
            ).fetchone()
            if cached is not None:
                reused_body = _rebased_body(cached["body"], chunks)
            if reused_body is not None:
                row = conn.execute(
                    "insert into lessons (user_id, subtopic_id, format, level, cache_key, status, body, reused, model)"
                    " values (%s, %s, %s, %s, %s, 'ready', %s, true, %s) returning *",
                    (user_id, subtopic_id, fmt, level, key, Jsonb(reused_body), cached["model"]),
                ).fetchone()
        if reused_body is not None:
            yield {"type": "lesson", "lesson": _lesson_json(row)}
            return

        # 5. Start a generation (limits and one-at-a-time are enforced by the database).
        with conn.transaction():
            conn.execute(
                "update lessons set status = 'failed' where subtopic_id = %s and format = %s"
                " and status = 'generating' and created_at < now() - interval '10 minutes'",
                (subtopic_id, fmt),
            )
        try:
            with conn.transaction():
                lesson_id = conn.execute(
                    "insert into lessons (user_id, subtopic_id, format, level, cache_key)"
                    " values (%s, %s, %s, %s, %s) returning id",
                    (user_id, subtopic_id, fmt, level, key),
                ).fetchone()["id"]
        except pg_errors.UniqueViolation:
            yield _error("in_progress")
            return
        except pg_errors.RaiseException as e:
            if "guest_lesson_limit_reached" in str(e):
                yield _error("guest_lesson_limit")
                return
            if "lesson_limit_reached" in str(e):
                yield _error("lesson_limit")
                return
            raise

        # 6. Stream and emit each section once its diagram is checked.
        served_by = {"model": MODEL}

        def bill(result: LLMResult) -> None:
            served_by["model"] = result.model or MODEL
            record_usage(conn, user_id, "lesson", result)

        sections = []
        system, user = build_lesson_prompt(topic["title"], topic["summary"], fmt, level, chunks)
        parser = SectionStream(len(chunks))
        stream = self._llm.stream_text(model=MODEL, system=system, user=user, max_tokens=MAX_TOKENS, on_usage=bill)
        try:
            # The numbered sources first, so the browser can render [n] citations as sections arrive.
            yield {"type": "start", "sources": sources}
            for text in stream:
                for section in parser.feed(text):
                    (section,) = check_diagrams([section], self._validator, self._llm, bill)
                    if not sections:
                        # Content is about to reach the user: this counts as a generation even if
                        # the stream is cut off afterwards.
                        with conn.transaction():
                            conn.execute("update lessons set delivered = true where id = %s", (lesson_id,))
                    sections.append(section)
                    yield {"type": "section", "index": len(sections) - 1, "section": section.to_json()}
            parser.finish()
            if not sections:
                raise ValueError("the model returned no usable sections")
        except GeneratorExit:
            stream.close()  # bills the partial stream now, not when it is garbage-collected
            self._fail(conn, lesson_id)  # the client went away
            raise
        except Exception as e:
            log.exception("lesson %s failed", lesson_id)
            self._fail(conn, lesson_id)
            # Out of AI quota (often OpenRouter's free daily limit): say so rather than "failed".
            yield _error("busy" if is_rate_limited(e) else "failed")
            return

        # 7. Store it.
        with conn.transaction():
            conn.execute(
                "update lessons set status = 'ready', body = %s, model = %s where id = %s",
                (Jsonb({"sections": [s.to_json() for s in sections], "sources": sources}), served_by["model"], lesson_id),
            )
        yield {"type": "done", "lesson_id": str(lesson_id)}

    @staticmethod
    def _fail(conn: psycopg.Connection, lesson_id: UUID) -> None:
        try:
            with conn.transaction():
                conn.execute("update lessons set status = 'failed' where id = %s", (lesson_id,))
        except Exception:
            log.exception("could not mark lesson %s failed", lesson_id)
