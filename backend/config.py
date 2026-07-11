"""
Central configuration for the GracePeriod backend.

Everything that changes between "local testing with mock data" and
"connected to the real DigitalOcean Gradient AI agent" is controlled here
through environment variables, so no code needs to change when you swap in
the real endpoint. Copy .env.example to .env and fill in the values.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
FORMS_DIR = DATA_DIR / "forms"


class Config:
    # ---- DigitalOcean Gradient AI agent ----
    # When both of these are set, the backend calls the real agent.
    # When either is missing, the backend automatically falls back to
    # richly-computed MOCK responses so every endpoint stays testable.
    GRADIENT_ENDPOINT = os.getenv("GRADIENT_ENDPOINT", "").strip()
    GRADIENT_API_KEY = os.getenv("GRADIENT_API_KEY", "").strip()
    GRADIENT_MODEL = os.getenv("GRADIENT_MODEL", "").strip()  # optional
    GRADIENT_TIMEOUT = int(os.getenv("GRADIENT_TIMEOUT", "60"))

    # ---- Data files ----
    # Point EMPLOYER_CSV at the real USCIS H-1B employer disclosure CSV when
    # you have it. Defaults to the bundled SAMPLE dataset so the endpoint
    # works out of the box.
    EMPLOYER_CSV = os.getenv("EMPLOYER_CSV", str(DATA_DIR / "employers_sample.csv"))
    I539_TEMPLATE = os.getenv("I539_TEMPLATE", str(FORMS_DIR / "i-539.pdf"))

    # ---- Employer risk thresholds (approval rate) ----
    EMPLOYER_RISK_LOW = float(os.getenv("EMPLOYER_RISK_LOW", "0.90"))   # >= -> low risk
    EMPLOYER_RISK_MED = float(os.getenv("EMPLOYER_RISK_MED", "0.75"))   # >= -> medium risk

    # ---- Flask ----
    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", str(16 * 1024 * 1024)))  # 16 MB uploads
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")

    @property
    def gradient_configured(self) -> bool:
        return bool(self.GRADIENT_ENDPOINT and self.GRADIENT_API_KEY)


config = Config()
