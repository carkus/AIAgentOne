"""
Tool quality, before and during a run (the tool-selection flow):

Bootstrap, after the model designs the tools:
- fold_guidance()   structured tool definitions: each generated tool's
                    use_when / do_not_use_when / returns are folded into its
                    description, the text the agent reads when choosing a tool.
- find_overlaps()   drops a generated tool that duplicates a built-in
                    primitive, a chosen MCP tool or another generated tool
                    (embeddings when available, word overlap otherwise).
- smoke_test()      runs each generated tool once in the sandbox on its own
                    example inputs. A failure that is the code's fault joins
                    bootstrap's existing one-retry/then-drop flow; a network
                    or remote failure is "inconclusive" and the tool is kept.

Agent loop, around each tool call:
- check_arguments() checks the model's arguments against the tool's schema
                    (required fields, types, enums), fixing harmless mismatches
                    ("5" for an integer); anything else is rejected before
                    the tool runs, with the expected arguments in the error.
- add_hint()        adds a "what to do next" line to a failed result, so the
                    model can recover instead of repeating the call.

Everything here is best-effort and deterministic apart from the optional
embedding calls; nothing raises to the caller.
"""
import concurrent.futures
import difflib
import json
import logging
import re

logger = logging.getLogger(__name__)

# Short summaries of the built-in primitives, for the overlap check only.
_PRIMITIVE_SUMMARIES = {
    "fetch_page": "Fetch a web page by URL and return its readable text content.",
    "search_jobs": "Search live job listings by job title and location.",
    "search_image": "Search the web for an existing image matching a query and return its URL.",
    "generate_image": "Generate a new image from a text prompt.",
}

_GUIDANCE_FIELDS = (
    ("use_when", "Use when"),
    ("do_not_use_when", "Do not use when"),
    ("returns", "Returns"),
)


def _generated(config: dict) -> list[dict]:
    return [
        t for t in (config.get("tools") or [])
        if isinstance(t, dict) and t.get("source") != "mcp" and isinstance(t.get("implementation"), str)
    ]


# ---------------------------------------------------------------------------
# Structured definitions
# ---------------------------------------------------------------------------

def fold_guidance(config: dict) -> list[str]:
    """Folds use_when / do_not_use_when / returns into each generated tool's
    description (and removes the separate keys, so a second pass changes
    nothing). Returns the names of tools that left any of them out."""
    missing: list[str] = []
    for tool in _generated(config):
        parts = []
        had_all = True
        for key, label in _GUIDANCE_FIELDS:
            value = tool.pop(key, None)
            if isinstance(value, list):
                value = "; ".join(str(v) for v in value if v)
            if isinstance(value, str) and value.strip():
                parts.append(f"{label}: {value.strip()}")
            else:
                had_all = False
        if parts:
            base = str(tool.get("description") or "").rstrip()
            tool["description"] = (base + "\n" if base else "") + "\n".join(parts)
        if not had_all:
            missing.append(str(tool.get("name") or "?"))
    return missing


# ---------------------------------------------------------------------------
# Overlap check
# ---------------------------------------------------------------------------

# Per embedding backend: cosine at or above this is "the same tool". Higher
# than focus_insights' topic thresholds, since tool descriptions share a lot
# of generic wording ("returns", "query", "results").
_EMBED_THRESHOLDS = {"ollama": 0.88, "gemini": 0.92}
_NAME_RATIO = 0.88
_WORD_JACCARD = 0.6
_STOPWORDS = frozenset(
    "the a an and or of for to in on with by from this that tool tools returns return "
    "given use using into its it is are be as at any each list text data get".split()
)
_embed_cache: dict[tuple[str, str], list[float] | None] = {}


def _backend(provider: str | None) -> str:
    return "ollama" if provider == "ollama" else "gemini"


def _tool_text(name: str, description: str) -> str:
    return f"{name.replace('_', ' ')}: {description}".strip()[:600]


