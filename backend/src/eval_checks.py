"""
Self-evaluation checks (root CLAUDE.md eval-framework task): the user asked
for the AI to test its own output at every stage of a session — agent
generation at bootstrap time, chat responses, tool-call sequences, and
worker delegation results — not just one of these. One function per stage
below, each returning a list of uniform result dicts so the frontend
("feedback status bar") and eval_log.py need only one shape:

{
    "check": str,             # stable id, e.g. "tool_syntax"
    "target": "bootstrap" | "chat_response" | "tool_call" | "worker_delegation",
    "target_id": str | None,  # call_index for tool_call, worker persona name for worker_delegation/bootstrap
    "passed": bool,
    "reason": str,
    "method": "deterministic" | "llm_judge",
    "severity": "info" | "warning",
    "provider": str | None,   # which LLM provider produced the thing being checked
    "model": str | None,      # which model, within that provider
}

provider/model are carried on every result (not just llm_judge ones) so a
result can be attributed back to the arm that produced it — e.g. a future
bandit over provider/tool choice, using `passed` as reward, needs to know
which arm each recorded outcome belongs to. Without this, eval_log.json is
just a pass/fail feed with no way to tell whose output was graded.

Deterministic checks are cheap, structural, and never call an LLM. An
llm_judge check for a given stage only runs once that stage's own
deterministic checks already passed — a config/response/worker result
already known to be broken doesn't need a second opinion, which bounds
judge-call volume without skipping genuinely ambiguous cases. Judge calls
reuse llm_client.create_chat_completion (the agent's own provider/model),
not a separate hardcoded "judge-tier" model.

Every public function here is best-effort: a judge call that returns
unparseable output is retried once with an explicit correction prompt (same
shape as bootstrap.py's _tool_syntax_errors retry); if still broken, or the
call itself raises, the judge check is simply omitted rather than faking a
result. Callers are expected to wrap each call to these functions in their
own try/except too, so an internal bug here never breaks the underlying
/bootstrap or /agent request.
"""
import json
import logging

from llm_client import create_chat_completion

logger = logging.getLogger(__name__)

_JUDGE_MAX_TOKENS = 300

_WORKER_FAILURE_PREFIXES = ("Worker failed:", "Worker crashed:", "Could not assemble a worker")

_SCHEMA_TYPE_MAP = {
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
    "object": dict,
    "array": list,
}


def _result(check, target, target_id, passed, reason, method, severity="info", provider=None, model=None, agent_id=None):
    return {
        "check": check,
        "target": target,
        "target_id": target_id,
        "passed": passed,
        "reason": reason,
        "method": method,
        "severity": severity,
        "provider": provider,
        "model": model,
        "agent_id": agent_id,
    }


def _judge(provider, model, rubric_prompt: str, label: str = "Self-check") -> tuple[bool, str] | None:
    """One LLM call asking for a strict-JSON {"passed": bool, "reason": str}
    verdict. Retries once with a correction message on unparseable output;
    returns None (never a fabricated result) if it's still broken or the
    call itself raises."""
    prompt = rubric_prompt + (
        '\n\nRespond with ONLY a JSON object of the exact shape '
        '{"passed": true|false, "reason": "<one sentence>"}. No markdown '
        "fences, no other text."
    )
    messages = [{"role": "user", "content": prompt}]
    for attempt in range(2):
        try:
            response = create_chat_completion(
                provider=provider, model=model, max_tokens=_JUDGE_MAX_TOKENS,
                messages=messages, _trace=("check", label),
            )
            content = (response.choices[0].message.content or "").strip()
            if content.startswith("```"):
                content = content.strip("`")
                if content[:4].lower() == "json":
                    content = content[4:]
                content = content.strip()
            parsed = json.loads(content)
            if isinstance(parsed, dict) and isinstance(parsed.get("passed"), bool):
                return bool(parsed["passed"]), str(parsed.get("reason") or "")
        except Exception as e:
            logger.info("eval_checks._judge attempt %d failed: %s", attempt, e)
        if attempt == 0:
            messages.append({
                "role": "user",
                "content": (
                    'That was not valid JSON. Respond with ONLY '
                    '{"passed": true|false, "reason": "..."}, nothing else.'
                ),
            })
    return None


