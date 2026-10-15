from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://postgres:postgres@127.0.0.1:56322/postgres"
    anthropic_api_key: str | None = None
    llm_provider: Literal["anthropic", "fake"] = "anthropic"
    poll_interval_s: float = 2.0
    # Tests only: lets the URL fetcher reach 127.0.0.1 and other private addresses.
    fetch_allow_private_hosts: bool = False
