"""LLM client: Anthropic (structured output) and a fixture-backed fake, plus usage recording."""

from collections.abc import Callable, Iterator
from dataclasses import dataclass
import logging
import re
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
    """The model returned no usable structured output (e.g. truncated at max_tokens).

    Carries the call's token usage so it can still be billed."""

    def __init__(self, message: str, input_tokens: int = 0, output_tokens: int = 0, model: str = ""):
        super().__init__(message)
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.model = model


class LLMRefusal(PermanentJobError):
    """The model declined, or the API rejected the request. Carries any token usage so it can be billed.

    Callers decide the user-facing message; the default is the topic-map one."""

    def __init__(self, message: str, input_tokens: int = 0, output_tokens: int = 0, model: str = ""):
        super().__init__(message)
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.model = model


# Request options per model. Effort and server-side refusal fallbacks only for models that
# accept them: Haiku 4.5 rejects output_config.effort, and Haiku models have no fallback.
_MODEL_OPTIONS: dict[str, dict] = {
    "claude-sonnet-5-5": {
        "output_config": {"effort": "medium"},
        "betas": [FALLBACK_BETA],
        "fallbacks": "default",
    },
}


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

    def stream_text(
        self, *, model: str, system: str, user: str, max_tokens: int, on_usage: Callable[[LLMResult], None]
    ) -> Iterator[str]:
        """Yield text deltas, then call on_usage once. Afterwards raise LLMRefusal on a refusal and
        LLMOutputError when the output was cut off at max_tokens."""
        ...


_PERMANENT_API_ERRORS = (
    anthropic.BadRequestError,
    anthropic.AuthenticationError,
    anthropic.PermissionDeniedError,
    anthropic.NotFoundError,
)


class AnthropicLLM:
    def __init__(self, api_key: str):
        # No SDK retries: the job queue owns them (1 attempt + 3 retries with backoff,
        # with "Processing is delayed" shown meanwhile), which meets the "3 retries
        # with backoff on rate limits and timeouts" constraint with one retry layer.
        self._client = anthropic.Anthropic(api_key=api_key, timeout=120.0, max_retries=0)

    def parse(
        self, *, model: str, system: str, user: str, schema: type[T], max_tokens: int = 16000
    ) -> LLMResult[T]:
        # Beta endpoint: the only one that accepts server-side refusal fallbacks.
        # Thinking is left at the model default (adaptive); never pass it.
        try:
            response = self._client.beta.messages.parse(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                output_format=schema,
                **_MODEL_OPTIONS.get(model, {}),
            )
        except _PERMANENT_API_ERRORS as e:
            # Retrying the same request cannot fix these; keep the detail in the log only.
            log.exception("Anthropic request rejected (%s)", type(e).__name__)
            raise LLMRefusal(REFUSAL_MESSAGE, model=model) from e
        if response.stop_reason == "refusal":
            raise LLMRefusal(
                REFUSAL_MESSAGE, response.usage.input_tokens, response.usage.output_tokens, response.model
            )
        if response.parsed_output is None:
            raise LLMOutputError(
                f"no parsed output (stop_reason={response.stop_reason})",
                response.usage.input_tokens,
                response.usage.output_tokens,
                response.model,
            )
        return LLMResult(
            response.parsed_output,
            response.usage.input_tokens,
            response.usage.output_tokens,
            response.model,  # the model that actually served the call (fallbacks may differ)
        )


    def stream_text(
        self, *, model: str, system: str, user: str, max_tokens: int, on_usage: Callable[[LLMResult], None]
    ) -> Iterator[str]:
        try:
            with self._client.beta.messages.stream(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                **_MODEL_OPTIONS.get(model, {}),
            ) as stream:
                yield from stream.text_stream
                final = stream.get_final_message()
        except _PERMANENT_API_ERRORS as e:
            log.exception("Anthropic request rejected (%s)", type(e).__name__)
            raise LLMRefusal(REFUSAL_MESSAGE, model=model) from e
        on_usage(LLMResult(None, final.usage.input_tokens, final.usage.output_tokens, final.model))
        if final.stop_reason == "refusal":
            raise LLMRefusal(REFUSAL_MESSAGE, model=final.model)
        if final.stop_reason == "max_tokens":
            raise LLMOutputError("output cut off at max_tokens", model=final.model)


class FakeLLM:
    def __init__(self, fixtures_dir: Path):
        self._dir = Path(fixtures_dir)

    def parse(
        self, *, model: str, system: str, user: str, schema: type[T], max_tokens: int = 16000
    ) -> LLMResult[T]:
        # Imported here: the ingest modules import this one.
        from worker.ingest.mapping import MappingResponse, fake_mapping_response
        from worker.ingest.punctuate import PunctuationResponse, fake_punctuation_response
        from worker.lessons.diagrams import MermaidFix

        if schema is MappingResponse:
            return LLMResult(fake_mapping_response(user), 100, 50, model)
        if schema is PunctuationResponse:
            return LLMResult(fake_punctuation_response(user), 100, 100, model)
        if schema is MermaidFix:
            return LLMResult(MermaidFix(mermaid="graph TD; A-->B"), 50, 20, model)
        clarify = "[clarify]" in user and "<clarification_answer>" not in user
        name = "topic_map_clarify.json" if clarify else "topic_map.json"
        output = schema.model_validate_json((self._dir / name).read_text(encoding="utf-8"))
        return LLMResult(output, 100, 200, model)


    def stream_text(
        self, *, model: str, system: str, user: str, max_tokens: int, on_usage: Callable[[LLMResult], None]
    ) -> Iterator[str]:
        match = re.search(r"<format>(\w+)</format>", user)
        text = (self._dir / f"lesson_{match.group(1) if match else 'text'}.txt").read_text(encoding="utf-8")
        for i in range(0, len(text), 40):
            yield text[i : i + 40]
        on_usage(LLMResult(None, 100, 400, model))


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
