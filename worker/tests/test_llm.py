from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import anthropic
import httpx2 as httpx  # the HTTP library the installed anthropic SDK uses
import pytest
from pydantic import BaseModel

from worker import llm
from worker.config import Settings
from worker.jobs import PermanentJobError
from worker.llm import (
    DEFAULT_FIXTURES_DIR,
    AnthropicLLM,
    FakeLLM,
    LLMOutputError,
    LLMResult,
    cost_cents,
    make_llm,
    record_usage,
)

FIXTURES = Path(__file__).parent / "fixtures" / "fake_llm"


class Child(BaseModel):
    title: str
    summary: str


class Sub(BaseModel):
    title: str
    summary: str
    children: list[Child]


class Resp(BaseModel):
    needs_clarification: bool
    clarifying_question: str | None
    subtopics: list[Sub]


def test_cost_cents_sonnet():
    r = LLMResult(output=None, input_tokens=1_000_000, output_tokens=100_000, model="claude-sonnet-5-5")
    assert cost_cents(r) == Decimal("300.0000")


def test_record_usage_inserts_row(db, make_user):
    uid = make_user(db)
    r = LLMResult(output=None, input_tokens=100, output_tokens=200, model="claude-sonnet-5-5")
    record_usage(db, uid, "topic_map", r)
    row = db.execute("select kind, tokens, cost_cents from usage_events where user_id = %s", (uid,)).fetchone()
    assert row["kind"] == "topic_map"
    assert row["tokens"] == 300
    assert row["cost_cents"] == cost_cents(r)


def test_fake_llm_selects_clarify_fixture():
    res = FakeLLM(FIXTURES).parse(model="m", system="s", user="Learn stuff [clarify]", schema=Resp)
    assert res.output.needs_clarification is True
    assert res.output.subtopics == []
    assert (res.input_tokens, res.output_tokens) == (100, 200)


def test_fake_llm_default_fixture():
    res = FakeLLM(FIXTURES).parse(model="m", system="s", user="Learn SQL", schema=Resp)
    assert res.output.needs_clarification is False
    assert len(res.output.subtopics) == 6
    assert sum(1 for s in res.output.subtopics if s.children) == 2


def test_fake_llm_answered_clarification_uses_default():
    user = "x [clarify] <clarification_answer>reports</clarification_answer>"
    res = FakeLLM(FIXTURES).parse(model="m", system="s", user=user, schema=Resp)
    assert res.output.needs_clarification is False


class _FakeBetaMessages:
    def __init__(self, response):
        self.response = response
        self.kwargs = None

    def parse(self, **kwargs):
        self.kwargs = kwargs
        return self.response


def _llm_with(response):
    a = AnthropicLLM("test-key")
    msgs = _FakeBetaMessages(response)
    a._client = SimpleNamespace(beta=SimpleNamespace(messages=msgs))
    return a, msgs


def _resp(parsed, stop="end_turn", model="claude-sonnet-5-5"):
    return SimpleNamespace(
        parsed_output=parsed, stop_reason=stop, model=model, usage=SimpleNamespace(input_tokens=5, output_tokens=7)
    )


def test_anthropic_refusal_raises_permanent():
    a, _ = _llm_with(_resp(None, "refusal"))
    with pytest.raises(PermanentJobError) as e:
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert "Try rewording it" in e.value.message


def test_anthropic_missing_output_raises_llm_output_error():
    a, _ = _llm_with(_resp(None, "max_tokens"))
    with pytest.raises(LLMOutputError):
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)


def test_llm_output_error_carries_usage():
    a, _ = _llm_with(_resp(None, "max_tokens"))
    with pytest.raises(LLMOutputError) as ei:
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert (ei.value.input_tokens, ei.value.output_tokens) == (5, 7)
    assert ei.value.model == "claude-sonnet-5-5"
    assert LLMOutputError("x").input_tokens == 0


def test_anthropic_success_passes_expected_args():
    parsed = Resp(needs_clarification=False, clarifying_question=None, subtopics=[])
    a, msgs = _llm_with(_resp(parsed))
    res = a.parse(model="claude-sonnet-5-5", system="sys", user="usr", schema=Resp, max_tokens=123)
    assert res.output is parsed
    assert (res.input_tokens, res.output_tokens, res.model) == (5, 7, "claude-sonnet-5-5")
    k = msgs.kwargs
    assert k["output_format"] is Resp
    assert k["output_config"] == {"effort": "medium"}
    assert k["betas"] == ["server-side-fallback-2026-07-01"]
    assert k["fallbacks"] == "default"
    assert k["max_tokens"] == 123
    assert k["messages"] == [{"role": "user", "content": "usr"}]
    assert "thinking" not in k


def test_make_llm_fake_and_anthropic():
    assert isinstance(make_llm(Settings(llm_provider="fake")), FakeLLM)
    assert isinstance(make_llm(Settings(llm_provider="anthropic", anthropic_api_key="k")), AnthropicLLM)
    with pytest.raises(RuntimeError):
        make_llm(Settings(llm_provider="anthropic", anthropic_api_key=None, _env_file=None))


def test_default_fixtures_dir_exists():
    assert llm.DEFAULT_FIXTURES_DIR.is_dir()


