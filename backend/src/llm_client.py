"""
Shared LLM client: cascades across configured providers so a cloud outage,
exhausted quota, or missing key doesn't take the agent down, and so local-only
development (zero API cost) is a one-line env change.

Mirrors ChattyPrayers.Api's LlmCascadeService pattern: try providers in
priority order, log every failure (so silent fallbacks stay visible), fall
through to the next on any error.

Order: Gemini (cheap, cloud) -> Cloudflare Workers AI (hosted Qwen, free
daily allowance, works from the droplet) -> Ollama (free, local-only, must be running on
the same machine as the caller — this only ever succeeds for `sam local` /
`backend/server.py` dev, never a deployed Lambda, which cannot reach a
developer's localhost).

Env vars:
  GEMINI_API_KEY   - required to use Gemini at all; if unset, Gemini is skipped
  OLLAMA_BASE_URL  - default http://localhost:11434/v1
  OLLAMA_MODEL     - default qwen3:8b (thinking turned off below). On the
                     Augustus team test it planned and ran a 3-worker team and
                     wrote the report; qwen2.5-coder:7b never delegated.
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
                   - both required to use Workers AI; if either is unset it is
                     skipped (the same pair tools.py's image cascade uses)
  CLOUDFLARE_MODELS - comma-separated Workers AI chat models offered in the
                     Setup picker; the first is the cascade default
  DISABLE_OLLAMA   - "1" drops Ollama from the cascade and the model list, so
                     a dev machine with Ollama installed runs exactly the
                     providers the droplet does (production parity)
  LLM_PROVIDER     - "gemini", "cloudflare" or "ollama" to force a single provider instead of
                     cascading (e.g. LLM_PROVIDER=ollama for offline/no-cost dev)
  CHATTY_GATEWAY_URL - the ChattyPrayers AI gateway (e.g. http://localhost:5131 or
                     https://<gateway host>). When set, chat calls go through its
                     OpenAI-compatible endpoint first; the gateway picks the
                     provider (Cloudflare first by default) and counts the call on
                     its dashboard. If it is unreachable or errors, calls fall back
                     to the direct free providers below (local Ollama, then
                     Workers AI) and gateway_status() reports the problem.
                     Unset = the direct cascade only, as before.
  CHATTY_GATEWAY_KEY - this app's Gateway:ApiKeys key. Not needed against a
                     gateway running locally in Development.
  CHATTY_GATEWAY_POLICY - gateway policy when no provider is chosen (default
                     "cloudflare"; also "free", "auto", "quality")
"""
import logging
import os
import requests
from openai import OpenAI
import run_trace

logger = logging.getLogger(__name__)

GEMINI_MODEL = "gemini-3.6-flash"
# Served from the same OpenAI-compat base_url as chat completions
# (https://ai.google.dev/gemini-api/docs/openai) — used by embeddings.py for
# bootstrap-grounding RAG (CLAUDE.md priority 5). Kept as a separate constant
# from GEMINI_MODEL since it's a different model family (embedding, not chat).
GEMINI_EMBED_MODEL = "gemini-embedding-2-preview"
# Also served from the OpenAI-compat surface via chat.completions.create(...,
# modalities=["text", "image"]) — used by tools.py's generate_image primitive.
# No Ollama equivalent exists to cascade to; tools.py falls back to Hugging
# Face's free-tier Inference API (HF_API_TOKEN) instead when this isn't
# configured or fails.
GEMINI_IMAGE_MODEL = "gemini-3.6-flash-image"
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:8b")
# Ollama's own runtime default (4096, confirmed live via /api/ps) is easily
# blown by this app's own prompt overhead alone — bootstrap system prompt +
# MCP catalog + tool schemas + few-shot grounding examples — before a single
# turn of real conversation history is added. Once a chat session grows past
# that budget, Ollama silently truncates rather than erroring, and the model
# starts answering a mangled/incomplete prompt instead of the real one —
# observed live as the exact same generic non-answer ("I don't have specific
# data yet...") coming back for every message regardless of what was asked.
# 8192 doubles the budget within this machine's ~2GB of free VRAM headroom
# (confirmed via nvidia-smi) without risking an OOM reload.
OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "8192"))
# Cloudflare Workers AI, through its OpenAI-compatible endpoint. Both Qwen
# models here call tools, stream with usage and write Mermaid (checked live
# 2026-11-08). Qwen 3.8 reasons at "xhigh" by default and rejects "none", so
# calls default to "low" below. Workers AI has 10,000 free neurons a day per
# account; past that calls fail and the cascade moves on.
CLOUDFLARE_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
CLOUDFLARE_MODELS = [
    m.strip() for m in os.environ.get(
        "CLOUDFLARE_MODELS", "@cf/qwen/qwen3.8-27b"
    ).split(",") if m.strip()
]
CLOUDFLARE_MODEL = CLOUDFLARE_MODELS[0] if CLOUDFLARE_MODELS else "@cf/qwen/qwen3.8-27b"


