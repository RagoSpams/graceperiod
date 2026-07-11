"""
Parser for the Gradient AI agent's real output format.

The agent's system prompt is fixed (already deployed) and, for the full plan
and attorney-summary requests, always replies with a structured Markdown
report rather than JSON -- confirmed by live testing against the real
endpoint. This module turns that Markdown into the exact shape the frontend
expects.

Observed real format (verified live, not guessed):
  - Section headers are plain numbered/all-caps lines, e.g.
    "1. SITUATION SUMMARY", "2. YOUR OPTIONS (explained in plain language)",
    "60-DAY ACTION PLAN" -- NOT "### N. HEADER" markdown headers.
  - "SCENARIO COMPARISON DATA" and "KEY DEADLINES" are markdown tables.
  - "60-DAY ACTION PLAN" groups steps under free-text period labels like
    "Week 1-2 (Jul 10-Jul 23):" or "Final days (Sep 4-Sep 8):" (not always
    literally "Week N"), with bullets like "- [DIY] ..." or compound tags
    like "[DIY/NEEDS ATTORNEY]" and "[DIY/EMPLOYER]".
  - Inline citation markers look like "[[C1]][[C2]]" and are stripped from
    user-facing text; the real citation list comes from the API response's
    separate `citations` payload instead (see services/gradient.py), which
    is far more reliable than trying to resolve marker numbers to sources.

Because this is parsing freeform LLM prose, every parser here is written to
degrade gracefully (empty list / best-effort string) rather than raise, so a
slightly-off agent response never crashes a route mid-demo.
"""

import re

_CITATION_MARKER_RE = re.compile(r"\[\[C\d+\]\]")

_PLAN_HEADER_MAP = {
    "situationSummary": ["SITUATION SUMMARY"],
    "options": ["YOUR OPTIONS"],
    "scenarios": ["SCENARIO COMPARISON"],
    "actionPlan": ["60-DAY ACTION PLAN", "60 DAY ACTION PLAN", "ACTION PLAN"],
    "formFieldData": ["FORM FIELD DATA"],
    "keyDeadlines": ["KEY DEADLINES"],
    "nextSteps": ["IMMEDIATE NEXT STEPS", "NEXT STEPS"],
    "disclaimer": ["IMPORTANT DISCLAIMER", "DISCLAIMER"],
}

_ATTORNEY_HEADER_MAP = {
    "clientSituation": ["CLIENT SITUATION"],
    "keyDates": ["KEY DATES"],
    "optionsIdentified": ["OPTIONS ALREADY IDENTIFIED", "OPTIONS IDENTIFIED"],
    "questions": ["QUESTIONS FOR THE ATTORNEY", "SPECIFIC QUESTIONS"],
}

_HEADER_LINE_RE = re.compile(
    r"^\s*(?:\d+[\.\)]\s*)?([A-Z0-9][A-Z0-9 \-&/]{2,70})\s*(?:\(.*\))?\s*:?\s*$"
)


def _clean(text):
    """Strip inline citation markers and tidy whitespace for user-facing text."""
    text = _CITATION_MARKER_RE.sub("", text or "")
    return re.sub(r"[ \t]+", " ", text).strip()


def split_sections(text, header_map):
    """
    Split `text` into named sections using `header_map`
    (canonical_key -> list of UPPERCASE keyword substrings to match).
    Returns { canonical_key: raw_section_text }.
    """
    lines = (text or "").splitlines()
    hits = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or "|" in stripped:
            continue
        m = _HEADER_LINE_RE.match(stripped)
        if not m:
            continue
        candidate = m.group(1).strip().upper()
        for key, keywords in header_map.items():
            if any(kw in candidate for kw in keywords):
                hits.append((i, key))
                break

    sections = {}
    for idx, (line_i, key) in enumerate(hits):
        start = line_i + 1
        end = hits[idx + 1][0] if idx + 1 < len(hits) else len(lines)
        sections[key] = "\n".join(lines[start:end]).strip()
    return sections


def _parse_markdown_table(text):
    """Return (header_cells, [data_row_cells, ...]) from a markdown table, or ([], [])."""
    rows = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
            continue  # separator row
        rows.append(cells)
    if not rows:
        return [], []
    header, *data = rows
    return header, data


def _table_to_dicts(text, colmap):
    """colmap: canonical_key -> list of lowercase substrings to match against a header cell."""
    header, data = _parse_markdown_table(text)
    header_l = [h.lower() for h in header]
    idx_map = {}
    for key, keywords in colmap.items():
        for i, h in enumerate(header_l):
            if any(kw in h for kw in keywords):
                idx_map[key] = i
                break
    results = []
    for row in data:
        results.append({key: (row[i] if i < len(row) else "") for key, i in idx_map.items()})
    return results


def _normalize_risk(raw):
    raw_up = (raw or "").upper()
    for level in ("LOW", "MEDIUM", "HIGH"):
        if level in raw_up:
            return level.title()
    return "Medium"


def _split_list_cell(cell):
    raw = (cell or "").strip()
    if not raw:
        return []
    parts = re.split(r";\s*|<br\s*/?>|\n", raw, flags=re.IGNORECASE)
    out = []
    for p in parts:
        p = _clean(p).lstrip("-\u2022").strip().rstrip(".").strip()
        if p:
            out.append(p)
    return out or [_clean(raw)]


_OPTION_ALIASES = (
    # (regex to match anywhere in the option text, canonical short label)
    (r"\bh-?1b\b.*\btransfer\b|\btransfer\b.*\bh-?1b\b|\bportab", "H-1B Transfer"),
    (r"\bchange (?:of|to another|your) .*status\b|\bchange of status\b", "Change of Status"),
    (r"\badjust(?:ment)? of status\b|\bgreen card\b|\bi-?485\b", "Adjustment of Status"),
    (r"\bcompelling circumstances\b", "Compelling Circumstances EAD"),
    (r"\bdepart\b|\bleave the u\.?s\.?\b|\breentry\b|\bre-entry\b", "Departure"),
    (r"\bo-?1\b", "O-1 Visa"),
    (r"\beb-?1\b", "EB-1"),
    (r"\bf-?1\b.*\bstudent\b|\bstudent status\b", "F-1 Student Status"),
    (r"\bb-?2\b|\bvisitor status\b", "B-2 Visitor Status"),
    (r"\bh-?4\b", "H-4 Dependent Status"),
)

# Trim leading filler so "Apply for a compelling circumstances EAD" -> "Compelling Circumstances EAD"
_LABEL_FILLER_RE = re.compile(
    r"^(?:you (?:can|may|could)\s+|apply for (?:an?\s+)?|file for (?:an?\s+)?|"
    r"request (?:an?\s+)?|seek (?:an?\s+)?|consider\s+|pursue\s+)",
    re.IGNORECASE,
)

_MAX_NAME_WORDS = 5


def _shorten_option_name(text):
    """
    Produce a genuinely SHORT label (2-5 words) for an option card.

    Strategy, in priority order -- extract a real label, never slice
    mid-word:
      1. A canonical alias if the option matches a known immigration path
         ("H-1B Transfer", "Change of Status", ...). Most reliable.
      2. A parenthetical the agent supplied, e.g.
         "Transfer your H-1B to a new employer (H-1B transfer):" -> "H-1B transfer".
      3. The text before the first colon, with leading filler stripped
         ("Apply for a compelling circumstances EAD" -> "compelling circumstances EAD").
      4. Fall back to the first few WORDS (never a character slice).
    """
    body = text.strip()

    # 1. Known immigration paths -> canonical label.
    for pattern, label in _OPTION_ALIASES:
        if re.search(pattern, body, re.IGNORECASE):
            return label

    # Everything before the first colon is the agent's own label, if present.
    head = body.split(":", 1)[0].strip() if ":" in body else body

    # 2. Prefer a parenthetical inside that label -- it's usually the short name.
    paren = re.search(r"\(([^)]{2,40})\)", head)
    if paren:
        candidate = paren.group(1).strip()
        if 1 <= len(candidate.split()) <= _MAX_NAME_WORDS:
            return _titlecase(candidate)

    # 3. The label itself, minus filler verbs and any parenthetical.
    head = re.sub(r"\([^)]*\)", "", head).strip(" .,-")
    head = _LABEL_FILLER_RE.sub("", head).strip(" .,-")

    words = head.split()
    if 1 <= len(words) <= _MAX_NAME_WORDS:
        return _titlecase(head)

    # 4. Word-bounded truncation -- NEVER a mid-word character slice.
    if words:
        return _titlecase(" ".join(words[:_MAX_NAME_WORDS]))
    return "Option"


