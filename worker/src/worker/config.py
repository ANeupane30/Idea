from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://postgres:postgres@127.0.0.1:44322/postgres"
    anthropic_api_key: str | None = None
    llm_provider: Literal["anthropic", "fake"] = "anthropic"
    poll_interval_s: float = 2.0
    # Tests only: lets the URL fetcher reach 127.0.0.1 and other private addresses.
    fetch_allow_private_hosts: bool = False
    embedder: Literal["fastembed", "fake"] = "fastembed"
    supabase_url: str = "http://127.0.0.1:44321"
    supabase_secret_key: str | None = None
    lesson_server_host: str = "127.0.0.1"
    lesson_server_port: int = 8787
    # Shared with the web app (LESSON_SERVER_TOKEN in web/.env.local).
    lesson_server_token: str | None = None
    # mermaid.js for validating lesson diagrams (installed with the web app).
    mermaid_js_path: str = str(
        Path(__file__).resolve().parents[3] / "web" / "node_modules" / "mermaid" / "dist" / "mermaid.min.js"
    )
