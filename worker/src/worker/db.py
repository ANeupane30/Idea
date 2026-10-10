import psycopg
from psycopg.rows import dict_row

from worker.config import Settings


def connect(settings: Settings) -> psycopg.Connection:
    """Open a connection that returns dict rows. Callers manage transactions."""
    return psycopg.connect(settings.database_url, row_factory=dict_row)