def _titlecase(s):
    """Title-case a label while preserving visa codes (H-1B, EAD, I-140, O-1)."""
    out = []
    for word in s.split():
        if re.search(r"\d", word) or word.isupper():
            out.append(word.upper() if len(word) <= 4 and word.isalpha() else word)
        else:
            out.append(word.capitalize())
    return " ".join(out)


def _parse_options(section_text):
    """
    Each option -> { name: SHORT label, description: full sentence }.

    The name must be a short card title (2-5 words). It is derived by
    extracting the agent's own label, never by slicing the description at a
    character offset -- that produced cut-off mid-word titles.
    """
    options = []
    seen = set()
    for line in (section_text or "").splitlines():
        line = line.strip()
        if not line or not (line.startswith("-") or line.startswith("\u2022")):
            continue
        text = _clean(line.lstrip("-\u2022").strip())
        if not text:
            continue

        name = _shorten_option_name(text)

        # Description: drop the agent's own "Label:" prefix so the card doesn't
        # repeat the title, but keep the full explanation.
        description = text
        if ":" in text:
            head, tail = text.split(":", 1)
            if tail.strip() and len(head.split()) <= 14:
                description = tail.strip()

        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        options.append({"name": name, "description": description})
    return options


def _parse_scenarios(section_text):
    rows = _table_to_dicts(section_text, {
        "name": ["option", "name", "scenario"],
        "timeline": ["timeline"],
        "risk": ["risk"],
        "pros": ["pros"],
        "cons": ["cons"],
    })
    scenarios = []
    for r in rows:
        name = _clean(r.get("name", ""))
        if not name:
            continue
        scenarios.append({
            "name": name,
            "timeline": _clean(r.get("timeline", "")),
            "risk": _normalize_risk(r.get("risk", "")),
            "pros": _split_list_cell(r.get("pros", "")),
            "cons": _split_list_cell(r.get("cons", "")),
        })
    return scenarios


_WEEK_LABEL_RE = re.compile(r"^(week\b|final\b|day\s+\d|month\b)", re.IGNORECASE)
_TAG_RE = re.compile(r"\[([^\]]*(?:DIY|ATTORNEY|EMPLOYER)[^\]]*)\]", re.IGNORECASE)


def _parse_step_flexible(text):
    """Determine the DIY/NEEDS ATTORNEY flag from ALL bracket-tag-like tokens
    in the line, then strip every bracket-wrapped chunk for display. More
    robust than matching a single start/end tag -- the agent occasionally
    produces multiple or nested tags in one line (e.g. malformed
    "[DIY or [NEEDS ATTORNEY] if complex]")."""
    tags = re.findall(r"\[([^\[\]]*)\]", text)
    flag = "NEEDS ATTORNEY" if any(
        re.search(r"ATTORNEY|EMPLOYER", t, re.IGNORECASE) for t in tags
    ) else "DIY"
    display = re.sub(r"\[[^\[\]]*\]", "", text)
    display = display.replace("[", "").replace("]", "")  # stray unmatched brackets
    # Stripping a tag can leave orphaned punctuation behind, e.g.
    # "...eligible for [DIY]." -> "...eligible for ." and
    # "...eligible for (DIY)." -> "...eligible for ()."
    display = re.sub(r"\(\s*\)", "", display)          # empty parens
    display = re.sub(r"\s+([.,;:])", r"\1", display)   # " ." -> "."
    display = re.sub(r"\s{2,}", " ", display).strip()
    display = display.rstrip(" ,;:-").strip()
    if display and not display.endswith((".", "!", "?")):
        display += "."
    return {"text": _clean(display), "flag": flag}


