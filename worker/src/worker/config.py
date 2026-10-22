from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


# Sites such as Wikipedia reject generic bot user agents; they want a name and a contact URL.
# Set FETCH_USER_AGENT to your real site before production.
DEFAULT_USER_AGENT = "LearningPlatform/1.0 (+http://localhost:3000)"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://postgres:postgres@127.0.0.1:44322/postgres"
    anthropic_api_key: str | None = None
    llm_provider: Literal["anthropic", "openrouter", "fake"] = "anthropic"
    openrouter_api_key: str | None = None
    # Comma-separated OpenRouter model ids, tried in order (OpenRouter falls back down the list).
    # "smart" replaces Sonnet (maps, lessons, questions); "fast" replaces Haiku (matching, checks).
    # Free models share one account-wide quota: 20 requests/minute, 50/day (1000/day after $10 of credits).
    openrouter_models_smart: str = "nvidia/nemotron-3-super-120b-a12b:free,openrouter/free"
    openrouter_models_fast: str = "nvidia/nemotron-3-super-120b-a12b:free,openrouter/free"
    poll_interval_s: float = 2.0
    # Tests only: lets the URL fetcher reach 127.0.0.1 and other private addresses.
    fetch_allow_private_hosts: bool = False
    fetch_user_agent: str = DEFAULT_USER_AGENT
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