def ollama_enabled() -> bool:
    return os.environ.get("DISABLE_OLLAMA", "").strip().lower() not in ("1", "true", "yes")


def cloudflare_configured() -> bool:
    return bool(os.environ.get("CLOUDFLARE_ACCOUNT_ID") and os.environ.get("CLOUDFLARE_API_TOKEN"))


# Once Workers AI says the daily free allocation is used up (429, code
# 4006), every further call fails the same way until 00:00 UTC. Remember
# that per process and skip it, rather than paying a round trip and an
# error on every call.
_cf_exhausted_until = 0.0


def _note_cloudflare_error(e: Exception) -> None:
    global _cf_exhausted_until
    # str(APIStatusError) is just "Error code: 429"; the 4006 code and the
    # message are in the response body, so check that too.
    text = f"{e} {getattr(e, 'body', '')}"
    response = getattr(e, "response", None)
    if response is not None:
        try:
            text += f" {response.text}"
        except Exception:
            pass
    if "4006" in text or "daily free allocation" in text:
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc)
        reset = (now + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        _cf_exhausted_until = reset.timestamp()
        logger.warning("Workers AI daily allocation used up; skipping it until %s", reset.isoformat())


# Gemini prepaid credits depleted (402) won't recover until someone tops up,
# so after one, skip Gemini for a while instead of paying a failed round trip
# on every call. Retried after the cooldown in case credits were added.
_GEMINI_COOLDOWN_S = 15 * 60
_gemini_skip_until = 0.0


def _note_gemini_error(e: Exception) -> None:
    global _gemini_skip_until
    if getattr(e, "status_code", None) == 402 or "prepayment credits are depleted" in str(e):
        import time
        _gemini_skip_until = time.time() + _GEMINI_COOLDOWN_S
        logger.warning("Gemini credits depleted; skipping it for %d min", _GEMINI_COOLDOWN_S // 60)


def gemini_available() -> bool:
    import time
    return bool(os.environ.get("GEMINI_API_KEY")) and time.time() >= _gemini_skip_until


def cloudflare_available() -> bool:
    import time
    return cloudflare_configured() and time.time() >= _cf_exhausted_until


# Native Ollama API (for /api/tags — model listing isn't part of the OpenAI-compatible surface)
OLLAMA_HOST = OLLAMA_BASE_URL.removesuffix("/v1").removesuffix("/")

# Per-request timeouts (seconds), passed straight to the OpenAI SDK's own
# `timeout=` kwarg (httpx underneath) — without this, a stalled connection to
# either provider hangs on the SDK's own ~10-minute default before this
# cascade even tries the next provider, which is indistinguishable from the
# whole agent turn never returning at all. Gemini is a cloud call over the
# open internet, so a real stall should fail fast and fall through to Ollama
# quickly. Ollama is local generation, which can legitimately take a while
# (especially CPU-only, or with the larger OLLAMA_NUM_CTX above), so it gets
# a much longer allowance — this is a hang guard, not a quality-of-service
# cap on slow-but-working local inference. Both overridable per-deployment.
GEMINI_TIMEOUT_SECONDS = float(os.environ.get("GEMINI_TIMEOUT_SECONDS", "30"))
OLLAMA_TIMEOUT_SECONDS = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "180"))
CLOUDFLARE_TIMEOUT_SECONDS = float(os.environ.get("CLOUDFLARE_TIMEOUT_SECONDS", "90"))
_TIMEOUTS = {
    "gemini": GEMINI_TIMEOUT_SECONDS,
    "cloudflare": CLOUDFLARE_TIMEOUT_SECONDS,
    "ollama": OLLAMA_TIMEOUT_SECONDS,
}

