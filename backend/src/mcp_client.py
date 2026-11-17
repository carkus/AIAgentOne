"""
Sync wrapper around the official `mcp` Python SDK, so the rest of this
codebase (Flask, bootstrap.py, agent_stream.py — all synchronous) can talk to
a vetted MCP server (mcp_registry.py) without becoming async itself.

Two transports, picked per-server by `_session_cm` based on
mcp_registry.py's "transport" field:

- "stdio" — spawns the server as a subprocess, does the MCP handshake, and
  tears it down per call — simple and correct rather than maximally fast,
  matching the "first scaffold, deliberately kept small" scope this mirrors
  from orchestrator.py. Tool calls are already LLM/network-latency bound, so
  a server's ~1s stdio startup is not the bottleneck.
- "http" — opens a Streamable HTTP session to a remote MCP server (e.g.
  Tavily's own hosted server) instead of spawning anything locally.

Both yield the same (read, write, ...) stream tuple shape from the SDK, so
everything past `_session_cm` is transport-agnostic. list_tools() results ARE
cached per server for the life of the process, since a reference server's
tool catalog doesn't change at runtime — this avoids re-spawning/re-hitting a
server on every single bootstrap call just to re-read the same schema.

Every public function degrades to "this server/tool isn't available" rather
than raising: an uninstalled, unreachable, or crashing vetted server should
shrink the catalog bootstrap sees, not break bootstrap or the agent loop.
"""
import asyncio
import concurrent.futures
import json
import logging
import os
import re
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from mcp_registry import MCP_SERVERS, WEB_SEARCH_PROVIDERS

logger = logging.getLogger(__name__)

_catalog_cache: dict[str, list[dict]] = {}
# server_id -> monotonic time of its last failed listing. A server that
# failed isn't retried for _FAILURE_RETRY_SECONDS: without this, every
# catalog_summary() call (several per bootstrap, one bootstrap per worker)
# respawned the failing server and waited for it again, ~4-5s each time.
_failed_at: dict[str, float] = {}
_FAILURE_RETRY_SECONDS = 300

# server_id -> monotonic time a call last came back "plan/usage limit
# reached" (Tavily's monthly credits). While set, the server is left out of
# the catalog (bootstrap, the agent's auto-added tavily_search, the brief) and
# calls fail at once, so agents stop spending rounds on a search that can only
# fail. Retried after QUOTA_RETRY_SECONDS, since the reset date depends on the
# account's billing cycle; a refused call costs no credits.
# A rate limit (too many calls a minute, e.g. Exa's keyless endpoint) gets a
# short pause instead.
_paused_until: dict[str, float] = {}
QUOTA_RETRY_SECONDS = float(os.environ.get("MCP_QUOTA_RETRY_SECONDS", "3600"))
RATE_LIMIT_PAUSE_SECONDS = 60
_QUOTA_RE = re.compile(
    r"\b432\b|usage limit|plan limit|exceeds your plan|quota|out of credits|insufficient credits",
    re.IGNORECASE,
)
_RATE_RE = re.compile(r"\b429\b|rate.?limit|too many requests", re.IGNORECASE)


def quota_exhausted(server_id: str) -> bool:
    until = _paused_until.get(server_id)
    return until is not None and time.monotonic() < until


def note_error(server_id: str, error: object) -> bool:
    """Pause `server_id` if `error` reads as a usage-limit (or rate-limit)
    refusal. Returns True when it did. Also used by tools.py's direct Tavily
    image search. Remote ("http") servers only: a stdio server like fetch
    can echo a fetched site's own "quota exceeded" page, which isn't its
    own limit."""
    if MCP_SERVERS.get(server_id, {}).get("transport") != "http":
        return False
    text = str(error)
    if _QUOTA_RE.search(text):
        seconds, why = QUOTA_RETRY_SECONDS, "usage limit"
    elif _RATE_RE.search(text):
        seconds, why = RATE_LIMIT_PAUSE_SECONDS, "rate limit"
    else:
        return False
    if not quota_exhausted(server_id):
        logger.warning(
            "MCP server '%s' hit its %s; pausing it for %ds: %s",
            server_id, why, seconds, text[:200],
        )
    _paused_until[server_id] = max(_paused_until.get(server_id, 0), time.monotonic() + seconds)
    return True

