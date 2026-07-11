"""
I-797 document intelligence (text-extraction fallback).

In production the uploaded I-797 image is sent straight to the Gradient AI
agent, which reads it natively. This module is the FALLBACK path the route
uses when direct image input isn't available: pull text out of the file with
pdfplumber (PDFs) or pytesseract (images), then regex the fields we care about
so the frontend still gets visaExpiry / visaType / employerName.

No AI here -- just OCR/text extraction and pattern matching.
"""

import io
import logging
import re

import pdfplumber

log = logging.getLogger("graceperiod.documents")

try:
    import pytesseract
    from PIL import Image
    _OCR_AVAILABLE = True
except Exception:  # pragma: no cover
    _OCR_AVAILABLE = False


# I-797 classification codes we recognize.
_VISA_TYPES = ["H-1B1", "H-1B", "H-4", "H-2A", "H-2B", "H-3",
               "O-1", "L-1A", "L-1B", "L-2", "E-3", "TN", "F-1", "J-1"]


def extract_text(file_bytes, filename=""):
    """Extract raw text from an uploaded PDF or image. Returns a string."""
    name = (filename or "").lower()
    is_pdf = name.endswith(".pdf") or file_bytes[:5] == b"%PDF-"

    if is_pdf:
        try:
            text_parts = []
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                for page in pdf.pages:
                    text_parts.append(page.extract_text() or "")
            text = "\n".join(text_parts).strip()
            if text:
                return text
        except Exception:
            log.warning("pdfplumber failed; will try OCR", exc_info=True)

    # Image (or image-only/scanned PDF) -> OCR
    if _OCR_AVAILABLE:
        try:
            image = Image.open(io.BytesIO(file_bytes))
            return pytesseract.image_to_string(image)
        except Exception:
            log.warning("pytesseract OCR failed", exc_info=True)

    return ""


def extract_fields(text):
    """
    Pull structured fields from I-797 text.

    Returns { visaType, visaExpiry, employerName, receiptNumber } with None for
    anything not found. Dates are normalized to YYYY-MM-DD where possible.
    """
    fields = {"visaType": None, "visaExpiry": None,
              "employerName": None, "receiptNumber": None}
    if not text:
        return fields

    # Visa classification
    for vt in _VISA_TYPES:
        if re.search(rf"\b{re.escape(vt)}\b", text, re.IGNORECASE):
            fields["visaType"] = vt
            break

    # Validity end date: "Valid from mm/dd/yyyy to mm/dd/yyyy"
    m = re.search(r"valid\s+from\s+([0-9/.\-]+)\s+(?:to|until|through)\s+([0-9/.\-]+)",
                  text, re.IGNORECASE)
    if m:
        fields["visaExpiry"] = _norm_date(m.group(2))
    else:
        m = re.search(r"(?:valid\s+(?:to|until|through)|expires?(?:\s+on)?)\s*[:]?\s*([0-9/.\-]+)",
                      text, re.IGNORECASE)
        if m:
            fields["visaExpiry"] = _norm_date(m.group(1))

    # Petitioner / employer
    m = re.search(r"(?:petitioner|employer)\s*[:\-]?\s*(.+)", text, re.IGNORECASE)
    if m:
        name = m.group(1).splitlines()[0].strip(" .:-")
        if 1 < len(name) < 120:
            fields["employerName"] = name

    # Receipt number: 3 letters + 10 digits (e.g. EAC1234567890)
    m = re.search(r"\b([A-Z]{3}\d{10})\b", text)
    if m:
        fields["receiptNumber"] = m.group(1)

    return fields


def _norm_date(raw):
    raw = raw.strip().replace(".", "/").replace("-", "/")
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d"):
        try:
            from datetime import datetime
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw  # return as-is if we can't parse it
