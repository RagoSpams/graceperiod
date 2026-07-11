"""
PDF form service.

Two jobs:
1. Decide which USCIS form applies and who must file it (the same rule the
   Gradient AI agent uses, kept here so the backend can enforce it too).
2. Produce a downloadable, clearly-labelled DRAFT PDF:
     - I-539  -> fill the real fillable USCIS PDF (AcroForm) + DRAFT stamp
     - I-129  -> generate a DRAFT field-summary PDF (employer-filed form; the
                 applicant can't self-file it, so we hand them a review sheet)
   If the fillable template is missing for any reason, we always fall back to
   the generated summary PDF so the endpoint never fails.

No AI lives here. The field VALUES come from the caller (collected form data
and/or the agent's field output); this module only maps and renders them.
"""

import io
import logging
import re
import uuid
from datetime import datetime

from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject, NameObject
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

from config import config

log = logging.getLogger("graceperiod.forms")

# In-memory registry so GET /api/download-form/<id> can serve a PDF that was
# generated moments ago by POST /api/fill-form. Same single-process,
# no-auth simplification as services/session_store.py -- fine for a
# hackathon demo; swap for real storage (S3, a DB blob column) for production.
_FORM_REGISTRY = {}


def register_pdf(pdf_bytes, form_type, filename=None):
    """Store a generated PDF and return its id + filename for the response."""
    form_id = uuid.uuid4().hex[:12]
    filename = filename or f"{form_type.replace(' ', '_')}_DRAFT.pdf"
    _FORM_REGISTRY[form_id] = {"pdfBytes": pdf_bytes, "formType": form_type, "filename": filename}
    return form_id, filename


def get_pdf(form_id):
    """Return the stored {pdfBytes, formType, filename} dict, or None."""
    return _FORM_REGISTRY.get(form_id)

# Statuses that CANNOT use Form I-539 -> they use I-129, filed by the employer.
I129_ONLY_STATUSES = {"H-1B", "H1B", "H-1B1", "H1B1", "H-2A", "H2A",
                      "H-2B", "H2B", "H-3", "H3"}

SELF_FILE_OK = "SELF-FILE OK"
MUST_BE_FILED_BY_EMPLOYER = "MUST BE FILED BY EMPLOYER"


def select_form(visa_type=None, scenario=None):
    """
    Return (form_type, self_file_flag) for the user's situation.

    Rule (mirrors the agent's Critical Form Selection Rule):
      H-1B / H-1B1 / H-2A / H-2B / H-3 -> I-129, filed BY THE EMPLOYER.
      Everything else changing status  -> I-539, self-file OK.
    """
    normalized = (visa_type or "").upper().replace("-", "").replace(" ", "")
    codes = {s.upper().replace("-", "").replace(" ", "") for s in I129_ONLY_STATUSES}
    is_i129 = any(normalized.startswith(code) for code in codes)
    if is_i129:
        return "I-129", MUST_BE_FILED_BY_EMPLOYER
    return "I-539", SELF_FILE_OK


def form_for_scenario(scenario_name, visa_type="H-1B"):
    """
    Map a scenario CARD NAME (as chosen on the comparison view) to a form
    decision. Returns (form_type, self_file_flag), or (None, None) when the
    scenario involves no USCIS filing at all (e.g. "Departure / Reentry").

    The form depends on the TARGET status, not the current one:
      * "H-1B Transfer" -> staying in H-1B -> I-129, filed BY THE EMPLOYER.
      * "Change of Status (B-2 / F-1 / H-4 ...)" -> the target status is NOT
        on the I-539 exclusion list, so the applicant files I-539 themselves.
        (Keying off the user's *current* H-1B status here would wrongly send
        every change-of-status applicant to I-129.)
      * Anything else -> fall back to the current-status rule.
    """
    name = (scenario_name or "").lower()

    if any(k in name for k in ("depart", "leave", "exit", "reentry", "re-entry")):
        return None, None

    if "transfer" in name or "h-1b" in name or "h1b" in name:
        return select_form(visa_type="H-1B")  # -> I-129, employer-filed

    if "change of status" in name or "change status" in name:
        # Target is some non-H status (B-2, F-1, H-4, ...). If the scenario
        # explicitly names a target that IS on the exclusion list, respect it.
        target = None
        m = re.search(r"\(([^)]+)\)", scenario_name or "")
        if m:
            target = m.group(1).split(",")[0].strip()
        if target and select_form(visa_type=target)[0] == "I-129":
            return "I-129", MUST_BE_FILED_BY_EMPLOYER
        return "I-539", SELF_FILE_OK

    return select_form(visa_type=visa_type)


