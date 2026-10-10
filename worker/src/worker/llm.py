"""LLM client: Anthropic (structured output) and a fixture-backed fake, plus usage recording."""

from dataclasses import dataclass
import logging
from decimal import Decimal
from pathlib import Path
from typing import Generic, Protocol, TypeVar
from uuid import UUID

import anthropic
import psycopg

from worker.config import Settings
from worker.jobs import PermanentJobError

log = logging.getLogger(__name__)

T = TypeVar("T")

REFUSAL_MESSAGE = "We couldn't build a topic map for this goal. Try rewording it."
FALLBACK_BETA = "server-side-fallback-2026-07-01"
# worker/src/worker/llm.py -> worker/tests/fixtures/fake_llm
DEFAULT_FIXTURES_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "fake_llm"

# USD per 1M tokens: (input, output)
PRICES_PER_MTOK = {"claude-sonnet-5-5": (2.00, 10.00), "claude-haiku-4-5": (1.00, 5.00)}


class LLMOutputError(Exception):
    """The model returned no usable structured output (e.g. truncated at max_tokens)."""


@dataclass
class LLMResult(Generic[T]):
    output: T
    input_tokens: int
    output_tokens: int
    model: str


class LLM(Protocol):
    def parse(
        self, *, model: str, system: str, user: str, schema: type[T], max_tokens: int = 16000
    ) -> LLMResult[T]: ...


class AnthropicLLM:
    def __init__(self, api_key: str):
        self._client = anthropic.Anthropic(api_key=api_key, max_retries=3)

    def parse(
        self, *, model: str, system: str, user: str, schema: type[T], max_tokens: int = 16000
    ) -> LLMResult[T]:
        # Beta endpoint: the only one that accepts server-side refusal fallbacks.
        # Thinking is left at the model default (adaptive); never pass it.
        response = self._client.beta.messages.parse(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_format=schema,
            output_config={"effort": "medium"},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
        if response.stop_reason == "refusal":
            raise PermanentJobError(REFUSAL_MESSAGE)
        if response.parsed_output is None:
            raise LLMOutputError(f"no parsed output (stop_reason={response.stop_reason})")
        return LLMResult(
            response.parsed_output,
            response.usage.input_tokens,
            response.usage.output_tokens,
            response.model,  # the model that actually served the call (fallbacks may differ)
        )


class FakeLLM:
    def __init__(self, fixtures_dir: Path):
        self._dir = Path(fixtures_dir)

    def parse(
        self, *, model: str, system: str, user: str, schema: type[T], max_tokens: int = 16000
    ) -> LLMResult[T]:
        clarify = "[clarify]" in user and "<clarification_answer>" not in user
        name = "topic_map_clarify.json" if clarify else "topic_map.json"
        output = schema.model_validate_json((self._dir / name).read_text(encoding="utf-8"))
        return LLMResult(output, 100, 200, model)


def make_llm(settings: Settings) -> LLM:
    if settings.llm_provider == "fake":
        return FakeLLM(DEFAULT_FIXTURES_DIR)
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic")
    return AnthropicLLM(settings.anthropic_api_key)


def cost_cents(result: LLMResult) -> Decimal:
    prices = PRICES_PER_MTOK.get(result.model)
    if prices is None:
        # Never lose a usage row: price an unknown model at the highest known rates.
        log.warning("unknown model %r for pricing; using max known rates", result.model)
        prices = (
            max(p[0] for p in PRICES_PER_MTOK.values()),
            max(p[1] for p in PRICES_PER_MTOK.values()),
        )
    price_in, price_out = prices
    usd = (
        Decimal(str(price_in)) * result.input_tokens + Decimal(str(price_out)) * result.output_tokens
    ) / Decimal(1_000_000)
    return (usd * 100).quantize(Decimal("0.0001"))


def record_usage(conn: psycopg.Connection, user_id: UUID, kind: str, result: LLMResult) -> None:
    with conn.transaction():
        conn.execute(
            "insert into usage_events (user_id, kind, tokens, cost_cents) values (%s, %s, %s, %s)",
            (user_id, kind, result.input_tokens + result.output_tokens, cost_cents(result)),
        )