def _stem(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def _words(name: str, text: str) -> set[str]:
    tokens = re.findall(r"[a-z]{3,}", (name.replace("_", " ") + " " + text).lower())
    return {_stem(w) for w in tokens if w not in _STOPWORDS}


def _lexical_similarity(a: tuple[str, str], b: tuple[str, str]) -> float:
    """Name tokens equal (word_count / count_words), names nearly identical,
    or most of the meaningful words shared. 0.0 when none of these hold."""
    name_a = {_stem(w) for w in a[0].lower().split("_") if w}
    name_b = {_stem(w) for w in b[0].lower().split("_") if w}
    if name_a and name_a == name_b:
        return 1.0
    name_ratio = difflib.SequenceMatcher(None, a[0].lower(), b[0].lower()).ratio()
    if name_ratio >= _NAME_RATIO:
        return name_ratio
    wa, wb = _words(*a), _words(*b)
    jaccard = len(wa & wb) / len(wa | wb) if len(wa) >= 3 and len(wb) >= 3 else 0.0
    return jaccard if jaccard >= _WORD_JACCARD else 0.0


def _embed(text: str, provider: str | None):
    key = (_backend(provider), text)
    if key not in _embed_cache:
        try:
            from embeddings import embed_text
            _embed_cache[key] = embed_text(text, provider)
        except Exception as e:
            logger.info("overlap check: embedding failed: %s", e)
            _embed_cache[key] = None
        if len(_embed_cache) > 512:
            _embed_cache.pop(next(iter(_embed_cache)))
    return _embed_cache[key]


def find_overlaps(config: dict, provider: str | None = None, use_embeddings: bool = True) -> list[dict]:
    """Drops generated tools that duplicate something the agent already has.
    Built-in primitives and chosen MCP tools always win over a generated
    tool; between two generated tools the first one is kept. Returns
    [{"dropped", "kept", "similarity", "method"}]."""
    generated = _generated(config)
    if not generated:
        return []
    refs: list[tuple[str, str]] = list(_PRIMITIVE_SUMMARIES.items())
    for t in config.get("tools") or []:
        if isinstance(t, dict) and t.get("source") == "mcp":
            refs.append((str(t.get("name") or t.get("mcp_tool") or "?"), str(t.get("description") or "")[:400]))

    all_items = refs + [(str(t.get("name") or "?"), str(t.get("description") or "")) for t in generated]
    vectors = None
    if use_embeddings:
        vecs = []
        for n, d in all_items:
            v = _embed(_tool_text(n, d), provider)
            if v is None:  # one failure means no backend: don't wait on the rest
                break
            vecs.append(v)
        if len(vecs) == len(all_items):
            vectors = dict(zip([n for n, _ in all_items], vecs))

    from embeddings import cosine_similarity
    threshold = _EMBED_THRESHOLDS[_backend(provider)]
    kept: list[tuple[str, str]] = list(refs)
    drops: list[dict] = []
    drop_names: set[str] = set()
    for t in generated:
        item = (str(t.get("name") or "?"), str(t.get("description") or ""))
        best = None
        for other in kept:
            if other[0] == item[0]:
                continue
            if vectors is not None:
                sim, method = cosine_similarity(vectors[item[0]], vectors[other[0]]), "embedding"
                hit = sim >= threshold
            else:
                sim, method = _lexical_similarity(item, other), "words"
                hit = sim > 0
            if hit and (best is None or sim > best["similarity"]):
                best = {"dropped": item[0], "kept": other[0], "similarity": round(sim, 3), "method": method}
        if best:
            drops.append(best)
            drop_names.add(item[0])
        else:
            kept.append(item)
    if drop_names:
        config["tools"] = [
            t for t in config.get("tools") or []
            if not (isinstance(t, dict) and t.get("source") != "mcp" and t.get("name") in drop_names)
        ]
    return drops


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

SMOKE_TIMEOUT_SECONDS = 12.0
SMOKE_HTTP_TIMEOUT_SECONDS = 8.0

# The code's fault whatever the input is.
_ALWAYS_BUG = ("NameError", "UnboundLocalError", "ImportError", "ModuleNotFoundError",
               "SyntaxError", "IndentationError", "RecursionError")
# The code's fault when it ran on the model's own example, offline.
_INPUT_BUG = ("TypeError", "AttributeError", "KeyError", "IndexError", "ValueError", "ZeroDivisionError")


class SmokeError:
    """Same .msg/.lineno shape as bootstrap's other tool errors, so it joins
    their retry/drop flow and report unchanged."""
    def __init__(self, msg: str):
        self.msg = msg
        self.lineno = "?"


def _sample_value(spec: dict):
    if not isinstance(spec, dict):
        return "example"
    if isinstance(spec.get("enum"), list) and spec["enum"]:
        return spec["enum"][0]
    if "default" in spec:
        return spec["default"]
    return {"integer": 1, "number": 1, "boolean": True, "array": [], "object": {}}.get(spec.get("type"), "example")


def sample_inputs(tool: dict) -> tuple[dict, bool]:
    """The tool's own `example` when it gave a usable one, else a minimal
    input built from its schema. Returns (inputs, from_example)."""
    schema = tool.get("input_schema") if isinstance(tool.get("input_schema"), dict) else {}
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    example = tool.get("example")
    if isinstance(example, dict) and example:
        return dict(example), True
    required = [r for r in schema.get("required") or [] if isinstance(r, str)]
    return {name: _sample_value(props.get(name, {})) for name in required}, False


def _last_error_line(error: str) -> str:
    lines = [l for l in (error or "").strip().splitlines() if l.strip()]
    return lines[-1].strip() if lines else "unknown error"


def _classify(reply: dict, network: bool, from_example: bool) -> tuple[str, str]:
    """('passed' | 'failed' | 'inconclusive', detail)."""
    if reply.get("ok"):
        result = reply.get("result")
        if result is None or result == "No result returned.":
            if network:
                return "inconclusive", "returned nothing (may depend on the remote service)"
            return "failed", "never assigned a value to `result`"
        if isinstance(result, dict) and result.get("error"):
            return "inconclusive", f"returned an error: {str(result['error'])[:160]}"
        return "passed", f"returned {type(result).__name__}"
    error = str(reply.get("error") or "")
    last = _last_error_line(error)
    kind = last.split(":", 1)[0].strip().split(".")[-1]
    if "timed out" in error.lower() or "Sandbox failed" in error:
        return "inconclusive", last[:200]
    if kind in _ALWAYS_BUG:
        return "failed", last[:200]
    if kind in _INPUT_BUG and from_example and not network:
        return "failed", last[:200]
    return "inconclusive", last[:200]


def smoke_test(config: dict, skip: set[str] | None = None) -> tuple[list[tuple[str, SmokeError]], list[dict]]:
    """Runs each generated tool once on sample inputs, in parallel. Returns
    (errors for the retry/drop flow, per-tool results for the report)."""
    import sandbox

    skip = skip or set()
    tools = [t for t in _generated(config) if t.get("name") not in skip]
    if not tools:
        return [], []

    def run_one(tool):
        inputs, from_example = sample_inputs(tool)
        reply = sandbox.run(
            tool["implementation"], inputs,
            http_timeout=SMOKE_HTTP_TIMEOUT_SECONDS, timeout=SMOKE_TIMEOUT_SECONDS,
        )
        status, detail = _classify(reply, bool(reply.get("network")), from_example)
        return tool, inputs, from_example, bool(reply.get("network")), status, detail

    errors: list[tuple[str, SmokeError]] = []
    results: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(tools))) as pool:
        for tool, inputs, from_example, network, status, detail in pool.map(run_one, tools):
            name = str(tool.get("name") or "?")
            results.append({
                "tool": name, "status": status, "detail": detail,
                "inputs": json.dumps(inputs, default=str)[:200],
                "from_example": from_example, "network": network,
            })
            if status == "failed":
                errors.append((name, SmokeError(
                    f"smoke test failed: running it on {'its example' if from_example else 'sample'} "
                    f"inputs {json.dumps(inputs, default=str)[:160]} gave `{detail}`"
                )))
    return errors, results


