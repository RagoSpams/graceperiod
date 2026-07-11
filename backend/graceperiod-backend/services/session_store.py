"""
Minimal in-memory "current session" store.

Why this exists: two frontend routes send very little data on their own --
GET /api/generate-calendar sends no body at all, and POST /api/fill-form
sends only { "scenario": "<name>" }. Both need data gathered earlier from
/api/generate-plan or /api/upload-document (the layoff/visa dates, the
computed deadlines, any extracted I-797 fields).

This is a SINGLE global slot, not per-user -- there's no session id or auth
in the current frontend contract, so this assumes one active user in the
browser at a time, which is fine for a hackathon demo. For a real multi-user
deployment, swap this for a server-side session keyed by a cookie/JWT, or
have the frontend send an explicit sessionId with every call.
"""

_STORE = {}


def save(**kwargs):
    _STORE.update(kwargs)


def get(key, default=None):
    return _STORE.get(key, default)


def all():
    return dict(_STORE)


def clear():
    _STORE.clear()