# Neither the stdio subprocess round trip nor the Streamable HTTP session has
# any timeout of its own — a vetted server that hangs (crashed subprocess
# still holding the pipe open, a remote server like Tavily's stalling mid-
# response) previously blocked this synchronous call, and therefore the whole
# agent loop that called it, forever. Per the module docstring, stdio startup
# is ~1s and a real tool call is LLM/network-latency bound, not slow by
# design, so this is a generous hang guard rather than a tight budget.
MCP_CALL_TIMEOUT_SECONDS = float(os.environ.get("MCP_CALL_TIMEOUT_SECONDS", "25"))

# _run() used to enforce MCP_CALL_TIMEOUT_SECONDS with a bare
# `asyncio.wait_for(coro, timeout=...)` inside `asyncio.run(...)`. That bounds
# how long the *coroutine* is awaited, but wait_for's timeout only requests
# cancellation — it doesn't guarantee the cancelled task actually unwinds. If
# a stdio subprocess (mcp_server_time/mcp_server_fetch) is wedged holding its
# pipe open, the cancelled task can sit forever at a blocking pipe read that
# never observes the CancelledError, and `asyncio.run()` then hangs in its own
# internal shutdown (`_cancel_all_tasks`) waiting for that task to finish —
# before `list_tools()`'s `try/except` ever gets a chance to catch anything.
# This surfaced as bootstrap hanging indefinitely on the very first "Thinking
# about your purpose…" status, well past the supposed 25s budget, with
# nothing else printed. Running the whole `asyncio.run(coro)` call in a worker
# thread and bounding it with `future.result(timeout=...)` fixes this: even if
# the background thread never returns, the calling thread stops waiting on
# schedule. The abandoned thread (and its wedged subprocess) leaks rather than
# blocking forever — an acceptable trade for a rare hang case.
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="mcp-call")


def _session_cm(server_id: str):
    """The right async context manager for this server's transport — callers
    just do `async with _session_cm(server_id) as streams:` and use
    streams[0]/streams[1] as (read, write), ignoring any extra items (the
    HTTP transport's session-id callback)."""
    spec = MCP_SERVERS[server_id]
    if spec.get("transport") == "http":
        return streamable_http_client(spec["url"])
    return stdio_client(StdioServerParameters(command=spec["command"], args=spec["args"]))


def _run(coro):
    """Run an async MCP call from sync code, hard-bounded by
    MCP_CALL_TIMEOUT_SECONDS so a hung server surfaces as a fast, catchable
    error instead of blocking the calling thread (and the whole synchronous
    bootstrap/agent loop above it) indefinitely. A fresh event loop per call
    is simplest and safe here — these are one-shot request/response calls,
    never long-lived, so there's no state to keep alive across calls.

    The timeout is enforced from *outside* the event loop (see module
    comment above `_executor`) rather than via `asyncio.wait_for` alone,
    since a wedged subprocess pipe can prevent that cancellation from ever
    completing."""
    future = _executor.submit(asyncio.run, coro)
    try:
        return future.result(timeout=MCP_CALL_TIMEOUT_SECONDS)
    except concurrent.futures.TimeoutError:
        raise TimeoutError(
            f"MCP call did not complete within {MCP_CALL_TIMEOUT_SECONDS}s (server may be hung)"
        )


async def _list_tools_async(server_id: str) -> list[dict]:
    async with _session_cm(server_id) as streams:
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            result = await session.list_tools()
            only = MCP_SERVERS[server_id].get("tools")
            return [
                {
                    "server_id": server_id,
                    "tool_name": t.name,
                    "description": t.description or "",
                    "input_schema": _field(t, "input_schema", "inputSchema") or {"type": "object", "properties": {}},
                }
                for t in result.tools
                if not only or t.name in only
            ]


