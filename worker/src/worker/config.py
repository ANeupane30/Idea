from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    anthropic_api_key: str | None = None
    llm_provider: Literal["anthropic", "fake"] = "anthropic"
    poll_interval_s: float = 2.0
