# GracePeriod — Backend

Flask backend for **GracePeriod**, the AI-powered H-1B layoff navigator
(MLH × DigitalOcean "AI for Social Good" Hackathon).

```
Frontend (React, :3000)  ->  THIS backend (Flask, :5000)  ->  Gradient AI agent
```

The frontend never talks to the Gradient AI agent directly — every AI call
goes through this backend, which also fills PDF forms, builds calendar
files, and queries the employer dataset. **The AI agent itself (its system
prompt and reasoning) lives in DigitalOcean Gradient AI and is not part of
this repo** — this backend only *calls* it.

Route shapes here are written to match the frontend team's handoff doc
**exactly** — field names in, field names out — since the frontend is
already built against that contract.

## Verified against the live agent

This backend has been tested end-to-end against the real, deployed Gradient
AI agent (not just placeholder mode). Two things worth knowing about how the
agent actually behaves, confirmed by live testing rather than assumed:

- **The agent replies with its fixed Markdown report format**, not JSON, for
  the full plan and attorney-summary requests — its own system prompt takes
  precedence over a JSON `response_format` request for those. So instead of
  asking for JSON, `services/plans.py` sends `"Provide the full structured
  output as defined in your instructions"` and `services/markdown_parser.py`
  parses the real Markdown (numbered headers, tables, bracketed
  `[DIY]`/`[NEEDS ATTORNEY]` tags) into the frontend's exact JSON contract.
  The parser is written to tolerate the format variation seen across live
  runs (header wording, bullet vs. colon-terminated period labels, bracket
  tags at the start or end of a line, `<br>` vs `;` inside table cells).
  Narrow single-purpose requests (like I-797 field extraction) still comply
  with JSON fine.
- **This endpoint accepts ONLY plain-string message content.** The OpenAI
  multimodal "list of content parts" format returns HTTP 422 (`Input should
  be a valid string`). Practical consequence: **an image cannot be sent
  inline to the agent**, so `/api/upload-document` extracts text from the
  I-797 locally (pdfplumber for PDFs, pytesseract OCR for images) and sends
  that *text* to the agent to parse the fields, with a local regex as a final
  fallback. `gradient.supports_images()` documents this and returns `False`.
- **Citations come from the platform's own RAG metadata**, not by parsing
  inline `[[C1]]` markers in the text — the API response includes a separate
  `citations` array with real source filenames, which is far more reliable.
  Note the agent doesn't always invoke retrieval for a given query, so
  `citations` can legitimately come back empty sometimes; that's the agent's
  behavior, not a parsing bug.

## Key feature: works before the agent is connected

Every endpoint runs immediately in **placeholder mode** (no AI credentials
needed). The moment you add Gradient AI credentials to `.env`, the
AI-dependent routes switch to the real agent automatically — **no code
changes**.

## Setup

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # fill in Gradient AI creds when ready (optional to start)
python app.py             # runs on http://localhost:5000
```

For OCR of image (non-PDF) I-797 uploads, the `tesseract` binary must be
installed (`apt-get install tesseract-ocr` / `brew install tesseract`). PDF
uploads work without it.

## Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `GRADIENT_ENDPOINT` | Gradient AI agent URL. Blank = placeholder mode. |
| `GRADIENT_API_KEY`  | Gradient AI agent key. Blank = placeholder mode. |
| `GRADIENT_MODEL`    | Optional model name if the endpoint needs one. |
| `EMPLOYER_CSV`      | Path to the H-1B employer disclosure CSV (defaults to bundled sample). |
| `I539_TEMPLATE`     | Path to the fillable I-539 PDF (bundled). |
| `EMPLOYER_RISK_LOW` / `EMPLOYER_RISK_MED` | Approval-rate thresholds for the risk badge. |
| `CORS_ORIGINS`      | Allowed origins (defaults to `*`). |

Check the current mode any time: `GET /health` returns `"mode": "placeholder"`
or `"live-agent"`.

## Session state (important, single-user hackathon simplification)

Two routes send very little on their own:
- `GET /api/generate-calendar` — no body at all.
- `POST /api/fill-form` — only `{ "scenario": "<name>" }`.

Both need data gathered earlier from `/api/generate-plan` or
`/api/upload-document`. The backend keeps a **single global in-memory slot**
(`services/session_store.py`) for this — there's no auth or session id in
the current frontend contract, so this assumes one active browser tab at a
time, which is fine for a demo. For a real multi-user deployment, swap it
for a server-side session keyed by a cookie, or have the frontend send an
explicit `sessionId`.

## Endpoints

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/generate-plan` | Structured 60-day plan (calls the agent). |
| `POST` | `/api/upload-document` | Reads an I-797, extracts fields, then plans. |
| `POST` | `/api/fill-form` | Builds a DRAFT USCIS form + preview fields. |
| `GET`  | `/api/download-form/<formId>` | Downloads the PDF a fill-form call produced. |
| `GET`/`POST` | `/api/generate-calendar` | Downloadable `.ics` of deadlines. |
| `POST` | `/api/check-employer` | Employer H-1B sponsorship lookup. |
| `POST` | `/api/attorney-summary` | One-page attorney consultation summary. |
| `POST` | `/api/chat` | Floating Q&A widget — conversational agent call. |
| `POST` | `/api/risk-check` | Two-pass Auditor→Attorney reasoning pipeline. |
| `GET`  | `/health` | Health check + current mode. |