_gemini_client = OpenAI(
    api_key=os.environ.get("GEMINI_API_KEY") or "unset",
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
)
_cloudflare_client = OpenAI(
    api_key=os.environ.get("CLOUDFLARE_API_TOKEN") or "unset",
    base_url=f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID or 'unset'}/ai/v1",
)
_ollama_client = OpenAI(
    api_key="ollama",  # unused by Ollama but required by the OpenAI SDK's constructor
    base_url=OLLAMA_BASE_URL,
)

# --- ChattyPrayers AI gateway -------------------------------------------------
GATEWAY_URL = os.environ.get("CHATTY_GATEWAY_URL", "").strip().rstrip("/")
GATEWAY_POLICY = os.environ.get("CHATTY_GATEWAY_POLICY", "cloudflare").strip() or "cloudflare"
# The gateway runs its own cascade (several providers, each with its own
# timeout), so the overall allowance is long; connecting is not, so an
# unreachable gateway falls back within seconds.
GATEWAY_TIMEOUT_SECONDS = float(os.environ.get("CHATTY_GATEWAY_TIMEOUT_SECONDS", "300"))
# After the gateway fails, go direct for this long before trying it again, so
# every call during an outage doesn't pay a failed round trip first.
_GATEWAY_RETRY_S = 60
_gateway_client = None
if GATEWAY_URL:
    import httpx
    _gateway_client = OpenAI(
        api_key=os.environ.get("CHATTY_GATEWAY_KEY") or "local",
        base_url=f"{GATEWAY_URL}/v1/openai",
        default_headers={"X-App": "AgentOne"},
        timeout=httpx.Timeout(GATEWAY_TIMEOUT_SECONDS, connect=5.0),
        max_retries=0,
    )
_gateway_state = {"ok": None, "error": None, "checked_at": None, "provider": None, "model": None}
_gateway_skip_until = 0.0


def gateway_configured() -> bool:
    return _gateway_client is not None


def gateway_status() -> dict:
    """For the UI banner: is the gateway in use, and did its last call work?
    ok is None until the first call (or a check_gateway() ping)."""
    return {"configured": gateway_configured(), "url": GATEWAY_URL or None, **_gateway_state}


def check_gateway() -> dict:
    """Ping the gateway's /health (free: touches no model) and update the status."""
    if not gateway_configured():
        return gateway_status()
    try:
        requests.get(f"{GATEWAY_URL}/health", timeout=3).raise_for_status()
        # Reachable clears "unreachable", but not a bad key or failing
        # providers: only a real call can show those are fixed.
        if _gateway_state["ok"] is None or (_gateway_state["error"] or "").startswith("unreachable"):
            _set_gateway(True, None)
    except Exception as e:
        logger.info("AI gateway health check failed: %s", e)
        _set_gateway(False, "unreachable")
    return gateway_status()