# ---------------------------------------------------------------------------
# Runtime: arguments and errors
# ---------------------------------------------------------------------------

_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "object": dict, "array": list}


def _coerce(value, spec: dict):
    """(value, ok). Harmless mismatches are fixed; anything else is not ok."""
    expected = spec.get("type")
    py = _TYPES.get(expected)
    if py is None or value is None:
        return value, True
    if expected in ("integer", "number") and isinstance(value, bool):
        return value, False
    if isinstance(value, py):
        return value, True
    if expected == "integer" and isinstance(value, float) and value.is_integer():
        return int(value), True
    if expected in ("integer", "number") and isinstance(value, str):
        s = value.strip()
        if re.fullmatch(r"-?\d+", s):
            return int(s), True
        if expected == "number" and re.fullmatch(r"-?\d+\.\d*", s):
            return float(s), True
        return value, False
    if expected == "boolean" and isinstance(value, str) and value.strip().lower() in ("true", "false"):
        return value.strip().lower() == "true", True
    if expected == "string" and isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value), True
    if expected == "array" and isinstance(value, (str, int, float, dict)):
        return [value], True
    return value, False


def check_arguments(inputs, schema) -> tuple[dict, list[str]]:
    """Returns (inputs with harmless fixes applied, problems). Unknown extra
    arguments are left alone; only declared fields are checked."""
    if not isinstance(inputs, dict):
        return {}, ["arguments must be a JSON object"]
    if not isinstance(schema, dict):
        return inputs, []
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    fixed = dict(inputs)
    problems: list[str] = []
    for field in schema.get("required") or []:
        if isinstance(field, str) and (field not in fixed or fixed[field] is None or fixed[field] == ""):
            problems.append(f"missing required argument '{field}'")
    for field, value in list(fixed.items()):
        spec = props.get(field)
        if not isinstance(spec, dict):
            continue
        value, ok = _coerce(value, spec)
        if not ok:
            problems.append(f"'{field}' should be {spec.get('type')}, got {type(value).__name__}")
            continue
        enum = spec.get("enum")
        if isinstance(enum, list) and enum and value is not None and value not in enum:
            match = next((e for e in enum if isinstance(e, str) and isinstance(value, str)
                          and e.lower() == value.strip().lower()), None)
            if match is None:
                problems.append(f"'{field}' must be one of {enum}, got {value!r}")
                continue
            value = match
        fixed[field] = value
    return fixed, problems


