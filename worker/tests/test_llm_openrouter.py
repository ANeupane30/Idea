from decimal import Decimal
from types import SimpleNamespace

import httpx2 as httpx  # the HTTP library the installed openai SDK uses
import openai
import pytest
from pydantic import BaseModel

from worker.config import Settings
from worker.jobs import PermanentJobError
from worker.llm import (
    LLMOutputError,
    LLMRefusal,
    LLMResult,
    OpenRouterLLM,
    cost_cents,
    make_llm,
)

SMART = ["vendor/big:free", "openrouter/free"]
FAST = ["vendor/small:free"]


class Item(BaseModel):
    title: str
    score: float


class Resp(BaseModel):
    items: list[Item]


def _completion(content, finish="stop", model="vendor/big:free", usage=(11, 22)):
    return SimpleNamespace(
        model=model,
        choices=[SimpleNamespace(finish_reason=finish, message=SimpleNamespace(content=content))],
        usage=SimpleNamespace(prompt_tokens=usage[0], completion_tokens=usage[1]) if usage else None,
    )


class _Completions:
    def __init__(self, result):
        self.result = result
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def _llm(result):
    a = OpenRouterLLM("test-key", smart=SMART, fast=FAST)
    comps = _Completions(result)
    a._client = SimpleNamespace(chat=SimpleNamespace(completions=comps))
    return a, comps


GOOD = '{"items": [{"title": "Joins", "score": 0.9}]}'


def test_parse_success_and_request_shape():
    a, comps = _llm(_completion(GOOD))
    res = a.parse(model="claude-sonnet-5-5", system="sys", user="usr", schema=Resp, max_tokens=321)
    assert res.output == Resp(items=[Item(title="Joins", score=0.9)])
    assert (res.input_tokens, res.output_tokens, res.model) == (11, 22, "vendor/big:free")
    k = comps.kwargs
    assert k["model"] == "vendor/big:free"
    assert k["extra_body"] == {"models": SMART}
    assert k["max_tokens"] == 321
    assert k["response_format"]["type"] == "json_schema"
    assert k["response_format"]["json_schema"]["name"] == "Resp"
    assert k["response_format"]["json_schema"]["schema"] == Resp.model_json_schema()
    system, user = k["messages"]
    assert system["role"] == "system" and system["content"].startswith("sys")
    # Models without native structured output still get the schema in the prompt.
    assert '"items"' in system["content"] and "JSON" in system["content"]
    assert user == {"role": "user", "content": "usr"}


def test_haiku_maps_to_fast_tier_and_single_model_has_no_fallback_list():
    a, comps = _llm(_completion(GOOD, model="vendor/small:free"))
    res = a.parse(model="claude-haiku-4-5", system="s", user="u", schema=Resp)
    assert comps.kwargs["model"] == "vendor/small:free"
    assert "models" not in (comps.kwargs.get("extra_body") or {})
    assert res.model == "vendor/small:free"


def test_unknown_model_maps_to_smart_tier():
    a, comps = _llm(_completion(GOOD))
    a.parse(model="claude-future-9", system="s", user="u", schema=Resp)
    assert comps.kwargs["model"] == "vendor/big:free"


@pytest.mark.parametrize(
    "content",
    [
        "```json\n" + GOOD + "\n```",
        "```\n" + GOOD + "\n```",
        "Here you go:\n" + GOOD,
    ],
)
def test_parse_tolerates_fences_and_preamble(content):
    a, _ = _llm(_completion(content))
    assert a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp).output.items[0].title == "Joins"


@pytest.mark.parametrize("content", ['{"items": [{"title": 1}]}', "not json", "", None])
def test_parse_invalid_output_raises_output_error_with_usage(content):
    a, _ = _llm(_completion(content))
    with pytest.raises(LLMOutputError) as ei:
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert (ei.value.input_tokens, ei.value.output_tokens, ei.value.model) == (11, 22, "vendor/big:free")


def test_parse_cut_off_raises_output_error():
    a, _ = _llm(_completion(GOOD[:10], finish="length"))
    with pytest.raises(LLMOutputError):
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)


def test_parse_content_filter_is_a_refusal_with_usage():
    a, _ = _llm(_completion(None, finish="content_filter"))
    with pytest.raises(LLMRefusal) as ei:
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert isinstance(ei.value, PermanentJobError)
    assert (ei.value.input_tokens, ei.value.output_tokens) == (11, 22)


def test_parse_no_choices_is_retryable_output_error():
    # OpenRouter can answer 200 with an upstream error and no choices.
    a, _ = _llm(SimpleNamespace(model=None, choices=None, usage=None))
    with pytest.raises(LLMOutputError) as ei:
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert not isinstance(ei.value, PermanentJobError)
    assert ei.value.model == "vendor/big:free"


def _api_error(exc_type, status):
    req = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    return exc_type("detail-xyz", response=httpx.Response(status, request=req), body=None)


@pytest.mark.parametrize(
    "exc_type,status",
    [
        (openai.BadRequestError, 400),
        (openai.AuthenticationError, 401),
        (openai.PermissionDeniedError, 403),
        (openai.NotFoundError, 404),
    ],
)
def test_client_errors_are_permanent(exc_type, status, caplog):
    a, _ = _llm(_api_error(exc_type, status))
    with caplog.at_level("ERROR", logger="worker.llm"), pytest.raises(LLMRefusal) as ei:
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert ei.value.message == "We couldn't build a topic map for this goal. Try rewording it."
    assert "detail-xyz" in caplog.text


def test_rate_limit_is_not_permanent():
    a, _ = _llm(_api_error(openai.RateLimitError, 429))
    with pytest.raises(openai.RateLimitError):
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)


