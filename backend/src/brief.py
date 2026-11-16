"""
Generates the Setup screen's "Brief" text (backend/src/agent_stream.py's own
delegation logic is the runtime counterpart of this — this module runs once,
before bootstrap, to help the user see what their specialty pool will mean).

Previously buildAgentBrief() in Setup.tsx synthesized this deterministically
from a fixed per-agent-type template string. This module replaces that with
a real LLM call so the brief reads as a considered interpretation of the
actual specialties chosen, not a fill-in-the-blank sentence — and, since a
model can tell when a specialty pool is genuinely ambiguous or sparse in a
way a template can't, it may ask the user one clarifying question instead of
guessing. The frontend still keeps the old deterministic buildAgentBrief() as
a same-turn fallback if this call fails, so a network hiccup never leaves the
Brief section blank.

Note: the house-style sentence shape below (_BRIEF_PROMPT) is a scaffold for
structure, not a fill-in-the-blank mold — the model is expected to actually
reason about what direction the chosen specialties collectively point
toward (the underlying goal, or which specialty is load-bearing when they
pull different ways), not just restate each keyword back into the template
slots. If a generated brief ever reads like a keyword list wearing a
sentence, that's a prompt regression, not an acceptable output.

Active Behavior toggles and Personality traits (Setup.tsx's BEHAVIOR_TOGGLES
/ PERSONALITY_TRAITS — e.g. "Max Delegation", "Meticulous") change what the
bootstrapped agent will actually do just as much as a specialty does, so the
brief gives them their own paragraph, naming every one selected and its
concrete effect on these focuses, rather than only ever discussing the
keywords. See generate_brief's `behaviors`/`traits` args.

Alongside a brief, the model may offer up to two output "relics" (relic.py)
suited to this commission — e.g. slides to pitch it, a PDF case file, a
diagram of how the work splits. Offered only; nothing is built unless the
user clicks one in Setup, and then relic.py builds it from the case and the
agent on board, not by restating this paragraph.
"""
import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from llm_client import create_chat_completion

logger = logging.getLogger(__name__)

# Brief-sourced relics: nothing has been researched yet, so a chart (which
# needs real numbers) isn't offered.
BRIEF_RELIC_KINDS = ("slides", "pdf", "docx", "diagram", "markdown", "json")


