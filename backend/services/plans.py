"""
Plan / chat orchestration -- the glue between Flask routes and the Gradient
AI agent. Response shapes here are written to match the frontend team's
handoff doc EXACTLY (field names, nesting, enum values), since the frontend
is already built against that contract and does not tolerate reshaping.

This module does not contain the agent's own reasoning (that lives in the
Gradient AI system prompt) -- it only builds requests, parses replies, and
provides a placeholder fallback so every route works before the agent is
connected.
"""

import json
import logging
import re
from datetime import datetime, timedelta

from services import gradient
from services import markdown_parser as mdp

log = logging.getLogger("graceperiod.plans")

GRACE_PERIOD_DAYS = 60

# These prompts intentionally do NOT ask for JSON. Live testing confirmed
# the agent's own (already-deployed) system prompt always replies with its
# fixed Markdown report format for these two request types -- "Provide the
# full structured output as defined in your instructions" reliably produces
# the real 8-section report / one-page summary. services/markdown_parser.py
# turns that Markdown into the frontend's exact JSON contract.
_PLAN_INSTRUCTION = "Provide the full structured output as defined in your instructions."
_ATTORNEY_INSTRUCTION = (
    "Provide ONLY the one-page attorney consultation summary format defined in "
    "your instructions (CLIENT SITUATION, KEY DATES, OPTIONS ALREADY IDENTIFIED, "
    "SPECIFIC QUESTIONS FOR THE ATTORNEY) -- not the full 60-day action plan."
)

_CONSIDERING_LABELS = {
    "new-employer": "a new H-1B employer / transfer",
    "change-status": "a change of status",
    "not-sure": "not sure yet which option to pursue",
}


def _parse_date(value):
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(str(value).strip(), fmt).date()
        except ValueError:
            continue
    return None


def grace_period_end(layoff_date):
    d = _parse_date(layoff_date)
    return (d + timedelta(days=GRACE_PERIOD_DAYS)).isoformat() if d else None


# --------------------------------------------------------------------------- #
# Plan generation
# --------------------------------------------------------------------------- #

def build_plan(payload):
    """
    Return the full plan dict for /api/generate-plan and /api/upload-document.

    `payload` uses the FRONTEND's field names: layoffDate, visaExpiry,
    hasDependents, considering, language, tone. Calls the real agent when
    configured; otherwise returns a placeholder in the same shape.
    """
    if gradient.is_configured():
        prompt = _plan_prompt(payload)
        try:
            text, citation_files = gradient.complete_with_citations(prompt)
            parsed = mdp.parse_plan_markdown(text)
            parsed["citations"] = citation_files
            return parsed
        except gradient.GradientError:
            log.exception("Agent plan call failed; returning placeholder")

    return _placeholder_plan(payload)


def build_attorney_summary(payload):
    """Return { summary: {...} } for /api/attorney-summary."""
    if gradient.is_configured():
        prompt = f"{_ATTORNEY_INSTRUCTION}\n\nUser situation:\n{_situation_block(payload)}"
        try:
            text, _citations = gradient.complete_with_citations(prompt)
            summary = mdp.parse_attorney_markdown(text)
            if summary.get("clientSituation"):
                return {"summary": summary}
        except gradient.GradientError:
            log.exception("Agent attorney-summary call failed; returning placeholder")

    return {"summary": _placeholder_attorney_summary(payload)}


def build_chat_reply(message, history=None):
    """
    Return { reply: str, extractedFields: {...} } for POST /api/chat.

    The chat call does TWO jobs in one round-trip: answer the user
    conversationally, AND pull any personal details they mentioned
    ("my name is X, I live at Y") out into structured fields the frontend
    can offer to auto-fill into the form.

    Implementation notes (from live testing against the real agent):
      * We append a delimited-format instruction (REPLY: / EXTRACTED:) to the
        latest user turn rather than requesting pure JSON -- asking this agent
        for JSON-only makes the conversational half stiff, and the delimited
        format survives the agent adding stray text around it.
      * Conversation `history` is still sent as real multi-turn messages, so
        the agent keeps context; only the newest turn carries the instruction.
      * The agent frequently OMITS the EXTRACTED section entirely when there's
        nothing to extract (rather than emitting `{}`), so a missing section
        must parse as {} -- not as an error.
    """
    history = history or []
    messages = [
        {"role": h.get("role", "user"), "content": h.get("text", "")}
        for h in history if h.get("text")
    ]
    messages.append({"role": "user", "content": message + _EXTRACTION_INSTRUCTION})

    if gradient.is_configured():
        try:
            raw = gradient.chat(messages)
            reply, extracted = _parse_chat_response(raw)
            return {"reply": reply, "extractedFields": extracted}
        except gradient.GradientError:
            log.exception("Agent chat call failed; returning placeholder")

    return {
        "reply": _placeholder_chat_reply(message),
        "extractedFields": {},
    }