def check_bootstrap(
    config: dict, purpose: str, provider: str | None, model: str | None,
    dropped_tool_names: list[str] | None = None, target_id: str | None = None,
) -> list[dict]:
    results = []
    tools = [t for t in (config.get("tools") or []) if isinstance(t, dict)]
    dropped = dropped_tool_names or []

    broken = []
    for t in tools:
        impl = t.get("implementation")
        if not impl:
            continue
        try:
            compile(impl, "<tool>", "exec")
        except SyntaxError:
            broken.append(t.get("name", "?"))
    tool_syntax_passed = not broken and not dropped
    reason_parts = []
    if dropped:
        reason_parts.append(f"dropped after a failed correction retry: {', '.join(dropped)}")
    if broken:
        reason_parts.append(f"still fails to compile: {', '.join(broken)}")
    reason = "; ".join(reason_parts) if reason_parts else f"all {len(tools)} tool implementation(s) compile cleanly"
    results.append(_result(
        "tool_syntax", "bootstrap", target_id, tool_syntax_passed, reason,
        "deterministic", severity="info" if tool_syntax_passed else "warning",
        provider=provider, model=model,
    ))

    shape_issues = []
    for t in tools:
        name = t.get("name", "?")
        if t.get("source") == "mcp":
            if not t.get("mcp_server") or not t.get("mcp_tool"):
                shape_issues.append(f"{name} (missing mcp_server/mcp_tool)")
        else:
            if not t.get("input_schema") or not t.get("implementation"):
                shape_issues.append(f"{name} (missing input_schema/implementation)")
    shape_passed = not shape_issues
    results.append(_result(
        "tool_schema_shape", "bootstrap", target_id, shape_passed,
        "every tool has the required keys for its kind" if shape_passed
        else f"malformed tool entries: {', '.join(shape_issues)}",
        "deterministic", severity="info" if shape_passed else "warning",
        provider=provider, model=model,
    ))

    if tools and tool_syntax_passed and shape_passed:
        tool_summary = "; ".join(
            f"{t.get('name')}: {t.get('description') or '(mcp tool)'}" for t in tools
        )
        verdict = _judge(
            provider, model,
            "An AI agent was configured for this purpose:\n"
            f"{purpose}\n\nIt was given these tools:\n{tool_summary}\n\n"
            "Do these tools plausibly serve the stated purpose? Answer false only "
            "if the toolset is clearly mismatched or missing something obviously "
            "essential to the purpose.",
            label="Self-check: tools fit purpose",
        )
        if verdict is not None:
            passed, reason = verdict
            results.append(_result(
                "purpose_fit_judge", "bootstrap", target_id, passed, reason,
                "llm_judge", severity="info" if passed else "warning",
                provider=provider, model=model,
            ))

    return results


def check_chat_response(
    user_message: str, final_text: str, tool_calls_log: list[dict],
    stripped_link_count: int, provider: str | None, model: str | None,
    agent_id: str | None = None, focus_topics: list[str] | None = None,
) -> list[dict]:
    results = []
    non_empty = bool(final_text and final_text.strip())
    results.append(_result(
        "non_empty_response", "chat_response", None, non_empty,
        "response is non-empty" if non_empty else "response text was empty",
        "deterministic", severity="info" if non_empty else "warning",
        provider=provider, model=model, agent_id=agent_id,
    ))

    links_ok = stripped_link_count == 0
    results.append(_result(
        "unverified_links_stripped", "chat_response", None, links_ok,
        "no unverified links were found in the reply" if links_ok
        else f"{stripped_link_count} unverified link(s) were demoted to plain text before showing the reply",
        "deterministic", severity="info" if links_ok else "warning",
        provider=provider, model=model, agent_id=agent_id,
    ))

    # agent_stream.py's own `_is_raw_json_dump` (same "whole reply parses as
    # JSON" test) already retries this up to twice before the reply reaches
    # here — this records whether a raw tool-output dump (confirmed live: a
    # Tavily search result shown to the user verbatim) still slipped through
    # after retries were exhausted, so it's visible in the self-check history
    # rather than silently accepted as a normal reply.
    stripped_text = final_text.strip() if final_text else ""
    raw_dump = False
    if stripped_text and stripped_text[0] in "{[":
        try:
            raw_dump = isinstance(json.loads(stripped_text), (dict, list))
        except json.JSONDecodeError:
            raw_dump = False
    if non_empty:
        results.append(_result(
            "raw_output_not_pasted", "chat_response", None, not raw_dump,
            "reply is not a raw tool-output dump" if not raw_dump
            else "reply is entirely raw JSON — looks like an unprocessed tool result, not a written answer",
            "deterministic", severity="info" if not raw_dump else "warning",
            provider=provider, model=model, agent_id=agent_id,
        ))

    if non_empty:
        tool_names = ", ".join(sorted({tc.get("tool", "?") for tc in tool_calls_log})) or "none"
        # A message like "Produce your standard output across your full focus
        # pool" doesn't name the subject, so without the topics the judge
        # passed a reply about an unrelated subject as "a clear plan".
        topics = [t for t in (focus_topics or []) if isinstance(t, str) and t.strip()]
        topics_block = (
            "The agent's focus topics (what the user means by its 'focus pool'): "
            + "; ".join(topics) + "\n\n"
        ) if topics else ""
        verdict = _judge(
            provider, model,
            f"A user asked:\n{user_message}\n\n{topics_block}Tools called this turn: {tool_names}\n\n"
            f"The agent replied:\n{final_text[:2000]}\n\n"
            "Does this reply substantively address what the user asked"
            + (", and is it actually about the focus topics rather than some other subject?" if topics else "?"),
            label="Self-check: reply answers the question",
        )
        if verdict is not None:
            passed, reason = verdict
            results.append(_result(
                "response_relevance_judge", "chat_response", None, passed, reason,
                "llm_judge", severity="info" if passed else "warning",
                provider=provider, model=model, agent_id=agent_id,
            ))
    return results