# --------------------------------------------------------------------------- #
# I-539 PART 1 AUTO-FILL
#
# Scope is deliberately Part 1 (Information About You) ONLY. Parts 2-8 involve
# application-type selections and sensitive eligibility questions (criminal
# history, immigrant intent, etc.) that must NOT be auto-filled from a simple
# intake form -- the applicant and their attorney complete those.
#
# Field names below were read directly out of the official USCIS i-539.pdf
# AcroForm (verified, not guessed). Two gotchas worth knowing:
#   * Part1_Item6_State is a DROPDOWN (/Ch), not a text box -- it only accepts
#     2-letter codes ("CA"), so free text like "California" silently fails.
#   * The form's printed item numbers don't always match the internal field
#     names (printed Item 9 "Date of Birth" is field P1_Line8_DateOfBirth), so
#     we map by verified field name rather than by item number.
# --------------------------------------------------------------------------- #

I539_PART1_FIELDS = {
    "familyName":    "form1[0].#subform[0].P1Line1a_FamilyName[0]",
    "givenName":     "form1[0].#subform[0].P1_Line1b_GivenName[0]",
    "middleName":    "form1[0].#subform[0].P1_Line1c_MiddleName[0]",
    "alienNumber":   "form1[0].#subform[0].Pt1Line2_AlienNumber[0]",
    "street":        "form1[0].#subform[0].Part1_Item6_StreetName[0]",
    "city":          "form1[0].#subform[0].Part1_Item6_City[0]",
    "state":         "form1[0].#subform[0].Part1_Item6_State[0]",   # dropdown: 2-letter code
    "zipCode":       "form1[0].#subform[0].Part1_Item6_ZipCode[0]",
    "countryOfBirth": "form1[0].#subform[1].P1_Line6_CountryOfBirth[0]",
    "dateOfBirth":   "form1[0].#subform[1].P1_Line8_DateOfBirth[0]",
    "statusExpires": "form1[0].#subform[1].SupA_Line1p_DateExpires[0]",  # Item 12
}

_US_STATES = {
    "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR",
    "CALIFORNIA": "CA", "COLORADO": "CO", "CONNECTICUT": "CT", "DELAWARE": "DE",
    "FLORIDA": "FL", "GEORGIA": "GA", "HAWAII": "HI", "IDAHO": "ID",
    "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA", "KANSAS": "KS",
    "KENTUCKY": "KY", "LOUISIANA": "LA", "MAINE": "ME", "MARYLAND": "MD",
    "MASSACHUSETTS": "MA", "MICHIGAN": "MI", "MINNESOTA": "MN",
    "MISSISSIPPI": "MS", "MISSOURI": "MO", "MONTANA": "MT", "NEBRASKA": "NE",
    "NEVADA": "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND", "OHIO": "OH", "OKLAHOMA": "OK", "OREGON": "OR",
    "PENNSYLVANIA": "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD", "TENNESSEE": "TN", "TEXAS": "TX", "UTAH": "UT",
    "VERMONT": "VT", "VIRGINIA": "VA", "WASHINGTON": "WA",
    "WEST VIRGINIA": "WV", "WISCONSIN": "WI", "WYOMING": "WY",
    "DISTRICT OF COLUMBIA": "DC",
}