def _clip(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _brief_map(raw) -> dict | None:
    """The brief drawn as a flow for Setup's brief graph (BriefGraph.tsx):
    the commission, how the agent understood it, the lines of work it will
    split into, and the result it hands back. Optional: a missing or
    malformed map just means no graph, never a failed brief."""
    if not isinstance(raw, dict):
        return None
    ask = _clip(raw.get("ask"), 200)
    result = _clip(raw.get("result"), 200)
    understood = [_clip(u, 160) for u in raw.get("understood") or [] if isinstance(u, str) and u.strip()][:4]
    work = []
    for item in raw.get("work") or []:
        if isinstance(item, dict) and _clip(item.get("label"), 60):
            work.append({"label": _clip(item.get("label"), 60), "detail": _clip(item.get("detail"), 180)})
        elif isinstance(item, str) and item.strip():
            work.append({"label": _clip(item, 60), "detail": ""})
    work = work[:6]
    if not ask or not result or not work:
        return None
    return {"ask": ask, "understood": understood, "work": work, "result": result}


def _relic_suggestions(raw) -> list[dict]:
    suggestions = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower()
        reason = str(item.get("reason") or "").strip()
        if kind in BRIEF_RELIC_KINDS and reason and all(s["kind"] != kind for s in suggestions):
            suggestions.append({"kind": kind, "reason": reason[:200]})
    return suggestions[:2]

def _topic_count_bullet(count: int, limit: int) -> str:
    if count <= limit:
        return ""
    return (
        f"- This one applies, so write about it first: the user added {count} focus topics "
        f"and each research turn runs at most {limit} worker agents, so some topics will be "
        "folded together or left for a follow-up turn rather than each getting its own worker "
        "(they can trim topics or raise the worker limit in Settings).\n"
    )


# A note about location or region, dropped when the user gave none.
_LOCATION_NOTE_RE = re.compile(
    r"\b(locations?|region(?:al|s)?|geograph\w*|country|countries|city|cities|"
    r"area-specific|location-specific|where you are)\b",
    re.IGNORECASE,
)

# Notes phrased as what the agent won't/can't do (a disclaimer, not a read
# of this case). Dropped in code because the prompt rule alone didn't hold.
_DISCLAIMER_RE = re.compile(
    r"\b(will not|won't|cannot|can't|can not|unable to|isn't able|is not able|"
    r"not designed to|doesn't provide|does not provide|"
    r"(?:rather than|instead of|not|never) (?:offer|offering|provide|providing|give|giving)|"
    r"(?:legal|medical|financial|career) advice)\b",
    re.IGNORECASE,
)


def _case_type_rule(agent_type: str | None) -> str:
    """Job search is one special case type; every other brief stays neutral,
    built only from the focus topics, traits and behaviors. Jobs, listings
    and careers are never raised unless the case type is job_search, and the
    brief never explains what a non-job agent can't do."""
    if agent_type == "job_search":
        return (
            "This is a job search case: the agent searches live job listings for "
            "the specialties and reports back on real postings.\n"
        )
    return (
        "Stay neutral and work only from the specialties, traits and behaviors given. "
        "Do not bring up jobs, job listings, job boards, careers or hiring unless a "
        "specialty itself is about that, and even then treat it purely as a research "
        "topic: never say what the agent cannot do or search, and never compare it to "
        "other kinds of agent.\n"
    )


_CASE_PROMPT = """You are drafting the short "Brief" shown on an AI agent platform's Setup screen. It tells the user how the agent they're about to commission will interpret the specialties (keywords) they've added, before they actually launch it.

Agent type: {agent_type}
Agent name: {agent_name}
Specialties/keywords: {keywords}
{location_line}Active behaviors: {behaviors}
Active personality traits: {traits}
{prior_qa}
"""

_ASK_RULE = """Most of the time, just write the brief directly and confidently — you don't need the user's permission to interpret a reasonable set of specialties. Only when the specialties are genuinely ambiguous, sparse, or pulling in conflicting directions (e.g. a single very broad word with no other context, two contradictory domains{location_question}) should you ask the user ONE short, specific clarifying question instead of guessing — don't ask just because you *could* be more specific.

"""

_SHAPE_RULE = """When writing the brief: third person, THREE short paragraphs separated by a blank line (written as \n\n inside the JSON string, never a raw line break), roughly 8-11 sentences in all. It should read as a considered write-up of this particular agent, not a one-liner.

"""

_P1_RULE = """PARAGRAPH 1, the focuses: your analytical read of the combination, not the list. Open with what these specialties mean TOGETHER that none of them means alone: the intersection they define, the underlying goal they imply, or which one is load-bearing and which ones narrow or qualify it. Then analyse that combination: why it is more useful than covering each specialty separately, where they pull against each other or leave a gap, and one concrete, specific scenario where commissioning this agent would actually pay off (a real situation, not "this could be useful for various purposes"). Do NOT open by naming the keywords one after another, and never name more than two keywords in a single sentence; refer to them through what they combine into (e.g. "solar", "insurance", "farms" becomes "the risk side of putting solar on agricultural land", not "solar, insurance and farms"). If this paragraph would read the same with the keywords shuffled, or a reader could reconstruct it from the keyword list alone, it is a keyword walk: rewrite it.{location_rule}

"""

_P2_RULE = """PARAGRAPH 2, its character: how the selected personality traits and behaviors shape the way it will tackle THESE focuses. Name EVERY active trait and behavior listed above (none may be left out), each tied to a concrete effect on this case: what it will do differently with these specialties because of it (e.g. "Meticulous" means it will flag where the evidence on crop-insurance terms is thin rather than smoothing it over; "Max Delegation" means each focus goes to its own worker agent and the main agent only compares their findings). Where two selections interact or pull against each other (e.g. "Concise" with "Cite Sources"), say how that plays out. Never just list the labels. If both traits and behaviors are "(none)", keep this paragraph to one sentence on the plain, default way it will work.

"""

_P3_RULE = """PARAGRAPH 3, the work: what the agent will actually do and what it will report back with, as 2-3 concrete actions that follow from paragraphs 1 and 2 (not one action per keyword). Vary the wording agent to agent; never fall back on a fixed shape like "Agent {agent_name} will... If commissioned, it will... and report back with..." that would make two briefs read like the same mail-merge with different nouns swapped in.

"""

_THIN_RULE = """Not enough to go on (should be RARE): only when the specialties together give you genuinely nothing to analyse (e.g. a single generic word, or terms you cannot place at all) and no single clarifying question would fix it, say so plainly in the brief instead of padding it out (it can be shorter than three paragraphs then, but still cover the selected traits and behaviors): one sentence on what you can infer, one on what is missing for a real read, and what kind of specialty the user could add. Do not use this to dodge a combination that just takes some thought; almost any set of two or more specific specialties has a direction worth stating.

"""

_NOTE_RULE = """Separately from the ambiguity check above, also consider whether something about how this agent is set up will shape the results in a way the user should know before commissioning it. If so, add ONE "warning": an informative note shown as a tip under the brief, not an error message. Write it as 1-2 plain, friendly sentences addressed to the user ("you"): say what this means for THIS commission in practice (name the actual topics, keywords or gap involved) and what they could do about it if they want to. Never restate a situation below as a label or rule, and no alarm words ("warning", "error", "danger"). Situations worth a note:
{topic_count_bullet}- Specialties spanning clearly unrelated domains (e.g. "tax law" and "vintage motorcycles"): the agent's persona and searches will be split between them rather than focused.
- A specialty that explicitly asks for binding legal, medical, financial, or safety advice (e.g. "tell me which pills to take"): it will research and summarise the topic, not act as a professional adviser. Only when a specialty actually asks for that; never as a general disclaimer.
{location_bullet}If more than one situation applies, write about the one that changes the results most. Never mention the agent type's internal id. A note is never a disclaimer: never write about what the agent will not do, capabilities it lacks, or other kinds of agent it isn't.
This is independent of the question/brief choice above: a note can accompany either a brief or a question. Omit "warning" (or use null) when nothing is worth pointing out; don't invent one just to have one.

"""

_RELICS_RULE = """When you write a brief (not a question), also offer up to two pieces of media the user could take away from this commission before it runs, picked for what would genuinely help THIS case: "slides" (to pitch or present the commission), "pdf" (a polished case file to share), "docx" (an editable case file), "diagram" (how the work splits across the focus topics and any workers), "markdown" (a working brief to keep editing), "json" (one entry per line of inquiry, for tracking). Each reason is one short line naming what it would contain for this case specifically. Offer none ([]) when nothing would really add to the brief.

"""

_ONESHOT_FORMAT = """Respond with ONLY raw JSON, no markdown code fences, no other text, exactly one of:
{{"type": "brief", "text": "...", "warning": "..." or null, "relics": [{{"kind": "...", "reason": "..."}}]}}
{{"type": "question", "text": "...", "warning": "..." or null}}
"""

# The one-call brief (generate_brief): the pieces above in their original order.
_BRIEF_PROMPT = (
    _CASE_PROMPT + _ASK_RULE + "{case_type_rule}\n" + _SHAPE_RULE + _P1_RULE
    + _P2_RULE + _P3_RULE + _THIN_RULE + _NOTE_RULE + _RELICS_RULE + _ONESHOT_FORMAT
)


def generate_brief(
    agent_type: str | None,
    keywords: list[str],
    location: str,
    agent_name: str,
    provider: str | None = None,
    model: str | None = None,
    prior_question: str | None = None,
    prior_answer: str | None = None,
    max_delegations: int | None = None,
    behaviors: list[str] | None = None,
    traits: list[str] | None = None,
) -> dict | None:
    """
    Returns {"type": "brief" | "question", "text": "...", "warning": "..." | None,
    "relics": [{"kind", "reason"}, ...]} (relics empty for a question)
    or None if the call/parse failed — callers should fall back to the
    deterministic template brief on None rather than surfacing an error,
    since this is a nice-to-have polish step, not a required one.
    """
    prompt = _BRIEF_PROMPT.format(**_prompt_fields(
        agent_type, keywords, location, agent_name, prior_question, prior_answer,
        max_delegations, behaviors, traits,
    ))

    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            # Gemini 3.x thinks by default and counts that against max_tokens
            # (OpenAI-compat API), so a tight cap cut the JSON off mid-brief
            # and Setup fell back to its two-line template with no graph.
            # Ollama/qwen3 has thinking off and stops well under this.
            max_tokens=8000,
            temperature=0.6,
            messages=[{"role": "user", "content": prompt}],
        )
        choice = response.choices[0]
        raw = (choice.message.content or "").strip()
        if choice.finish_reason == "length":
            logger.warning("brief: reply hit max_tokens (%d chars), JSON likely cut off", len(raw))
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        # strict=False: small models put real line breaks inside the text
        # string; strict parsing rejected the whole brief, and Setup showed
        # its two-line template fallback instead.
        data = json.loads(raw, strict=False)
        text = (data.get("text") or "").strip()
        kind = data.get("type") if data.get("type") in ("brief", "question") else "brief"
        warning = _clean_warning(data.get("warning"), location)
        if not text:
            return None
        relics = _relic_suggestions(data.get("relics")) if kind == "brief" else []
        return {"type": kind, "text": text, "warning": warning, "relics": relics}
    except Exception as e:
        # Logged so a silent template fallback in production can be traced.
        logger.warning("brief: generation failed (%s): %s", provider or "default", e)
        return None