def test_result_model_is_served_model():
    parsed = Resp(needs_clarification=False, clarifying_question=None, subtopics=[])
    a, _ = _llm_with(_resp(parsed, model="claude-haiku-4-5"))
    res = a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert res.model == "claude-haiku-4-5"


def test_cost_cents_unknown_model_uses_max_rates_and_warns(caplog):
    r = LLMResult(output=None, input_tokens=1_000_000, output_tokens=100_000, model="claude-future-9")
    with caplog.at_level("WARNING", logger="worker.llm"):
        assert cost_cents(r) == Decimal("300.0000")
    assert "claude-future-9" in caplog.text


def test_anthropic_client_timeout_and_no_sdk_retries():
    # The job queue owns retries (1 attempt + 3 retries with backoff), so the SDK must not retry.
    client = AnthropicLLM("test-key")._client
    assert client.timeout == 120.0
    assert client.max_retries == 0


class _RaisingBetaMessages:
    def __init__(self, exc):
        self.exc = exc

    def parse(self, **kwargs):
        raise self.exc


@pytest.mark.parametrize(
    "exc_type,status",
    [
        (anthropic.BadRequestError, 400),
        (anthropic.AuthenticationError, 401),
        (anthropic.PermissionDeniedError, 403),
        (anthropic.NotFoundError, 404),
    ],
)
def test_anthropic_client_errors_are_permanent(exc_type, status, caplog):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    exc = exc_type("detail-xyz", response=httpx.Response(status, request=req), body=None)
    a = AnthropicLLM("test-key")
    a._client = SimpleNamespace(beta=SimpleNamespace(messages=_RaisingBetaMessages(exc)))
    with caplog.at_level("ERROR", logger="worker.llm"), pytest.raises(PermanentJobError) as ei:
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)
    assert ei.value.message == "We couldn't build a topic map for this goal. Try rewording it."
    assert "detail-xyz" in caplog.text


def test_anthropic_rate_limit_is_not_permanent():
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    exc = anthropic.RateLimitError("slow down", response=httpx.Response(429, request=req), body=None)
    a = AnthropicLLM("test-key")
    a._client = SimpleNamespace(beta=SimpleNamespace(messages=_RaisingBetaMessages(exc)))
    with pytest.raises(anthropic.RateLimitError):
        a.parse(model="claude-sonnet-5-5", system="s", user="u", schema=Resp)


def test_haiku_gets_no_effort_or_fallbacks():
    """Haiku 4.5 rejects output_config.effort and has no server-side refusal fallback."""
    parsed = Resp(needs_clarification=False, clarifying_question=None, subtopics=[])
    a, msgs = _llm_with(_resp(parsed, model="claude-haiku-4-5"))
    a.parse(model="claude-haiku-4-5", system="sys", user="usr", schema=Resp)
    k = msgs.kwargs
    assert k["model"] == "claude-haiku-4-5"
    assert k["output_format"] is Resp
    for absent in ("output_config", "fallbacks", "betas", "thinking"):
        assert absent not in k, absent


def test_refusal_carries_usage():
    from worker.llm import LLMRefusal

    a, _ = _llm_with(_resp(None, "refusal", model="claude-haiku-4-5"))
    with pytest.raises(LLMRefusal) as e:
        a.parse(model="claude-haiku-4-5", system="s", user="u", schema=Resp)
    assert isinstance(e.value, PermanentJobError)
    assert (e.value.input_tokens, e.value.output_tokens, e.value.model) == (5, 7, "claude-haiku-4-5")


class _FakeStream:
    def __init__(self, texts, final):
        self.text_stream = iter(texts)
        self._final = final

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self._final


def test_anthropic_stream_text_passes_options():
    from worker.llm import LLMRefusal

    a = AnthropicLLM("test-key")
    seen = {}

    def stream(**kwargs):
        seen.update(kwargs)
        return _FakeStream(["Hel", "lo"], _resp(None, "end_turn"))

    a._client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))
    usage = []
    out = list(a.stream_text(model="claude-sonnet-5-5", system="s", user="u", max_tokens=99, on_usage=usage.append))
    assert out == ["Hel", "lo"]
    assert seen["output_config"] == {"effort": "medium"} and seen["fallbacks"] == "default"
    assert seen["max_tokens"] == 99 and seen["messages"] == [{"role": "user", "content": "u"}]
    assert (usage[0].input_tokens, usage[0].output_tokens) == (5, 7)

    def refused(**kwargs):
        return _FakeStream(["x"], _resp(None, "refusal"))

    a._client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=refused)))
    usage = []
    with pytest.raises(LLMRefusal):
        list(a.stream_text(model="claude-sonnet-5-5", system="s", user="u", max_tokens=99, on_usage=usage.append))
    assert len(usage) == 1


def test_fake_stream_text_uses_format_fixture():
    fake = FakeLLM(DEFAULT_FIXTURES_DIR)
    usage = []
    text = "".join(fake.stream_text(model="m", system="s", user="<format>summary</format>", max_tokens=9,
                                    on_usage=usage.append))
    assert "Joins combine rows from related tables." in text
    assert len(usage) == 1
