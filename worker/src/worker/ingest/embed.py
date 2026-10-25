"""Text embeddings: a local fastembed model, or a deterministic hashing fake for tests."""

import hashlib
import math
import os
import re
import threading
from typing import Protocol

from worker.config import Settings

DIMS = 384
CGROUP_CPU_MAX = "/sys/fs/cgroup/cpu.max"


def usable_cpus() -> int:
    """CPUs this process may really use: a container's CPU quota, else the CPUs it may run on."""
    try:
        with open(CGROUP_CPU_MAX) as f:
            quota, period = f.read().split()[:2]
        if quota != "max":
            return max(1, int(quota) // int(period))
    except (OSError, ValueError):
        pass
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except AttributeError:  # not on Linux
        return os.cpu_count() or 1


class Embedder(Protocol):
    model: str
    shortlist_min: float

    def embed_passages(self, texts: list[str]) -> list[list[float]]: ...

    def embed_queries(self, texts: list[str]) -> list[list[float]]: ...


class FastEmbedder:
    """BAAI/bge-small-en-v1.5 via fastembed (ONNX, CPU).

    One model per process, shared by every job thread, and used by one thread at a time with as
    many ONNX threads as the machine has CPUs: concurrent runs on a small VM thrash. The worker
    image has the model built in (FASTEMBED_CACHE_PATH); elsewhere it downloads on first use."""

    model = "BAAI/bge-small-en-v1.5"
    shortlist_min = 0.50
    _shared = None
    _lock = threading.Lock()
    _run_lock = threading.Lock()

    def _get(self):
        cls = type(self)
        if cls._shared is None:
            with cls._lock:
                if cls._shared is None:
                    from fastembed import TextEmbedding

                    cls._shared = TextEmbedding(
                        self.model, cache_dir=os.environ.get("FASTEMBED_CACHE_PATH"), threads=usable_cpus()
                    )
        return cls._shared

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        model = self._get()
        with self._run_lock:
            return [[float(x) for x in v] for v in model.passage_embed(texts)]

    def embed_queries(self, texts: list[str]) -> list[list[float]]:
        model = self._get()
        with self._run_lock:
            return [[float(x) for x in v] for v in model.query_embed(texts)]


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