def _parse_action_plan(section_text):
    """
    Tolerant of both real formats observed live:
      A) non-bulleted, colon-terminated period header ("Week 1-2 (...):")
         followed by bracket-FIRST bulleted steps ("- [DIY] do the thing").
      B) bulleted, non-colon period header ("- Week 1-2 (...)") with nested
         bulleted steps and bracket-LAST tags ("- do the thing [DIY]").
    A line is treated as a new period/week group if its content (bullet
    marker and indentation stripped) starts with a period-label keyword
    (Week/Final/Day/Month) AND is not itself a flagged step. Every other
    bulleted line under an active group is a step.
    """
    groups = []
    current = None
    for raw_line in (section_text or "").splitlines():
        if not raw_line.strip():
            continue
        was_bulleted = bool(re.match(r"^\s*[-\u2022]\s+", raw_line))
        content = re.sub(r"^\s*[-\u2022]\s*", "", raw_line).strip()
        # Some responses wrap the whole period label in markdown bold
        # ("**Week 1-2 (...)**") instead of using a bullet or trailing colon.
        content = re.sub(r"^\*\*(.+)\*\*$", r"\1", content).strip()
        if not content:
            continue

        if _WEEK_LABEL_RE.match(content) and not _TAG_RE.search(content):
            current = {"week": content.rstrip(":").strip(), "steps": []}
            groups.append(current)
            continue

        if not was_bulleted:
            # Unbulleted prose that isn't a week label -- e.g. a trailing
            # sub-heading like "Employer Legitimacy Guidance:". Stop
            # collecting into the current group so we don't absorb it.
            if content.endswith(":") and len(content) < 80:
                current = None
            continue

        if current is None:
            current = {"week": "This Week", "steps": []}
            groups.append(current)
        step = _parse_step_flexible(content)
        if step["text"]:
            current["steps"].append(step)

    return [g for g in groups if g["steps"]]


def _parse_key_deadlines(section_text):
    rows = _table_to_dicts(section_text, {
        "date": ["date"],
        "description": ["description", "desc"],
    })
    deadlines = []
    for r in rows:
        desc = _clean(r.get("description", ""))
        date_raw = (r.get("date") or "").strip()
        if not desc or not date_raw:
            continue
        deadlines.append({
            "date": date_raw,
            "title": desc[:60],
            "description": desc,
        })
    return deadlines


def parse_plan_markdown(text):
    """
    Parse the agent's full structured report into the frontend's exact
    contract shape, plus one backend-only key (keyDeadlines) used later to
    build the .ics calendar.
    """
    sections = split_sections(text, _PLAN_HEADER_MAP)
    return {
        "situationSummary": _clean(sections.get("situationSummary", "")),
        "options": _parse_options(sections.get("options", "")),
        "scenarios": _parse_scenarios(sections.get("scenarios", "")),
        "actionPlan": _parse_action_plan(sections.get("actionPlan", "")),
        "keyDeadlines": _parse_key_deadlines(sections.get("keyDeadlines", "")),
    }


def parse_attorney_markdown(text):
    """Parse the agent's one-page attorney summary into the frontend's nested shape."""
    sections = split_sections(text, _ATTORNEY_HEADER_MAP)
    questions_raw = sections.get("questions", "")
    questions = []
    for line in questions_raw.splitlines():
        line = line.strip()
        m = re.match(r"^\d+[\.\)]\s*(.*)", line)
        if m:
            questions.append(_clean(m.group(1)))
        elif line.startswith("-") or line.startswith("\u2022"):
            questions.append(_clean(line.lstrip("-\u2022")))
    questions = [q for q in questions if q]

    return {
        "clientSituation": _clean(sections.get("clientSituation", "")),
        "keyDates": _clean(sections.get("keyDates", "")),
        "optionsIdentified": _clean(sections.get("optionsIdentified", "")),
        "questions": questions,
    }
