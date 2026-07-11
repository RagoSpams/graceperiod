"""
Calendar (.ics) generation.

Takes the list of key deadlines (each a date + short description) and builds
a real importable calendar file, one event per deadline, each with a reminder
3 days before. Works in Google Calendar, Apple Calendar, and Outlook.

No AI here -- the deadline list comes from the caller (the agent's output in
production, or computed dates when testing).
"""

from datetime import datetime, timedelta

from ics import Calendar, Event
from ics.alarm import DisplayAlarm


def _parse_date(value):
    """Accept 'YYYY-MM-DD', ISO datetime, or a datetime/date; return datetime."""
    if isinstance(value, datetime):
        return value
    if hasattr(value, "year") and not isinstance(value, str):  # date
        return datetime(value.year, value.month, value.day)
    value = str(value).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    # last resort: ISO 8601
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def build_calendar(deadlines, reminder_days=3):
    """
    Build an .ics string from a list of deadlines.

    deadlines : list of dicts, each like
        { "date": "2026-09-08", "title": "Grace period ends",
          "description": "Last day of the 60-day grace period" }
      ("name"/"summary" are accepted as aliases for "title".)

    Returns the .ics file contents as a string.
    """
    cal = Calendar()
    cal.creator = "GracePeriod//H-1B Layoff Navigator//EN"

    for item in deadlines or []:
        raw_date = item.get("date") or item.get("deadline")
        if not raw_date:
            continue
        try:
            when = _parse_date(raw_date)
        except (ValueError, TypeError):
            continue

        title = (item.get("title") or item.get("name")
                 or item.get("summary") or "GracePeriod deadline")
        description = item.get("description", "")

        event = Event()
        event.name = title
        event.begin = when
        event.make_all_day()
        if description:
            event.description = description
        # Reminder N days before the deadline.
        event.alarms = [DisplayAlarm(trigger=timedelta(days=-abs(reminder_days)))]
        cal.events.add(event)

    return cal.serialize()