# Appended to the newest user turn only. The "do not mention this section"
# line keeps the agent from narrating the machinery back to the user.
_EXTRACTION_INSTRUCTION = """

---
SYSTEM TASK (do not mention this section to the user):
Respond naturally to the user's message above as you normally would.
SEPARATELY, check whether their message states any of these personal details:
full legal name, date of birth, country of birth, current U.S. address, or
alien registration number (A-number).

Output in this EXACT format:
REPLY: <your normal conversational response>
EXTRACTED: <a JSON object with any of these keys found: legalName, dateOfBirth, countryOfBirth, currentAddress, alienNumber. Use {} if none were mentioned. Only include a key if that detail was actually stated in the message.>"""

# Only these keys are passed through to the frontend; anything else the agent
# invents is dropped rather than silently populating unknown form fields.
_ALLOWED_EXTRACTED_KEYS = {
    "legalName", "dateOfBirth", "countryOfBirth", "currentAddress", "alienNumber",
}


def _parse_chat_response(raw_text):
    """
    Split the agent's reply into (reply_text, extracted_fields).

    Defensive by design:
      * A missing EXTRACTED: section -> {} (the agent often omits it entirely
        when nothing was mentioned -- confirmed live).
      * Malformed JSON -> {} rather than raising.
      * The whole response with no REPLY: marker -> treat it all as the reply,
        so the user still sees an answer.
    """
    raw = (raw_text or "").strip()

    reply_match = re.search(r"REPLY:\s*(.*?)(?=\n\s*EXTRACTED:|$)", raw, re.DOTALL | re.IGNORECASE)
    reply = reply_match.group(1).strip() if reply_match else raw

    # Strip a trailing EXTRACTED block if it leaked into the reply text.
    reply = re.sub(r"\n?\s*EXTRACTED:.*$", "", reply, flags=re.DOTALL | re.IGNORECASE).strip()
    reply = re.sub(r"\[\[C\d+\]\]", "", reply).strip()  # inline citation markers

    extracted = {}
    ext_match = re.search(r"EXTRACTED:\s*(\{.*\})", raw, re.DOTALL | re.IGNORECASE)
    if ext_match:
        try:
            parsed = json.loads(ext_match.group(1))
            if isinstance(parsed, dict):
                extracted = parsed
        except (json.JSONDecodeError, ValueError):
            log.warning("Could not parse EXTRACTED JSON from chat response")

    return reply, _normalize_extracted(extracted)


def _normalize_extracted(raw):
    """
    Keep only recognized keys with non-empty values, and normalize dates.

    Date normalization matters: the agent returns natural language it heard
    ("March 15 2006"), but the form fields and the I-539 auto-fill expect
    YYYY-MM-DD. Without this, a voice-filled date would silently fail to
    populate the PDF.
    """
    out = {}
    for key, value in (raw or {}).items():
        if key not in _ALLOWED_EXTRACTED_KEYS:
            continue
        if value in (None, "", {}, []):
            continue
        text = str(value).strip()
        if not text or text.lower() in ("null", "none", "n/a", "unknown"):
            continue
        if key == "dateOfBirth":
            text = _normalize_dob(text) or text
        out[key] = text
    return out


_DOB_FORMATS = (
    "%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y",
    "%B %d %Y", "%B %d, %Y", "%b %d %Y", "%b %d, %Y",
    "%d %B %Y", "%d %b %Y",
)


def _normalize_dob(text):
    """Natural-language or US date -> YYYY-MM-DD. Returns None if unparseable."""
    cleaned = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", text.strip(), flags=re.IGNORECASE)
    for fmt in _DOB_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt).date().isoformat()
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------- #
# Prompt construction (what we send TO the agent)
# --------------------------------------------------------------------------- #

