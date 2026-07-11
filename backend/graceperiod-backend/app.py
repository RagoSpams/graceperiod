"""
GracePeriod backend -- Flask application.

Architecture:
    Frontend (React, localhost:3000)  ->  THIS backend (localhost:5000)  ->  Gradient AI agent
The frontend never talks to the agent directly; every AI call goes through here.

Route shapes in this file are written to match the frontend team's handoff
doc EXACTLY (field names in, field names out) -- the frontend is already
built against that contract, so nothing here is free to reshape.

Routes
    POST /api/generate-plan        structured 60-day plan (calls the agent)
    POST /api/upload-document      read an I-797, extract fields, then plan
    POST /api/fill-form            build a DRAFT USCIS form + preview fields
    GET  /api/download-form/<id>   download the PDF a fill-form call produced
    GET|POST /api/generate-calendar   downloadable .ics of deadlines
    POST /api/check-employer       employer H-1B sponsorship lookup (CSV)
    POST /api/attorney-summary     one-page attorney consultation summary
    POST /api/chat                 floating Q&A widget (conversational agent call)
    POST /api/risk-check           two-pass Auditor->Attorney reasoning pipeline
    GET  /health                   health check

Every route works with placeholder data before the Gradient AI agent is
connected, then automatically uses the real agent once configured in .env.
"""

import base64
import logging

from flask import Flask, Response, jsonify, request
from flask_cors import CORS

from config import config
from services import calendars, documents, employers, gradient, plans, session_store
from services import risk_check as risk_checker
from services.forms import build_field_preview, build_form, form_for_scenario, get_pdf, register_pdf

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("graceperiod")