def _clean_warning(raw, location: str) -> str | None:
    warning = str(raw or "").strip() or None
    if warning and _DISCLAIMER_RE.search(warning):
        # A "will not / cannot" disclaimer isn't a note about this case;
        # the prompt forbids it, but small models still write one.
        logger.info("brief: dropped disclaimer note: %s", warning[:160])
        return None
    if warning and not location and _LOCATION_NOTE_RE.search(warning):
        # The prompt no longer asks about location when there is none,
        # but a model can still volunteer "no location was provided".
        logger.info("brief: dropped location note with location off: %s", warning[:160])
        return None
    return warning


def _prompt_fields(
    agent_type, keywords, location, agent_name, prior_question, prior_answer,
    max_delegations, behaviors, traits,
) -> dict:
    """Every placeholder the brief prompt pieces use, for the one-call brief
    and each stage of the streamed one alike."""
    prior_qa = ""
    if prior_question and prior_answer:
        prior_qa = (
            f'You previously asked: "{prior_question}" — the user answered: '
            f'"{prior_answer}". Use that answer now; write the brief this '
            f'time rather than asking again, unless the answer itself opens '
            f'up a genuinely new, different ambiguity.\n'
        )

    location_clause = f" in {location}" if location else ""
    # No location at all: say nothing about it, or the model spends a
    # sentence on "with no location specified".
    location_line = f"Location focus: {location}\n" if location else ""
    location_rule = (
        f" A location ({location}) only belongs where it genuinely shapes the work."
        if location else " The agent is not location-bound: never mention location."
    )
    # Location only comes up as a question or a note when one was given and
    # is unclear. With none, the user switched it off (or never set one) on
    # purpose: a "no location was provided" note is just wrong.
    location_question = ", or a location need that isn't clear" if location else ""
    location_bullet = (
        f'- A specialty that needs a narrower area than "{location}" to mean anything '
        '(e.g. "local events" for a whole country).\n'
        if location else ""
    )
    return dict(
        agent_type=agent_type or "general",
        agent_name=agent_name or "Agent",
        keywords=", ".join(keywords) if keywords else "(none yet)",
        location_line=location_line,
        location_rule=location_rule,
        location_question=location_question,
        location_bullet=location_bullet,
        behaviors=", ".join(behaviors) if behaviors else "(none)",
        traits=", ".join(traits) if traits else "(none)",
        location_clause=location_clause,
        prior_qa=prior_qa,
        max_delegations=max_delegations or 3,
        case_type_rule=_case_type_rule(agent_type),
        # Only listed when it's actually true: an always-present topic-count
        # rule got applied to two-topic cases too.
        topic_count_bullet=_topic_count_bullet(len(keywords), max_delegations or 3),
    )


