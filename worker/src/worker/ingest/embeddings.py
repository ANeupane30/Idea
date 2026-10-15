"""Topic (subtopic) embeddings, computed once per embedding model."""

from uuid import UUID

import numpy as np
import psycopg

from worker.ingest.embed import Embedder


def ensure_subtopic_embeddings(conn: psycopg.Connection, embedder: Embedder, goal_id: UUID) -> None:
    """Embed the goal's subtopics that have no embedding for this model yet."""
    with conn.transaction():
        missing = conn.execute(
            "select s.id, s.title, s.summary from subtopics s left join subtopic_embeddings e"
            " on e.subtopic_id = s.id and e.embed_model = %s where s.goal_id = %s and e.subtopic_id is null",
            (embedder.model, goal_id),
        ).fetchall()
    if not missing:
        return
    texts = [f"{r['title']}: {r['summary']}" if r["summary"] else r["title"] for r in missing]
    vectors = embedder.embed_queries(texts)
    with conn.transaction():
        with conn.cursor() as cur:
            cur.executemany(
                "insert into subtopic_embeddings (subtopic_id, embed_model, embedding) values (%s, %s, %s)"
                " on conflict (subtopic_id) do update set embed_model = excluded.embed_model,"
                " embedding = excluded.embedding",
                [(r["id"], embedder.model, np.asarray(v, dtype=np.float32)) for r, v in zip(missing, vectors)],
            )
