import React, { useState, useRef } from "react";

/* ============================================================
   GracePeriod — AI-Powered H-1B Layoff Navigator
   Design intent: calm, trustworthy, document-like. Not a chat
   app — a structured report generator. Navy + blue on white,
   generous whitespace, clear section dividers.
   ============================================================ */

const API_BASE = "http://localhost:5000";

// Shared fetch wrapper — always includes the ngrok interstitial bypass
// header. Safe to use even when not tunneling through ngrok (backend
// just ignores the extra header when running plain localhost).
async function apiFetch(path, options = {}) {
  const headers = {
    "ngrok-skip-browser-warning": "true",
    ...(options.headers || {}),
  };
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

// ---------- Placeholder / dummy data (swap for real API responses) ----------

const DUMMY_RESULT = {
  situationSummary:
    "You were laid off on July 10, 2026. Your H-1B visa is valid through March 15, 2027, so your full 60-day grace period applies — it will run from your layoff date rather than being cut short by your visa's expiry.",
  options: [
    {
      name: "H-1B Transfer",
      description:
        "A new employer sponsors you under the same H-1B category you already hold. Once they file Form I-129 on your behalf, you're legally allowed to begin working there — you don't have to wait for approval.",
    },
    {
      name: "Change of Status",
      description:
        "You switch to a different visa category (such as B-2 visitor status) to legally remain in the country while you continue your search. This does not authorize employment.",
    },
    {
      name: "Voluntary Departure",
      description:
        "You leave the U.S. before day 60, which preserves your ability to re-enter cleanly later under a new petition.",
    },
  ],
  scenarios: [
    {
      name: "H-1B Transfer",
      timeline: "1–4 weeks",
      risk: "Low",
      pros: ["Keeps your current status", "No lottery re-entry required", "Can start work at filing"],
      cons: ["Depends on finding a sponsor in time", "New employer must file quickly"],
    },
    {
      name: "Change of Status (B-2)",
      timeline: "2–6 weeks processing",
      risk: "Medium",
      pros: ["Buys additional time in the U.S.", "Keeps options open"],
      cons: ["No work authorization", "Recent increased USCIS scrutiny on bridge filings"],
    },
    {
      name: "Voluntary Departure",
      timeline: "Immediate",
      risk: "Low",
      pros: ["Cleanest re-entry path later", "No filing required"],
      cons: ["Ends your U.S. job search in person", "May disrupt family / housing"],
    },
  ],
  actionPlan: [
    {
      week: "Week 1 (Days 1–7)",
      steps: [
        { text: "Notify any active interviewers of your visa timeline and urgency.", flag: "DIY" },
        { text: "Gather termination letter and final pay stub as proof of your layoff date.", flag: "DIY" },
        { text: "Identify one immigration attorney now, before you need them.", flag: "DIY" },
      ],
    },
    {
      week: "Week 2–4 (Days 8–30)",
      steps: [
        { text: "If no offer yet, consult an attorney about change of status as a backup plan.", flag: "NEEDS ATTORNEY" },
        { text: "If an offer arrives, ask the new employer's HR to file Form I-129 immediately.", flag: "NEEDS ATTORNEY" },
      ],
    },
    {
      week: "Week 5–7 (Days 31–50)",
      steps: [
        { text: "If still unresolved, prepare documentation for change of status or departure.", flag: "NEEDS ATTORNEY" },
      ],
    },
    {
      week: "Final Week (Days 51–60)",
      steps: [
        { text: "Confirm filing status or finalize departure plans before day 60.", flag: "DIY" },
      ],
    },
  ],
  citations: [
    "USCIS — Options for Nonimmigrant Workers Following Termination of Employment (archived 2025; underlying regulation still valid)",
    "8 CFR 214.1(l)(2)",
    "USCIS — H-1B Cap Season (confirms no lottery re-entry required for transfers)",
  ],
};

const DUMMY_FORM = {
  formType: "Form I-129",
  selfFileFlag: "MUST BE FILED BY EMPLOYER",
  pdfBase64: null,
  fields: [
    { label: "Petitioner Name", value: "[New Employer Legal Name]" },
    { label: "Beneficiary Name", value: "[Your Full Legal Name]" },
    { label: "Classification Requested", value: "H-1B — Specialty Occupation" },
    { label: "Requested Action", value: "New employment / Change of employer" },
    { label: "Current Nonimmigrant Status", value: "H-1B" },
    { label: "Status Expiration Date", value: "March 15, 2027" },
  ],
};

const DUMMY_DEADLINES = [
  { date: "Jul 17, 2026", label: "Deadline to notify interviewing employers of visa timeline" },
  { date: "Aug 9, 2026", label: "Recommended deadline to consult an attorney if unresolved" },
  { date: "Sep 8, 2026", label: "60-day grace period ends" },
];

// ---------- Small UI primitives ----------

function Badge({ tone, children }) {
  const tones = {
    green: "bg-emerald-50 text-emerald-800 border-emerald-200",
    orange: "bg-amber-50 text-amber-800 border-amber-200",
    red: "bg-rose-50 text-rose-800 border-rose-200",
    navy: "bg-[#EEF2FA] text-[#1F3A5F] border-[#C9D6EC]",
    gray: "bg-slate-50 text-slate-600 border-slate-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function SectionCard({ eyebrow, title, children, className = "", id }) {
  return (
    <section id={id} className={`bg-white/60 backdrop-blur-xl border border-white/80 rounded-2xl shadow-[0_1px_3px_rgba(31,58,95,0.08),0_12px_32px_rgba(31,58,95,0.08)] scroll-mt-24 ${className}`}>
      <div className="px-6 sm:px-8 pt-6 sm:pt-7 pb-2">
        {eyebrow && (
          <div className="text-[11px] font-semibold tracking-[0.14em] text-[#5B8DEF] uppercase mb-1.5">
            {eyebrow}
          </div>
        )}
        {title && (
          <h2 className="text-lg sm:text-xl font-display font-medium text-[#1F3A5F]">{title}</h2>
        )}
      </div>
      <div className="px-6 sm:px-8 pb-7 sm:pb-8">{children}</div>
    </section>
  );
}

function Divider() {
  return <div className="h-px bg-slate-200 my-10" />;
}

function RiskDot({ level }) {
  const colors = { Low: "bg-emerald-500", Medium: "bg-amber-500", High: "bg-rose-500" };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[level] || "bg-slate-400"}`} />;
}

function VoiceInputButton({ onResult, size = "sm" }) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const supported =
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  function startListening() {
    if (!supported) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setListening(true);
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      onResult(transcript);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  if (!supported) return null;

  const dim = size === "sm" ? "w-8 h-8" : "w-10 h-10";

  return (
    <button
      type="button"
      onClick={startListening}
      title="Speak to fill this field"
      className={`${dim} shrink-0 rounded-lg flex items-center justify-center transition-colors ${
        listening
          ? "bg-rose-500 text-white animate-pulse"
          : "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-[#2563EB]"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    </button>
  );
}

function CountdownRing({ layoffDate }) {
  if (!layoffDate) return null;
  const start = new Date(layoffDate);
  const end = new Date(start);
  end.setDate(end.getDate() + 60);
  const today = new Date();
  const totalMs = end - start;
  const elapsedMs = today - start;
  const daysLeft = Math.max(0, Math.ceil((end - today) / (1000 * 60 * 60 * 24)));
  const pctElapsed = Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100));
  const pctRemaining = 100 - pctElapsed;

  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pctRemaining / 100);

  const urgency = daysLeft <= 14 ? "urgent" : daysLeft <= 30 ? "moderate" : "calm";
  const ringColor =
    urgency === "urgent" ? "#E08A4C" : urgency === "moderate" ? "#5B8DEF" : "#2563EB";

  return (
    <div className="flex items-center gap-5 bg-white/70 backdrop-blur-sm border border-white/80 rounded-2xl px-6 py-5 shadow-sm">
      <div className="relative w-[132px] h-[132px] shrink-0">
        <svg width="132" height="132" viewBox="0 0 132 132" className="-rotate-90">
          <circle cx="66" cy="66" r={radius} fill="none" stroke="#E7EEF9" strokeWidth="10" />
          <circle
            cx="66"
            cy="66"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 1s ease-out, stroke 0.4s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="font-display text-3xl font-medium text-[#1F3A5F] leading-none">
            {daysLeft}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 tracking-wide">days left</div>
        </div>
      </div>
      <div className="flex-1">
        <div className="text-sm font-semibold text-[#1F3A5F] mb-1">
          {urgency === "urgent"
            ? "Your window is closing — let's prioritize the next steps."
            : urgency === "moderate"
            ? "You still have real time to work with."
            : "You're early in your grace period — plenty of room to plan carefully."}
        </div>
        <div className="text-xs text-slate-500">
          Grace period ends {end.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </div>
      </div>
    </div>
  );
}


// ---------- Main App ----------

export default function App() {
  const [activeTab, setActiveTab] = useState("details");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [selectedScenario, setSelectedScenario] = useState(null);
  const [formDraft, setFormDraft] = useState(null);

  // risk audit / two-pass reasoning pipeline
  const [riskCheck, setRiskCheck] = useState(null);
  const [riskCheckLoading, setRiskCheckLoading] = useState(false);
  const [riskCheckStage, setRiskCheckStage] = useState(null); // "auditing" | "defending" | null
  const [debateLogOpen, setDebateLogOpen] = useState(false);
  const [deadlines, setDeadlines] = useState(null);
  const [employerQuery, setEmployerQuery] = useState("");
  const [employerResult, setEmployerResult] = useState(null);
  const [employerLoading, setEmployerLoading] = useState(false);
  const [attorneySummary, setAttorneySummary] = useState(null);
  const [attorneyLoading, setAttorneyLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const fileInputRef = useRef(null);

  // chat widget
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([
    {
      role: "assistant",
      text: "Hi — I'm the GracePeriod assistant. Ask me anything about H-1B grace periods, visa options, or current policy — or just tell me about your situation in your own words (or tap the mic to talk), and I'll offer to fill your form for you.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [suggestedFields, setSuggestedFields] = useState(null);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // form fields
  const [layoffDate, setLayoffDate] = useState("");
  const [visaExpiry, setVisaExpiry] = useState("");
  const [hasDependents, setHasDependents] = useState(false);
  const [considering, setConsidering] = useState("not-sure");
  const [language, setLanguage] = useState("english");
  const [tone, setTone] = useState("full");

  // fields required to actually fill a real USCIS PDF form
  const [legalName, setLegalName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [countryOfBirth, setCountryOfBirth] = useState("");
  const [currentAddress, setCurrentAddress] = useState("");
  const [alienNumber, setAlienNumber] = useState("");

  async function handleGeneratePlan(e) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          layoffDate,
          visaExpiry,
          hasDependents,
          considering,
          language,
          tone,
          legalName,
          dateOfBirth,
          countryOfBirth,
          currentAddress,
          alienNumber,
        }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      console.log("API response:", data);
      console.log("actionPlan value:", data.actionPlan);
      setResult(data);
    } catch {
      // Backend not connected yet — fall back to placeholder so UI stays testable
      await new Promise((r) => setTimeout(r, 900));
      setResult(DUMMY_RESULT);
    } finally {
      setLoading(false);
    }
  }

  async function handleUploadDocument(e) {
    e.preventDefault();
    if (!uploadedFile) return;
    setLoading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", uploadedFile);
      fd.append("language", language);
      fd.append("hasDependents", hasDependents);
      const res = await apiFetch(`/api/upload-document`, { method: "POST", body: fd });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      console.log("API response:", data);
      console.log("actionPlan value:", data.actionPlan);
      setResult(data);
    } catch {
      await new Promise((r) => setTimeout(r, 1200));
      setResult(DUMMY_RESULT);
    } finally {
      setLoading(false);
    }
  }

  async function handleRunRiskCheck(scenario) {
    setRiskCheck(null);
    setDebateLogOpen(true);
    setRiskCheckLoading(true);
    setRiskCheckStage("auditing");
    try {
      const res = await apiFetch(`/api/risk-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario: scenario.name,
          layoffDate,
          visaExpiry,
          hasDependents,
        }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      // brief staged reveal even on real data, so the pipeline feels visible
      await new Promise((r) => setTimeout(r, 900));
      setRiskCheckStage("defending");
      await new Promise((r) => setTimeout(r, 700));
      setRiskCheck(data);
    } catch {
      await new Promise((r) => setTimeout(r, 1100));
      setRiskCheckStage("defending");
      await new Promise((r) => setTimeout(r, 900));
      setRiskCheck({
        risks: [
          {
            severity: "high",
            issue:
              "Filing a B-2 change of status too close to day 60 risks USCIS deeming it a 'bridge' filing with heightened scrutiny.",
          },
          {
            severity: "medium",
            issue:
              "No documentation plan currently exists to prove maintenance of status during the gap between employment and filing.",
          },
        ],
        mitigatedPlan:
          "File the change of status request by day 45, not day 60, to build in review buffer. Include a cover letter explaining the employment gap and attach termination documentation immediately. This positions the filing as a good-faith, well-documented request rather than a last-minute bridge filing.",
      });
    } finally {
      setRiskCheckLoading(false);
      setRiskCheckStage(null);
    }
  }

  async function handleSelectScenario(scenario) {
    setSelectedScenario(scenario.name);
    setFormDraft(null);
    try {
      const res = await apiFetch(`/api/fill-form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario: scenario.name,
          legalName,
          dateOfBirth,
          countryOfBirth,
          currentAddress,
          alienNumber,
          visaExpiry,
        }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      setFormDraft(data);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      setFormDraft(DUMMY_FORM);
    }
  }

  async function handleDownloadCalendar() {
    try {
      const res = await apiFetch(`/api/generate-calendar`, { method: "GET" });
      if (!res.ok) throw new Error("bad response");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "graceperiod-deadlines.ics";
      a.click();
    } catch {
      setDeadlines(DUMMY_DEADLINES);
    }
  }

  async function handleCheckEmployer(e) {
    e.preventDefault();
    if (!employerQuery.trim()) return;
    setEmployerLoading(true);
    setEmployerResult(null);
    try {
      const res = await apiFetch(`/api/check-employer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employerName: employerQuery }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      setEmployerResult(data);
    } catch {
      await new Promise((r) => setTimeout(r, 700));
      setEmployerResult({
        found: true,
        petitionCount: 340,
        approvalRate: 94,
        riskLevel: "low",
        notes: "Consistent filing history over the past 3 fiscal years.",
      });
    } finally {
      setEmployerLoading(false);
    }
  }

  async function handleGenerateAttorneySummary() {
    setAttorneyLoading(true);
    setAttorneySummary(null);
    try {
      const res = await apiFetch(`/api/attorney-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layoffDate, visaExpiry, hasDependents, considering }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      setAttorneySummary(data.summary);
    } catch {
      await new Promise((r) => setTimeout(r, 800));
      setAttorneySummary({
        clientSituation: "H-1B worker, laid off Jul 10 2026, visa valid through Mar 15 2027, no dependents.",
        keyDates: "Grace period ends Sep 8, 2026.",
        optionsIdentified: "Actively interviewing (2 companies); considering B-2 change of status as fallback.",
        questions: [
          "Given current USCIS scrutiny on B-2 bridge filings, is this still a safe fallback for my situation?",
          "How fast can premium processing realistically get a new H-1B petition filed near day 60?",
          "Should I verify a prospective employer's H-1B sponsorship history before accepting an offer?",
        ],
      });
    } finally {
      setAttorneyLoading(false);
    }
  }

  const [attorneySummaryPdfLoading, setAttorneySummaryPdfLoading] = useState(false);

  async function handleDownloadAttorneySummaryPdf() {
    setAttorneySummaryPdfLoading(true);
    try {
      const res = await apiFetch("/api/attorney-summary/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layoffDate, visaExpiry, hasDependents, considering }),
      });
      if (!res.ok) throw new Error("bad response");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "GracePeriod_Attorney_Summary.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Attorney summary PDF download failed:", err);
      alert("Couldn't generate the PDF right now — check that the backend is connected and try again.");
    } finally {
      setAttorneySummaryPdfLoading(false);
    }
  }


  function handleDownloadFormPdf() {
    if (!formDraft?.pdfBase64) return;
    const byteChars = atob(formDraft.pdfBase64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${formDraft.formType || "form"}-draft.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) setUploadedFile(e.dataTransfer.files[0]);
  }

  async function handleSendChat(e) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    const nextMessages = [...chatMessages, { role: "user", text }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatLoading(true);
    try {
      const res = await apiFetch(`/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: nextMessages }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      setChatMessages((m) => [...m, { role: "assistant", text: data.reply }]);
      if (data.extractedFields && Object.keys(data.extractedFields).length > 0) {
        setSuggestedFields(data.extractedFields);
      }
    } catch {
      await new Promise((r) => setTimeout(r, 700));
      // Placeholder demonstrates the entity-extraction flow even with no backend.
      // Fires only if the message sounds like it contains personal details.
      const looksLikeDetails = /my name is|i live at|i was born in|address is/i.test(text);
      setChatMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: looksLikeDetails
            ? "Got it — I picked up a few details from that. Want me to fill them into your form below?"
            : "Per 8 CFR 214.1(l)(2), your grace period is capped at 60 days or the end of your authorized validity period, whichever is shorter. I can go deeper on this once I'm connected to the live knowledge base — for now this is a placeholder response so you can preview the chat layout.",
        },
      ]);
      if (looksLikeDetails) {
        setSuggestedFields({
          legalName: "Sriraghav Srisankar",
          countryOfBirth: "India",
          currentAddress: "123 Main St, Sunnyvale, CA 94086",
        });
      }
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  function applySuggestedFields() {
    if (!suggestedFields) return;
    if (suggestedFields.legalName) setLegalName(suggestedFields.legalName);
    if (suggestedFields.dateOfBirth) setDateOfBirth(suggestedFields.dateOfBirth);
    if (suggestedFields.countryOfBirth) setCountryOfBirth(suggestedFields.countryOfBirth);
    if (suggestedFields.currentAddress) setCurrentAddress(suggestedFields.currentAddress);
    if (suggestedFields.alienNumber) setAlienNumber(suggestedFields.alienNumber);
    setSuggestedFields(null);
    setChatMessages((m) => [
      ...m,
      { role: "assistant", text: "Done — I've filled those into your form. You can review and edit them anytime." },
    ]);
  }

  function handleVoiceChatResult(transcript) {
    setChatInput(transcript);
  }

  return (
    <div className="min-h-screen text-slate-800 relative">
      <div className="aurora-bg" aria-hidden="true">
        <div className="aurora-blob b1" />
        <div className="aurora-blob b2" />
        <div className="aurora-blob b3" />
        <div className="aurora-blob b4" />
        <div className="aurora-blob b5" />
      </div>
      <div className="aurora-grain" aria-hidden="true" />

      {/* ---------- Header ---------- */}
      <header className="border-b border-white/60 bg-white/40 backdrop-blur-xl relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#1F3A5F] via-[#5B8DEF] to-[#F3E4C8]" />
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#1F3A5F] to-[#2563EB] flex items-center justify-center shadow-md shrink-0">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 15.5C4 11.36 7.36 8 11.5 8h1C16.64 8 20 11.36 20 15.5"
                  stroke="white"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <line x1="3" y1="18.5" x2="21" y2="18.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
                <line x1="12" y1="2.5" x2="12" y2="5" stroke="white" strokeWidth="1.8" strokeLinecap="round" opacity="0.9" />
                <line x1="5.5" y1="5" x2="7.2" y2="6.6" stroke="white" strokeWidth="1.8" strokeLinecap="round" opacity="0.9" />
                <line x1="18.5" y1="5" x2="16.8" y2="6.6" stroke="white" strokeWidth="1.8" strokeLinecap="round" opacity="0.9" />
              </svg>
            </div>
            <div>
              <div className="text-[26px] font-display font-medium text-[#1F3A5F] leading-none tracking-tight">
                GracePeriod
              </div>
              <div className="text-sm text-slate-500 mt-1.5">
                Know your options. Act fast. Stay informed.
              </div>
            </div>
          </div>
          <Badge tone="navy">Built on DigitalOcean Gradient AI</Badge>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 relative">
        {/* ---------- Hero ---------- */}
        <div className="text-center mb-10 max-w-2xl mx-auto">
          <h1 className="font-display text-3xl sm:text-4xl font-medium text-[#1F3A5F] leading-tight mb-3">
            You have more time — and more options — than it feels like right now.
          </h1>
          <p className="text-slate-600 text-[15px] leading-relaxed">
            Answer a few questions or upload your visa notice, and we'll walk you
            through exactly what to do next — grounded in real USCIS guidance,
            not guesswork.
          </p>
        </div>

        {/* ---------- Input Section ---------- */}
        <SectionCard>
          <div className="flex gap-2 mb-6 border-b border-slate-200 -mx-6 sm:-mx-8 px-6 sm:px-8 justify-center">
            {[
              { id: "details", label: "Enter Details" },
              { id: "upload", label: "Upload Document" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                  activeTab === tab.id
                    ? "border-[#2563EB] text-[#1F3A5F]"
                    : "border-transparent text-slate-400 hover:text-slate-600"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "details" && (
            <form onSubmit={handleGeneratePlan} className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-5">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    When were you laid off?
                  </label>
                  <input
                    type="date"
                    required
                    value={layoffDate}
                    onChange={(e) => setLayoffDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    When does your H-1B visa expire?
                  </label>
                  <input
                    type="date"
                    required
                    value={visaExpiry}
                    onChange={(e) => setVisaExpiry(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-5">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Do you have dependents on H-4 visa?
                  </label>
                  <div className="flex rounded-lg border border-slate-300 overflow-hidden w-fit">
                    {[
                      { v: false, l: "No" },
                      { v: true, l: "Yes" },
                    ].map((opt) => (
                      <button
                        type="button"
                        key={opt.l}
                        onClick={() => setHasDependents(opt.v)}
                        className={`px-5 py-2 text-sm font-medium transition-colors ${
                          hasDependents === opt.v
                            ? "bg-[#1F3A5F] text-white"
                            : "bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {opt.l}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    What are you considering?
                  </label>
                  <select
                    value={considering}
                    onChange={(e) => setConsidering(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  >
                    <option value="new-employer">A new H-1B employer</option>
                    <option value="change-status">Change of status</option>
                    <option value="not-sure">Not sure yet</option>
                  </select>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-5">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Language</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  >
                    <option value="english">English</option>
                    <option value="spanish">Español</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Response style</label>
                  <div className="flex rounded-lg border border-slate-300 overflow-hidden">
                    {[
                      { v: "quick", l: "Quick & Calm" },
                      { v: "full", l: "Full Detail" },
                    ].map((opt) => (
                      <button
                        type="button"
                        key={opt.v}
                        onClick={() => setTone(opt.v)}
                        className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                          tone === opt.v
                            ? "bg-[#1F3A5F] text-white"
                            : "bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {opt.l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="pt-2">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-[#1F3A5F]">
                    For AI-drafted form filing (optional)
                  </h3>
                  <Badge tone="gray">Unlocks pre-filled PDF</Badge>
                </div>
                <p className="text-xs text-slate-500 mb-4">
                  Add these and we'll generate an actual pre-filled draft of your USCIS
                  form — not just a summary. Skip this and you'll still get your full
                  action plan.
                </p>
                <div className="grid sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Full legal name
                    </label>
                    <input
                      type="text"
                      value={legalName}
                      onChange={(e) => setLegalName(e.target.value)}
                      placeholder="As it appears on your passport"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Date of birth
                    </label>
                    <input
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) => setDateOfBirth(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Country of birth
                    </label>
                    <input
                      type="text"
                      value={countryOfBirth}
                      onChange={(e) => setCountryOfBirth(e.target.value)}
                      placeholder="e.g. India"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Alien Registration Number (if known)
                    </label>
                    <input
                      type="text"
                      value={alienNumber}
                      onChange={(e) => setAlienNumber(e.target.value)}
                      placeholder="A-000000000"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Current U.S. mailing address
                    </label>
                    <input
                      type="text"
                      value={currentAddress}
                      onChange={(e) => setCurrentAddress(e.target.value)}
                      placeholder="Street, city, state, ZIP"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-lift w-full sm:w-auto mt-2 bg-[#2563EB] hover:bg-[#1d4fd1] disabled:opacity-60 text-white font-semibold px-7 py-3 rounded-lg text-sm shadow-md hover:shadow-lg"
              >
                {loading ? "Generating…" : "Generate My Action Plan"}
              </button>
            </form>
          )}

          {activeTab === "upload" && (
            <form onSubmit={handleUploadDocument} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Upload your I-797 Approval Notice
                </label>
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
                    dragActive ? "border-[#2563EB] bg-blue-50" : "border-slate-300 bg-slate-50"
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={(e) => setUploadedFile(e.target.files?.[0] || null)}
                  />
                  {uploadedFile ? (
                    <div className="text-sm font-medium text-[#1F3A5F]">{uploadedFile.name}</div>
                  ) : (
                    <>
                      <div className="text-sm font-medium text-slate-600">
                        Drag and drop a photo or PDF here, or click to browse
                      </div>
                      <div className="text-xs text-slate-400 mt-1">
                        We'll read your visa dates automatically
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-5">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Language</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                  >
                    <option value="english">English</option>
                    <option value="spanish">Español</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Dependents on H-4?
                  </label>
                  <div className="flex rounded-lg border border-slate-300 overflow-hidden w-fit">
                    {[
                      { v: false, l: "No" },
                      { v: true, l: "Yes" },
                    ].map((opt) => (
                      <button
                        type="button"
                        key={opt.l}
                        onClick={() => setHasDependents(opt.v)}
                        className={`px-5 py-2 text-sm font-medium transition-colors ${
                          hasDependents === opt.v
                            ? "bg-[#1F3A5F] text-white"
                            : "bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {opt.l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !uploadedFile}
                className="btn-lift w-full sm:w-auto mt-2 bg-[#2563EB] hover:bg-[#1d4fd1] disabled:opacity-50 text-white font-semibold px-7 py-3 rounded-lg text-sm shadow-md hover:shadow-lg"
              >
                {loading ? "Analyzing…" : "Analyze Document"}
              </button>
            </form>
          )}
        </SectionCard>

        {/* ---------- Loading state ---------- */}
        {loading && (
          <div className="mt-8 flex items-center justify-center gap-3 py-10 text-slate-500">
            <span className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-[#2563EB] animate-spin" />
            <span className="text-sm font-display">Taking a breath and reviewing your situation…</span>
          </div>
        )}

        {/* ---------- Results ---------- */}
        {result && !loading && (
          <div className="mt-10 animate-fade-in">
            <div className="mb-6">
              <CountdownRing layoffDate={layoffDate} />
            </div>
            <div className="sticky top-0 z-10 -mx-6 px-6 py-3 mb-6 bg-white/70 backdrop-blur-md border-b border-slate-200/70 flex gap-1 overflow-x-auto justify-center">
              {[
                ["summary", "Summary"],
                ["options", "Options"],
                ["compare", "Compare"],
                ["plan", "60-Day Plan"],
                ["calendar", "Calendar"],
                ["employer", "Employer"],
                ["attorney", "Attorney"],
              ].map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="shrink-0 text-xs font-medium text-slate-500 hover:text-[#2563EB] hover:bg-white px-3 py-1.5 rounded-full transition-colors"
                >
                  {label}
                </a>
              ))}
            </div>
            <Divider />

            {/* Situation Summary */}
            <SectionCard id="summary" eyebrow="01 — Situation Summary" className="mb-6">
              <p className="text-[15px] leading-relaxed text-slate-700">{result.situationSummary}</p>
            </SectionCard>

            {/* Your Options */}
            <SectionCard id="options" eyebrow="02 — Your Options" className="mb-6">
              <div className="grid gap-4">
                {result.options.map((opt) => (
                  <div key={opt.name} className="border border-slate-200 rounded-xl p-4">
                    <div className="font-semibold text-[#1F3A5F] text-sm mb-1">{opt.name}</div>
                    <div className="text-sm text-slate-600 leading-relaxed">{opt.description}</div>
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* Scenario Comparison */}
            <SectionCard id="compare" eyebrow="03 — Compare Your Paths" className="mb-6">
              <div className="grid md:grid-cols-3 gap-4">
                {result.scenarios.map((s) => (
                  <div
                    key={s.name}
                    className={`border rounded-xl p-5 flex flex-col transition-all duration-200 hover:shadow-md ${
                      selectedScenario === s.name
                        ? "border-[#2563EB] ring-1 ring-[#2563EB] shadow-sm"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-semibold text-[#1F3A5F] text-sm">{s.name}</div>
                      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                        <RiskDot level={s.risk} /> {s.risk}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 mb-3">{s.timeline}</div>
                    <div className="space-y-1 mb-4 flex-1">
                      {s.pros.map((p) => (
                        <div key={p} className="text-xs text-emerald-700 flex gap-1.5">
                          <span>+</span>
                          <span>{p}</span>
                        </div>
                      ))}
                      {s.cons.map((c) => (
                        <div key={c} className="text-xs text-rose-600 flex gap-1.5">
                          <span>–</span>
                          <span>{c}</span>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => handleSelectScenario(s)}
                      className={`text-xs font-semibold px-3 py-2 rounded-lg transition-colors ${
                        selectedScenario === s.name
                          ? "bg-[#1F3A5F] text-white"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      {selectedScenario === s.name ? "Selected" : "Select this path"}
                    </button>
                    <button
                      onClick={() => handleRunRiskCheck(s)}
                      className="mt-2 text-xs font-semibold px-3 py-2 rounded-lg border border-[#2563EB]/30 text-[#2563EB] hover:bg-[#2563EB]/5 transition-colors flex items-center justify-center gap-1.5"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M9 12l2 2 4-4" />
                      </svg>
                      Run AI Risk Check
                    </button>
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* Action Plan */}
            {/* AI Risk Check — Debate Log */}
            {debateLogOpen && (
              <SectionCard eyebrow="AI Risk Check — Two-Pass Reasoning" className="mb-6">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm text-slate-500">
                    One AI pass audits your plan for legal risk. A second pass defends
                    and mitigates every risk it finds. Grounded in the same verified
                    USCIS knowledge base.
                  </p>
                  <button
                    onClick={() => setDebateLogOpen(false)}
                    className="text-slate-400 hover:text-slate-600 text-sm shrink-0 ml-4"
                  >
                    ✕
                  </button>
                </div>

                <div className="bg-[#0F1A2B] rounded-xl px-5 py-4 font-mono text-[13px] leading-relaxed mb-5 overflow-x-auto">
                  <div className="text-emerald-400/90">$ risk_check.run(scenario)</div>
                  <div className="text-slate-400 mt-2">
                    [Pass 1] Auditor agent reviewing plan for status &amp; timing risks…
                  </div>
                  {(riskCheckStage === "auditing" || riskCheckStage === "defending" || riskCheck) && (
                    <div className="text-amber-400 mt-1 animate-fade-in">
                      [Auditor] {riskCheck ? `${riskCheck.risks.length} risk(s) flagged` : "analyzing…"}
                    </div>
                  )}
                  {(riskCheckStage === "defending" || riskCheck) && (
                    <div className="text-sky-400 mt-1 animate-fade-in">
                      [Pass 2] Attorney agent generating mitigation strategy…
                    </div>
                  )}
                  {riskCheck && (
                    <div className="text-emerald-400 mt-1 animate-fade-in">
                      [Verdict] Risk-mitigated plan ready.
                    </div>
                  )}
                  {riskCheckLoading && !riskCheck && (
                    <div className="text-slate-500 mt-2 flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-slate-500 animate-bounce [animation-delay:-0.3s]" />
                      <span className="w-1 h-1 rounded-full bg-slate-500 animate-bounce [animation-delay:-0.15s]" />
                      <span className="w-1 h-1 rounded-full bg-slate-500 animate-bounce" />
                    </div>
                  )}
                </div>

                {riskCheck && (
                  <div className="animate-fade-in space-y-4">
                    <div>
                      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                        Risks the Auditor Flagged
                      </div>
                      <div className="space-y-2">
                        {riskCheck.risks.map((r, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-3 border border-slate-200 rounded-lg px-3.5 py-2.5"
                          >
                            <Badge tone={r.severity === "high" ? "red" : "orange"}>
                              {r.severity === "high" ? "HIGH RISK" : "MEDIUM RISK"}
                            </Badge>
                            <span className="text-sm text-slate-700 leading-snug">{r.issue}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                        Attorney's Mitigation Strategy
                      </div>
                      <div className="border border-emerald-200 bg-emerald-50/50 rounded-lg px-4 py-3 text-sm text-slate-700 leading-relaxed">
                        {riskCheck.mitigatedPlan}
                      </div>
                    </div>
                  </div>
                )}
              </SectionCard>
            )}

            <SectionCard id="plan" eyebrow="04 — Your 60-Day Action Plan" className="mb-6">
              <div className="space-y-6">
                {Array.isArray(result.actionPlan) && result.actionPlan.length > 0 ? (
                  result.actionPlan.map((block, blockIdx) => (
                    <div key={block.week || blockIdx}>
                      <div className="text-sm font-semibold text-[#1F3A5F] mb-2">{block.week}</div>
                      <div className="space-y-2">
                        {Array.isArray(block.steps) &&
                          block.steps.map((step, i) => (
                            <div
                              key={i}
                              className="flex items-start gap-3 border border-slate-200 rounded-lg px-3.5 py-2.5"
                            >
                              <Badge tone={step.flag === "DIY" ? "green" : "orange"}>{step.flag}</Badge>
                              <span className="text-sm text-slate-700 leading-snug">{step.text}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-slate-400 italic">
                    No action plan data received — check the browser console for errors.
                  </div>
                )}
              </div>

              <div className="mt-6 pt-5 border-t border-slate-100">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                  Sources
                </div>
                <ul className="space-y-1">
                  {(result.citations || []).map((c) => (
                    <li key={c} className="text-xs text-slate-400">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </SectionCard>

            {/* Form Auto-Fill */}
            {formDraft && (
              <SectionCard id="form" eyebrow="05 — AI-Drafted Form" className="mb-6">
                <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
                  <h3 className="font-semibold text-[#1F3A5F]">{formDraft.formType}</h3>
                  <Badge tone={formDraft.selfFileFlag === "SELF-FILE OK" ? "green" : "orange"}>
                    {formDraft.selfFileFlag}
                  </Badge>
                </div>
                <div className="border border-slate-200 rounded-xl overflow-hidden mb-4">
                  {formDraft.fields.map((f, i) => (
                    <div
                      key={f.label}
                      className={`flex text-sm px-4 py-2.5 ${i % 2 ? "bg-slate-50" : "bg-white"}`}
                    >
                      <div className="w-1/2 text-slate-500">{f.label}</div>
                      <div className="w-1/2 font-medium text-slate-800">{f.value}</div>
                    </div>
                  ))}
                </div>
                <p className="text-sm font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4">
                  This is an AI-generated draft. Review carefully and consult an attorney before filing.
                </p>
                {!legalName && (
                  <p className="text-xs text-slate-500 mb-4">
                    Add your legal name, date of birth, and address above to generate a
                    fully pre-filled PDF instead of this summary.
                  </p>
                )}
                <button
                  onClick={handleDownloadFormPdf}
                  disabled={!formDraft.pdfBase64}
                  className="btn-lift bg-[#1F3A5F] hover:bg-[#182e4b] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
                >
                  {formDraft.pdfBase64 ? "Download Filled PDF" : "Download Filled PDF (add details above first)"}
                </button>
              </SectionCard>
            )}

            {/* Calendar Export */}
            <SectionCard id="calendar" eyebrow="06 — Calendar" className="mb-6">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                  <h3 className="font-semibold text-[#1F3A5F] mb-1">Add your deadlines to your calendar</h3>
                  <p className="text-sm text-slate-500">
                    Exports as a .ics file compatible with Google Calendar, Apple Calendar, and Outlook.
                  </p>
                </div>
                <button
                  onClick={handleDownloadCalendar}
                  className="bg-[#2563EB] hover:bg-[#1d4fd1] text-white text-sm font-semibold px-5 py-2.5 rounded-lg whitespace-nowrap transition-colors"
                >
                  Download Calendar File
                </button>
              </div>
              {deadlines && (
                <div className="mt-5 space-y-2">
                  {deadlines.map((d) => (
                    <div key={d.label} className="flex gap-3 text-sm border-t border-slate-100 pt-2.5">
                      <span className="font-semibold text-[#1F3A5F] w-28 shrink-0">{d.date}</span>
                      <span className="text-slate-600">{d.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* Employer Lookup */}
            <SectionCard id="employer" eyebrow="07 — Employer Check" className="mb-6">
              <h3 className="font-semibold text-[#1F3A5F] mb-1">
                Considering a new employer? Check their H-1B sponsorship history
              </h3>
              <p className="text-sm text-slate-500 mb-4">
                Pulled from public USCIS H-1B disclosure data.
              </p>
              <form onSubmit={handleCheckEmployer} className="flex gap-2 flex-wrap mb-4">
                <input
                  type="text"
                  value={employerQuery}
                  onChange={(e) => setEmployerQuery(e.target.value)}
                  placeholder="Company name"
                  className="flex-1 min-w-[200px] rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                />
                <button
                  type="submit"
                  disabled={employerLoading}
                  className="bg-[#1F3A5F] hover:bg-[#182e4b] disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
                >
                  {employerLoading ? "Checking…" : "Check Employer"}
                </button>
              </form>
              {employerResult && (
                <div className="border border-slate-200 rounded-xl p-4 flex items-start gap-4">
                  <RiskDot level={employerResult.riskLevel === "low" ? "Low" : employerResult.riskLevel === "medium" ? "Medium" : "High"} />
                  <div className="text-sm">
                    <div className="font-semibold text-[#1F3A5F] mb-1">
                      {employerResult.petitionCount} petitions filed · {employerResult.approvalRate}% approval rate
                    </div>
                    <div className="text-slate-500">{employerResult.notes}</div>
                  </div>
                </div>
              )}
            </SectionCard>

            {/* Attorney Summary */}
            <SectionCard id="attorney" eyebrow="08 — Attorney Consultation">
              <h3 className="font-semibold text-[#1F3A5F] mb-1">Prepare for an attorney consultation</h3>
              <p className="text-sm text-slate-500 mb-4">
                Generates a one-page summary so your consultation gets straight to the advice you need.
              </p>
              <button
                onClick={handleGenerateAttorneySummary}
                disabled={attorneyLoading}
                className="bg-[#2563EB] hover:bg-[#1d4fd1] disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors mb-5"
              >
                {attorneyLoading ? "Generating…" : "Generate One-Page Summary"}
              </button>

              {attorneySummary && (
                <div className="border border-slate-200 rounded-xl p-6 bg-slate-50">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                    Client Situation
                  </div>
                  <p className="text-sm text-slate-700 mb-4">{attorneySummary.clientSituation}</p>

                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                    Key Dates
                  </div>
                  <p className="text-sm text-slate-700 mb-4">{attorneySummary.keyDates}</p>

                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                    Options Already Identified
                  </div>
                  <p className="text-sm text-slate-700 mb-4">{attorneySummary.optionsIdentified}</p>

                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                    Questions for the Attorney
                  </div>
                  <ol className="text-sm text-slate-700 list-decimal list-inside space-y-1 mb-5">
                    {attorneySummary.questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ol>

                  <button
                    onClick={handleDownloadAttorneySummaryPdf}
                    disabled={attorneySummaryPdfLoading}
                    className="btn-lift bg-[#1F3A5F] hover:bg-[#182e4b] disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
                  >
                    {attorneySummaryPdfLoading ? "Generating PDF…" : "Download as PDF"}
                  </button>
                </div>
              )}
            </SectionCard>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-slate-400 pb-10 relative">
        GracePeriod is informational only and does not constitute legal advice.
      </footer>

      {/* ---------- Floating Chat Button ---------- */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="btn-lift fixed bottom-6 right-6 z-30 flex items-center gap-2 bg-[#1F3A5F] hover:bg-[#162a45] text-white pl-4 pr-5 py-3.5 rounded-full shadow-lg hover:shadow-xl"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          <span className="text-sm font-semibold">Ask about your visa</span>
        </button>
      )}

      {/* ---------- Chat Panel ---------- */}
      {chatOpen && (
        <div className="fixed bottom-0 right-0 sm:bottom-6 sm:right-6 z-30 w-full sm:w-[400px] h-full sm:h-[560px] bg-white/95 backdrop-blur-md sm:rounded-2xl shadow-2xl border border-slate-200/70 flex flex-col overflow-hidden animate-fade-in">
          {/* Chat header */}
          <div className="bg-[#1F3A5F] px-5 py-4 flex items-center justify-between shrink-0">
            <div>
              <div className="text-white font-display font-medium text-base">Ask GracePeriod</div>
              <div className="text-white/60 text-xs mt-0.5">
                Grounded in verified USCIS sources
              </div>
            </div>
            <button
              onClick={() => setChatOpen(false)}
              className="text-white/70 hover:text-white w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 transition-colors"
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-slate-50">
            {chatMessages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "bg-[#2563EB] text-white rounded-br-sm"
                      : "bg-white border border-slate-200 text-slate-700 rounded-bl-sm"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Suggested fields banner */}
          {suggestedFields && (
            <div className="border-t border-slate-200 bg-blue-50 px-4 py-3 animate-fade-in">
              <div className="text-xs font-semibold text-[#1F3A5F] mb-1.5">
                I picked up some details from our chat:
              </div>
              <div className="text-xs text-slate-600 space-y-0.5 mb-2.5">
                {Object.entries(suggestedFields).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-slate-400">{k}:</span> {v}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={applySuggestedFields}
                  className="text-xs font-semibold bg-[#2563EB] hover:bg-[#1d4fd1] text-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  Fill my form with these
                </button>
                <button
                  onClick={() => setSuggestedFields(null)}
                  className="text-xs font-medium text-slate-500 hover:text-slate-700 px-3 py-1.5"
                >
                  Not now
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          <form onSubmit={handleSendChat} className="border-t border-slate-200 p-3 flex gap-2 shrink-0 bg-white">
            <VoiceInputButton onResult={handleVoiceChatResult} />
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask, or tell me your details…"
              className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
            />
            <button
              type="submit"
              disabled={chatLoading}
              className="bg-[#2563EB] hover:bg-[#1d4fd1] disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