def _schema_violations(inputs: dict, schema: dict) -> list[str]:
    issues = []
    if not isinstance(schema, dict):
        return issues
    props = schema.get("properties") or {}
    for field in schema.get("required") or []:
        if field not in inputs:
            issues.append(f"missing required field '{field}'")
    for field, value in inputs.items():
        spec = props.get(field)
        if not isinstance(spec, dict):
            continue
        expected = _SCHEMA_TYPE_MAP.get(spec.get("type"))
        if expected and value is not None and not isinstance(value, expected):
            issues.append(f"field '{field}' expected {spec.get('type')}, got {type(value).__name__}")
    return issues


def check_tool_call(
    tool_name: str, tool_inputs: dict, tool_def: dict | None, result_str: str,
    source: str, call_index: int, provider: str | None = None, model: str | None = None,
    agent_id: str | None = None,
) -> list[dict]:
    results = []
    schema = (tool_def or {}).get("input_schema")
    if schema:
        issues = _schema_violations(tool_inputs or {}, schema)
        passed = not issues
        results.append(_result(
            "tool_input_schema", "tool_call", str(call_index), passed,
            "inputs match the tool's declared schema" if passed else "; ".join(issues),
            "deterministic", severity="info" if passed else "warning",
            provider=provider, model=model, agent_id=agent_id,
        ))

    errored = isinstance(result_str, str) and result_str.startswith("Tool execution error:")
    # Primitives and MCP calls don't raise — they return {"error": ...}. That
    # used to pass this check (e.g. generate_image "executed without error"
    # while returning Hugging Face's "no remaining credits"), hiding a tool
    # that failed every time.
    returned_error = None
    if not errored and isinstance(result_str, str) and result_str.lstrip().startswith("{"):
        try:
            parsed = json.loads(result_str)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict) and parsed.get("error"):
            returned_error = str(parsed["error"])[:200]
    if errored:
        reason = f"{tool_name} raised an exception during execution"
    elif returned_error:
        reason = f"{tool_name} returned an error: {returned_error}"
    else:
        reason = f"{tool_name} executed without error"
    errored = errored or returned_error is not None
    results.append(_result(
        "tool_execution_error", "tool_call", str(call_index), not errored,
        reason,
        "deterministic", severity="info" if not errored else "warning",
        provider=provider, model=model, agent_id=agent_id,
    ))
    return results


def _call_failed(result) -> bool:
    if not isinstance(result, str):
        return False
    if result.startswith("Tool execution error:"):
        return True
    if result.lstrip().startswith("{"):
        try:
            parsed = json.loads(result)
        except ValueError:
            return False
        return isinstance(parsed, dict) and bool(parsed.get("error"))
    return False


# Tools whose result isn't text a reply would quote (images, workers' own
# cards), so "result ignored" doesn't apply to them.
_NOT_QUOTED_TOOLS = {"delegate_to_worker", "search_image", "generate_image"}
_COMMON_LONG_WORDS = frozenset(
    "because between through however without against following another important "
    "available information including different something research results".split()
)


def _distinctive_words(text: str) -> set[str]:
    import re
    return {w for w in re.findall(r"[a-z][a-z\-]{6,}", text.lower()) if w not in _COMMON_LONG_WORDS}


