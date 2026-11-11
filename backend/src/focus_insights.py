"""
Smart Focus for Setup's Focus step (POST /brief-focus).

Embeds the chosen focus topics and the user's Saved Focus pool, then reports:
- overlaps: pairs of chosen topics so close in meaning that two workers
  would research nearly the same thing (merge or drop one);
- related: Saved Focus items close to what's chosen, offered as one-click
  additions.

Advisory only, like the brief: the user decides. Returns None when no
embedding provider answers, and the Focus step simply shows nothing extra.

Embeddings are memoised in-process (bounded), keyed by provider and text, so
re-checking after each add/remove only embeds the new topic. That's a cache
of a pure function, not session state; losing it on restart costs one call.
"""

import logging
from collections import OrderedDict
from embeddings import cosine_similarity, embed_text

logger = logging.getLogger(__name__)

# (overlap, related) cosine thresholds per embedding backend: above
# `overlap`, two chosen topics are the same line of research; above
# `related`, a Saved Focus item is close enough to suggest. The scales
# differ by model. Ollama's nomic-embed-text, measured on short research
# topics (2026-11-11): synonyms ("climate change"/"global warming",
# "roman empire"/"ancient rome", "byzantine empire"/"eastern roman
# empire") 0.72-0.75; related ("roman emperors"/"augustus", "machine
# learning"/"deep learning", "renaissance art"/"italian painters")
# 0.61-0.70; unrelated 0.38-0.54. Its "clustering:" prefix squeezed
# everything upward and separated worse, so it isn't used. Embeddings can't
# know "augustus"/"octavian" are one person (0.65). Gemini's values are
# estimates, not yet measured: no key in local env.json.
THRESHOLDS = {
    "ollama": (0.72, 0.60),
    "gemini": (0.82, 0.68),
}
MAX_RELATED = 4
MAX_TOPICS = 20
MAX_POOL = 80

_CACHE_SIZE = 512
_cache: "OrderedDict[tuple[str, str], list[float]]" = OrderedDict()


def _backend(provider: str | None) -> str:
    return "ollama" if provider == "ollama" else "gemini"


def _embed(text: str, provider: str | None) -> list[float] | None:
    key = (_backend(provider), text.strip().lower())
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    vector = embed_text(text, provider)
    if vector is not None:
        _cache[key] = vector
        if len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return vector


def _clean(items, limit: int) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items if isinstance(items, list) else []:
        text = str(item or "").strip()[:200]
        if text and text.lower() not in seen:
            seen.add(text.lower())
            out.append(text)
    return out[:limit]


def check_focus(keywords, pool, provider: str | None = None) -> dict | None:
    """{"overlaps": [{"a", "b", "similarity"}], "related": [{"topic",
    "near", "similarity"}]}, or None when embeddings are unavailable."""
    topics = _clean(keywords, MAX_TOPICS)
    chosen = {t.lower() for t in topics}
    candidates = [p for p in _clean(pool, MAX_POOL) if p.lower() not in chosen]
    if not topics:
        return {"overlaps": [], "related": []}
    overlap_threshold, related_threshold = THRESHOLDS[_backend(provider)]

    topic_vectors = []
    for topic in topics:
        vector = _embed(topic, provider)
        if vector is None:
            logger.info("focus check: no embedding for %r, skipping", topic)
            return None
        topic_vectors.append(vector)

    overlaps = []
    for i in range(len(topics)):
        for j in range(i + 1, len(topics)):
            sim = cosine_similarity(topic_vectors[i], topic_vectors[j])
            if sim >= overlap_threshold:
                overlaps.append({"a": topics[i], "b": topics[j], "similarity": round(sim, 3)})
    overlaps.sort(key=lambda o: o["similarity"], reverse=True)

    related = []
    for candidate in candidates:
        vector = _embed(candidate, provider)
        if vector is None:
            continue
        best_sim, best_topic = max(
            (cosine_similarity(vector, tv), topic) for tv, topic in zip(topic_vectors, topics)
        )
        if best_sim >= related_threshold:
            related.append({"topic": candidate, "near": best_topic, "similarity": round(best_sim, 3)})
    related.sort(key=lambda r: r["similarity"], reverse=True)

    return {"overlaps": overlaps, "related": related[:MAX_RELATED]}