def create_app():
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = config.MAX_CONTENT_LENGTH
    CORS(app, resources={r"/*": {"origins": config.CORS_ORIGINS}})

    # ----------------------------------------------------------------- #
    # Health
    # ----------------------------------------------------------------- #
    @app.get("/health")
    def health():
        return jsonify({
            "status": "ok",
            "gradientConfigured": gradient.is_configured(),
            "mode": "live-agent" if gradient.is_configured() else "placeholder",
        })

    # ----------------------------------------------------------------- #
    # 1. Generate plan
    # ----------------------------------------------------------------- #
    @app.post("/api/generate-plan")
    def generate_plan():
        data = request.get_json(silent=True) or {}
        if not data.get("layoffDate"):
            return _bad_request("layoffDate is required.")
        try:
            plan = plans.build_plan(data)
            _remember_session(data, plan)
            return jsonify(_frontend_plan_shape(plan))
        except Exception as exc:  # noqa: BLE001
            log.exception("generate-plan failed")
            return _server_error(exc)

    # ----------------------------------------------------------------- #
    # 2. Upload document (I-797)
    # ----------------------------------------------------------------- #
    @app.post("/api/upload-document")
    def upload_document():
        if "file" not in request.files:
            return _bad_request("No file uploaded (expected multipart field 'file').")
        f = request.files["file"]
        file_bytes = f.read()
        if not file_bytes:
            return _bad_request("Uploaded file is empty.")

        form = request.form.to_dict()

        try:
            # This Gradient endpoint accepts ONLY plain-string message content
            # (multimodal image payloads return HTTP 422 -- verified live), so
            # we cannot hand the I-797 image straight to the agent. Instead:
            #   1. extract text locally (pdfplumber for PDFs, OCR for images)
            #   2. send that TEXT to the agent to parse out the fields
            #   3. if the agent is unreachable, fall back to local regex
            extracted = {}
            doc_text = documents.extract_text(file_bytes, f.filename)

            if doc_text and gradient.is_configured():
                try:
                    prompt = (
                        "The following text was extracted from a USCIS I-797 approval "
                        "notice. Extract the visa type, the validity end date "
                        "(YYYY-MM-DD), the petitioner/employer name, and the receipt "
                        'number. Return ONLY JSON: {"visaType":..,"visaExpiry":..,'
                        '"employerName":..,"receiptNumber":..}\n\n'
                        f"Notice text:\n{doc_text[:4000]}"
                    )
                    extracted = gradient.complete_json(prompt) or {}
                except (gradient.GradientError, ValueError):
                    log.warning("Agent field extraction failed; using local regex")
                    extracted = {}

            if not extracted:
                extracted = documents.extract_fields(doc_text)

            # The handoff doc only lists file/language/hasDependents as sent
            # fields for this route (no layoffDate). Default sensibly so a
            # plan can still be produced if layoffDate isn't sent.
            has_dependents = str(form.get("hasDependents", "false")).lower() == "true"
            import datetime as _dt
            payload = {
                "layoffDate": form.get("layoffDate") or _dt.date.today().isoformat(),
                "visaExpiry": form.get("visaExpiry") or extracted.get("visaExpiry"),
                "visaType": extracted.get("visaType") or "H-1B",
                "hasDependents": has_dependents,
                "considering": form.get("considering", "not-sure"),
                "language": form.get("language", "english"),
                "tone": form.get("tone", "full"),
            }

            plan = plans.build_plan(payload)
            _remember_session(payload, plan, extracted=extracted)
            return jsonify(_frontend_plan_shape(plan))
        except Exception as exc:  # noqa: BLE001
            log.exception("upload-document failed")
            return _server_error(exc)

    # ----------------------------------------------------------------- #
    # 3. Fill form
    # ----------------------------------------------------------------- #
    @app.post("/api/fill-form")
    def fill_form():
        data = request.get_json(silent=True) or {}
        scenario_name = data.get("scenario")
        session = session_store.all()

        try:
            form_type, self_file_flag = form_for_scenario(
                scenario_name, visa_type=session.get("visaType", "H-1B"))

            if form_type is None:
                # e.g. "Departure / Reentry" -- no form is needed for this path.
                return jsonify({
                    "formType": None,
                    "selfFileFlag": None,
                    "fields": [],
                    "pdfBase64": None,
                    "message": "No USCIS form is required for this path.",
                })

            # Identity fields the frontend now sends for the real I-539 fill.
            # visaExpiry falls back to whatever the plan/I-797 upload captured.
            user_data = {
                "legalName": data.get("legalName", ""),
                "dateOfBirth": data.get("dateOfBirth", ""),
                "countryOfBirth": data.get("countryOfBirth", ""),
                "currentAddress": data.get("currentAddress", ""),
                "alienNumber": data.get("alienNumber", ""),
                "visaExpiry": data.get("visaExpiry") or session.get("visaExpiry", ""),
            }

            has_identity = bool(str(user_data["legalName"]).strip())

            if has_identity and form_type == "I-539":
                # Real government PDF, Part 1 auto-filled.
                result = build_form(form_type=form_type, user_data=user_data,
                                    scenario=scenario_name)
            else:
                # No identity data (or I-129, which the applicant can't
                # self-file) -> keep the existing summary-sheet behavior.
                preview = build_field_preview(scenario_name, session)
                result = build_form(form_type=form_type, user_data=session,
                                    scenario=scenario_name, fields=preview)

            form_id, filename = register_pdf(result["pdfBytes"], result["formType"])
            pdf_b64 = base64.b64encode(result["pdfBytes"]).decode("ascii")

            return jsonify({
                "formType": f"Form {result['formType']}",
                "selfFileFlag": result["selfFileFlag"],
                "fields": result["fieldsUsed"],
                "pdfBase64": pdf_b64,
                "filledRealForm": result["filledRealForm"],
                "formId": form_id,
                "downloadUrl": f"/api/download-form/{form_id}",
                "filename": filename,
                "disclaimer": "This is an AI-generated draft. Review carefully and "
                              "consult an attorney before filing.",
            })
        except Exception as exc:  # noqa: BLE001
            log.exception("fill-form failed")
            return _server_error(exc)

    # ----------------------------------------------------------------- #
    # 3b. Download a previously-generated form PDF
    # ----------------------------------------------------------------- #
    @app.get("/api/download-form/<form_id>")
    def download_form(form_id):
        record = get_pdf(form_id)
        if not record:
            return jsonify({"success": False, "error": "Form not found or expired."}), 404
        return Response(
            record["pdfBytes"],
            mimetype="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{record["filename"]}"'},
        )

    # ----------------------------------------------------------------- #
    # 4. Generate calendar (.ics) -- GET sends no body; uses last session
    # ----------------------------------------------------------------- #
    @app.route("/api/generate-calendar", methods=["GET", "POST"])
    def generate_calendar():
        try:
            deadlines = _collect_deadlines()
            ics_text = calendars.build_calendar(deadlines)
            return Response(
                ics_text,
                mimetype="text/calendar",
                headers={
                    "Content-Disposition": "attachment; filename=graceperiod_deadlines.ics"
                },
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("generate-calendar failed")
            return _server_error(exc)

    # ----------------------------------------------------------------- #
    # 5. Check employer
    # ----------------------------------------------------------------- #
    @app.post("/api/check-employer")
    def check_employer():
        data = request.get_json(silent=True) or {}
        name = data.get("employerName")
        if not name:
            return _bad_request("employerName is required.")
        try:
            return jsonify(employers.check_employer(name))
        except Exception as exc:  # noqa: BLE001
            log.exception("check-employer failed")
            return _server_error(exc)

    # ----------------------------------------------------------------- #
    # 6. Attorney summary
    # ----------------------------------------------------------------- #
    @app.post("/api/attorney-summary")
    def attorney_summary():
        data = request.get_json(silent=True) or {}
        try:
            result = plans.build_attorney_summary(data)
            return jsonify(result)
        except Exception as exc:
            log.exception("attorney-summary failed")
            return _server_error(exc)

    @app.post("/api/attorney-summary/pdf")
    def attorney_summary_pdf():
        """Generate a clean downloadable PDF of the attorney consultation summary."""
        data = request.get_json(silent=True) or {}
        try:
            result = plans.build_attorney_summary(data)
            summary = result.get("summary", {})
            pdf_bytes = _build_attorney_pdf(summary)
            return Response(
                pdf_bytes,
                mimetype="application/pdf",
                headers={"Content-Disposition": 'attachment; filename="GracePeriod_Attorney_Summary.pdf"'},
            )
        except Exception as exc:
            log.exception("attorney-summary/pdf failed")
            return _server_error(exc)

    # ----------------------------------------------------------------- #
    # 7. Chat (floating Q&A widget) + entity extraction
    #    Returns { reply, extractedFields } -- one agent call does both:
    #    answers the user AND pulls any personal details they mentioned
    #    ("my name is X, I live at Y") into structured fields the frontend
    #    can offer to auto-fill into the form. extractedFields is {} for
    #    ordinary questions.
    # ----------------------------------------------------------------- #
    @app.post("/api/chat")
    def chat():
        data = request.get_json(silent=True) or {}
        message = data.get("message")
        if not message:
            return _bad_request("message is required.")
        history = data.get("history", [])
        try:
            result = plans.build_chat_reply(message, history)
            return jsonify(result)  # { reply: str, extractedFields: {...} }
        except Exception as exc:  # noqa: BLE001
            log.exception("chat failed")
            return _server_error(exc)

    # ----------------------------------------------------------------- #
    # 8. Risk check -- TWO-PASS pipeline (Auditor -> Attorney)
    #    Same agent, called twice; pass 2's prompt is built from pass 1's
    #    output. Slower than other routes by design (2 sequential calls).
    # ----------------------------------------------------------------- #
    @app.post("/api/risk-check")
    def risk_check():
        data = request.get_json(silent=True) or {}
        scenario = data.get("scenario")
        if not scenario:
            return _bad_request("scenario is required.")
        session = session_store.all()
        try:
            result = risk_checker.run_risk_check(
                scenario=scenario,
                layoff_date=data.get("layoffDate") or session.get("layoffDate"),
                visa_expiry=data.get("visaExpiry") or session.get("visaExpiry"),
                has_dependents=data.get("hasDependents", session.get("hasDependents", False)),
            )
            return jsonify(result)  # { risks: [...], mitigatedPlan: str }
        except Exception as exc:  # noqa: BLE001
            log.exception("risk-check failed")
            return _server_error(exc)

    # ----------------------------------------------------------------- #
    # Error handlers
    # ----------------------------------------------------------------- #
    @app.errorhandler(413)
    def too_large(_):
        return jsonify({"success": False, "error": "File too large."}), 413

    @app.errorhandler(404)
    def not_found(_):
        return jsonify({"success": False, "error": "Endpoint not found."}), 404

    return app


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _frontend_plan_shape(plan):
    """Return exactly the keys the frontend contract documents (extra keys
    like keyDeadlines are harmless if included, but we keep this explicit)."""
    return {
        "situationSummary": plan.get("situationSummary", ""),
        "options": plan.get("options", []),
        "scenarios": plan.get("scenarios", []),
        "actionPlan": plan.get("actionPlan", []),
        "citations": plan.get("citations", []),
    }


def _remember_session(payload, plan, extracted=None):
    """Stash the data /api/fill-form and /api/generate-calendar need later."""
    session_store.save(
        layoffDate=payload.get("layoffDate"),
        visaExpiry=payload.get("visaExpiry"),
        visaType=payload.get("visaType", "H-1B"),
        hasDependents=payload.get("hasDependents"),
        considering=payload.get("considering"),
        graceEnd=plans.grace_period_end(payload.get("layoffDate")),
        keyDeadlines=plan.get("keyDeadlines", []),
        extracted=extracted or {},
    )


def _collect_deadlines():
    """POST body can still override; GET (the documented case) uses the
    deadlines computed during the last generate-plan / upload-document call."""
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        if data.get("deadlines"):
            return data["deadlines"]

    stored = session_store.get("keyDeadlines")
    if stored:
        return stored

    # Nothing generated yet this session -- still return a valid (empty)
    # calendar rather than erroring, so the button never crashes the UI.
    return []


def _build_attorney_pdf(summary):
    """Build a clean one-page attorney consultation summary PDF."""
    import io
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter,
                            topMargin=0.8*inch, bottomMargin=0.8*inch,
                            leftMargin=0.9*inch, rightMargin=0.9*inch)
    styles = getSampleStyleSheet()
    navy  = colors.HexColor("#1F3A5F")
    blue  = colors.HexColor("#2563EB")
    gray  = colors.HexColor("#64748B")

    title_style   = ParagraphStyle("t", parent=styles["Title"],   textColor=navy, fontSize=18, spaceAfter=4)
    sub_style     = ParagraphStyle("s", parent=styles["Normal"],  textColor=gray, fontSize=10, spaceAfter=16)
    heading_style = ParagraphStyle("h", parent=styles["Heading2"],textColor=blue, fontSize=11, spaceBefore=14, spaceAfter=4)
    body_style    = ParagraphStyle("b", parent=styles["Normal"],  textColor=colors.HexColor("#1E293B"), fontSize=10, leading=15)
    q_style       = ParagraphStyle("q", parent=body_style, leftIndent=14, spaceBefore=4)
    disc_style    = ParagraphStyle("d", parent=styles["Normal"],  textColor=gray, fontSize=8, spaceBefore=12)

    story = [
        Paragraph("GracePeriod", title_style),
        Paragraph("Attorney Consultation Summary — Confidential", sub_style),
        HRFlowable(width="100%", thickness=1, color=navy, spaceAfter=12),
    ]

    sections = [
        ("CLIENT SITUATION",       summary.get("clientSituation", "")),
        ("KEY DATES",              summary.get("keyDates", "")),
        ("OPTIONS ALREADY IDENTIFIED", summary.get("optionsIdentified", "")),
    ]
    for heading, text in sections:
        if text:
            story.append(Paragraph(heading, heading_style))
            story.append(Paragraph(text.replace("\n", "<br/>"), body_style))

    questions = summary.get("questions", [])
    if questions:
        story.append(Paragraph("QUESTIONS FOR THE ATTORNEY", heading_style))
        for i, q in enumerate(questions, 1):
            story.append(Paragraph(f"{i}. {q}", q_style))

    story.append(Spacer(1, 20))
    story.append(HRFlowable(width="100%", thickness=0.5, color=gray))
    story.append(Paragraph(
        "This summary was generated by GracePeriod for informational purposes only and does not constitute legal advice. "
        "Review all information with a licensed immigration attorney before taking any action.",
        disc_style))

    doc.build(story)
    return buf.getvalue()


def _bad_request(msg):
    return jsonify({"success": False, "error": msg}), 400


def _server_error(exc):
    return jsonify({"success": False, "error": str(exc)}), 500


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
