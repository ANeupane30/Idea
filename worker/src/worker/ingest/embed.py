"""Text embeddings: a local fastembed model, or a deterministic hashing fake for tests."""

import hashlib
import math
import re
from typing import Protocol

from worker.config import Settings

DIMS = 384


class Embedder(Protocol):
    model: str
    shortlist_min: float

    def embed_passages(self, texts: list[str]) -> list[list[float]]: ...

    def embed_queries(self, texts: list[str]) -> list[list[float]]: ...


class FastEmbedder:
    """BAAI/bge-small-en-v1.5 via fastembed (ONNX, CPU). The model downloads on first use."""

    model = "BAAI/bge-small-en-v1.5"
    shortlist_min = 0.50

    def __init__(self):
        self._model = None

    def _get(self):
        if self._model is None:
            from fastembed import TextEmbedding

            self._model = TextEmbedding(self.model)
        return self._model

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        return [[float(x) for x in v] for v in self._get().passage_embed(texts)]

    def embed_queries(self, texts: list[str]) -> list[list[float]]:
        return [[float(x) for x in v] for v in self._get().query_embed(texts)]


class FakeEmbedder:
    """Bag of words hashed into 384 buckets, L2-normalized: shared words mean higher similarity."""

    model = "fake-hash-384"
    shortlist_min = 0.10

    def _one(self, text: str) -> list[float]:
        vec = [0.0] * DIMS
        for word in re.findall(r"[a-z]{3,}", text.lower()):
            vec[int(hashlib.sha1(word.encode()).hexdigest(), 16) % DIMS] += 1.0
        norm = math.sqrt(sum(x * x for x in vec))
        if norm == 0:
            vec[0], norm = 1.0, 1.0
        return [x / norm for x in vec]

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]

    def embed_queries(self, texts: list[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]


def make_embedder(settings: Settings) -> Embedder:
    return FakeEmbedder() if settings.embedder == "fake" else FastEmbedder()