### Request/response shapes (match the frontend contract exactly)

**POST `/api/generate-plan`**
```json
// body
{ "layoffDate":"2026-07-10", "visaExpiry":"2027-03-15", "hasDependents":false,
  "considering":"not-sure", "language":"english", "tone":"full" }
// returns
{ "situationSummary":"...", "options":[{"name","description"}],
  "scenarios":[{"name","timeline","risk","pros":[...],"cons":[...]}],
  "actionPlan":[{"week":"Week 1 (Days 1-7)","steps":[{"text","flag"}]}],
  "citations":["string", ...] }
```
`considering` ∈ `new-employer` | `change-status` | `not-sure`.
`tone` ∈ `quick` (Week 1 only) | `full` (all weeks).
`flag` ∈ `DIY` | `NEEDS ATTORNEY`. `risk` ∈ `Low` | `Medium` | `High`.

**POST `/api/upload-document`** — `multipart/form-data`: `file`, `language`,
`hasDependents` (string `"true"`/`"false"`). Returns the same shape as
`generate-plan`. If `layoffDate` isn't sent, defaults to today so a plan can
still be produced.

**POST `/api/fill-form`**
```json
// body
{ "scenario": "Change of Status (B-2)",
  "legalName": "Sriraghav Srisankar",
  "dateOfBirth": "2006-03-15",
  "countryOfBirth": "India",
  "currentAddress": "123 Main St, Sunnyvale, CA 94086",
  "alienNumber": "123456789",
  "visaExpiry": "2027-03-15" }
// returns
{ "formType":"Form I-539", "selfFileFlag":"SELF-FILE OK",
  "fields":[{"label":"Family Name (Last Name)","value":"Srisankar"}, ...],
  "pdfBase64":"...", "filledRealForm":true,
  "formId":"...", "downloadUrl":"/api/download-form/...",
  "filename":"I-539_DRAFT.pdf", "disclaimer":"..." }
```

**Real I-539 Part 1 auto-fill.** When the scenario resolves to I-539 *and*
`legalName` is provided, the backend fills **Part 1 (Information About You)**
of the genuine fillable USCIS I-539 PDF and stamps it `DRAFT — NOT FOR
FILING`. Parts 2–8 are deliberately left blank: they involve
application-type selections and sensitive eligibility questions (criminal
history, immigrant intent) that must not be auto-filled from an intake form.

Fields filled (mapped to AcroForm names read directly out of the official
template, verified by reading the values back out of the generated PDF):
Family/Given/Middle Name, A-Number, Street, City, State, ZIP, Country of
Birth, Date of Birth, Date Status Expires.

Three parsing details worth knowing:
- `legalName` is split on whitespace — **last token = Family Name**, the rest
  = Given Name. Predictable rather than perfect; the applicant reviews the draft.
- `currentAddress` is split on commas into street / city / state+ZIP. Full
  state names are converted to 2-letter codes ("Texas" → "TX") because the
  form's **State field is a dropdown that only accepts 2-letter codes** — free
  text silently fails to render. A trailing `, USA` is ignored.
- Dates are converted to USCIS's required `mm/dd/yyyy`.

**Fallbacks (all still return a valid `pdfBase64`):**
- No `legalName` → clean DRAFT summary sheet instead of the real form
  (`filledRealForm: false`).
- **I-129** scenarios (H-1B transfer) → always the summary sheet, since the
  applicant legally cannot self-file I-129; it must be filed by the employer.
- **Departure / Reentry** scenarios → `formType: null`, `pdfBase64: null`, plus
  a message: no USCIS form is required for that path.

Form selection is by **target** status, not current status: "H-1B Transfer" →
I-129 (employer-filed); "Change of Status (B-2 / F-1 / H-4)" → I-539
(self-file OK).

**GET `/api/download-form/<formId>`** → the same PDF as `application/pdf`, if
you'd rather link to a download than decode base64.

**GET `/api/generate-calendar`** (no body) or **POST** with an optional
`{ "deadlines":[...] }` override. Returns an `.ics` file, `Content-Type:
text/calendar`; each event has a reminder 3 days before.

**POST `/api/check-employer`** → `{ "employerName":"Acme Corp" }` returns
`{ "found":true, "petitionCount":340, "approvalRate":94, "riskLevel":"low",
"notes":"..." }` (`approvalRate` is 0–100, not a fraction).

