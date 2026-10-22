"""LLM clients: Anthropic and OpenRouter (structured output) and a fixture-backed fake, plus usage recording."""

from collections.abc import Callable, Iterator
from dataclasses import dataclass
import json
import logging
import re
from decimal import Decimal
from pathlib import Path
from typing import Generic, Protocol, TypeVar
from uuid import UUID

import anthropic
import openai
import psycopg
from pydantic import ValidationError

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
        final = None
        try:
            with self._client.beta.messages.stream(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                **_MODEL_OPTIONS.get(model, {}),
            ) as stream:
                try:
                    yield from stream.text_stream
                    final = stream.get_final_message()
                finally:
                    if final is None:
                        # Closed early (the reader went away) or failed mid-stream: bill what was used so far.
                        _bill_snapshot(stream, model, on_usage)
        except _PERMANENT_API_ERRORS as e:
            log.exception("Anthropic request rejected (%s)", type(e).__name__)
            raise LLMRefusal(REFUSAL_MESSAGE, model=model) from e
        on_usage(LLMResult(None, final.usage.input_tokens, final.usage.output_tokens, final.model))
        if final.stop_reason == "refusal":
            raise LLMRefusal(REFUSAL_MESSAGE, model=final.model)
        if final.stop_reason == "max_tokens":
            raise LLMOutputError("output cut off at max_tokens", model=final.model)


def _bill_snapshot(stream, model: str, on_usage: Callable[[LLMResult], None]) -> None:
    try:
        snapshot = stream.current_message_snapshot
        usage = snapshot.usage
        on_usage(LLMResult(None, usage.input_tokens, usage.output_tokens, getattr(snapshot, "model", None) or model))
    except Exception:
        log.exception("could not bill a partial stream")


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# The code names Anthropic models; OpenRouter maps each to a tier of configured models.
_TIER_OF = {"claude-haiku-4-5": "fast"}

_OPENROUTER_PERMANENT_ERRORS = (
    openai.BadRequestError,
    openai.AuthenticationError,
    openai.PermissionDeniedError,
    openai.NotFoundError,
)

_JSON_INSTRUCTION = (
    "\n\nReply with one JSON object that conforms to this JSON Schema, and nothing else"
    " (no prose, no code fences):\n"
)


def _extract_json(text: str) -> str:
    """The JSON object in a reply, tolerating code fences and a line of preamble."""
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if start != -1 and end > start else text