def check_tool_use(
    tool_calls_log: list[dict], offered_tools: list[str], final_text: str,
    provider: str | None, model: str | None, agent_id: str | None = None,
) -> list[dict]:
    """Turn-level online signals over the whole turn's tool calls:

    - tool_recovery: after a failed call, did the agent switch tool or fix
      the inputs (pass), or repeat the identical failing call (warning)?
    - unused_tools: the agent's own tools (generated/MCP) never called in a
      turn that did use tools. A signal about the tool, not the model, so
      it carries no provider/model and the bandit never counts it.
    - result_ignored: a successful text result with none of its distinctive
      words in the reply, i.e. fetched and then not used."""
    results = []
    calls = [c for c in tool_calls_log or [] if isinstance(c, dict)]
    if not calls:
        return results

    switched = corrected = repeated = 0
    for i, call in enumerate(calls[:-1]):
        if not _call_failed(call.get("result")):
            continue
        nxt = calls[i + 1]
        if nxt.get("tool") != call.get("tool"):
            switched += 1
        elif json.dumps(nxt.get("inputs"), sort_keys=True, default=str) != json.dumps(call.get("inputs"), sort_keys=True, default=str):
            corrected += 1
        else:
            repeated += 1
    failures = sum(1 for c in calls if _call_failed(c.get("result")))
    if failures:
        parts = []
        if switched:
            parts.append(f"switched tool {switched}×")
        if corrected:
            parts.append(f"retried with new inputs {corrected}×")
        if repeated:
            parts.append(f"repeated the identical failing call {repeated}×")
        last_failed = _call_failed(calls[-1].get("result"))
        if last_failed:
            parts.append("the last call failed and nothing followed it")
        results.append(_result(
            "tool_recovery", "tool_call", None, repeated == 0,
            f"{failures} failed call(s): " + ("; ".join(parts) or "no follow-up call"),
            "deterministic", severity="info" if repeated == 0 else "warning",
            provider=provider, model=model, agent_id=agent_id,
        ))

    called = {c.get("tool") for c in calls}
    unused = [t for t in offered_tools if t not in called]
    if offered_tools:
        results.append(_result(
            "unused_tools", "tool_call", None, not unused,
            "every one of the agent's own tools was used" if not unused
            else f"offered but not called this turn: {', '.join(unused)}",
            "deterministic", severity="info", agent_id=agent_id,
        ))

    reply_words = _distinctive_words(final_text or "")
    ignored, checked = [], 0
    for call in calls:
        result = call.get("result")
        if call.get("tool") in _NOT_QUOTED_TOOLS or _call_failed(result) or not isinstance(result, str) or len(result) < 300:
            continue
        words = _distinctive_words(result)
        if len(words) < 10:
            continue
        checked += 1
        if not (words & reply_words):
            ignored.append(str(call.get("tool")))
    if checked and (final_text or "").strip():
        results.append(_result(
            "result_ignored", "tool_call", None, not ignored,
            f"all {checked} text result(s) show up in the reply" if not ignored
            else f"{len(ignored)} of {checked} result(s) fetched but not used in the reply: {', '.join(ignored)}",
            "deterministic", severity="info",
            provider=provider, model=model, agent_id=agent_id,
        ))
    return results


def check_worker_delegation(
    task: str, final_response: str, tool_calls: list[dict], provider: str | None,
    model: str | None, worker_name: str | None = None,
) -> list[dict]:
    results = []
    failed = any((final_response or "").startswith(p) for p in _WORKER_FAILURE_PREFIXES)
    results.append(_result(
        "worker_completed", "worker_delegation", worker_name, not failed,
        "worker returned a final response" if not failed else final_response,
        "deterministic", severity="info" if not failed else "warning",
        provider=provider, model=model,
    ))

    if tool_calls:
        errors = [
            tc for tc in tool_calls
            if isinstance(tc.get("result"), str) and tc["result"].startswith("Tool execution error:")
        ]
        ok = not errors
        results.append(_result(
            "worker_tool_errors", "worker_delegation", worker_name, ok,
            "none of the worker's tool calls errored" if ok
            else f"{len(errors)} of {len(tool_calls)} of the worker's tool call(s) errored",
            "deterministic", severity="info" if ok else "warning",
            provider=provider, model=model,
        ))

    if not failed:
        verdict = _judge(
            provider, model,
            f"A worker agent was delegated this task:\n{task}\n\n"
            f"It responded:\n{(final_response or '')[:2000]}\n\n"
            "Did the worker's response actually accomplish the delegated task?",
            label="Self-check: worker did its task",
        )
        if verdict is not None:
            passed, reason = verdict
            results.append(_result(
                "worker_task_fit_judge", "worker_delegation", worker_name, passed, reason,
                "llm_judge", severity="info" if passed else "warning",
                provider=provider, model=model,
            ))
    return results
