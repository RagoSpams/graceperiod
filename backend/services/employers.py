"""
Employer legitimacy lookup.

Loads a USCIS H-1B employer disclosure CSV (bundled sample by default; point
EMPLOYER_CSV at the real dataset in .env) and answers "what is this employer's
H-1B sponsorship track record?" with a simple risk indicator.

Not AI -- this is a structured dataset lookup, which is exactly one of the
things that distinguishes GracePeriod from a chatbot.
"""

import logging

import pandas as pd

from config import config

log = logging.getLogger("graceperiod.employers")

_df_cache = {"path": None, "df": None}


def _load_df():
    """Load and cache the employer CSV. Reloads if the configured path changes."""
    path = config.EMPLOYER_CSV
    if _df_cache["df"] is not None and _df_cache["path"] == path:
        return _df_cache["df"]

    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]

    # Normalize to the columns we need, tolerating a few schema variants so a
    # real USCIS export can drop in with minimal fuss.
    if "employer_name" not in df.columns:
        for alt in ("employer", "petitioner", "company", "name"):
            if alt in df.columns:
                df = df.rename(columns={alt: "employer_name"})
                break

    if "approvals" not in df.columns and "initial_approvals" in df.columns:
        cont = df["continuing_approvals"] if "continuing_approvals" in df.columns else 0
        df["approvals"] = df["initial_approvals"].fillna(0) + (
            cont.fillna(0) if hasattr(cont, "fillna") else 0)
    if "denials" not in df.columns and "initial_denials" in df.columns:
        cont = df["continuing_denials"] if "continuing_denials" in df.columns else 0
        df["denials"] = df["initial_denials"].fillna(0) + (
            cont.fillna(0) if hasattr(cont, "fillna") else 0)

    df["_name_lower"] = df["employer_name"].astype(str).str.lower().str.strip()
    _df_cache.update({"path": path, "df": df})
    log.info("Loaded employer dataset (%d rows) from %s", len(df), path)
    return df


def _risk_level(approval_rate):
    if approval_rate >= config.EMPLOYER_RISK_LOW:
        return "low"
    if approval_rate >= config.EMPLOYER_RISK_MED:
        return "medium"
    return "high"


def check_employer(employer_name):
    """
    Look up an employer and return its sponsorship profile.

    Response shape matches the frontend contract exactly:
      found True:  { found, petitionCount, approvalRate, riskLevel, notes }
                   (approvalRate is a 0-100 number, e.g. 94, not a fraction)
      found False: { found, notes }
    """
    query = (employer_name or "").strip()
    if not query:
        return {"found": False, "notes": "Please enter an employer name to check."}

    try:
        df = _load_df()
    except FileNotFoundError:
        return {
            "found": False,
            "notes": "Employer dataset is not configured on the server. "
                     "You can check USCIS's public H-1B Employer Data Hub directly "
                     "at my.uscis.gov/employer-information-h1b.",
        }

    q = query.lower()
    # exact, then substring match
    match = df[df["_name_lower"] == q]
    if match.empty:
        match = df[df["_name_lower"].str.contains(q, regex=False, na=False)]

    if match.empty:
        return {
            "found": False,
            "notes": f"'{query}' was not found in the current dataset. Check USCIS's "
                     "public H-1B Employer Data Hub at my.uscis.gov/employer-information-h1b "
                     "for their official filing history.",
        }

    row = match.iloc[0]
    approvals = float(row.get("approvals", 0) or 0)
    denials = float(row.get("denials", 0) or 0)
    total = approvals + denials
    petition_count = int(row.get("petitions_filed", total) or total)
    approval_fraction = (approvals / total) if total > 0 else None
    risk = _risk_level(approval_fraction) if approval_fraction is not None else "unknown"

    notes = {
        "low": "Strong, consistent H-1B approval record.",
        "medium": "Moderate approval record — reasonable, but confirm details of your offer.",
        "high": "Below-average approval rate. Ask detailed questions about their filing "
                "history and compliance before resigning any current search.",
        "unknown": "Insufficient data to assess approval rate.",
    }[risk]
    if _source_label(df).startswith("SAMPLE"):
        notes += " (Figures are from a SAMPLE dataset for demo purposes — replace with real USCIS data.)"

    return {
        "found": True,
        "petitionCount": petition_count,
        "approvalRate": round(approval_fraction * 100) if approval_fraction is not None else None,
        "riskLevel": risk,
        "notes": notes,
    }


def _source_label(df):
    if "data_source" in df.columns and str(df["data_source"].iloc[0]).upper() == "SAMPLE":
        return "SAMPLE dataset (illustrative only — replace with real USCIS disclosure data)"
    return "USCIS H-1B employer disclosure data"