**POST `/api/attorney-summary`**
```json
// body
{ "layoffDate":"...", "visaExpiry":"...", "hasDependents":false, "considering":"not-sure" }
// returns
{ "summary": { "clientSituation":"...", "keyDates":"...",
               "optionsIdentified":"...", "questions":["...", ...] } }
```

**POST `/api/chat`** — reply + entity extraction (voice-to-form)
```json
// body
{ "message":"My name is Sriraghav Srisankar and I live at 123 Main St, Sunnyvale, CA",
  "history":[{"role":"assistant","text":"..."}, {"role":"user","text":"..."}] }
// returns
{ "reply": "Got it — I picked up a few details...",
  "extractedFields": { "legalName":"Sriraghav Srisankar",
                       "currentAddress":"123 Main St, Sunnyvale, CA" } }
```
One agent call does **two jobs**: answer the user conversationally *and* pull
any personal details they mentioned into structured fields the frontend can
offer to auto-fill into the form. This feeds directly into the I-539
auto-fill — a spoken sentence can populate the real government PDF.

Recognized keys (only those actually stated are returned): `legalName`,
`dateOfBirth`, `countryOfBirth`, `currentAddress`, `alienNumber`. For an
ordinary question ("what is the grace period?") `extractedFields` is `{}`, so
the frontend's confirmation banner doesn't pop up on every message.

Implementation details worth knowing (all confirmed by live testing):
- Uses a delimited `REPLY:` / `EXTRACTED:` format rather than pure JSON —
  asking this agent for JSON-only makes the conversational half stiff, and
  the delimited form survives stray text around it.
- The instruction is appended **only to the newest user turn**, so
  conversation `history` is still sent as real multi-turn messages and the
  agent keeps context.
- The agent often **omits the `EXTRACTED:` section entirely** when there's
  nothing to extract, so a missing section parses as `{}` — not an error.
  Malformed JSON also degrades to `{}` rather than raising.
- **Dates are normalized to `YYYY-MM-DD`.** The agent returns what it heard
  ("March 15 2006"); without normalization a voice-filled date would silently
  fail to populate the PDF.
- Unrecognized keys the agent invents are dropped rather than passed through.

**POST `/api/risk-check`** — two-pass reasoning pipeline
```json
// body
{ "scenario":"Change of Status (B-2)", "layoffDate":"2026-07-10",
  "visaExpiry":"2027-03-15", "hasDependents":false }
// returns
{ "risks":[ { "severity":"high",   "issue":"..." },
            { "severity":"medium", "issue":"..." } ],
  "mitigatedPlan": "calm prose, 2-4 sentences" }
```
The **same agent** is called **twice in sequence**, and pass 2's prompt is
built dynamically from pass 1's output — a backend-orchestrated pipeline, not
two agents:

1. **Auditor pass** — "act as a strict USCIS compliance auditor; find every
   legal risk in this plan, be harsh, cite regulations." Returns a JSON array
   of risks.
2. **Attorney pass** — "here are the risks just found: `<pass 1 output>` —
   mitigate each one." Returns one calm, reassuring paragraph.

The mitigation therefore addresses the *specific* risks the model surfaced
against the USCIS knowledge base; a single call structurally cannot do this.

Notes: `severity` is always exactly `"high"` or `"medium"` (lowercase);
anything else the agent emits is coerced. Risks are sorted high-first and
capped at 4. **Expect ~10–15s latency** — it's two sequential agent calls by
design. If the auditor pass fails or returns unparseable JSON, the route
degrades to a single honest "recommend attorney review" risk rather than
erroring, so a live demo never crashes.

## Data files

- `data/forms/i-539.pdf` — the official fillable USCIS Form I-539.
- `data/employers_sample.csv` — **illustrative sample** employer data so the
  lookup works out of the box. Replace with the real USCIS H-1B Employer Data
  Hub export and point `EMPLOYER_CSV` at it. Sample-data use is disclosed in
  the `notes` field of the response so nothing fabricated looks official.

## Project layout

```
backend/
  app.py                 # Flask app + all routes
  config.py              # env-driven configuration
  services/
    gradient.py          # Gradient AI agent client (real call + mock fallback)
    plans.py             # builds agent requests, parses replies, chat, test placeholders
    forms.py             # form selection + PDF fill/draft generation + download registry
    calendars.py         # .ics generation
    employers.py         # CSV lookup (pandas)
    documents.py         # I-797 text/OCR extraction fallback
    session_store.py     # single-session in-memory store (see note above)
    risk_check.py        # two-pass Auditor->Attorney pipeline
  data/
    forms/i-539.pdf
    employers_sample.csv
  requirements.txt
  .env.example
```

## Deploy (DigitalOcean App Platform)

Run with a production server:
```bash
pip install gunicorn
gunicorn "app:app" --bind 0.0.0.0:8080
```
Set the environment variables above in the App Platform dashboard.

---

**Disclaimer:** GracePeriod is an informational tool, not legal advice. All
generated forms are drafts requiring review by a licensed immigration attorney.