def expected_arguments(schema) -> dict:
    """A compact view of a schema for an error message the model reads."""
    if not isinstance(schema, dict):
        return {}
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    required = set(schema.get("required") or [])
    out = {}
    for name, spec in props.items():
        spec = spec if isinstance(spec, dict) else {}
        line = str(spec.get("type") or "any") + (" (required)" if name in required else "")
        if isinstance(spec.get("enum"), list):
            line += f", one of {spec['enum']}"
        if spec.get("description"):
            line += f" — {str(spec['description'])[:100]}"
        out[name] = line
    return out


def rejection(tool_name: str, problems: list[str], schema) -> dict:
    return {
        "error": f"Arguments rejected before running {tool_name}: " + "; ".join(problems) + ".",
        "expected_arguments": expected_arguments(schema),
        "hint": "Call it again with corrected arguments, or use a different tool if this one doesn't fit.",
    }


_NETWORK_ERROR_RE = re.compile(
    r"ConnectionError|ConnectTimeout|ReadTimeout|Timeout|HTTPError|SSLError|URLError|"
    r"socket|\b4\d\d\b|\b5\d\d\b|Max retries|Name or service not known|getaddrinfo", re.IGNORECASE,
)


def _hint_for(error_text: str) -> str:
    last = _last_error_line(error_text)
    kind = last.split(":", 1)[0].strip().split(".")[-1]
    if "timed out" in error_text.lower():
        return "The tool took too long. Try a narrower input, or a different tool."
    if kind in _ALWAYS_BUG or kind in ("AttributeError", "TypeError"):
        return ("This looks like a bug in the tool, which new inputs are unlikely to fix. "
                "Don't call it again this turn; use another tool or answer with what you have.")
    if _NETWORK_ERROR_RE.search(error_text):
        return ("The remote service failed or refused the request. Don't repeat the identical call; "
                "try different inputs or another tool (for example web search or fetch_page).")
    return "Check the inputs against the tool's description and try once more with different ones, or use another tool."


def add_hint(result):
    """A failed result with a "what to do next" line added; others unchanged.
    The "Tool execution error:" prefix eval_checks relies on is kept."""
    if isinstance(result, str) and result.startswith("Tool execution error:"):
        if "\nWhat to do: " in result:
            return result
        return result.rstrip() + "\n\nWhat to do: " + _hint_for(result)
    if isinstance(result, dict) and result.get("error") and not result.get("hint"):
        return {**result, "hint": _hint_for(str(result["error"]))}
    return result
