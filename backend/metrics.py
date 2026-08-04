"""Diversity metrics and idea dedup (SPEC section 5.3).

No torch / sentence-transformers anywhere (C3): embeddings come from a cloud
embedding API through LiteLLM when a usable key exists, otherwise from a
numpy-only character-bigram TF-IDF representation. Character n-grams (rather
than word tokens) keep the fallback meaningful for Japanese as well.
"""

from __future__ import annotations

from collections import Counter
from typing import Optional

import numpy as np

from . import providers
from .models import SessionMetrics

DEDUP_THRESHOLD = 0.8
# Below this mean cosine distance from the centroid the pool is considered to
# have collapsed into a single semantic point.
_DISPERSION_FLOOR = 0.02


# ---------------------------------------------------------------------------
# Vectorization
# ---------------------------------------------------------------------------


def _char_bigrams(text: str) -> list[str]:
    normalized = " ".join(text.lower().split())
    if len(normalized) < 2:
        return [normalized] if normalized else []
    return [normalized[i : i + 2] for i in range(len(normalized) - 1)]


def tfidf_matrix(texts: list[str]) -> np.ndarray:
    """L2-normalized TF-IDF matrix of shape (n_docs, n_terms), numpy only."""

    if not texts:
        return np.zeros((0, 0), dtype=np.float64)

    doc_counts: list[Counter] = [Counter(_char_bigrams(t)) for t in texts]
    df: Counter = Counter()
    for counts in doc_counts:
        for term in counts:
            df[term] += 1

    vocab = sorted(df)
    index = {term: i for i, term in enumerate(vocab)}
    n_docs, n_terms = len(texts), len(vocab)
    matrix = np.zeros((n_docs, n_terms), dtype=np.float64)

    for d, counts in enumerate(doc_counts):
        total = sum(counts.values()) or 1
        for term, c in counts.items():
            tf = c / total
            idf = np.log((1 + n_docs) / (1 + df[term])) + 1.0  # smoothed idf
            matrix[d, index[term]] = tf * idf

    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return matrix / norms


async def _vectorize(texts: list[str]) -> np.ndarray:
    """Cloud embeddings when available, TF-IDF otherwise (transparent fallback)."""

    embeddings = await providers.embed_texts(texts)
    if embeddings:
        matrix = np.asarray(embeddings, dtype=np.float64)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0.0] = 1.0
        return matrix / norms
    return tfidf_matrix(texts)


# ---------------------------------------------------------------------------
# Clustering / dedup
# ---------------------------------------------------------------------------


def _greedy_clusters(matrix: np.ndarray, threshold: float) -> list[int]:
    """Assign each vector to the first cluster whose representative reaches the
    cosine threshold; deterministic in document order."""

    n = matrix.shape[0]
    cluster_of = [-1] * n
    representatives: list[int] = []
    for i in range(n):
        assigned = -1
        for rep in representatives:
            if float(matrix[i] @ matrix[rep]) >= threshold:
                assigned = cluster_of[rep]
                break
        if assigned < 0:
            assigned = len(representatives)
            representatives.append(i)
        cluster_of[i] = assigned
    return cluster_of


async def dedup_ideas(texts: list[str], threshold: float = DEDUP_THRESHOLD) -> list[int]:
    """Cluster idea texts; returns one cluster id per input (0-based)."""

    if not texts:
        return []
    matrix = await _vectorize(texts)
    return _greedy_clusters(matrix, threshold)


def semantic_dispersion(matrix: np.ndarray) -> float:
    """Mean cosine distance of the vectors from their centroid."""

    n = matrix.shape[0]
    if n <= 1:
        return 0.0
    centroid = matrix.mean(axis=0)
    norm = float(np.linalg.norm(centroid))
    if norm == 0.0:
        return 0.0
    centroid /= norm
    distances = 1.0 - (matrix @ centroid)
    return float(np.mean(distances))


async def compute_metrics(
    texts: list[str], cluster_ids: Optional[list[int]] = None
) -> tuple[SessionMetrics, list[int]]:
    """Compute the full metric set for an idea pool.

    Returns (metrics, cluster_ids); the caller may pass precomputed cluster ids
    (from dedup_ideas) to avoid vectorizing twice.
    """

    total = len(texts)
    if total == 0:
        metrics = SessionMetrics(
            total_ideas=0,
            unique_ideas=0,
            non_duplicate_ratio=1.0,
            semantic_dispersion=0.0,
            collapse_alert=False,
        )
        return metrics, []

    matrix = await _vectorize(texts)
    if cluster_ids is None:
        cluster_ids = _greedy_clusters(matrix, DEDUP_THRESHOLD)
    unique = len(set(cluster_ids))
    ndr = unique / total
    dispersion = semantic_dispersion(matrix)
    metrics = SessionMetrics(
        total_ideas=total,
        unique_ideas=unique,
        non_duplicate_ratio=round(ndr, 4),
        semantic_dispersion=round(dispersion, 4),
        collapse_alert=(ndr < 0.5) or (dispersion < _DISPERSION_FLOOR),
    )
    return metrics, cluster_ids