class OpenRouterLLM:
    """OpenRouter's OpenAI-compatible API. Free models have no refusal fallbacks or effort settings."""

    def __init__(self, api_key: str, *, smart: list[str], fast: list[str]):
        # No SDK retries: the job queue owns them, as for Anthropic. Rate limits (429) are retried there.
        self._client = openai.OpenAI(api_key=api_key, base_url=OPENROUTER_BASE_URL, timeout=120.0, max_retries=0)
        self._tiers = {"smart": smart, "fast": fast}

    def _route(self, model: str) -> dict:
        ids = self._tiers[_TIER_OF.get(model, "smart")]
        # OpenRouter tries `models` in order when one is down or rate limited.
        return {"model": ids[0], **({"extra_body": {"models": ids}} if len(ids) > 1 else {})}

    def _served(self, model: str, served: str | None) -> str:
        ids = self._tiers[_TIER_OF.get(model, "smart")]
        served = served or ids[0]
        # A route of only free models can't be charged, whatever name the router reports.
        if all(_is_free(m) for m in ids) and not _is_free(served):
            return f"{served}:free"
        return served

    def parse(
        self, *, model: str, system: str, user: str, schema: type[T], max_tokens: int = 16000
    ) -> LLMResult[T]:
        route = self._route(model)
        json_schema = schema.model_json_schema()
        try:
            response = self._client.chat.completions.create(
                messages=[
                    {"role": "system", "content": system + _JSON_INSTRUCTION + json.dumps(json_schema)},
                    {"role": "user", "content": user},
                ],
                max_tokens=max_tokens,
                response_format={
                    "type": "json_schema",
                    "json_schema": {"name": schema.__name__, "schema": json_schema},
                },
                **route,
            )
        except _OPENROUTER_PERMANENT_ERRORS as e:
            log.exception("OpenRouter request rejected (%s)", type(e).__name__)
            raise LLMRefusal(REFUSAL_MESSAGE, model=route["model"]) from e
        served = self._served(model, response.model)
        usage = response.usage
        tokens = (usage.prompt_tokens or 0, usage.completion_tokens or 0) if usage else (0, 0)
        if not response.choices:
            # OpenRouter can return 200 with an upstream error instead of choices: retry the job.
            raise LLMOutputError("no choices in the response", *tokens, served)
        choice = response.choices[0]
        if choice.finish_reason == "content_filter":
            raise LLMRefusal(REFUSAL_MESSAGE, *tokens, served)
        if choice.finish_reason == "length":
            raise LLMOutputError("output cut off at max_tokens", *tokens, served)
        try:
            output = schema.model_validate_json(_extract_json(choice.message.content or ""))
        except ValidationError as e:
            raise LLMOutputError(f"output does not match {schema.__name__}: {e.error_count()} errors", *tokens, served) from e
        return LLMResult(output, *tokens, served)

    def stream_text(
        self, *, model: str, system: str, user: str, max_tokens: int, on_usage: Callable[[LLMResult], None]
    ) -> Iterator[str]:
        route = self._route(model)
        try:
            stream = self._client.chat.completions.create(
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                max_tokens=max_tokens,
                stream=True,
                stream_options={"include_usage": True},
                **route,
            )
        except _OPENROUTER_PERMANENT_ERRORS as e:
            log.exception("OpenRouter request rejected (%s)", type(e).__name__)
            raise LLMRefusal(REFUSAL_MESSAGE, model=route["model"]) from e
        served, finish, tokens, chars, done = route["model"], None, None, 0, False
        try:
            for chunk in stream:
                served = self._served(model, chunk.model or served)
                if chunk.usage:
                    tokens = (chunk.usage.prompt_tokens or 0, chunk.usage.completion_tokens or 0)
                for choice in chunk.choices or []:
                    finish = choice.finish_reason or finish
                    if choice.delta and choice.delta.content:
                        chars += len(choice.delta.content)
                        yield choice.delta.content
            done = True
        finally:
            stream.close()
            # Closed early or failed mid-stream: no usage arrived, so bill an estimate (~4 characters a token).
            on_usage(LLMResult(None, *(tokens if done and tokens else (0, chars // 4)), served))
        if finish == "content_filter":
            raise LLMRefusal(REFUSAL_MESSAGE, model=served)
        if finish == "length":
            raise LLMOutputError("output cut off at max_tokens", model=served)
        if finish == "error":
            raise LLMOutputError("the model failed mid-stream", model=served)


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
        from worker.quiz.questions import QuestionSet, fake_question_set
        from worker.quiz.validate import VerdictSet, fake_verdicts

        if schema is MappingResponse:
            return LLMResult(fake_mapping_response(user), 100, 50, model)
        if schema is PunctuationResponse:
            return LLMResult(fake_punctuation_response(user), 100, 100, model)
        if schema is QuestionSet:
            return LLMResult(fake_question_set(user), 300, 900, model)
        if schema is VerdictSet:
            return LLMResult(fake_verdicts(user), 200, 60, model)
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
        done = False
        try:
            for i in range(0, len(text), 40):
                yield text[i : i + 40]
            done = True
        finally:
            # Like the real client: a stream closed early is billed for what it produced.
            on_usage(LLMResult(None, 100, 400 if done else 200, model))


def make_llm(settings: Settings) -> LLM:
    if settings.llm_provider == "fake":
        return FakeLLM(DEFAULT_FIXTURES_DIR)
    if settings.llm_provider == "openrouter":
        if not settings.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter")
        return OpenRouterLLM(
            settings.openrouter_api_key,
            smart=_model_list(settings.openrouter_models_smart),
            fast=_model_list(settings.openrouter_models_fast),
        )
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic")
    return AnthropicLLM(settings.anthropic_api_key)


def _model_list(value: str) -> list[str]:
    ids = [m.strip() for m in value.split(",") if m.strip()]
    if not ids:
        raise RuntimeError("OPENROUTER_MODELS_SMART and OPENROUTER_MODELS_FAST need at least one model id")
    return ids


def _is_free(model: str) -> bool:
    return model.endswith(":free") or model == "openrouter/free"


def cost_cents(result: LLMResult) -> Decimal:
    if _is_free(result.model):
        return Decimal("0.0000")
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
