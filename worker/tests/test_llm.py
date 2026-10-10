from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from worker import llm
from worker.config import Settings
from worker.jobs import PermanentJobError
from worker.llm import (
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


def _resp(parsed, stop="end_turn"):
    return SimpleNamespace(
        parsed_output=parsed, stop_reason=stop, usage=SimpleNamespace(input_tokens=5, output_tokens=7)
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