def _situation_block(p):
    considering = _CONSIDERING_LABELS.get(p.get("considering"), p.get("considering", "not sure yet"))
    return (
        f"Layoff date: {p.get('layoffDate')}\n"
        f"Visa expiry: {p.get('visaExpiry')}\n"
        f"Visa type: {p.get('visaType', 'H-1B')}\n"
        f"Has H-4 dependents: {p.get('hasDependents')}\n"
        f"Considering: {considering}\n"
        f"Language: {p.get('language', 'english')}\n"
        f"Tone: {'Quick & Calm' if p.get('tone') == 'quick' else 'Full Detail'}"
    )


def _plan_prompt(p):
    return (
        f"Generate the personalized action plan for this H-1B layoff situation.\n\n"
        f"{_situation_block(p)}\n\n"
        f"Grace period end date (computed): {grace_period_end(p.get('layoffDate'))}\n\n"
        f"{_PLAN_INSTRUCTION}"
    )


# --------------------------------------------------------------------------- #
# Response normalization (what we return to the frontend)
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# Placeholders (used only until the agent is connected) -- NOT the AI's
# output. Real date math only; text is obviously a stub.
# --------------------------------------------------------------------------- #

def _placeholder_plan(p):
    end = grace_period_end(p.get("layoffDate")) or "your grace-period end date"
    considering = _CONSIDERING_LABELS.get(p.get("considering"), "your options")
    stub = "[placeholder — connect the Gradient AI agent to populate this]"

    week_labels = ["Week 1 (Days 1-7)", "Week 2 (Days 8-14)",
                  "Week 3 (Days 15-21)", "Week 4 (Days 22-28)"]
    action_plan = [
        {
            "week": label,
            "steps": [
                {"text": f"{label} step 1 {stub}", "flag": "DIY"},
                {"text": f"{label} step 2 {stub}",
                 "flag": "DIY" if i < 2 else "NEEDS ATTORNEY"},
            ],
        }
        for i, label in enumerate(week_labels)
    ]
    # "Quick & Calm" -> immediate next steps only (Week 1).
    if p.get("tone") == "quick":
        action_plan = action_plan[:1]

    return {
        "situationSummary": (
            f"Based on a layoff date of {p.get('layoffDate')}, your 60-day grace "
            f"period ends on {end}. You indicated you're considering {considering}. {stub}"
        ),
        "options": [
            {"name": "H-1B Transfer", "description": stub},
            {"name": "Change of Status", "description": stub},
            {"name": "Departure / Reentry", "description": stub},
        ],
        "scenarios": [
            {"name": "H-1B Transfer", "timeline": "1-4 weeks", "risk": "Medium",
             "pros": [stub], "cons": [stub]},
            {"name": "Change of Status", "timeline": "varies", "risk": "Medium",
             "pros": [stub], "cons": [stub]},
            {"name": "Departure / Reentry", "timeline": "by day 60", "risk": "Low",
             "pros": [stub], "cons": [stub]},
        ],
        "actionPlan": action_plan,
        "citations": [f"8 CFR 214.1(l)(2) {stub}"],
        "keyDeadlines": [
            {"date": end, "title": "Grace period ends",
             "description": "Last day of the 60-day grace period."},
        ],
        "_note": "PLACEHOLDER response — Gradient AI agent not configured. "
                 "Set GRADIENT_ENDPOINT and GRADIENT_API_KEY to get real content.",
    }


def _placeholder_attorney_summary(p):
    end = grace_period_end(p.get("layoffDate")) or "TBD"
    return {
        "clientSituation": f"H-1B holder, laid off {p.get('layoffDate')}, "
                           f"grace period ends {end}. [placeholder]",
        "keyDates": f"Visa expiry {p.get('visaExpiry')}; grace period ends {end}. [placeholder]",
        "optionsIdentified": "[connect Gradient AI agent for real options]",
        "questions": [
            "[placeholder question 1 — connect Gradient AI agent]",
            "[placeholder question 2 — connect Gradient AI agent]",
            "[placeholder question 3 — connect Gradient AI agent]",
        ],
    }


def _placeholder_chat_reply(message):
    return (
        "[placeholder reply — connect the Gradient AI agent to answer live] "
        f'You asked: "{message}". Once GRADIENT_ENDPOINT / GRADIENT_API_KEY are '
        "set, this will be answered from the same USCIS knowledge base as your action plan."
    )