def split_name(full_name):
    """
    "Sriraghav Srisankar" -> family="Srisankar", given="Sriraghav".
    Last token is the family name; everything before it is the given name.
    Imperfect for some name formats, but predictable, and the applicant
    reviews the DRAFT before filing.
    """
    parts = (full_name or "").strip().split()
    if not parts:
        return {"family": "", "given": "", "middle": ""}
    if len(parts) == 1:
        return {"family": parts[0], "given": "", "middle": ""}
    return {"family": parts[-1], "given": " ".join(parts[:-1]), "middle": ""}


def split_address(address):
    """
    "123 Main St, Sunnyvale, CA 94086" ->
      street="123 Main St", city="Sunnyvale", state="CA", zip="94086"

    Also handles a full state name ("California 94086") and a trailing
    country segment ("..., CA 94086, USA"). Returns "" for anything it can't
    confidently parse rather than guessing wrong.
    """
    out = {"street": "", "city": "", "state": "", "zipCode": ""}
    if not address:
        return out

    parts = [p.strip() for p in str(address).split(",") if p.strip()]
    # Drop a trailing country segment so it isn't mistaken for state/zip.
    if len(parts) > 3 and re.fullmatch(r"(USA|U\.S\.A\.|UNITED STATES)", parts[-1], re.IGNORECASE):
        parts = parts[:-1]

    if parts:
        out["street"] = parts[0]
    if len(parts) > 1:
        out["city"] = parts[1]
    if len(parts) > 2:
        tail = parts[2]
        zip_match = re.search(r"(\d{5}(?:-\d{4})?)", tail)
        if zip_match:
            out["zipCode"] = zip_match.group(1)
            tail = tail.replace(zip_match.group(1), "")
        state_raw = tail.strip(" .,")
        if state_raw:
            upper = state_raw.upper()
            if len(upper) == 2:
                out["state"] = upper
            else:
                out["state"] = _US_STATES.get(upper, "")
    return out


