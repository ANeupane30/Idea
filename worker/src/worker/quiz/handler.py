"""The quiz_bank job: write questions for a topic, validate them, regenerate failures once.

Like the other jobs, no transaction is held across LLM calls; every statement runs in its
own `with conn.transaction():`.
"""

import logging
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from worker.ingest.embed import Embedder
from worker.ingest.embeddings import ensure_subtopic_embeddings
from worker.jobs import AI_BUSY, Job, PermanentJobError
from worker.lessons.content import LessonChunk, select_chunks, source_json
from worker.llm import LLM, LLMOutputError, LLMRefusal, LLMResult, record_usage
from worker.quiz.questions import MODEL, QuestionDraft, QuestionSet, build_question_prompt, check_draft
from worker.quiz.validate import validate_questions

log = logging.getLogger(__name__)

PER_DIFFICULTY = 6
NO_SOURCES = "no_sources"
FAILED = "failed"


class QuizBankHandler:
    def __init__(self, llm: LLM, embedder: Embedder):
        self._llm = llm
        self._embedder = embedder

    def _generate(self, conn, user_id: UUID, prompt: tuple[str, str], counts: dict[int, int]) -> list[QuestionDraft]:
        """One Sonnet call (plus one retry if it returns no structured output); at most counts[d] per difficulty."""
        system, user = prompt
        for _ in range(2):
            try:
                result = self._llm.parse(model=MODEL, system=system, user=user, schema=QuestionSet, max_tokens=16000)
            except LLMOutputError as e:
                if e.input_tokens or e.output_tokens:
                    record_usage(conn, user_id, "quiz_gen", LLMResult(None, e.input_tokens, e.output_tokens, e.model or MODEL))
                continue
            except LLMRefusal as e:
                if e.input_tokens or e.output_tokens:
                    record_usage(conn, user_id, "quiz_gen", LLMResult(None, e.input_tokens, e.output_tokens, e.model or MODEL))
                raise PermanentJobError(FAILED) from e
            record_usage(conn, user_id, "quiz_gen", result)
            kept: list[QuestionDraft] = []
            for d, n in counts.items():
                kept.extend([q for q in result.output.questions if q.difficulty == d][:n])
            return kept
        return []

    def _checked(self, conn, user_id: UUID, drafts: list[QuestionDraft], chunks: list[LessonChunk]) -> list[str | None]:
        """Deterministic checks first; Haiku only sees drafts that pass them."""
        problems: list[str | None] = [("; ".join(p) or None) for p in (check_draft(d, len(chunks)) for d in drafts)]
        to_validate = [i for i, p in enumerate(problems) if p is None]
        verdicts = validate_questions(
            self._llm, [drafts[i] for i in to_validate], chunks, lambda r: record_usage(conn, user_id, "validate", r)
        )
        for i, verdict in zip(to_validate, verdicts):
            problems[i] = verdict
        return problems

    def run(self, conn: psycopg.Connection, job: Job) -> None:
        subtopic_id = UUID(str(job.payload["subtopic_id"]))
        user_id = UUID(str(job.payload["user_id"]))
        difficulty = job.payload.get("difficulty")

        with conn.transaction():
            topic = conn.execute(
                "select s.title, s.summary, s.goal_id, g.user_id from subtopics s join goals g on g.id = s.goal_id"
                " where s.id = %s",
                (subtopic_id,),
            ).fetchone()
            prefs = conn.execute("select level from learning_prefs where user_id = %s", (user_id,)).fetchone()
        if topic is None or topic["user_id"] != user_id:
            log.info("quiz bank for %s: topic gone or not owned; skipping", subtopic_id)
            return
        level = prefs["level"] if prefs else "beginner"

        ensure_subtopic_embeddings(conn, self._embedder, topic["goal_id"])
        chunks = select_chunks(conn, subtopic_id, self._embedder.model)
        if not chunks:
            raise PermanentJobError(NO_SOURCES)

        counts = {int(difficulty): PER_DIFFICULTY} if difficulty else {d: PER_DIFFICULTY for d in (1, 2, 3)}
        prompt = build_question_prompt(topic["title"], topic["summary"], level, counts, chunks)
        drafts = self._generate(conn, user_id, prompt, counts)
        problems = self._checked(conn, user_id, drafts, chunks)
        passed = [d for d, p in zip(drafts, problems) if p is None]

        # Regenerate the failures once, in one call; whatever still fails is kept as rejected.
        failed_counts: dict[int, int] = {}
        for d, p in zip(drafts, problems):
            if p is not None:
                failed_counts[d.difficulty] = failed_counts.get(d.difficulty, 0) + 1
        rejected: list[QuestionDraft] = []
        if failed_counts:
            retry_prompt = build_question_prompt(topic["title"], topic["summary"], level, failed_counts, chunks)
            retries = self._generate(conn, user_id, retry_prompt, failed_counts)
            for d, p in zip(retries, self._checked(conn, user_id, retries, chunks)):
                (passed if p is None else rejected).append(d)

        if not passed and difficulty is None:
            raise PermanentJobError(FAILED)
        self._store(conn, user_id, subtopic_id, chunks, passed, rejected)

    @staticmethod
    def _store(conn, user_id, subtopic_id, chunks, passed, rejected) -> None:
        by_n = {c.n: c for c in chunks}

        def row(d: QuestionDraft, status: str):
            cited = [by_n[n] for n in dict.fromkeys(d.cite) if n in by_n]
            return (
                user_id,
                subtopic_id,
                d.difficulty,
                d.stem.strip()[:300],
                [o.strip() for o in d.options][:4],
                d.correct_index,
                d.explanation.strip()[:500] or "-",
                [c.chunk_id for c in cited],
                Jsonb([source_json(c) for c in cited]),
                status,
            )

        rows = [row(d, "active") for d in passed]
        # Rejected drafts are kept for review only when they fit the table's checks.
        rows += [row(d, "rejected") for d in rejected if len(d.options) == 4 and 0 <= d.correct_index <= 3 and d.stem.strip()]
        with conn.transaction():
            with conn.cursor() as cur:
                cur.executemany(
                    "insert into quiz_questions (user_id, subtopic_id, difficulty, stem, options, correct_index,"
                    " explanation, source_chunk_ids, citations, status) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    rows,
                )
            conn.execute(
                "insert into quiz_banks (subtopic_id, user_id, status) values (%s, %s, 'ready')"
                " on conflict (subtopic_id) do update set status = 'ready', error = null, updated_at = now()",
                (subtopic_id, user_id),
            )

    def on_retry(self, conn: psycopg.Connection, job: Job) -> None:
        pass  # the bank stays pending while the job retries

    def on_permanent_failure(self, conn: psycopg.Connection, job: Job, message: str) -> None:
        code = "busy" if message == AI_BUSY else message if message in (NO_SOURCES, FAILED) else FAILED
        subtopic_id = UUID(str(job.payload["subtopic_id"]))
        with conn.transaction():
            if job.payload.get("difficulty"):
                # A failed top-up leaves a working bank alone (and top-ups can be queued again);
                # only a bank with nothing to serve is marked failed.
                has_questions = conn.execute(
                    "select 1 from quiz_questions where subtopic_id = %s and status = 'active' limit 1",
                    (subtopic_id,),
                ).fetchone()
                if has_questions:
                    log.warning("quiz top-up for %s failed (%s); bank stays ready", subtopic_id, code)
                    return
            conn.execute(
                "update quiz_banks set status = 'failed', error = %s, updated_at = now() where subtopic_id = %s",
                (code, subtopic_id),
            )
