"""
Thin client for the DigitalOcean Gradient AI agent.

Design goals
------------
* The frontend NEVER talks to the agent directly. Only this module does,
  and only the Flask routes call this module.
* If the agent isn't configured yet (no GRADIENT_ENDPOINT / GRADIENT_API_KEY),
  `is_configured()` returns False and every service falls back to mock data,
  so the whole app is testable end-to-end before the agent is live.
* Gradient AI agents expose an OpenAI-compatible /chat/completions endpoint.
  We also support sending an image in the same request (the model can read
  I-797 notices natively), with a text-extraction fallback handled upstream.

Swap-in instructions: set GRADIENT_ENDPOINT and GRADIENT_API_KEY in .env.
No other code needs to change.
"""

import json
import logging

import requests

from config import config

log = logging.getLogger("graceperiod.gradient")


class GradientError(RuntimeError):
    """Raised when the agent is configured but the call fails."""


def is_configured() -> bool:
    """True when the real agent should be used instead of mock data."""
    return config.gradient_configured


def _endpoint() -> str:
    url = config.GRADIENT_ENDPOINT.rstrip("/")
    # Allow the user to set either the base agent URL or the full path.
    if url.endswith("/chat/completions"):
        return url
    if url.endswith("/api/v1"):
        return url + "/chat/completions"
    return url + "/api/v1/chat/completions"


def _post(payload):
    """Shared request plumbing. Returns the FULL parsed JSON response body
    (not just the message content) so callers can also pull out the
    top-level `citations` array the Gradient AI platform returns alongside
    the message -- a real RAG feature, confirmed by live testing, distinct
    from the OpenAI-compatible `choices[].message.content` field."""
    if not is_configured():
        raise GradientError("Gradient AI agent is not configured (running in mock mode).")

    headers = {
        "Authorization": f"Bearer {config.GRADIENT_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(
            _endpoint(), json=payload, headers=headers,
            timeout=config.GRADIENT_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:
        log.exception("Gradient AI request failed")
        raise GradientError(f"Gradient AI request failed: {exc}") from exc


def _extract_content(data):
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise GradientError(f"Unexpected Gradient AI response shape: {data}") from exc


def _extract_citation_filenames(data):
    """Return a deduplicated, order-preserving list of source filenames
    from the response's `citations.citations[]` array. Using the platform's
    own citation metadata is far more reliable than trying to resolve
    inline [[C1]] markers back to specific sources."""
    try:
        raw = data.get("citations", {}).get("citations", [])
    except AttributeError:
        return []
    seen, out = set(), []
    for c in raw:
        name = c.get("filename") or c.get("item_name")
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def supports_images() -> bool:
    """
    False for this deployment.

    Verified against the live endpoint: it rejects the OpenAI multimodal
    "list of content parts" message format with HTTP 422
    ("Input should be a valid string"). It accepts ONLY a plain string as
    message content, so an image cannot be attached inline to a request.

    Callers should therefore extract text from documents locally (pdfplumber
    / pytesseract) and send that text instead. See services/documents.py and
    the /api/upload-document route.
    """
    return False


def complete(user_prompt, system=None, image_b64=None,
             image_media_type="image/jpeg", want_json=True, temperature=0.2):
    """
    Send a single-turn request to the Gradient AI agent and return the text.

    Parameters
    ----------
    user_prompt : str      The instruction / data for this turn.
    system      : str      Optional extra system guidance (the agent already
                           has its own system prompt configured in Gradient;
                           this is appended context only).
    image_b64   : str      Accepted but IGNORED -- this endpoint cannot take
                           inline images (see supports_images()). Passing one
                           logs a warning rather than failing the request, so
                           callers fall back to local text extraction.
    want_json   : bool     If True, ask for a raw JSON object back.

    Returns the assistant's text content (str). Raises GradientError on failure.
    """
    if image_b64:
        log.warning(
            "Image passed to Gradient agent, but this endpoint only accepts "
            "string content (HTTP 422 on multimodal payloads). Ignoring the "
            "image; caller should use local text extraction instead."
        )

    # IMPORTANT: content MUST be a plain string. This endpoint returns 422 for
    # the OpenAI list-of-parts format ([{"type":"text",...}]) -- verified live.
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user_prompt})

    payload = {"messages": messages, "temperature": temperature, "stream": False}
    if config.GRADIENT_MODEL:
        payload["model"] = config.GRADIENT_MODEL
    if want_json:
        # Best-effort structured output; harmless if the agent ignores it
        # (confirmed live: the agent honors this for narrow extraction
        # requests, but its fixed system prompt overrides it for the big
        # structured-report prompts -- see complete_with_citations below).
        payload["response_format"] = {"type": "json_object"}

    return _extract_content(_post(payload))


def complete_with_citations(user_prompt, temperature=0.2):
    """
    Single-turn call for prompts where the agent replies with its fixed
    Markdown report format (the 60-day plan, the attorney summary) rather
    than JSON -- confirmed by live testing that the agent's own system
    prompt takes precedence over a JSON response_format request for these.

    Returns (text, citation_filenames) where citation_filenames is a
    deduplicated list of source document names from the platform's RAG
    citation metadata.
    """
    payload = {
        "messages": [{"role": "user", "content": user_prompt}],
        "temperature": temperature,
        "stream": False,
    }
    if config.GRADIENT_MODEL:
        payload["model"] = config.GRADIENT_MODEL
    data = _post(payload)
    return _extract_content(data), _extract_citation_filenames(data)


def chat(messages, temperature=0.4):
    """
    Multi-turn conversational call for the floating Q&A widget.

    `messages` is a plain list of {"role": "user"|"assistant", "content": str}
    dicts (already in send-order, most recent last). No JSON response_format
    is requested here -- unlike the structured routes, we want natural
    conversational prose back, not a JSON object.

    Returns the assistant's reply text. Raises GradientError on failure.
    """
    payload = {"messages": messages, "temperature": temperature, "stream": False}
    if config.GRADIENT_MODEL:
        payload["model"] = config.GRADIENT_MODEL
    return _extract_content(_post(payload))


def complete_json(user_prompt, **kwargs):
    """
    Call the agent and parse the reply as JSON.

    Returns a dict. Tolerates code-fence wrapping and leading/trailing prose
    by extracting the outermost {...} block if a direct parse fails.
    """
    text = complete(user_prompt, want_json=True, **kwargs)
    return _loads_lenient(text)


def _loads_lenient(text):
    if isinstance(text, (dict, list)):
        return text
    text = (text or "").strip()
    # strip ```json fences if present
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise
