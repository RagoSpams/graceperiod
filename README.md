# GracePeriod

**An AI-powered navigator for H-1B workers facing layoffs — built in 24 hours at the MLH × DigitalOcean "AI for Social Good" Hackathon.**

---

## The Problem

Yo whats up! When an H-1B visa holder in the United States loses their job, a legal clock starts immediately. Federal regulation gives them a **maximum 60-day grace period** to either find a new sponsoring employer, change their visa status, or leave the country — whichever comes first.

Most people don't know this rule exists until it's already happening to them. Immigration attorneys are expensive and slow to book during a time-sensitive crisis. And the tool most people reach for instead — a general AI chatbot — is a genuinely dangerous fit for this problem: general models hallucinate, and if one invents a wrong deadline, the cost isn't a bad answer. It's someone's legal status in the country.

We're all from the Bay Area, one of the highest-concentration H-1B regions in the world, and this past year we watched tech layoffs turn into immigration emergencies for people around us — coworkers, alumni, family friends. We built GracePeriod because we wanted to actually do something about it.

## What GracePeriod Does

GracePeriod turns a stressful, confusing legal situation into a clear, personalized action plan — grounded entirely in real USCIS policy, not general AI knowledge.

**Core flow:** A user enters their layoff date and visa details, or uploads a photo of their I-797 approval notice, and receives:

- **A plain-language situation summary** — what's happening and what it means, explained without legal jargon
- **A structured 60-day action plan** — week-by-week, with every step flagged as something they can do themselves or something that needs an attorney
- **Every claim cited** back to the specific USCIS document it came from
- **A side-by-side scenario comparison** — H-1B transfer vs. change of status vs. departure, each with timeline, risk level, and tradeoffs
- **An AI-drafted, pre-filled USCIS form** based on their real information, clearly labeled as a draft for attorney review
- **A calendar export** of every deadline, ready to import into Google/Apple/Outlook
- **An employer legitimacy check** — real H-1B sponsorship history pulled from public USCIS disclosure data, so someone can vet a new employer before accepting an offer
- **A one-page attorney consultation summary**, downloadable as a PDF, so a paid consultation gets straight to the advice that matters
- **Voice input** — users can describe their situation out loud instead of filling out forms

## Why This Isn't Just a ChatGPT Wrapper

**Grounded in real, current documents.** We built a knowledge base from actual USCIS policy pages, the federal regulation (8 CFR 214.1), form instructions, and visa program pages — not general training data with a cutoff date. Every fact the AI states is retrieved from a specific, citable source.

**A two-pass reasoning pipeline, not a single response.** Before a plan ever reaches the user, it goes through two distinct AI passes: one configured entirely as a strict compliance auditor, whose only job is to find every legal risk in the plan, and a second configured as defense counsel, which takes every flagged risk and builds a mitigation strategy around it. The user only ever sees the plan after it's been checked and corrected once.

**It knows what it doesn't know.** If a question falls outside what the knowledge base actually supports, the system says so directly and recommends an attorney — instead of guessing with false confidence, which is exactly the failure mode that makes general AI models risky for something this high-stakes.

## Tech Stack

**Frontend:** React, Tailwind CSS, Vite
**Backend:** Python, Flask
**AI Platform:** DigitalOcean Gradient AI — managed agent hosting, RAG knowledge base, model orchestration
**Model:** Claude (Sonnet), selected for grounded, citation-accurate reasoning and native document/image understanding
**PDF generation:** Python-based form field mapping onto official USCIS PDF templates

## Architecture

```
User (browser)
      │
      ▼
React Frontend  ──────►  Flask Backend  ──────►  DigitalOcean Gradient AI
                                                        │
                                                        ▼
                                              Knowledge Base (RAG)
                                              — USCIS policy documents,
                                                8 CFR 214.1, form instructions,
                                                visa program pages
```

The frontend never calls the AI platform directly — every request is routed through the backend, which handles prompt construction, the two-pass risk-check pipeline, PDF generation, and response formatting before anything reaches the user.

## Team

Built by a three-person team over one hackathon weekend:

- **Sriraghav Srisankar**
- **Pranav Saravanan**
- **Teertha Patil**

## Disclaimer

GracePeriod is an informational tool. It does not provide legal advice, and every generated plan includes a disclaimer directing users to consult a licensed immigration attorney for filing decisions. USCIS forms and instructions remain the authoritative source.

---

*Built at the MLH × DigitalOcean "AI for Social Good" Hackathon, July 2026, San Francisco.*
