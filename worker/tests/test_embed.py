import math
import os

import pytest

from worker.config import Settings
from worker.ingest.embed import DIMS, FakeEmbedder, FastEmbedder, make_embedder


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def test_fake_embedder():
    e = FakeEmbedder()
    a, b, c = e.embed_passages(["SQL joins tables", "joining tables in SQL", "baking bread at home"])
    assert len(a) == DIMS
    assert math.isclose(math.sqrt(dot(a, a)), 1.0, rel_tol=1e-6)
    assert e.embed_passages(["SQL joins tables"])[0] == a
    assert dot(a, b) > dot(a, c)
    assert e.embed_queries(["SQL joins tables"])[0] == a
    assert e.model == "fake-hash-384" and e.shortlist_min == 0.10


def test_fake_embedder_empty_text_is_unit_vector():
    (v,) = FakeEmbedder().embed_passages([""])
    assert math.isclose(math.sqrt(dot(v, v)), 1.0)


def test_make_embedder():
    assert isinstance(make_embedder(Settings(embedder="fake")), FakeEmbedder)
    assert isinstance(make_embedder(Settings(embedder="fastembed")), FastEmbedder)


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("FASTEMBED_SKIP") == "1", reason="FASTEMBED_SKIP=1")
def test_fastembed_dims():
    e = FastEmbedder()
    (q,) = e.embed_queries(["Joining tables: combine rows from related tables"])
    related, unrelated = e.embed_passages(
        ["An inner join returns rows with a match in both tables.", "Bread rises because yeast produces gas."]
    )
    assert len(q) == DIMS
    assert dot(q, related) > dot(q, unrelated)
    assert e.model == "BAAI/bge-small-en-v1.5" and e.shortlist_min == 0.50


def test_fast_embedders_share_one_model(monkeypatch):
    import sys
    import types

    from worker.ingest import embed

    made = []

    class FakeTextEmbedding:
        def __init__(self, name, cache_dir=None):
            made.append((name, cache_dir))

        def passage_embed(self, texts):
            return [[0.0] * 384 for _ in texts]

    monkeypatch.setitem(sys.modules, "fastembed", types.SimpleNamespace(TextEmbedding=FakeTextEmbedding))
    monkeypatch.setenv("FASTEMBED_CACHE_PATH", "/opt/fastembed")
    monkeypatch.setattr(embed.FastEmbedder, "_shared", None, raising=False)
    embed.FastEmbedder().embed_passages(["a"])
    embed.FastEmbedder().embed_passages(["b"])
    assert made == [("BAAI/bge-small-en-v1.5", "/opt/fastembed")]