_MAP_PROMPT = """Below is the brief an AI agent wrote about a commission it is about to take on. Draw that same brief as a flow chart the user sees beside it. Short plain phrases (under ~14 words each), synthesised from the brief, never a copy of the keyword list.

Agent type: {agent_type}
Specialties/keywords: {keywords}

<brief>
{brief}
</brief>

Return:
- "ask": what the user is commissioning, in one line.
- "understood": 2-4 instructions the agent takes from it and holds itself to (its angle, its scope, what its traits and behaviors make it do).
- "work": 2-5 lines of work it will actually split the job into (an angle or a worker each, the split the brief's last paragraph describes), each {{"label": "2-5 word title", "detail": "one line on what that branch digs into"}}.
- "result": the finished thing it hands back, in one line.

Respond with ONLY raw JSON, no markdown code fences, no other text:
{{"ask": "...", "understood": ["..."], "work": [{{"label": "...", "detail": "..."}}], "result": "..."}}
"""


def generate_brief_map(
    brief_text: str,
    keywords: list[str],
    agent_type: str | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> dict | None:
    """Second, separate call after the brief text: turns the finished brief
    into BriefGraph's flow. Split from generate_brief so the text never waits
    on (or dies with) the graph. Returns None on any failure, meaning just
    no graph."""
    brief_text = (brief_text or "").strip()
    if not brief_text:
        return None
    prompt = _MAP_PROMPT.format(
        agent_type=agent_type or "general",
        keywords=", ".join(keywords) if keywords else "(none)",
        brief=brief_text[:4000],
    )
    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=4000,  # headroom for Gemini thinking, as above
            temperature=0.4,
            messages=[{"role": "user", "content": prompt}],
        )
        choice = response.choices[0]
        raw = (choice.message.content or "").strip()
        if choice.finish_reason == "length":
            logger.warning("brief map: reply hit max_tokens (%d chars)", len(raw))
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        brief_map = _brief_map(json.loads(raw, strict=False))
        if brief_map is None:
            logger.warning("brief map: reply had no usable ask/work/result")
        return brief_map
    except Exception as e:
        logger.warning("brief map: generation failed (%s): %s", provider or "default", e)
        return None