def _field(obj, *names):
    """First attribute present among `names`. The mcp SDK renamed its
    camelCase fields to snake_case in 2.x (inputSchema -> input_schema,
    isError -> is_error); requirements.txt doesn't pin a major version, so
    read either spelling."""
    for name in names:
        value = getattr(obj, name, None)
        if value is not None:
            return value
    return None


async def _call_tool_async(server_id: str, tool_name: str, inputs: dict):
    async with _session_cm(server_id) as streams:
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, inputs)
            return _unpack_result(result)


def _unpack_result(result) -> object:
    """MCP tool results come back as a list of content blocks (usually
    TextContent). Flatten to a single string when it's all text — the common
    case — falling back to a list of best-effort dicts for anything else, so
    json.dumps(default=str) in agent_stream.py always has something sane."""
    blocks = getattr(result, "content", None) or []
    texts = [b.text for b in blocks if getattr(b, "type", None) == "text" and hasattr(b, "text")]
    if texts and len(texts) == len(blocks):
        text = "\n".join(texts)
        if _field(result, "is_error", "isError"):
            return {"error": text}
        return text
    parts = []
    for b in blocks:
        if hasattr(b, "model_dump"):
            parts.append(b.model_dump())
        else:
            parts.append(str(b))
    if _field(result, "is_error", "isError"):
        return {"error": parts}
    return parts


def _describe_exception(e: BaseException) -> str:
    """anyio's TaskGroup (used by both transports' async context managers)
    wraps whatever actually failed in an ExceptionGroup, so a bare str(e) on
    the outer exception is just the uninformative "unhandled errors in a
    TaskGroup (1 sub-exception)" — the real cause (a connection reset, a 401
    from Tavily, a DNS failure) is one level down in `.exceptions` and was
    previously discarded entirely. Recurses since a TaskGroup can itself
    raise a TaskGroup (nested cancel scopes)."""
    if isinstance(e, BaseExceptionGroup):
        inner = [_describe_exception(sub) for sub in e.exceptions]
        return "; ".join(inner) if inner else str(e)
    return f"{type(e).__name__}: {e}"


def list_tools(server_id: str) -> list[dict]:
    """Real tool schemas from a running vetted server — cached after first
    success. Returns [] if the server isn't installed/reachable, logged but
    not raised. [] while the server is paused at its usage limit."""
    if quota_exhausted(server_id):
        return []
    if server_id in _catalog_cache:
        return _catalog_cache[server_id]
    if server_id not in MCP_SERVERS:
        return []
    failed_at = _failed_at.get(server_id)
    if failed_at is not None and time.monotonic() - failed_at < _FAILURE_RETRY_SECONDS:
        return []
    try:
        tools = _run(_list_tools_async(server_id))
        _catalog_cache[server_id] = tools
        _failed_at.pop(server_id, None)
        return tools
    except Exception as e:
        _failed_at[server_id] = time.monotonic()
        logger.warning(
            "MCP server '%s' unavailable, omitting from catalog: %s",
            server_id, _describe_exception(e), exc_info=True,
        )
        return []


def catalog_summary() -> list[dict]:
    """[{server_id, tool_name, description, input_schema}, ...] across every
    registered server that's actually reachable right now. Used by
    bootstrap.py to ground the prompt in real tools, and to validate/resolve
    a model's "source": "mcp" tool picks."""
    catalog = []
    for server_id in MCP_SERVERS:
        catalog.extend(list_tools(server_id))
    return catalog


def call_tool(server_id: str, tool_name: str, inputs: dict) -> dict:
    if quota_exhausted(server_id):
        return {"error": f"{server_id}.{tool_name} is unavailable: its usage limit has been reached. Use other tools or your own knowledge."}
    try:
        result = _run(_call_tool_async(server_id, tool_name, inputs))
    except Exception as e:
        description = _describe_exception(e)
        logger.warning(
            "MCP call to %s.%s failed: %s", server_id, tool_name, description, exc_info=True,
        )
        note_error(server_id, description)
        return {"error": f"MCP call to {server_id}.{tool_name} failed: {description}"}
    if isinstance(result, dict) and result.get("error"):
        note_error(server_id, result["error"])
    return result


