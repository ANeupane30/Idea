import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row

from worker.config import Settings


def connect(settings: Settings) -> psycopg.Connection:
    """Open a connection that returns dict rows. Callers manage transactions."""
    conn = psycopg.connect(settings.database_url, row_factory=dict_row)
    register_vector(conn)
    return conn