# ---------------------------------------------------------------------------
# The staged brief (POST /brief-stream). The one-call brief writes three
# paragraphs, the note and the media offers in one long reply, then a second
# call draws the graph from it, with nothing on screen until both finish.
# Here the same instructions (the prompt pieces above) are split into four
# smaller calls, streamed as each lands:
#   read      - question or go ahead, the note, media offers   } run at
#   focus     - paragraph 1                                     } the same
#   character - paragraph 2                                     } time
#   plan      - paragraph 3 and the graph, written after reading 1 and 2
# A question from "read" wins and the paragraphs are dropped. A "thin" case,
# or any paragraph failing, falls back to the one-call brief and graph.
# ---------------------------------------------------------------------------

_READ_PART = """Your part of this brief: decide how to proceed, add any note, and offer media. Other writers are drafting the brief's paragraphs at the same time, so do not write them.

Choose "type":
- "question": the clarifying-question rule above applies. Put the ONE question in "text".
- "thin": RARE. Only when the specialties together give you genuinely nothing to analyse (a single generic word, or terms you cannot place at all) and no single question would fix it. Leave "text" empty.
- "brief": everything else, which is almost every set of two or more specific specialties. Leave "text" empty.

"""

_READ_FORMAT = """Respond with ONLY raw JSON, no markdown code fences, no other text:
{{"type": "brief" or "question" or "thin", "text": "..." or "", "warning": "..." or null, "relics": [{{"kind": "...", "reason": "..."}}]}}
"""

_PARAGRAPH_PART = """The brief is third person, about 8-11 sentences over three paragraphs, and each paragraph is drafted by a different writer at the same time. Write ONLY the paragraph described below; the others are covered, so stay inside its remit.

"""

_PARAGRAPH_FORMAT = """Write {sentences} sentences. Reply with the paragraph only: plain prose, no heading, no label, no quotes, no JSON, no markdown.
"""

_PLAN_PART = """The first two paragraphs of the brief are written:

<paragraph_1>
{p1}
</paragraph_1>

<paragraph_2>
{p2}
</paragraph_2>

Write paragraph 3 so it follows on from them without repeating what they say.

"""

_PLAN_MAP = """Then draw the whole brief (all three paragraphs) as a flow chart the user sees beside it. Short plain phrases (under ~14 words each), synthesised from the brief, never a copy of the keyword list:
- "ask": what the user is commissioning, in one line.
- "understood": 2-4 instructions the agent takes from it and holds itself to (its angle, its scope, what its traits and behaviors make it do).
- "work": 2-5 lines of work it will actually split the job into (an angle or a worker each, the split paragraph 3 describes), each {{"label": "2-5 word title", "detail": "one line on what that branch digs into"}}.
- "result": the finished thing it hands back, in one line.

Respond with ONLY raw JSON, no markdown code fences, no other text:
{{"text": "paragraph 3", "map": {{"ask": "...", "understood": ["..."], "work": [{{"label": "...", "detail": "..."}}], "result": "..."}}}}
"""

_READ_PROMPT = _CASE_PROMPT + _ASK_RULE + "{case_type_rule}\n" + _READ_PART + _NOTE_RULE + _RELICS_RULE + _READ_FORMAT
_FOCUS_PROMPT = _CASE_PROMPT + "{case_type_rule}\n" + _PARAGRAPH_PART + _P1_RULE + _PARAGRAPH_FORMAT
_CHARACTER_PROMPT = _CASE_PROMPT + "{case_type_rule}\n" + _PARAGRAPH_PART + _P2_RULE + _PARAGRAPH_FORMAT
_PLAN_PROMPT = _CASE_PROMPT + "{case_type_rule}\n" + _PLAN_PART + _P3_RULE + _PLAN_MAP


def _parse_json(raw: str) -> dict:
    """The first JSON object in a reply. Models sometimes add a second
    object or a closing remark after it; json.loads rejected the whole reply
    for that ("Extra data")."""
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    start = raw.find("{")
    if start < 0:
        raise ValueError("no JSON object in reply")
    data, _ = json.JSONDecoder(strict=False).raw_decode(raw[start:])
    if not isinstance(data, dict):
        raise ValueError("reply was not a JSON object")
    return data


def _paragraph(raw: str) -> str:
    """One plain paragraph from a reply: no fences, label or stray breaks."""
    text = raw.strip().strip("`").strip()
    text = re.sub(r"^(?:#+\s*)?(?:\*\*)?paragraph\s*\d\s*[:.\-—]*(?:\*\*)?\s*", "", text, flags=re.IGNORECASE)
    text = " ".join(line.strip() for line in text.splitlines() if line.strip())
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].strip()
    return text


def _stage_call(stage: str, prompt: str, provider, model, max_tokens: int, temperature: float) -> str:
    response = create_chat_completion(
        provider=provider,
        model=model,
        _trace=f"brief {stage}",
        # Headroom for Gemini 3.x thinking, as in generate_brief.
        max_tokens=max_tokens,
        temperature=temperature,
        messages=[{"role": "user", "content": prompt}],
    )
    choice = response.choices[0]
    raw = (choice.message.content or "").strip()
    if choice.finish_reason == "length":
        logger.warning("brief %s: reply hit max_tokens (%d chars)", stage, len(raw))
    return raw


