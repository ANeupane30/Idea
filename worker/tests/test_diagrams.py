from worker.config import Settings
from worker.lessons.diagrams import FakeDiagramValidator, MermaidFix, MermaidValidator, check_diagrams
from worker.lessons.parse import Section
from worker.llm import LLMRefusal, LLMResult


class SpyLLM:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    def parse(self, *, model, system, user, schema, max_tokens=16000):
        self.calls.append({"model": model, "user": user, "schema": schema})
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return LLMResult(MermaidFix(mermaid=out), 10, 20, model)


def section(code):
    return Section("Text", code, [1])


def test_mermaid_valid_and_invalid():
    errors = MermaidValidator(Settings().mermaid_js_path).errors(["graph TD; A-->B", "graph TD; A-->"])
    assert errors[0] is None
    assert errors[1]


def test_validator_blocks_network():
    validator = MermaidValidator(Settings().mermaid_js_path)
    errors = validator.errors(['graph TD; A["<img src=http://10.255.255.1/x>"]-->B'])
    assert errors == [None]
    assert validator.requests == []


def test_check_diagrams_repairs_once():
    llm = SpyLLM(["graph TD; A-->B"])
    billed = []
    out = check_diagrams([section("graph TD; A-->INVALID")], FakeDiagramValidator(), llm, billed.append)
    assert out[0].mermaid == "graph TD; A-->B"
    assert len(llm.calls) == 1 and llm.calls[0]["model"] == "claude-sonnet-5-5"
    assert "INVALID" in llm.calls[0]["user"]
    assert len(billed) == 1


def test_check_diagrams_drops_after_failed_repair():
    llm = SpyLLM(["still INVALID"])
    out = check_diagrams([section("INVALID")], FakeDiagramValidator(), llm, lambda r: None)
    assert out[0].mermaid is None
    assert (out[0].markdown, out[0].citations) == ("Text", [1])


def test_check_diagrams_refusal_drops_and_bills():
    llm = SpyLLM([LLMRefusal("no", 7, 1, "claude-sonnet-5-5")])
    billed = []
    out = check_diagrams([section("INVALID")], FakeDiagramValidator(), llm, billed.append)
    assert out[0].mermaid is None
    assert [b.input_tokens for b in billed] == [7]


def test_valid_and_missing_diagrams_untouched():
    llm = SpyLLM([])
    sections = [section("graph TD; A-->B"), Section("No diagram", None, [2])]
    assert check_diagrams(sections, FakeDiagramValidator(), llm, lambda r: None) == sections
    assert llm.calls == []