def _set_gateway(ok: bool, error: str | None, provider: str | None = None, model: str | None = None) -> None:
    import datetime
    import time
    global _gateway_skip_until
    _gateway_state.update(ok=ok, error=error, checked_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    if provider:
        _gateway_state.update(provider=provider, model=model)
    _gateway_skip_until = 0.0 if ok else time.time() + _GATEWAY_RETRY_S


def _gateway_error_text(e: Exception) -> str:
    status = getattr(e, "status_code", None)
    if status == 401:
        return "rejected the API key (set CHATTY_GATEWAY_KEY)"
    if status == 502:
        return "is up, but all of its providers failed"
    if status:
        return f"returned {status}"
    return f"unreachable ({type(e).__name__})"


def _try_gateway(forced: str, model: str | None, kwargs: dict, _meta, trace_kind, trace_label, streamed):
    """One call through the gateway. Returns the response, or None to go direct."""
    import time
    if not gateway_configured() or time.time() < _gateway_skip_until:
        return None
    policy = forced if forced in ("gemini", "cloudflare", "ollama") else GATEWAY_POLICY
    call_kwargs = dict(kwargs)
    if model:
        is_cf = model.startswith("@cf/")
        # Same rule as the direct cascade: a model only applies to its own provider.
        if (forced == "cloudflare" and is_cf) or (forced == "ollama" and not is_cf) or not forced:
            call_kwargs["extra_body"] = {**kwargs.get("extra_body", {}), "gateway_model": model}
    started = run_trace.now_ms()
    try:
        raw = _gateway_client.chat.completions.with_raw_response.create(model=policy, **call_kwargs)
        response = raw.parse()
    except Exception as e:
        reason = _gateway_error_text(e)
        logger.warning("AI gateway %s: %s; going direct to local providers", reason, e)
        _set_gateway(False, reason)
        run_trace.record(trace_kind, trace_label, started, status="error", provider="gateway",
                         model=policy, detail=str(e)[:300])
        if _meta is not None:
            _meta.setdefault("failed", []).append({"provider": "gateway", "model": policy})
        return None
    used = (raw.headers.get("x-gateway-provider") or "gateway").lower()
    used_model = raw.headers.get("x-gateway-model") or policy
    _set_gateway(True, None, used, used_model)
    if not streamed:
        usage = getattr(response, "usage", None)
        run_trace.record(
            trace_kind, trace_label, started, provider=used, model=used_model,
            input_tokens=getattr(usage, "prompt_tokens", None),
            output_tokens=getattr(usage, "completion_tokens", None),
        )
    if _meta is not None:
        _meta["used"] = {"provider": used, "model": used_model, "via": "gateway"}
    return response


# (provider name, client, model) in cascade priority order
_PROVIDERS = [
    ("gemini", _gemini_client, GEMINI_MODEL),
    ("cloudflare", _cloudflare_client, CLOUDFLARE_MODEL),
    ("ollama", _ollama_client, OLLAMA_MODEL),
]


def create_chat_completion(provider: str | None = None, model: str | None = None, _meta: dict | None = None,
                           _trace: str | tuple[str, str] | None = None, **kwargs):
    """
    Drop-in replacement for `client.chat.completions.create(...)`. Do not pass
    `model` as a plain kwarg — use the `model` parameter below instead.

    `provider`, when given ("gemini", "cloudflare" or "ollama"), forces that single provider
    for this call — e.g. a per-agent choice made on the Setup screen and carried
    in AgentConfig. Falls back to the LLM_PROVIDER env var, then the full cascade.

    `model` overrides the default model for whichever provider ends up serving
    the call, when it belongs to that provider: an "@cf/..." name for
    Workers AI, any other name for Ollama (e.g. qwen2.5-coder instead of the
    OLLAMA_MODEL default). Gemini's model is fixed.

    `_meta`, when given, is populated in place with which provider actually
    served the call (or attempted to) so a caller can report it to the user —
    e.g. bootstrap.py's streaming progress feed. Optional and backward
    compatible: existing callers that don't pass it see no change in behaviour.
      _meta["used"]   = {"provider": ..., "model": ...} on success, None if every
                        provider failed
      _meta["failed"] = [{"provider": ..., "model": ...}, ...] for every
                        provider that was tried and failed before either a
                        success or total failure

    `_trace` labels this call in the run trace (run_trace.py): a label
    string (kind "llm"), or a (kind, label) tuple, e.g. ("check", "Scope
    guard"). Every attempt is recorded as a span, including failed cascade
    attempts. Streamed calls aren't recorded here (only time-to-first-byte is
    known at this point), so their callers time them themselves.

    Raises RuntimeError only if every eligible provider fails.
    """
    trace_kind, trace_label = _trace if isinstance(_trace, tuple) else ("llm", _trace or "Model call")
    streamed = bool(kwargs.get("stream"))
    forced = (provider or os.environ.get("LLM_PROVIDER", "")).strip().lower()
    providers = [p for p in _PROVIDERS if p[0] == forced] if forced else _PROVIDERS
    # A browser can keep "gemini" saved in Settings after the key is removed
    # (local dev has none; production turned it off). Forcing it then failed
    # every call — the Setup Brief silently fell back to its template, with
    # no output buttons. Fall back to the rest of the cascade instead
    # (Workers AI if configured, then Ollama).
    if forced == "gemini" and not os.environ.get("GEMINI_API_KEY"):
        logger.warning("gemini requested but GEMINI_API_KEY not set; using the rest of the cascade")
        providers = [p for p in _PROVIDERS if p[0] != "gemini"]
    # A browser can also keep "ollama" saved from local dev; with Ollama off,
    # use the rest of the cascade.
    if forced == "ollama" and not ollama_enabled():
        logger.warning("ollama requested but DISABLE_OLLAMA is set; using the cascade")
        providers = [p for p in _PROVIDERS if p[0] != "ollama"]
    # A "cloudflare" choice falls back to free local Ollama when Workers AI
    # fails (daily allocation used up, outage) or isn't configured, instead
    # of failing the whole call. Never on to Gemini: that can cost money.
    if forced == "cloudflare":
        providers = [p for p in _PROVIDERS if p[0] in ("cloudflare", "ollama")]
    # A "gemini" choice falls back to the free providers when the call fails
    # (prepaid credits depleted -> 402, quota -> 429, outage), instead of
    # failing every bootstrap and chat turn: Workers AI, then Ollama.
    elif forced == "gemini" and os.environ.get("GEMINI_API_KEY"):
        providers = _PROVIDERS
    # An "ollama" choice falls back to Workers AI (also free) if the local
    # server is down. Never on to Gemini: that can cost money.
    elif forced == "ollama" and ollama_enabled():
        providers = [p for p in _PROVIDERS if p[0] in ("ollama", "cloudflare")]
        providers.sort(key=lambda p: p[0] != "ollama")

    if gateway_configured():
        response = _try_gateway(forced, model, kwargs, _meta, trace_kind, trace_label, streamed)
        if response is not None:
            return response
        # Gateway down or failing: fall back to the free providers only (local
        # Ollama, then Workers AI), never straight to a paid one.
        if ollama_enabled() or cloudflare_configured():
            providers = [p for p in _PROVIDERS if p[0] in ("ollama", "cloudflare")]
            providers.sort(key=lambda p: p[0] != "ollama")

    last_error = None
    for name, client, default_model in providers:
        if name == "gemini" and not gemini_available():
            logger.info("Skipping gemini: GEMINI_API_KEY not set, or credits depleted")
            continue
        if name == "ollama" and not ollama_enabled():
            continue
        if name == "cloudflare" and not cloudflare_available():
            logger.info("Skipping cloudflare: not configured, or daily allocation used up")
            continue
        is_cf_model = bool(model) and model.startswith("@cf/")
        if name == "ollama" and model and not is_cf_model:
            use_model = model
        elif name == "cloudflare" and is_cf_model:
            use_model = model
        else:
            use_model = default_model
        call_kwargs = kwargs
        if name == "cloudflare" and use_model and "qwen3.8" in use_model:
            # xhigh by default (slow, burns the free allowance); "none" is
            # rejected for this model.
            call_kwargs = {**kwargs}
            if 0 < (kwargs.get("max_tokens") or 0) <= 1000 and "reasoning_effort" not in kwargs:
                # Even "low" spends a small budget entirely on reasoning and
                # returns no content; this switches thinking off (checked live
                # 2026-11-23). Big calls (design, replies) keep reasoning low.
                extra_body = {**kwargs.get("extra_body", {})}
                extra_body.setdefault("chat_template_kwargs", {"enable_thinking": False})
                call_kwargs["extra_body"] = extra_body
            else:
                call_kwargs.setdefault("reasoning_effort", "low")
        elif name == "cloudflare" and use_model and "qwen3" in use_model and (kwargs.get("max_tokens") or 0) <= 1000:
            # Qwen3-30B thinks by default and ignores reasoning_effort, so a
            # small-budget call (route suggestions, self-checks) spends every
            # token thinking and returns no content. Its "/no_think" tag is
            # the switch that works; big calls (design, replies) keep thinking.
            msgs = list(kwargs.get("messages") or [])
            for idx in range(len(msgs) - 1, -1, -1):
                m = msgs[idx]
                if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                    msgs[idx] = {**m, "content": m["content"] + " /no_think"}
                    call_kwargs = {**kwargs, "messages": msgs}
                    break
        if name == "ollama":
            # Ollama-only: extra_body passes through to its native /api/chat
            # `options`, not part of the OpenAI-compat schema Gemini expects.
            extra_body = {**kwargs.get("extra_body", {})}
            extra_body.setdefault("options", {}).setdefault("num_ctx", OLLAMA_NUM_CTX)
            call_kwargs = {**kwargs, "extra_body": extra_body}
            # qwen3 thinks by default: over the OpenAI-compat API the answer
            # lands in `reasoning`, `content` comes back empty, and each call
            # takes ~8x longer. Turn thinking off unless the caller asked.
            if use_model and use_model.startswith("qwen3"):
                call_kwargs.setdefault("reasoning_effort", "none")
        started = run_trace.now_ms()
        try:
            response = client.chat.completions.create(
                model=use_model, timeout=_TIMEOUTS[name], **call_kwargs
            )
            if not streamed:
                usage = getattr(response, "usage", None)
                run_trace.record(
                    trace_kind, trace_label, started, provider=name, model=use_model,
                    input_tokens=getattr(usage, "prompt_tokens", None),
                    output_tokens=getattr(usage, "completion_tokens", None),
                )
            if last_error is not None:
                logger.warning("LLM provider %s failed (%s); fell back to %s", last_error[0], last_error[1], name)
            if _meta is not None:
                _meta["used"] = {"provider": name, "model": use_model}
            return response
        except Exception as e:
            logger.warning("LLM provider %s (%s) failed: %s", name, use_model, e)
            if name == "cloudflare":
                _note_cloudflare_error(e)
            if name == "gemini":
                _note_gemini_error(e)
            run_trace.record(
                trace_kind, trace_label, started, status="error", provider=name,
                model=use_model, detail=str(e)[:300],
            )
            if _meta is not None:
                _meta.setdefault("failed", []).append({"provider": name, "model": use_model})
            last_error = (name, e)

    if _meta is not None:
        _meta["used"] = None
    raise RuntimeError(f"All LLM providers failed. Last error: {last_error}")


def list_ollama_models() -> list[str]:
    """
    Names of models currently pulled in the local Ollama install (via its
    native /api/tags — the OpenAI-compatible surface has no listing endpoint).
    Returns [] on any failure (Ollama not running, unreachable, etc.) rather
    than raising — the Setup screen just shows an empty picker in that case,
    since this only ever matters for local dev in the first place.
    """
    if not ollama_enabled():
        return []
    try:
        resp = requests.get(f"{OLLAMA_HOST}/api/tags", timeout=3)
        resp.raise_for_status()
        # /api/tags lists every pulled model, including embedding-only ones
        # (this project's own nomic-embed-text among them) that 400 on a
        # chat completion call. This list only ever feeds the Setup screen's
        # chat-model picker, so those are filtered out here rather than left
        # for the picker to stumble into.
        return sorted(
            m["name"] for m in resp.json().get("models", [])
            if "embed" not in m["name"].lower()
        )
    except Exception as e:
        logger.info("Could not list Ollama models: %s", e)
        return []