def generate_brief_stream(
    agent_type: str | None,
    keywords: list[str],
    location: str,
    agent_name: str,
    provider: str | None = None,
    model: str | None = None,
    prior_question: str | None = None,
    prior_answer: str | None = None,
    max_delegations: int | None = None,
    behaviors: list[str] | None = None,
    traits: list[str] | None = None,
):
    """Yields NDJSON-ready events:
      {"type": "stage", "stage": "read"|"focus"|"character"|"plan", "state": "active"|"done"|"failed", "ms"?}
      {"type": "part", "part": "focus"|"character"|"plan", "text": "..."}
      {"type": "fallback", "message": "..."}
      {"type": "done", "brief": <generate_brief's shape>, "map": <BriefGraph map> | None}
      {"type": "error", "message": "..."}
    """
    fields = _prompt_fields(
        agent_type, keywords, location, agent_name, prior_question, prior_answer,
        max_delegations, behaviors, traits,
    )
    started = time.monotonic()

    def timed(stage, prompt, max_tokens, temperature):
        t0 = time.monotonic()
        raw = _stage_call(stage, prompt, provider, model, max_tokens, temperature)
        return raw, int((time.monotonic() - t0) * 1000)

    def fallback(reason: str):
        logger.info("brief stream: falling back to the one-call brief (%s)", reason)
        yield {"type": "fallback", "message": "Writing the brief in one go instead…"}
        brief = generate_brief(
            agent_type, keywords, location, agent_name, provider, model,
            prior_question, prior_answer, max_delegations, behaviors, traits,
        )
        if brief is None:
            yield {"type": "error", "message": "Could not generate a brief"}
            return
        brief_map = None
        if brief["type"] == "brief":
            yield {"type": "stage", "stage": "plan", "state": "active"}
            brief_map = generate_brief_map(brief["text"], keywords, agent_type, provider, model)
            yield {"type": "stage", "stage": "plan", "state": "done" if brief_map else "failed"}
        yield {"type": "done", "brief": brief, "map": brief_map}

    jobs = {
        "read": (_READ_PROMPT.format(**fields), 4000, 0.4),
        "focus": (_FOCUS_PROMPT.format(**fields, sentences="3 to 4"), 3000, 0.6),
        "character": (_CHARACTER_PROMPT.format(**fields, sentences="2 to 4"), 3000, 0.6),
    }
    for stage in jobs:
        yield {"type": "stage", "stage": stage, "state": "active"}

    read = None
    paragraphs: dict[str, str] = {}
    failed: str | None = None
    # Not a `with` block: a question from "read" returns at once, without
    # waiting on paragraphs that will be thrown away.
    pool = ThreadPoolExecutor(max_workers=len(jobs))
    try:
        futures = {pool.submit(timed, stage, *job): stage for stage, job in jobs.items()}
        for future in as_completed(futures):
            stage = futures[future]
            try:
                raw, ms = future.result()
                if stage == "read":
                    read = _parse_json(raw)
                else:
                    text = _paragraph(raw)
                    if not text:
                        raise ValueError("empty paragraph")
                    paragraphs[stage] = text
            except Exception as e:
                logger.warning("brief %s: failed (%s): %s", stage, provider or "default", e)
                yield {"type": "stage", "stage": stage, "state": "failed"}
                if stage != "read":
                    failed = failed or stage
                continue
            yield {"type": "stage", "stage": stage, "state": "done", "ms": ms}
            if stage == "read" and read.get("type") == "question" and str(read.get("text") or "").strip():
                yield {"type": "done", "brief": {
                    "type": "question",
                    "text": str(read["text"]).strip(),
                    "warning": _clean_warning(read.get("warning"), location),
                    "relics": [],
                }, "map": None}
                return
            if stage != "read":
                yield {"type": "part", "part": stage, "text": paragraphs[stage]}
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    if read is not None and read.get("type") == "thin":
        yield from fallback("thin case")
        return
    if failed:
        yield from fallback(f"{failed} failed")
        return

    # A failed "read" isn't fatal: the brief just has no note or media
    # offers, and Setup shows its code-checked note instead.
    warning = _clean_warning(read.get("warning"), location) if read else None
    relics = _relic_suggestions(read.get("relics")) if read else []

    yield {"type": "stage", "stage": "plan", "state": "active"}
    plan_prompt = _PLAN_PROMPT.format(**fields, p1=paragraphs["focus"], p2=paragraphs["character"])
    try:
        raw, ms = timed("plan", plan_prompt, 4000, 0.5)
        plan = _parse_json(raw)
        p3 = _paragraph(str(plan.get("text") or ""))
        if not p3:
            raise ValueError("no paragraph 3")
    except Exception as e:
        logger.warning("brief plan: failed (%s): %s", provider or "default", e)
        yield {"type": "stage", "stage": "plan", "state": "failed"}
        yield from fallback("plan failed")
        return
    brief_map = _brief_map(plan.get("map"))
    yield {"type": "stage", "stage": "plan", "state": "done", "ms": ms}
    yield {"type": "part", "part": "plan", "text": p3}
    logger.info("brief stream: done in %d ms", int((time.monotonic() - started) * 1000))
    yield {"type": "done", "brief": {
        "type": "brief",
        "text": "\n\n".join([paragraphs["focus"], paragraphs["character"], p3]),
        "warning": warning,
        "relics": relics,
    }, "map": brief_map}