# ---- Web search: Tavily first, then Exa (mcp_registry.WEB_SEARCH_PROVIDERS)


def active_web_search() -> dict | None:
    """The provider agents, bootstrap and the brief should search with now:
    the first in WEB_SEARCH_PROVIDERS that's registered, not paused at a
    limit, and actually lists its search tool. Its registry entry plus the
    tool's real description/input_schema, or None when there's no web
    search at all."""
    for p in WEB_SEARCH_PROVIDERS:
        if p["server_id"] not in MCP_SERVERS or quota_exhausted(p["server_id"]):
            continue
        real = next((c for c in list_tools(p["server_id"]) if c["tool_name"] == p["tool"]), None)
        if real:
            return {**p, "description": real["description"], "input_schema": real["input_schema"]}
    return None


def web_search_provider(server_id: str | None, tool: str | None) -> dict | None:
    """The WEB_SEARCH_PROVIDERS entry for this MCP tool, if it is one."""
    return next((p for p in WEB_SEARCH_PROVIDERS if p["server_id"] == server_id and p["tool"] == tool), None)


def web_search_status() -> dict:
    """For the UI: the provider in use now and any paused at a limit."""
    active = active_web_search()
    return {
        "active": active["label"] if active else None,
        "paused": [p["label"] for p in WEB_SEARCH_PROVIDERS
                   if p["server_id"] in MCP_SERVERS and quota_exhausted(p["server_id"])],
    }


def call_web_search(server_id: str, tool_name: str, inputs: dict):
    """call_tool for a web search tool, falling back mid-turn: if the call
    fails because this provider just hit (or is paused at) its limit, the
    same query goes to the next usable provider."""
    result = call_tool(server_id, tool_name, inputs)
    if not (isinstance(result, dict) and result.get("error")) or not quota_exhausted(server_id):
        return result
    fallback = active_web_search()
    query = str((inputs or {}).get("query") or "").strip()
    if not fallback or not query:
        return result
    try:
        n = int((inputs or {}).get("max_results") or (inputs or {}).get("numResults") or 5)
    except (TypeError, ValueError):
        n = 5
    logger.info("web search: %s unavailable, using %s", server_id, fallback["label"])
    return call_tool(fallback["server_id"], fallback["tool"], fallback["args"](query, max(1, min(n, 10))))


def _parse_search_results(reply) -> list[dict]:
    """[{title, content}] from either provider's reply: Tavily's JSON
    ({"results": [...]}) or Exa's text blocks ("Title: ...", "URL: ...",
    "Highlights: ...")."""
    data = reply
    if isinstance(reply, str):
        try:
            data = json.loads(reply)
        except ValueError:
            data = None
    if isinstance(data, dict):
        return [{"title": r.get("title"), "content": r.get("content")} for r in (data.get("results") or [])]
    if not isinstance(reply, str):
        return []
    out = []
    for block in re.split(r"(?m)^Title:\s*", reply)[1:]:
        title, _, rest = block.partition("\n")
        body = rest.split("Highlights:", 1)[1] if "Highlights:" in rest else rest
        body = re.sub(r"(?m)^(URL|Published|Author|Text):.*$", "", body)
        out.append({"title": title.strip(), "content": body.strip()})
    return out


def web_search(query: str, n: int = 5) -> tuple[str | None, list[dict]]:
    """One search on the active provider (falling back on a limit): its
    label and [{title, content}]. Raises RuntimeError on failure."""
    provider = active_web_search()
    if not provider:
        raise RuntimeError("no web search available")
    reply = call_web_search(provider["server_id"], provider["tool"], provider["args"](query, n))
    if isinstance(reply, dict) and reply.get("error"):
        raise RuntimeError(reply["error"])
    used = active_web_search() or provider
    return used["label"], _parse_search_results(reply)