def to_uscis_date(value):
    """USCIS forms want mm/dd/yyyy. Accepts YYYY-MM-DD or mm/dd/yyyy."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%m/%d/%Y")
        except ValueError:
            continue
    return raw  # pass through unrecognized formats rather than dropping data


def build_i539_values(user_data):
    """
    Map the frontend's flat request body onto the verified Part 1 AcroForm
    field names. Returns (pdf_field_values, fields_used_preview).
    Only non-empty values are written.
    """
    name = split_name(user_data.get("legalName", ""))
    addr = split_address(user_data.get("currentAddress", ""))

    mapped = {
        "familyName": name["family"],
        "givenName": name["given"],
        "middleName": name["middle"],
        "alienNumber": (user_data.get("alienNumber") or "").strip(),
        "street": addr["street"],
        "city": addr["city"],
        "state": addr["state"],
        "zipCode": addr["zipCode"],
        "countryOfBirth": (user_data.get("countryOfBirth") or "").strip(),
        "dateOfBirth": to_uscis_date(user_data.get("dateOfBirth")),
        "statusExpires": to_uscis_date(user_data.get("visaExpiry")),
    }

    values, preview = {}, []
    for key, val in mapped.items():
        if not val:
            continue
        values[I539_PART1_FIELDS[key]] = str(val)
        preview.append({"label": _PART1_LABELS[key], "value": str(val)})
    return values, preview


_PART1_LABELS = {
    "familyName": "Family Name (Last Name)",
    "givenName": "Given Name (First Name)",
    "middleName": "Middle Name",
    "alienNumber": "Alien Registration Number (A-Number)",
    "street": "Street Number and Name",
    "city": "City or Town",
    "state": "State",
    "zipCode": "ZIP Code",
    "countryOfBirth": "Country of Birth",
    "dateOfBirth": "Date of Birth",
    "statusExpires": "Date Status Expires",
}


def fill_i539_part1(user_data):
    """
    Fill Part 1 of the real USCIS I-539 and stamp it DRAFT.
    Returns (pdf_bytes, fields_used). Raises on template problems so the
    caller can fall back to the summary sheet.
    """
    values, preview = build_i539_values(user_data)

    reader = PdfReader(config.I539_TEMPLATE)
    writer = PdfWriter(clone_from=reader)

    # Drop the XFA layer and force appearance regeneration, otherwise ordinary
    # PDF viewers render the (empty) XFA form instead of our AcroForm values.
    acro = writer._root_object["/AcroForm"]
    if "/XFA" in acro:
        del acro["/XFA"]
    acro[NameObject("/NeedAppearances")] = BooleanObject(True)

    for page in writer.pages:
        try:
            writer.update_page_form_field_values(page, values, auto_regenerate=False)
        except Exception:  # page contains none of the target fields
            continue

    _stamp_draft(writer)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue(), preview


def _stamp_draft(writer):
    """Overlay a light 'DRAFT — NOT FOR FILING' banner on every page."""
    try:
        from reportlab.pdfgen import canvas

        first = writer.pages[0]
        w = float(first.mediabox.width)
        h = float(first.mediabox.height)
        overlay_buf = io.BytesIO()
        c = canvas.Canvas(overlay_buf, pagesize=(w, h))
        c.saveState()
        c.setFont("Helvetica-Bold", 30)
        c.setFillColor(colors.Color(0.85, 0.1, 0.1, alpha=0.18))
        c.translate(w / 2, h / 2)
        c.rotate(35)
        c.drawCentredString(0, 0, "DRAFT — NOT FOR FILING")
        c.restoreState()
        c.save()
        overlay_buf.seek(0)
        stamp = PdfReader(overlay_buf).pages[0]
        for page in writer.pages:
            page.merge_page(stamp)
    except Exception:
        log.warning("Could not stamp DRAFT watermark", exc_info=True)


def _draft_summary_pdf(form_type, self_file_flag, user_data, fields=None):
    """
    Generate a clean DRAFT field-summary PDF from scratch (used for I-129,
    which the applicant cannot self-file, and as the universal fallback).
    Returns (pdf_bytes, fields_used).
    """
    fields_used = fields or [
        {"label": _pretty(k), "value": str(v)}
        for k, v in user_data.items() if v not in (None, "", [])
    ]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        topMargin=0.8 * inch, bottomMargin=0.8 * inch,
        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
    )
    styles = getSampleStyleSheet()
    navy = colors.HexColor("#1F3A5F")
    blue = colors.HexColor("#2563EB")

    title = ParagraphStyle("t", parent=styles["Title"], textColor=navy, fontSize=18)
    h = ParagraphStyle("h", parent=styles["Heading2"], textColor=navy, fontSize=12)
    warn = ParagraphStyle("w", parent=styles["Normal"], textColor=colors.HexColor("#B45309"),
                          fontSize=10, spaceBefore=6)
    small = ParagraphStyle("s", parent=styles["Normal"], textColor=colors.grey, fontSize=8)

    story = [
        Paragraph(f"AI-Drafted Form {form_type} — DRAFT", title),
        Paragraph(f"Filing status: <b>{self_file_flag}</b>", h),
        Spacer(1, 6),
        Paragraph(
            "<b>This is an AI-generated draft.</b> Review every field carefully and "
            "consult a licensed immigration attorney before filing. Field values are "
            "prepared from the information you provided and are not verified.",
            warn),
        Spacer(1, 14),
        Paragraph("Prepared field values", h),
    ]

    data = [["Field", "Value"]] + [[f["label"], f["value"]] for f in fields_used]
    table = Table(data, colWidths=[2.6 * inch, 3.6 * inch])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), navy),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F1F5F9")]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story += [
        table,
        Spacer(1, 16),
        Paragraph(
            "GracePeriod is an informational tool and does not provide legal advice. "
            "USCIS forms and instructions are the authoritative source.", small),
    ]
    doc.build(story)
    return buf.getvalue(), fields_used


def build_field_preview(scenario_name, session_data):
    """
    Build a realistic field-preview list from whatever this app's intake
    form actually collected. GracePeriod's current form only gathers
    layoffDate / visaExpiry / hasDependents / an uploaded I-797's extracted
    fields -- NOT full legal name, DOB, or address. So fields we don't have
    are explicitly marked for the applicant to complete themselves, rather
    than guessed or left silently blank.
    """
    extracted = session_data.get("extracted") or {}
    has_dependents = session_data.get("hasDependents")
    dependents_label = "Yes" if has_dependents in (True, "true", "True") else "No"

    return [
        {"label": "Requested Action", "value": scenario_name or "Not specified"},
        {"label": "Current Nonimmigrant Classification",
         "value": extracted.get("visaType") or session_data.get("visaType") or "H-1B"},
        {"label": "Petitioner / Employer Name",
         "value": extracted.get("employerName") or "To be provided by employer"},
        {"label": "Visa Expiration Date", "value": session_data.get("visaExpiry") or "Not provided"},
        {"label": "Layoff / Termination Date", "value": session_data.get("layoffDate") or "Not provided"},
        {"label": "Grace Period End Date", "value": session_data.get("graceEnd") or "Not calculated"},
        {"label": "H-4 Dependents", "value": dependents_label},
        {"label": "Beneficiary Full Legal Name", "value": "To be completed by applicant"},
    ]


def build_form(form_type=None, user_data=None, visa_type=None, scenario=None, fields=None):
    """
    Public entry point used by the /api/fill-form route.

    Behavior:
      * I-539 AND a `legalName` was provided -> fill the REAL fillable USCIS
        I-539 PDF (Part 1 only), stamped DRAFT. This is the genuine
        government-form output.
      * Otherwise -> the clean DRAFT field-summary sheet. Used for I-129
        (which the applicant cannot self-file) and whenever we lack the
        identity data needed to populate Part 1.

    `fields` overrides the summary sheet's rows when supplied.

    Returns { formType, selfFileFlag, pdfBytes, fieldsUsed[], filledRealForm }.
    """
    user_data = user_data or {}

    # Resolve the form + filer if the caller didn't pin it explicitly.
    if not form_type:
        form_type, self_file_flag = select_form(visa_type=visa_type, scenario=scenario)
    else:
        normalized_in = form_type.upper().replace("-", "")
        if normalized_in == "I129":
            self_file_flag = MUST_BE_FILED_BY_EMPLOYER
        elif normalized_in == "I539":
            self_file_flag = SELF_FILE_OK
        else:
            _, self_file_flag = select_form(visa_type=visa_type, scenario=scenario)

    normalized = form_type.upper().replace("-", "")
    filled_real_form = False

    if normalized == "I539" and str(user_data.get("legalName") or "").strip():
        try:
            pdf_bytes, fields_used = fill_i539_part1(user_data)
            filled_real_form = True
        except Exception:
            log.exception("I-539 Part 1 fill failed; falling back to summary sheet")
            pdf_bytes, fields_used = _draft_summary_pdf(
                form_type, self_file_flag, user_data, fields=fields)
    else:
        pdf_bytes, fields_used = _draft_summary_pdf(
            form_type, self_file_flag, user_data, fields=fields)

    return {
        "formType": form_type,
        "selfFileFlag": self_file_flag,
        "pdfBytes": pdf_bytes,
        "fieldsUsed": fields_used,
        "filledRealForm": filled_real_form,
    }


def _pretty(key):
    """camelCase / snake_case -> 'Title Case' for the preview table."""
    import re
    key = key.replace("_", " ")
    key = re.sub(r"(?<!^)(?=[A-Z])", " ", key)
    return key.strip().title()
