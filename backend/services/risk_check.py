"""
Two-pass risk-check pipeline (Auditor -> Attorney).

This is a backend-orchestrated reasoning pipeline, not two agents: the SAME
Gradient AI agent (same knowledge base) is called twice in sequence with
different instructions, and the second call's prompt is constructed
dynamically from the first call's output.

    Pass 1 (Auditor):   "find every legal risk in this plan, be harsh"
                          -> a structured list of risks
    Pass 2 (Attorney):  "here are the risks just found: <pass 1 output>,
                         now mitigate them"
                          -> one calm, reassuring mitigation paragraph

Why it's worth the extra latency: the mitigation is grounded in risks the
model actually surfaced against the USCIS knowledge base, rather than
generic reassurance. A single call cannot do this -- pass 2 literally
cannot exist without pass 1's output.

Tone note: the Auditor is deliberately harsh (that's its job -- it must find
real problems). The Attorney output is the calm prose actually shown
prominently to a stressed user; the harsh risk list is secondary, displayed
in a clearly-labeled debate log.
"""

import json
import logging
import re

from services import gradient

log = logging.getLogger("graceperiod.riskcheck")

_VALID_SEVERITIES = {"high", "medium"}

# Cap on risks returned. The agent reliably produces 4-6; the frontend's
# badge list gets cluttered past ~4, and zero looks broken.
_MAX_RISKS = 4


def _auditor_prompt(scenario, layoff_date, visa_expiry, has_dependents):
    return f"""You are acting as a strict USCIS compliance auditor reviewing a proposed immigration plan. Your only job is to find legal risks, timing vulnerabilities, or status violation risks in the plan below. Be specific and harsh - cite exact regulations or deadlines from the knowledge base where risks exist. Do not soften your findings.

PLAN UNDER REVIEW:
Scenario: {scenario}
Layoff date: {layoff_date}
Visa expiry: {visa_expiry}
Has H-4 dependents: {has_dependents}

Output your findings as a JSON array of risk objects, each with:
- "severity": either "high" or "medium"
- "issue": a specific, concrete description of the risk

Output ONLY the JSON array, no other text."""


def _attorney_prompt(risks):
    return f"""You are acting as an immigration strategist defending and refining a client's plan. Here is a risk audit that was just generated for their plan:

{json.dumps(risks, indent=2)}

For each risk listed, address it directly and provide a specific, concrete mitigation strategy or safe harbor, grounded in the knowledge base where applicable. Then synthesize this into ONE final paragraph (2-4 sentences) describing the risk-mitigated version of the plan. Write it as calm, reassuring, actionable prose - this will be shown directly to a stressed user.

Output ONLY that final paragraph, no other text, no lists, no headers."""


def _extract_risk_array(text):
    """
    Pull a JSON array of risks out of the agent's reply.

    Defensive because LLM JSON output is the fragile part of this pipeline:
    tolerates ```json code fences, leading/trailing prose, and a single
    object instead of an array. Raises ValueError if nothing usable is found,
    so the caller can fall back gracefully rather than 500.
    """
    if isinstance(text, list):
        return text
    raw = (text or "").strip()

    # Strip markdown code fences.
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        raw = re.sub(r"```$", "", raw).strip()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]", raw, re.DOTALL)  # outermost array
        if not match:
            raise ValueError("no JSON array found in auditor output")
        parsed = json.loads(match.group())

    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        raise ValueError("auditor output was not a list")
    return parsed


def _normalize_risks(raw_risks):
    """Coerce to exactly {severity: "high"|"medium", issue: str}, drop junk."""
    out = []
    for item in raw_risks:
        if not isinstance(item, dict):
            continue
        issue = str(item.get("issue") or "").strip()
        if not issue:
            continue
        severity = str(item.get("severity") or "").strip().lower()
        if severity not in _VALID_SEVERITIES:
            # Anything unexpected ("low", "critical", missing) becomes
            # "medium" -- the frontend only renders high/medium badges.
            severity = "high" if "high" in severity or "critical" in severity else "medium"
        out.append({"severity": severity, "issue": issue})

    # Show the most serious findings first, then cap.
    out.sort(key=lambda r: 0 if r["severity"] == "high" else 1)
    return out[:_MAX_RISKS]


_FALLBACK_RISKS = [{
    "severity": "medium",
    "issue": "Unable to complete full risk analysis — recommend attorney review.",
}]


def run_risk_check(scenario, layoff_date=None, visa_expiry=None, has_dependents=False):
    """
    Run both passes and return { risks: [...], mitigatedPlan: str }.

    Never raises: if either pass fails, returns a safe, honest fallback so a
    live demo degrades instead of erroring.
    """
    if not gradient.is_configured():
        return _placeholder(scenario)

    # ---------- PASS 1: The Auditor ----------
    try:
        auditor_raw = gradient.complete(
            _auditor_prompt(scenario, layoff_date, visa_expiry, has_dependents),
            want_json=False,   # we want the raw array text, not a JSON object envelope
            temperature=0.2,
        )
        risks = _normalize_risks(_extract_risk_array(auditor_raw))
        if not risks:
            raise ValueError("auditor returned no usable risks")
    except (gradient.GradientError, ValueError, json.JSONDecodeError):
        log.exception("Risk-check auditor pass failed")
        return {
            "risks": _FALLBACK_RISKS,
            "mitigatedPlan": (
                "We couldn't complete the automated risk analysis for this option. "
                "This doesn't mean the path is unsafe — it means it should be reviewed "
                "with a licensed immigration attorney before you act on it."
            ),
        }

    # ---------- PASS 2: The Attorney ----------
    # Prompt is built dynamically from pass 1's output -- this is the pipeline.
    try:
        mitigated = gradient.complete(
            _attorney_prompt(risks), want_json=False, temperature=0.3,
        )
        mitigated = _clean_prose(mitigated)
    except gradient.GradientError:
        log.exception("Risk-check attorney pass failed")
        mitigated = (
            "We identified the risks above but couldn't generate a mitigation "
            "strategy automatically. Bring this risk list to an immigration "
            "attorney — it will make your consultation faster and more focused."
        )

    return {"risks": risks, "mitigatedPlan": mitigated}


def _clean_prose(text):
    """The attorney pass should be flowing prose. Strip stray markdown/headers
    in case the agent adds them despite the instruction."""
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:\w+)?|```$", "", raw).strip()
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    # Drop any leading markdown heading or bolded label line.
    lines = [ln for ln in lines if not re.match(r"^#{1,6}\s|^\*\*[^*]+\*\*:?$", ln)]
    cleaned = " ".join(lines)
    cleaned = re.sub(r"\[\[C\d+\]\]", "", cleaned)   # inline citation markers
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def _placeholder(scenario):
    stub = "[placeholder — connect the Gradient AI agent for real analysis]"
    return {
        "risks": [
            {"severity": "high", "issue": f"Timing risk for '{scenario}'. {stub}"},
            {"severity": "medium", "issue": f"Status-maintenance risk. {stub}"},
        ],
        "mitigatedPlan": (
            f"{stub} Once the Gradient AI agent is configured, this will contain a "
            "risk-mitigated strategy generated from the audit findings above."
        ),
    }