# Setup's Outputs step: what the agent proposes to hand back for this job.
# Unlike BRIEF_RELIC_KINDS these are produced after research, so a chart or
# spreadsheet (which need real numbers) are fair game.
OUTPUT_KINDS = ("csv", "chart", "diagram", "markdown", "pdf", "docx", "slides", "json")

_OUTPUTS_PROMPT = """You are an AI agent about to start a job. Before starting, propose the
finished outputs (deliverables) you would hand back to the user for this job,
judged by what would actually be most useful to them, not a generic list.

Focus topics (the job): {keywords}
Agent type: {agent_type}
Personality: {traits}
Behaviour: {behaviors}
Brief the user has read:
{brief}

Allowed kinds:
- csv: a spreadsheet of rows (comparisons, timelines, inventories of sources or facts)
- chart: a chart of real numbers found during research
- diagram: a Mermaid diagram (process, structure, relationships, timeline)
- markdown: a written report
- pdf: a polished printable report
- docx: an editable Word document
- slides: a short slide deck
- json: structured data for another program

Return ONLY JSON, no prose, in this shape:
{{"outputs": [{{"kind": "<one allowed kind>", "title": "<short specific title, max 8 words>", "reason": "<one sentence: why this output suits this job>", "recommended": true}}]}}

Rules:
- Propose 3 to 5 outputs, each a different kind.
- Titles name this job's actual subject, never a generic label like "Report".
- Mark the 1 or 2 you judge most useful "recommended": true, the rest false.
"""


def _output_proposals(raw) -> list[dict]:
    items = raw.get("outputs") if isinstance(raw, dict) else raw
    proposals: list[dict] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower()
        title = _clip(item.get("title"), 80)
        if kind not in OUTPUT_KINDS or not title or any(p["kind"] == kind for p in proposals):
            continue
        proposals.append({
            "kind": kind,
            "title": title,
            "reason": _clip(item.get("reason"), 200),
            "recommended": bool(item.get("recommended")),
        })
    return proposals[:5]


def propose_outputs(
    keywords: list[str],
    brief_text: str = "",
    agent_type: str | None = None,
    traits: list[str] | None = None,
    behaviors: list[str] | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> list[dict] | None:
    """Setup's Outputs step: 3-5 deliverables the agent proposes for this
    job, each {kind, title, reason, recommended}. None on failure, so the
    step can fall back to letting the user pick kinds by hand."""
    if not keywords:
        return None
    prompt = _OUTPUTS_PROMPT.format(
        keywords=", ".join(str(k) for k in keywords)[:600],
        agent_type=agent_type or "general",
        traits=", ".join(traits or []) or "(none)",
        behaviors=", ".join(behaviors or []) or "(none)",
        brief=(brief_text or "(not written yet)").strip()[:3000],
    )
    try:
        response = create_chat_completion(
            provider=provider,
            model=model,
            max_tokens=4000,  # headroom for Gemini thinking, as above
            temperature=0.5,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = (response.choices[0].message.content or "").strip()
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        proposals = _output_proposals(json.loads(raw, strict=False))
        if not proposals:
            logger.warning("brief outputs: reply had no usable outputs")
            return None
        if not any(p["recommended"] for p in proposals):
            proposals[0]["recommended"] = True
        return proposals
    except Exception as e:
        logger.warning("brief outputs: generation failed (%s): %s", provider or "default", e)
        return None
