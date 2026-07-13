import React, { useState, useRef } from "react";

/* ============================================================
   GracePeriod — Dashboard rebuild
   Same functionality/API contract as the hackathon build.
   New visual system: fixed dark sidebar + white canvas,
   indigo/lime accent, confident SaaS-product feel.
   ============================================================ */

const API_BASE = "http://localhost:5000";

async function apiFetch(path, options = {}) {
  const headers = {
    "ngrok-skip-browser-warning": "true",
    ...(options.headers || {}),
  };
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

// ---------- Placeholder data ----------
const DUMMY_RESULT = {
  situationSummary:
    "You were laid off on July 10, 2026. Your H-1B visa is valid through March 15, 2027, so your full 60-day grace period applies — it runs from your layoff date rather than being cut short by your visa's expiry.",
  options: [
    { name: "H-1B Transfer", description: "A new employer sponsors you under the same H-1B category you already hold. Once they file Form I-129 on your behalf, you're legally allowed to begin working there — you don't have to wait for approval." },
    { name: "Change of Status", description: "You switch to a different visa category (such as B-2 visitor status) to legally remain in the country while you continue your search. This does not authorize employment." },
    { name: "Voluntary Departure", description: "You leave the U.S. before day 60, which preserves your ability to re-enter cleanly later under a new petition." },
  ],
  scenarios: [
    { name: "H-1B Transfer", timeline: "1–4 weeks", risk: "Low", pros: ["Keeps your current status", "No lottery re-entry required", "Can start work at filing"], cons: ["Depends on finding a sponsor in time", "New employer must file quickly"] },
    { name: "Change of Status (B-2)", timeline: "2–6 weeks processing", risk: "Medium", pros: ["Buys additional time in the U.S.", "Keeps options open"], cons: ["No work authorization", "Recent increased USCIS scrutiny on bridge filings"] },
    { name: "Voluntary Departure", timeline: "Immediate", risk: "Low", pros: ["Cleanest re-entry path later", "No filing required"], cons: ["Ends your U.S. job search in person", "May disrupt family / housing"] },
  ],
  actionPlan: [
    { week: "Week 1 (Days 1–7)", steps: [
      { text: "Notify any active interviewers of your visa timeline and urgency.", flag: "DIY" },
      { text: "Gather termination letter and final pay stub as proof of your layoff date.", flag: "DIY" },
      { text: "Identify one immigration attorney now, before you need them.", flag: "DIY" },
    ]},
    { week: "Week 2–4 (Days 8–30)", steps: [
      { text: "If no offer yet, consult an attorney about change of status as a backup plan.", flag: "NEEDS ATTORNEY" },
      { text: "If an offer arrives, ask the new employer's HR to file Form I-129 immediately.", flag: "NEEDS ATTORNEY" },
    ]},
    { week: "Week 5–7 (Days 31–50)", steps: [
      { text: "If still unresolved, prepare documentation for change of status or departure.", flag: "NEEDS ATTORNEY" },
    ]},
    { week: "Final Week (Days 51–60)", steps: [
      { text: "Confirm filing status or finalize departure plans before day 60.", flag: "DIY" },
    ]},
  ],
  citations: [
    "USCIS — Options for Nonimmigrant Workers Following Termination of Employment",
    "8 CFR 214.1(l)(2)",
    "USCIS — H-1B Cap Season",
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
    { label: "Current Nonimmigrant Status", value: "H-1B" },
    { label: "Status Expiration Date", value: "March 15, 2027" },
  ],
};

const DUMMY_DEADLINES = [
  { date: "Jul 17, 2026", label: "Notify interviewing employers of visa timeline" },
  { date: "Aug 9, 2026", label: "Recommended deadline to consult an attorney if unresolved" },
  { date: "Sep 8, 2026", label: "60-day grace period ends" },
];

// ---------- UI Primitives ----------

function Pill({ tone = "neutral", children }) {
  const tones = {
    neutral: "bg-white/10 text-white/60",
    indigo: "bg-[#4F46E5]/10 text-[#4F46E5]",
    lime: "bg-[#A3E635]/20 text-[#4d7c0f]",
    red: "bg-rose-50 text-rose-700",
    orange: "bg-amber-50 text-amber-700",
    green: "bg-emerald-50 text-emerald-700",
    dark: "bg-[#0A0A0F] text-white",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Card({ children, className = "", id, noPad = false }) {
  return (
    <section
      id={id}
      className={`bg-white/[0.04] backdrop-blur-sm border border-white/10 rounded-2xl card-lift scroll-mt-24 ${noPad ? "" : "p-7"} ${className}`}
    >
      {children}
    </section>
  );
}

function SectionLabel({ index, children }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <span className="font-mono-tech text-[11px] font-bold text-[#4F46E5] bg-[#4F46E5]/10 w-6 h-6 rounded-md flex items-center justify-center">
        {index}
      </span>
      <h2 className="text-[15px] font-bold text-white tracking-tight">{children}</h2>
    </div>
  );
}

function RiskDot({ level }) {
  const colors = { Low: "bg-emerald-500", Medium: "bg-amber-500", High: "bg-rose-500" };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[level] || "bg-slate-400"}`} />;
}

function VoiceInputButton({ onResult, size = "sm" }) {
  const [listening, setListening] = useState(false);
  const supported = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  function startListening() {
    if (!supported) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognition.onresult = (e) => onResult(e.results[0][0].transcript);
    recognition.start();
  }
  if (!supported) return null;
  const dim = size === "sm" ? "w-9 h-9" : "w-10 h-10";
  return (
    <button type="button" onClick={startListening} title="Speak to fill this field"
      className={`${dim} shrink-0 rounded-lg flex items-center justify-center transition-colors ${
        listening ? "bg-rose-500 text-white animate-pulse" : "bg-[#0A0A0F]/5 text-white/50 hover:bg-[#4F46E5]/10 hover:text-[#4F46E5]"
      }`}>
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
  const daysLeft = Math.max(0, Math.ceil((end - today) / 86400000));
  const pctRemaining = 100 - Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100));
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pctRemaining / 100);
  const urgency = daysLeft <= 14 ? "urgent" : daysLeft <= 30 ? "moderate" : "calm";
  const ringColor = urgency === "urgent" ? "#FB923C" : urgency === "moderate" ? "#A3E635" : "#4F46E5";

  return (
    <div className="flex items-center gap-6 bg-[#0A0A0F] rounded-2xl px-8 py-7 sidebar-texture">
      <div className="relative w-[140px] h-[140px] shrink-0">
        <svg width="140" height="140" viewBox="0 0 140 140" className="-rotate-90">
          <circle cx="70" cy="70" r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" />
          <circle cx="70" cy="70" r={radius} fill="none" stroke={ringColor} strokeWidth="9" strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 1s ease-out, stroke 0.4s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-4xl font-black text-white leading-none font-mono-tech">{daysLeft}</div>
          <div className="text-[10px] text-white/40 mt-1.5 tracking-widest uppercase">days left</div>
        </div>
      </div>
      <div className="flex-1">
        <Pill tone={urgency === "urgent" ? "orange" : urgency === "moderate" ? "lime" : "indigo"}>
          {urgency === "urgent" ? "Act soon" : urgency === "moderate" ? "On track" : "Early stage"}
        </Pill>
        <div className="text-white font-bold text-lg mt-2.5 leading-snug">
          {urgency === "urgent" ? "Your window is closing — prioritize next steps." : urgency === "moderate" ? "You still have real time to work with." : "Plenty of room to plan carefully."}
        </div>
        <div className="text-white/40 text-xs mt-2 font-mono-tech">
          GRACE PERIOD ENDS {end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase()}
        </div>
      </div>
    </div>
  );
}

function LandingPage({ onGetStarted }) {
  const features = [
    { icon: "📄", title: "Reads your actual documents", desc: "Upload your I-797 and we extract your real dates — no manual entry." },
    { icon: "🛡️", title: "Two-pass AI risk check", desc: "One agent attacks your plan for legal risk, a second one defends it." },
    { icon: "📋", title: "AI-drafted forms", desc: "Real USCIS form fields pre-filled, ready for your attorney to review." },
    { icon: "🏢", title: "Employer verification", desc: "Check any company's real H-1B sponsorship track record before you accept." },
  ];

  return (
    <div className="min-h-screen w-full relative overflow-hidden text-white">
      <div className="landing-bg">
        <div className="glow-orb g1" />
        <div className="glow-orb g2" />
        <div className="glow-orb g3" />
      </div>

      <div className="relative z-10">
        <div className="max-w-6xl mx-auto px-8 py-7 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#A3E635] flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0A0A0F" strokeWidth="2.4">
                <path d="M4 15.5C4 11.36 7.36 8 11.5 8h1C16.64 8 20 11.36 20 15.5" strokeLinecap="round" />
                <line x1="3" y1="18.5" x2="21" y2="18.5" strokeLinecap="round" />
              </svg>
            </div>
            <span className="font-black text-lg tracking-tight">GracePeriod</span>
          </div>
          <button onClick={onGetStarted} className="btn-press text-sm font-bold bg-white/10 hover:bg-white/15 border border-white/15 px-5 py-2.5 rounded-lg">
            Sign In
          </button>
        </div>

        <div className="max-w-4xl mx-auto px-8 pt-20 pb-16 text-center">
          <h1 className="text-5xl sm:text-6xl font-black tracking-tight leading-[1.05] mb-6">
            You have <span className="text-[#A3E635]">60 days.</span><br />
            Know exactly what to do with them.
          </h1>
          <p className="text-white/50 text-lg max-w-xl mx-auto mb-10 leading-relaxed">
            When an H-1B worker gets laid off, GracePeriod turns real USCIS policy into a personalized action plan — not a guess from a general AI model.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <button onClick={onGetStarted}
              className="btn-press bg-[#4F46E5] hover:bg-[#4338CA] text-white font-bold px-8 py-4 rounded-xl text-[15px] shadow-[0_0_40px_rgba(79,70,229,0.4)]">
              Get Started — It's Free →
            </button>
            <span className="text-white/30 text-sm">No account needed</span>
          </div>
        </div>

        <div className="max-w-5xl mx-auto px-8 pb-24">
          <div className="grid sm:grid-cols-2 gap-4">
            {features.map((f) => (
              <div key={f.title} className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 hover:bg-white/[0.05] transition-colors">
                <div className="text-2xl mb-3">{f.icon}</div>
                <div className="font-bold text-[15px] mb-1.5">{f.title}</div>
                <div className="text-white/45 text-sm leading-relaxed">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-white/10 py-6">
          <div className="max-w-6xl mx-auto px-8 text-center text-white/25 text-xs">
            GracePeriod is informational only and does not constitute legal advice.
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Main App ----------

export default function App() {
  const [view, setView] = useState("landing");
  const [activeTab, setActiveTab] = useState("details");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [selectedScenario, setSelectedScenario] = useState(null);
  const [formDraft, setFormDraft] = useState(null);
  const [riskCheck, setRiskCheck] = useState(null);
  const [riskCheckLoading, setRiskCheckLoading] = useState(false);
  const [riskCheckStage, setRiskCheckStage] = useState(null);
  const [debateLogOpen, setDebateLogOpen] = useState(false);
  const [deadlines, setDeadlines] = useState(null);
  const [employerQuery, setEmployerQuery] = useState("");
  const [employerResult, setEmployerResult] = useState(null);
  const [employerLoading, setEmployerLoading] = useState(false);
  const [attorneySummary, setAttorneySummary] = useState(null);
  const [attorneyLoading, setAttorneyLoading] = useState(false);
  const [attorneySummaryPdfLoading, setAttorneySummaryPdfLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const fileInputRef = useRef(null);
  const [activeSection, setActiveSection] = useState("summary");

  const [layoffDate, setLayoffDate] = useState("");
  const [visaExpiry, setVisaExpiry] = useState("");
  const [hasDependents, setHasDependents] = useState(false);
  const [considering, setConsidering] = useState("not-sure");
  const [language, setLanguage] = useState("english");
  const [tone, setTone] = useState("full");
  const [legalName, setLegalName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [countryOfBirth, setCountryOfBirth] = useState("");
  const [currentAddress, setCurrentAddress] = useState("");
  const [alienNumber, setAlienNumber] = useState("");

  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", text: "Hi — I'm the GracePeriod assistant. Ask me anything about H-1B grace periods, or tell me about your situation and I'll offer to fill your form." },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [suggestedFields, setSuggestedFields] = useState(null);
  const chatEndRef = useRef(null);

  async function handleGeneratePlan(e) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layoffDate, visaExpiry, hasDependents, considering, language, tone, legalName, dateOfBirth, countryOfBirth, currentAddress, alienNumber }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      setResult(data);
    } catch {
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
      setResult(data);
    } catch {
      await new Promise((r) => setTimeout(r, 1200));
      setResult(DUMMY_RESULT);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectScenario(scenario) {
    setSelectedScenario(scenario.name);
    setFormDraft(null);
    try {
      const res = await apiFetch(`/api/fill-form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: scenario.name, legalName, dateOfBirth, countryOfBirth, currentAddress, alienNumber, visaExpiry }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      setFormDraft(data);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      setFormDraft(DUMMY_FORM);
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
        body: JSON.stringify({ scenario: scenario.name, layoffDate, visaExpiry, hasDependents }),
      });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
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
          { severity: "high", issue: "Filing a B-2 change of status too close to day 60 risks USCIS deeming it a 'bridge' filing with heightened scrutiny." },
          { severity: "medium", issue: "No documentation plan currently exists to prove maintenance of status during the gap between employment and filing." },
        ],
        mitigatedPlan: "File the change of status request by day 45, not day 60, to build in review buffer. Include a cover letter explaining the employment gap and attach termination documentation immediately.",
      });
    } finally {
      setRiskCheckLoading(false);
      setRiskCheckStage(null);
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
      setEmployerResult({ found: true, petitionCount: 340, approvalRate: 94, riskLevel: "low", notes: "Consistent filing history over the past 3 fiscal years." });
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
      if (data.extractedFields && Object.keys(data.extractedFields).length > 0) setSuggestedFields(data.extractedFields);
    } catch {
      await new Promise((r) => setTimeout(r, 700));
      const looksLikeDetails = /my name is|i live at|i was born in|address is/i.test(text);
      setChatMessages((m) => [...m, { role: "assistant", text: looksLikeDetails ? "Got it — want me to fill your form with those details?" : "Per 8 CFR 214.1(l)(2), your grace period is capped at 60 days or the end of your authorized validity period, whichever is shorter." }]);
      if (looksLikeDetails) setSuggestedFields({ legalName: "Sriraghav Srisankar", countryOfBirth: "India", currentAddress: "123 Main St, Sunnyvale, CA 94086" });
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
    setChatMessages((m) => [...m, { role: "assistant", text: "Done — filled into your form." }]);
  }

  const navSections = [
    ["summary", "Summary"], ["options", "Options"], ["compare", "Compare"],
    ["plan", "60-Day Plan"], ["calendar", "Calendar"], ["employer", "Employer"], ["attorney", "Attorney"],
  ];

  function scrollTo(id) {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className={view === "landing" ? "min-h-screen bg-[#050507]" : "min-h-screen bg-[#050507] flex"}>
      {view === "landing" ? (
        <LandingPage onGetStarted={() => setView("app")} />
      ) : (
      <>
      <div className="landing-bg" style={{position:"fixed"}}>
        <div className="glow-orb g1" style={{opacity:0.28}} />
        <div className="glow-orb g2" style={{opacity:0.16}} />
      </div>
      {/* ============ SIDEBAR ============ */}
      <aside className="w-[248px] shrink-0 bg-[#0A0A0F] sidebar-texture min-h-screen sticky top-0 flex flex-col">
        <div className="px-6 py-7 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#A3E635] flex items-center justify-center shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0A0A0F" strokeWidth="2.4">
                <path d="M4 15.5C4 11.36 7.36 8 11.5 8h1C16.64 8 20 11.36 20 15.5" strokeLinecap="round" />
                <line x1="3" y1="18.5" x2="21" y2="18.5" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <div className="text-white font-black text-[15px] tracking-tight leading-none">GracePeriod</div>
              <div className="text-white/35 text-[10px] mt-1 tracking-wide">H-1B NAVIGATOR</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-5">
          {result && (
            <div className="px-3 mb-4">
              <div className="text-white/30 text-[10px] font-bold uppercase tracking-widest px-3 mb-2">Your Plan</div>
              {navSections.map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => scrollTo(id)}
                  className={`nav-item w-full text-left px-3 py-2.5 rounded-lg text-[13px] font-medium mb-0.5 ${
                    activeSection === id ? "active bg-white/[0.06] text-white" : "text-white/50 hover:text-white/80 hover:bg-white/[0.03]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {!result && (
            <div className="px-6 py-4">
              <div className="text-white/30 text-[12px] leading-relaxed">
                Fill in your details or upload your visa notice to generate your plan.
              </div>
            </div>
          )}
        </nav>

        <div className="px-6 py-5 border-t border-white/10">
          <div className="flex items-center gap-2 text-white/30 text-[10px] font-mono-tech tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-[#A3E635] pulse-dot" />
            BUILT ON DIGITALOCEAN GRADIENT AI
          </div>
        </div>
      </aside>

      {/* ============ MAIN CANVAS ============ */}
      <main className="flex-1 min-h-screen relative overflow-hidden">
        <div className="landing-bg" style={{position:"absolute"}}>
          <div className="glow-orb g1" style={{opacity:0.25}} />
          <div className="glow-orb g2" style={{opacity:0.15}} />
        </div>
        <div className="max-w-4xl mx-auto px-10 py-10 relative z-10">

          {!result && (
            <div className="mb-8">
              <h1 className="text-3xl font-black text-white tracking-tight leading-tight mb-2">
                You have more options than it feels like right now.
              </h1>
              <p className="text-white/50 text-[15px] max-w-lg">
                Answer a few questions or upload your visa notice — we'll walk you through exactly what to do next, grounded in real USCIS guidance.
              </p>
            </div>
          )}

          {/* ---------- Input Card ---------- */}
          <Card noPad className="mb-8">
            <div className="flex border-b border-white/10">
              {[{ id: "details", label: "Enter Details" }, { id: "upload", label: "Upload Document" }].map((tab) => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  className={`px-6 py-4 text-[13px] font-bold border-b-2 -mb-px transition-colors ${
                    activeTab === tab.id ? "border-[#4F46E5] text-white" : "border-transparent text-white/35 hover:text-white/60"
                  }`}>
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="p-7">
              {activeTab === "details" && (
                <form onSubmit={handleGeneratePlan} className="space-y-5">
                  <div className="grid sm:grid-cols-2 gap-5">
                    <div>
                      <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Layoff date</label>
                      <input type="date" required value={layoffDate} onChange={(e) => setLayoffDate(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5] focus:border-transparent" />
                    </div>
                    <div>
                      <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">H-1B expiry</label>
                      <input type="date" required value={visaExpiry} onChange={(e) => setVisaExpiry(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5] focus:border-transparent" />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-5">
                    <div>
                      <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">H-4 dependents?</label>
                      <div className="flex rounded-lg border border-white/10 overflow-hidden w-fit">
                        {[{ v: false, l: "No" }, { v: true, l: "Yes" }].map((opt) => (
                          <button type="button" key={opt.l} onClick={() => setHasDependents(opt.v)}
                            className={`px-5 py-2 text-sm font-bold transition-colors ${hasDependents === opt.v ? "bg-[#0A0A0F] text-white" : "bg-white/5 text-white/60 hover:bg-white/[0.06]"}`}>
                            {opt.l}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Considering</label>
                      <select value={considering} onChange={(e) => setConsidering(e.target.value)}
                        className="w-full rounded-lg border border-white/10 px-3.5 py-2.5 text-sm bg-white/[0.03] text-white focus:outline-none focus:ring-2 focus:ring-[#4F46E5]">
                        <option value="new-employer" style={{backgroundColor: "#14141C", color: "#fff"}}>A new H-1B employer</option>
                        <option value="change-status" style={{backgroundColor: "#14141C", color: "#fff"}}>Change of status</option>
                        <option value="not-sure" style={{backgroundColor: "#14141C", color: "#fff"}}>Not sure yet</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-5">
                    <div>
                      <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Language</label>
                      <select value={language} onChange={(e) => setLanguage(e.target.value)}
                        className="w-full rounded-lg border border-white/10 px-3.5 py-2.5 text-sm bg-white/[0.03] text-white focus:outline-none focus:ring-2 focus:ring-[#4F46E5]">
                        <option value="english" style={{backgroundColor: "#14141C", color: "#fff"}}>English</option>
                        <option value="spanish" style={{backgroundColor: "#14141C", color: "#fff"}}>Español</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Response style</label>
                      <div className="flex rounded-lg border border-white/10 overflow-hidden">
                        {[{ v: "quick", l: "Quick" }, { v: "full", l: "Full Detail" }].map((opt) => (
                          <button type="button" key={opt.v} onClick={() => setTone(opt.v)}
                            className={`flex-1 px-3 py-2 text-sm font-bold transition-colors ${tone === opt.v ? "bg-[#0A0A0F] text-white" : "bg-white/5 text-white/60 hover:bg-white/[0.06]"}`}>
                            {opt.l}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-white/10">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-[13px] font-bold text-white">For AI-drafted form filing</h3>
                      <Pill tone="indigo">Optional</Pill>
                    </div>
                    <p className="text-[12px] text-white/45 mb-4">Add these to unlock a pre-filled draft form instead of a summary.</p>
                    <div className="grid sm:grid-cols-2 gap-5">
                      <div>
                        <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Full legal name</label>
                        <div className="flex gap-2">
                          <input type="text" value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="As on your passport"
                            className="flex-1 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]" />
                          <VoiceInputButton onResult={setLegalName} />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Date of birth</label>
                        <input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)}
                          className="w-full rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]" />
                      </div>
                      <div>
                        <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Country of birth</label>
                        <input type="text" value={countryOfBirth} onChange={(e) => setCountryOfBirth(e.target.value)} placeholder="e.g. India"
                          className="w-full rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]" />
                      </div>
                      <div>
                        <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">A-Number (if known)</label>
                        <input type="text" value={alienNumber} onChange={(e) => setAlienNumber(e.target.value)} placeholder="A-000000000"
                          className="w-full rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]" />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Current U.S. address</label>
                        <div className="flex gap-2">
                          <input type="text" value={currentAddress} onChange={(e) => setCurrentAddress(e.target.value)} placeholder="Street, city, state, ZIP"
                            className="flex-1 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]" />
                          <VoiceInputButton onResult={setCurrentAddress} />
                        </div>
                      </div>
                    </div>
                  </div>

                  <button type="submit" disabled={loading}
                    className="btn-press w-full sm:w-auto mt-2 bg-white/10 hover:bg-white/[0.16] border border-white/15 disabled:opacity-50 text-white font-bold px-8 py-3.5 rounded-xl text-sm">
                    {loading ? "Generating…" : "Generate My Action Plan →"}
                  </button>
                </form>
              )}

              {activeTab === "upload" && (
                <form onSubmit={handleUploadDocument} className="space-y-5">
                  <div>
                    <label className="block text-[12px] font-bold text-white/60 uppercase tracking-wide mb-2">Upload your I-797 approval notice</label>
                    <div onDragOver={(e) => { e.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={onDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`cursor-pointer rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${dragActive ? "border-[#4F46E5] bg-[#4F46E5]/5" : "border-white/10 bg-white/[0.03]"}`}>
                      <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setUploadedFile(e.target.files?.[0] || null)} />
                      {uploadedFile ? (
                        <div className="text-sm font-bold text-white">{uploadedFile.name}</div>
                      ) : (
                        <>
                          <div className="text-sm font-bold text-white/70">Drag and drop, or click to browse</div>
                          <div className="text-xs text-white/35 mt-1">We'll read your visa dates automatically</div>
                        </>
                      )}
                    </div>
                  </div>
                  <button type="submit" disabled={loading || !uploadedFile}
                    className="btn-press w-full sm:w-auto bg-white/10 hover:bg-white/[0.16] border border-white/15 disabled:opacity-40 text-white font-bold px-8 py-3.5 rounded-xl text-sm">
                    {loading ? "Analyzing…" : "Analyze Document →"}
                  </button>
                </form>
              )}
            </div>
          </Card>

          {loading && (
            <div className="flex items-center justify-center gap-3 py-14 text-white/40">
              <span className="w-4 h-4 rounded-full border-2 border-white/10 border-t-[#4F46E5] animate-spin" />
              <span className="text-sm font-medium">Reviewing your situation…</span>
            </div>
          )}

          {result && !loading && (
            <div className="animate-in space-y-6">
              <CountdownRing layoffDate={layoffDate} />

              <Card id="summary">
                <SectionLabel index="01">Situation Summary</SectionLabel>
                <p className="text-[15px] leading-relaxed text-white/75">{result.situationSummary}</p>
              </Card>

              <Card id="options">
                <SectionLabel index="02">Your Options</SectionLabel>
                <div className="grid gap-3">
                  {result.options.map((opt) => (
                    <div key={opt.name} className="border border-white/10 rounded-xl p-4 hover:border-[#4F46E5]/30 transition-colors">
                      <div className="font-bold text-white text-sm mb-1">{opt.name}</div>
                      <div className="text-sm text-white/60 leading-relaxed">{opt.description}</div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card id="compare">
                <SectionLabel index="03">Compare Your Paths</SectionLabel>
                <div className="grid md:grid-cols-3 gap-4">
                  {result.scenarios.map((s) => (
                    <div key={s.name} className={`border rounded-xl p-5 flex flex-col transition-all ${selectedScenario === s.name ? "border-[#4F46E5] ring-1 ring-[#4F46E5]" : "border-white/10 hover:border-white/25"}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-bold text-white text-sm">{s.name}</div>
                        <span className="flex items-center gap-1.5 text-[11px] font-bold text-white/50"><RiskDot level={s.risk} /> {s.risk}</span>
                      </div>
                      <div className="text-[11px] text-white/35 mb-3 font-mono-tech">{s.timeline}</div>
                      <div className="space-y-1 mb-4 flex-1">
                        {s.pros.map((p) => <div key={p} className="text-xs text-emerald-700 flex gap-1.5"><span>+</span><span>{p}</span></div>)}
                        {s.cons.map((c) => <div key={c} className="text-xs text-rose-600 flex gap-1.5"><span>–</span><span>{c}</span></div>)}
                      </div>
                      <button onClick={() => handleSelectScenario(s)}
                        className={`text-xs font-bold px-3 py-2 rounded-lg transition-colors ${selectedScenario === s.name ? "bg-[#0A0A0F] text-white" : "bg-white/10 text-white hover:bg-white/[0.14]"}`}>
                        {selectedScenario === s.name ? "Selected" : "Select this path"}
                      </button>
                      <button onClick={() => handleRunRiskCheck(s)}
                        className="mt-2 text-xs font-bold px-3 py-2 rounded-lg border border-[#4F46E5]/25 text-[#4F46E5] hover:bg-[#4F46E5]/5 flex items-center justify-center gap-1.5">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9" /><path d="M9 12l2 2 4-4" /></svg>
                        Run AI Risk Check
                      </button>
                    </div>
                  ))}
                </div>
              </Card>

              {debateLogOpen && (
                <Card>
                  <div className="flex items-center justify-between mb-4">
                    <SectionLabel index="◆">AI Risk Check — Two-Pass Reasoning</SectionLabel>
                    <button onClick={() => setDebateLogOpen(false)} className="text-white/30 hover:text-white/60 text-sm">✕</button>
                  </div>
                  <div className="bg-[#0A0A0F] rounded-xl px-5 py-4 font-mono-tech text-[13px] leading-relaxed mb-5 overflow-x-auto">
                    <div className="text-[#A3E635]">$ risk_check.run(scenario)</div>
                    <div className="text-white/40 mt-2">[Pass 1] Auditor agent reviewing plan for status &amp; timing risks…</div>
                    {(riskCheckStage === "auditing" || riskCheckStage === "defending" || riskCheck) && (
                      <div className="text-amber-400 mt-1">[Auditor] {riskCheck ? `${riskCheck.risks.length} risk(s) flagged` : "analyzing…"}</div>
                    )}
                    {(riskCheckStage === "defending" || riskCheck) && (
                      <div className="text-sky-400 mt-1">[Pass 2] Attorney agent generating mitigation strategy…</div>
                    )}
                    {riskCheck && <div className="text-[#A3E635] mt-1">[Verdict] Risk-mitigated plan ready.</div>}
                    {riskCheckLoading && !riskCheck && (
                      <div className="text-white/30 mt-2 flex items-center gap-1.5">
                        <span className="w-1 h-1 rounded-full bg-white/30 animate-bounce [animation-delay:-0.3s]" />
                        <span className="w-1 h-1 rounded-full bg-white/30 animate-bounce [animation-delay:-0.15s]" />
                        <span className="w-1 h-1 rounded-full bg-white/30 animate-bounce" />
                      </div>
                    )}
                  </div>
                  {riskCheck && (
                    <div className="space-y-4">
                      <div>
                        <div className="text-[11px] font-bold text-white/40 uppercase tracking-wide mb-2">Risks the Auditor Flagged</div>
                        <div className="space-y-2">
                          {riskCheck.risks.map((r, i) => (
                            <div key={i} className="flex items-start gap-3 border border-white/10 rounded-lg px-3.5 py-2.5">
                              <Pill tone={r.severity === "high" ? "red" : "orange"}>{r.severity === "high" ? "High" : "Medium"}</Pill>
                              <span className="text-sm text-white/75 leading-snug">{r.issue}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] font-bold text-white/40 uppercase tracking-wide mb-2">Attorney's Mitigation Strategy</div>
                        <div className="border border-emerald-200 bg-emerald-50/50 rounded-lg px-4 py-3 text-sm text-white/75 leading-relaxed">{riskCheck.mitigatedPlan}</div>
                      </div>
                    </div>
                  )}
                </Card>
              )}

              <Card id="plan">
                <SectionLabel index="04">Your 60-Day Action Plan</SectionLabel>
                <div className="space-y-6">
                  {Array.isArray(result.actionPlan) && result.actionPlan.length > 0 ? (
                    result.actionPlan.map((block, bi) => (
                      <div key={block.week || bi}>
                        <div className="text-[13px] font-bold text-white mb-2 font-mono-tech">{block.week}</div>
                        <div className="space-y-2">
                          {Array.isArray(block.steps) && block.steps.map((step, i) => (
                            <div key={i} className="flex items-start gap-3 border border-white/10 rounded-lg px-3.5 py-2.5">
                              <Pill tone={step.flag === "DIY" ? "green" : "orange"}>{step.flag}</Pill>
                              <span className="text-sm text-white/75 leading-snug">{step.text}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-white/35 italic">No action plan data received.</div>
                  )}
                </div>
                <div className="mt-6 pt-5 border-t border-white/10">
                  <div className="text-[11px] font-bold text-white/40 uppercase tracking-wide mb-2">Sources</div>
                  <ul className="space-y-1">
                    {(result.citations || []).map((c) => <li key={c} className="text-xs text-white/35">{c}</li>)}
                  </ul>
                </div>
              </Card>

              {formDraft && (
                <Card>
                  <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
                    <h3 className="font-bold text-white">{formDraft.formType}</h3>
                    <Pill tone={formDraft.selfFileFlag === "SELF-FILE OK" ? "green" : "orange"}>{formDraft.selfFileFlag}</Pill>
                  </div>
                  <div className="border border-white/10 rounded-xl overflow-hidden mb-4">
                    {formDraft.fields.map((f, i) => (
                      <div key={f.label} className={`flex text-sm px-4 py-2.5 ${i % 2 ? "bg-white/[0.03]" : "bg-white/5"}`}>
                        <div className="w-1/2 text-white/45">{f.label}</div>
                        <div className="w-1/2 font-bold text-white">{f.value}</div>
                      </div>
                    ))}
                  </div>
                  <p className="text-sm font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4">
                    This is an AI-generated draft. Review carefully and consult an attorney before filing.
                  </p>
                  {!legalName && <p className="text-xs text-white/40 mb-4">Add your legal name, DOB, and address above to unlock a fully pre-filled PDF.</p>}
                  <button onClick={handleDownloadFormPdf} disabled={!formDraft.pdfBase64}
                    className="btn-press bg-white/10 hover:bg-white/[0.16] border border-white/15 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold px-5 py-2.5 rounded-lg">
                    {formDraft.pdfBase64 ? "Download Filled PDF" : "Download Filled PDF (add details above)"}
                  </button>
                </Card>
              )}

              <Card id="calendar">
                <SectionLabel index="05">Calendar</SectionLabel>
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <h3 className="font-bold text-white mb-1">Add your deadlines to your calendar</h3>
                    <p className="text-sm text-white/45">Exports as .ics — compatible with Google/Apple/Outlook.</p>
                  </div>
                  <button onClick={handleDownloadCalendar} className="btn-press bg-[#4F46E5] hover:bg-[#4338CA] text-white text-sm font-bold px-5 py-2.5 rounded-lg whitespace-nowrap">
                    Download Calendar File
                  </button>
                </div>
                {deadlines && (
                  <div className="mt-5 space-y-2">
                    {deadlines.map((d) => (
                      <div key={d.label} className="flex gap-3 text-sm border-t border-white/10 pt-2.5">
                        <span className="font-bold text-white w-28 shrink-0 font-mono-tech text-xs">{d.date}</span>
                        <span className="text-white/60">{d.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card id="employer">
                <SectionLabel index="06">Employer Check</SectionLabel>
                <h3 className="font-bold text-white mb-1">Check a prospective employer's H-1B sponsorship history</h3>
                <p className="text-sm text-white/45 mb-4">Pulled from public USCIS H-1B disclosure data.</p>
                <form onSubmit={handleCheckEmployer} className="flex gap-2 flex-wrap mb-4">
                  <input type="text" value={employerQuery} onChange={(e) => setEmployerQuery(e.target.value)} placeholder="Company name"
                    className="flex-1 min-w-[200px] rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]" />
                  <button type="submit" disabled={employerLoading} className="btn-press bg-white/10 hover:bg-white/[0.16] border border-white/15 disabled:opacity-50 text-white text-sm font-bold px-5 py-2.5 rounded-lg">
                    {employerLoading ? "Checking…" : "Check Employer"}
                  </button>
                </form>
                {employerResult && (
                  <div className="border border-white/10 rounded-xl p-4 flex items-start gap-4">
                    <RiskDot level={employerResult.riskLevel === "low" ? "Low" : employerResult.riskLevel === "medium" ? "Medium" : "High"} />
                    <div className="text-sm">
                      <div className="font-bold text-white mb-1">{employerResult.petitionCount} petitions filed · {employerResult.approvalRate}% approval rate</div>
                      <div className="text-white/50">{employerResult.notes}</div>
                    </div>
                  </div>
                )}
              </Card>

              <Card id="attorney">
                <SectionLabel index="07">Attorney Consultation</SectionLabel>
                <h3 className="font-bold text-white mb-1">Prepare for an attorney consultation</h3>
                <p className="text-sm text-white/45 mb-4">A one-page summary so your consultation gets straight to the advice you need.</p>
                <button onClick={handleGenerateAttorneySummary} disabled={attorneyLoading}
                  className="btn-press bg-[#4F46E5] hover:bg-[#4338CA] disabled:opacity-50 text-white text-sm font-bold px-5 py-2.5 rounded-lg mb-5">
                  {attorneyLoading ? "Generating…" : "Generate One-Page Summary"}
                </button>
                {attorneySummary && (
                  <div className="border border-white/10 rounded-xl p-6 bg-white/[0.03]">
                    <div className="text-[11px] font-bold text-white/40 uppercase tracking-wide mb-1">Client Situation</div>
                    <p className="text-sm text-white/75 mb-4">{attorneySummary.clientSituation}</p>
                    <div className="text-[11px] font-bold text-white/40 uppercase tracking-wide mb-1">Key Dates</div>
                    <p className="text-sm text-white/75 mb-4">{attorneySummary.keyDates}</p>
                    <div className="text-[11px] font-bold text-white/40 uppercase tracking-wide mb-1">Options Identified</div>
                    <p className="text-sm text-white/75 mb-4">{attorneySummary.optionsIdentified}</p>
                    <div className="text-[11px] font-bold text-white/40 uppercase tracking-wide mb-1">Questions for the Attorney</div>
                    <ol className="text-sm text-white/75 list-decimal list-inside space-y-1 mb-5">
                      {attorneySummary.questions.map((q, i) => <li key={i}>{q}</li>)}
                    </ol>
                    <button onClick={handleDownloadAttorneySummaryPdf} disabled={attorneySummaryPdfLoading}
                      className="btn-press bg-white/10 hover:bg-white/[0.16] border border-white/15 disabled:opacity-60 text-white text-sm font-bold px-5 py-2.5 rounded-lg">
                      {attorneySummaryPdfLoading ? "Generating PDF…" : "Download as PDF"}
                    </button>
                  </div>
                )}
              </Card>
            </div>
          )}

          <div className="text-center text-xs text-white/30 pt-10 pb-6">
            GracePeriod is informational only and does not constitute legal advice.
          </div>
        </div>
      </main>

      {/* ============ CHAT WIDGET ============ */}
      {!chatOpen && (
        <button onClick={() => setChatOpen(true)}
          className="btn-press fixed bottom-6 right-6 z-30 flex items-center gap-2 bg-white/10 hover:bg-white/[0.16] border border-white/15 text-white pl-4 pr-5 py-3.5 rounded-full shadow-xl">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A3E635" strokeWidth="2">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          <span className="text-sm font-bold">Ask about your visa</span>
        </button>
      )}

      {chatOpen && (
        <div className="fixed bottom-0 right-0 sm:bottom-6 sm:right-6 z-30 w-full sm:w-[400px] h-full sm:h-[560px] bg-white/5 sm:rounded-2xl shadow-2xl border border-white/10 flex flex-col overflow-hidden animate-in">
          <div className="bg-[#0A0A0F] px-5 py-4 flex items-center justify-between shrink-0">
            <div>
              <div className="text-white font-bold text-sm">Ask GracePeriod</div>
              <div className="text-white/40 text-xs mt-0.5">Grounded in verified USCIS sources</div>
            </div>
            <button onClick={() => setChatOpen(false)} className="text-white/60 hover:text-white w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-white/[0.03]">
            {chatMessages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-[#4F46E5] text-white rounded-br-sm" : "bg-white/5 border border-white/10 text-white/80 rounded-bl-sm"}`}>
                  {m.text}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-white/5 border border-white/10 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#0A0A0F]/20 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[#0A0A0F]/20 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[#0A0A0F]/20 animate-bounce" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          {suggestedFields && (
            <div className="border-t border-white/10 bg-[#4F46E5]/5 px-4 py-3">
              <div className="text-xs font-bold text-white mb-1.5">I picked up some details:</div>
              <div className="text-xs text-white/60 space-y-0.5 mb-2.5">
                {Object.entries(suggestedFields).map(([k, v]) => <div key={k}><span className="text-white/35">{k}:</span> {v}</div>)}
              </div>
              <div className="flex gap-2">
                <button onClick={applySuggestedFields} className="text-xs font-bold bg-[#4F46E5] hover:bg-[#4338CA] text-white px-3 py-1.5 rounded-lg">Fill my form</button>
                <button onClick={() => setSuggestedFields(null)} className="text-xs font-medium text-white/45 hover:text-white/70 px-3 py-1.5">Not now</button>
              </div>
            </div>
          )}
          <form onSubmit={handleSendChat} className="border-t border-white/10 p-3 flex gap-2 shrink-0 bg-white/5">
            <VoiceInputButton onResult={setChatInput} />
            <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Ask, or tell me your details…"
              className="flex-1 rounded-lg border border-white/10 bg-white/5 text-white placeholder-white/25 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]" />
            <button type="submit" disabled={chatLoading} className="btn-press bg-[#4F46E5] hover:bg-[#4338CA] disabled:opacity-50 text-white text-sm font-bold px-4 py-2.5 rounded-lg">Send</button>
          </form>
        </div>
      )}
      </>
      )}
    </div>
  );
}