def test_client_timeout_and_no_sdk_retries():
    client = OpenRouterLLM("test-key", smart=SMART, fast=FAST)._client
    assert client.timeout == 120.0
    assert client.max_retries == 0
    assert str(client.base_url).rstrip("/") == "https://openrouter.ai/api/v1"


def _chunk(text=None, finish=None, usage=None, model="vendor/big:free", choices=True):
    return SimpleNamespace(
        model=model,
        choices=[SimpleNamespace(delta=SimpleNamespace(content=text), finish_reason=finish)] if choices else [],
        usage=SimpleNamespace(prompt_tokens=usage[0], completion_tokens=usage[1]) if usage else None,
    )


class _Stream:
    def __init__(self, chunks):
        self._chunks = chunks
        self.closed = False

    def __iter__(self):
        return iter(self._chunks)

    def close(self):
        self.closed = True


def test_stream_text_yields_deltas_and_bills_final_usage():
    chunks = [_chunk("Hel"), _chunk("lo"), _chunk(None, "stop"), _chunk(choices=False, usage=(5, 7))]
    a, comps = _llm(_Stream(chunks))
    usage = []
    out = list(a.stream_text(model="claude-sonnet-5-5", system="s", user="u", max_tokens=99, on_usage=usage.append))
    assert out == ["Hel", "lo"]
    k = comps.kwargs
    assert k["stream"] is True and k["stream_options"] == {"include_usage": True}
    assert k["max_tokens"] == 99 and k["model"] == "vendor/big:free"
    assert k["messages"] == [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
    assert [(u.input_tokens, u.output_tokens, u.model) for u in usage] == [(5, 7, "vendor/big:free")]


def test_stream_text_cut_off_bills_then_raises():
    chunks = [_chunk("abc"), _chunk(None, "length", usage=(5, 7))]
    a, _ = _llm(_Stream(chunks))
    usage = []
    with pytest.raises(LLMOutputError):
        list(a.stream_text(model="claude-sonnet-5-5", system="s", user="u", max_tokens=9, on_usage=usage.append))
    assert len(usage) == 1


def test_stream_text_upstream_error_is_retryable():
    chunks = [_chunk("abc"), _chunk(None, "error")]
    a, _ = _llm(_Stream(chunks))
    usage = []
    with pytest.raises(LLMOutputError) as ei:
        list(a.stream_text(model="claude-sonnet-5-5", system="s", user="u", max_tokens=9, on_usage=usage.append))
    assert not isinstance(ei.value, PermanentJobError)
    assert len(usage) == 1


def test_stream_text_content_filter_is_a_refusal():
    a, _ = _llm(_Stream([_chunk("x"), _chunk(None, "content_filter", usage=(1, 1))]))
    with pytest.raises(LLMRefusal):
        list(a.stream_text(model="claude-sonnet-5-5", system="s", user="u", max_tokens=9, on_usage=lambda r: None))


def test_stream_closed_early_bills_an_estimate_and_closes_the_stream():
    stream = _Stream([_chunk("a" * 40), _chunk("b" * 40), _chunk(None, "stop", usage=(5, 7))])
    a, _ = _llm(stream)
    usage = []
    gen = a.stream_text(model="claude-sonnet-5-5", system="s", user="u", max_tokens=9, on_usage=usage.append)
    assert next(gen) == "a" * 40
    gen.close()  # the reader went away
    assert stream.closed
    assert len(usage) == 1 and usage[0].output_tokens == 10  # ~4 characters per token


def test_stream_permanent_error_is_a_refusal():
    a, _ = _llm(_api_error(openai.AuthenticationError, 401))
    with pytest.raises(LLMRefusal):
        list(a.stream_text(model="claude-sonnet-5-5", system="s", user="u", max_tokens=9, on_usage=lambda r: None))


def test_make_llm_openrouter():
    s = Settings(
        llm_provider="openrouter",
        openrouter_api_key="k",
        openrouter_models_smart="a/x:free, b/y:free",
        openrouter_models_fast="c/z:free",
        _env_file=None,
    )
    llm = make_llm(s)
    assert isinstance(llm, OpenRouterLLM)
    assert llm._tiers == {"smart": ["a/x:free", "b/y:free"], "fast": ["c/z:free"]}
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        make_llm(Settings(llm_provider="openrouter", openrouter_api_key=None, _env_file=None))


def test_openrouter_default_models_have_known_prices():
    """Usage is billed at the model's own rates, never the "unknown model" maximum."""
    from worker.llm import PRICES_PER_MTOK

    s = Settings(_env_file=None)
    for value in (s.openrouter_models_smart, s.openrouter_models_fast):
        ids = [m.strip() for m in value.split(",")]
        assert ids and all(m in PRICES_PER_MTOK for m in ids)


@pytest.mark.parametrize("model", ["vendor/big:free", "openrouter/free"])
def test_free_models_cost_nothing(model, caplog):
    r = LLMResult(output=None, input_tokens=1_000_000, output_tokens=1_000_000, model=model)
    with caplog.at_level("WARNING", logger="worker.llm"):
        assert cost_cents(r) == Decimal("0.0000")
    assert "unknown model" not in caplog.text


def test_free_route_reports_a_free_model_even_when_the_router_names_the_base_model():
    # openrouter/free may report the model that answered without its ":free" suffix.
    a, _ = _llm(_completion(GOOD, model="vendor/other"))
    res = a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert res.model == "vendor/other:free"
    assert cost_cents(res) == Decimal("0.0000")


def test_paid_route_keeps_the_served_model():
    a = OpenRouterLLM("k", smart=["vendor/paid"], fast=FAST)
    comps = _Completions(_completion(GOOD, model="vendor/paid-2026"))
    a._client = SimpleNamespace(chat=SimpleNamespace(completions=comps))
    assert a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp).model == "vendor/paid-2026"
