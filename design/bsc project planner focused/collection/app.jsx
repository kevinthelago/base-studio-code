/* =====================================================================
   app.jsx — Data Collection planner · four panes shell.
   Pane switcher (Targets · Legitimacy · Acquire · Extract) +
   per-pane state switcher. Left terminal, right focused pane.
   ===================================================================== */

const TERM_LOG = {
  targets: [
    { c: "pp", t: "▸ claude · planning session · conf-talks-directory" },
    { c: "ph", t: "── stage 2 / 8 · collectTargets ──────────────────" },
    { t: "Declaring external sources for the Talks directory…" },
    { c: "tool", t: "  source  confsite.com/2024/sessions → scrape" },
    { c: "tool", t: "  source  api.confsite.com/v1/speakers → fetch" },
    { c: "tool", t: "  bind    Data Model → Talks (Talk·Speaker·Session)" },
    { c: "ok", t: "  ✓ 2 sources → Talks" },
  ],
  license: [
    { c: "ph", t: "── stage 4 / 8 · sourceLicensing ─────────────────" },
    { t: "Clearing each source before any acquisition…" },
    { c: "tool", t: "  robots  confsite /2024/sessions → allowed (delay 1s)" },
    { c: "tool", t: "  terms   non-commercial + attribution → ok" },
    { c: "tool", t: "  license speakers API → CC-BY" },
    { c: "ok", t: "  ✓ sources cleared — acquire unblocked" },
  ],
  acquire: [
    { c: "ph", t: "── stage 5 / 8 · dataAcquire ─────────────────────" },
    { c: "tool", t: "  scrape  /2024/sessions · 1 req/s · depth 2 · robots ✓" },
    { c: "tool", t: "  fetch   /v1/speakers · cursor · 50/page" },
    { c: "dim", t: "  staging raw artifacts to working area…" },
  ],
  extract: [
    { c: "ph", t: "── stage 6 / 8 · dataExtract ─────────────────────" },
    { c: "tool", t: "  html    .session-card .title → Talk.title" },
    { c: "tool", t: "  html    time[datetime] → Session.startsAt" },
    { c: "tool", t: "  json    $.speakers[].name → Speaker.name" },
    { c: "tool", t: "  sample  5 Talk rows · 172/180 parsed" },
    { c: "dim", t: "  → feeds shared clean → load back half" },
  ],
};

function Terminal({ log }) {
  const ref = React.useRef(null);
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log]);
  return (
    <section className="term">
      <div className="term-head">
        <span className="sdot run" />
        <span style={{ color: "var(--accent)" }}>▸ claude · planning session</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-dim)" }}>conf-talks-directory</span>
      </div>
      <div className="term-body" ref={ref}>
        {log.map((l, i) => <div key={i} className="term-line"><span className={l.c || ""}>{l.t}</span></div>)}
        <div className="term-line"><span className="pp">❯ </span><span className="term-caret" /></div>
      </div>
    </section>
  );
}

/* gate computation per pane × state */
function gateInfo(paneId, state) {
  if (paneId === "targets") {
    if (state === "empty") return { ok: 0, total: 2 };
    if (state === "partial") return { ok: 1, total: 2, need: "Data Model bound" };
    return { ok: 2, total: 2 };
  }
  if (paneId === "license") {
    if (state === "empty") return { ok: 0, total: 2, need: "declare sources" };
    if (state === "partial") return { ok: 1, total: 2, need: "1 source needs review" };
    if (state === "multi") return { ok: 2, total: 3, blocked: true, need: "1 source blocked" };
    return { ok: 2, total: 2 };
  }
  if (paneId === "acquire") {
    if (state === "empty") return { ok: 0, total: 2, need: "configure capture" };
    if (state === "partial") return { ok: 1, total: 2, need: "1 source not run" };
    if (state === "live") return { ok: 1, total: 2, need: "crawl running" };
    if (state === "multi") return { ok: 3, total: 3 };
    return { ok: 2, total: 2 };
  }
  // extract
  if (state === "empty") return { ok: 0, total: 4, need: "define rules" };
  if (state === "partial") return { ok: 3, total: 4, need: "Extract field mapping" };
  if (state === "multi") return { ok: 4, total: 4 };
  return { ok: 4, total: 4 };
}

/* stepper — Data Collection (8 stages) */
function Stepper({ pane, state }) {
  const steps = window.STEPS;
  const curIdx = steps.findIndex((s) => s.key === pane.stepKey);
  const curDone = state === "defined" || (state === "multi" && pane.id !== "license");
  const statusOf = (i) => {
    if (i < curIdx) return "done";
    if (i === curIdx) return curDone ? "done" : "active";
    if (i === curIdx + 1 && curDone) return "active";
    return "upcoming";
  };
  return (
    <div className="stepper">
      <div className="stepper-track">
        {steps.map((p, i) => {
          const st = statusOf(i);
          return (
            <React.Fragment key={p.key}>
              <div className={`step ${st}${i === curIdx ? " selected" : ""}`} title={p.title}>
                <div className="step-node">
                  {st === "done" ? "✓" : st === "upcoming" ? <span style={{ fontSize: 8 }}>🔒</span> : i + 1}
                  {st === "active" && <span className="live-ring" />}
                </div>
                <span className="step-label">{p.title}</span>
              </div>
              {i < steps.length - 1 && <span className={"step-conn" + (st === "done" ? " fill" : "")} />}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function App() {
  const panes = window.PANES;
  const [paneId, setPaneId] = React.useState("targets");
  const [state, setState] = React.useState("defined");
  const pane = panes.find((p) => p.id === paneId);

  // states available for this pane (Live = acquire only)
  const states = window.STATES.filter((s) => !s.only || s.only === paneId);
  // if current state invalid for pane, fall back
  React.useEffect(() => { if (!states.find((s) => s.id === state)) setState("defined"); }, [paneId]);

  const g = gateInfo(paneId, state);
  const met = g.ok === g.total && !g.blocked;
  const log = TERM_LOG[paneId];

  const gateCls = g.blocked ? "fail" : met ? "pass" : "wait";
  const gateTxt = g.blocked ? "blocked · acquire held"
    : met ? `✓ ${pane.gateLabel}`
    : `${g.ok}/${g.total} needed`;

  function body() {
    if (paneId === "targets") return <window.TargetsPane state={state} />;
    if (paneId === "license") return <window.LegitimacyPane state={state} />;
    if (paneId === "acquire") return <window.AcquirePane state={state} />;
    return <window.ExtractPane state={state} />;
  }

  return (
    <div className="app">
      <div className="titlebar mac">
        <span className="tl-lights"><i /><i /><i /></span>
        <span className="tl-title">base-studio-code — Project Planner</span>
        <span className="tl-meta"><b>conf-talks-directory</b> · Data Collection blueprint</span>
      </div>

      {/* pane + state switcher */}
      <div className="state-switch">
        <span className="ss-label">Pane</span>
        <div className="ss-seg">
          {panes.map((p) => <button key={p.id} className={paneId === p.id ? "on" : ""} onClick={() => setPaneId(p.id)}>{p.title}</button>)}
        </div>
        <span className="ss-div" />
        <span className="ss-label">State</span>
        <div className="ss-seg alt">
          {states.map((s) => <button key={s.id} className={state === s.id ? "on" : ""} onClick={() => setState(s.id)} title={s.sub}>{s.label}</button>)}
        </div>
        <span style={{ flex: 1 }} />
        <span className="ss-sub">{states.find((s) => s.id === state)?.sub}</span>
      </div>

      <div className="shell">
        <div className="rail">
          <div className="logo">B</div>
          <button title="Console">⌘</button>
          <button className="active" title="Projects">◧</button>
          <button title="Knowledge">✦</button>
          <button title="GitHub">⎇</button>
          <div className="spacer" />
          <button title="Settings">⚙</button>
        </div>

        <div className="main">
          <div className="plan-shell">
            <Terminal log={log} />

            <aside className="fp" style={{ flexBasis: 600 }}>
              <div className="fp-top">
                <span className="glyph" />
                <span className="name">conf-talks-directory</span>
                <span style={{ flex: 1 }} />
                <span className="pulse"><span className="sdot run" /> planning</span>
              </div>

              <Stepper pane={pane} state={state} />

              <div className="ph-head">
                <div className="ph-eyebrow">
                  <span className="num">STAGE {String(pane.n).padStart(2, "0")} / 08</span>
                  <span>·</span><span>{pane.stage}</span>
                  {paneId === "extract" && <span className="before-pill">→ clean · load</span>}
                  {paneId === "license" && <span className="before-pill" style={{ color: "var(--danger)", background: "color-mix(in oklch,var(--danger),transparent 88%)", borderColor: "color-mix(in oklch,var(--danger),transparent 72%)" }}>hard gate · blocks acquire</span>}
                </div>
                <div className="ph-title"><h2>{pane.title}</h2></div>
                <p className="ph-blurb">{pane.blurb}</p>
                <span className={"ph-gate " + gateCls}>
                  <span className="gd" />
                  gate · {gateTxt}
                  {g.need && <span style={{ color: "var(--fg-dim)" }}> · needs: {g.need}</span>}
                </span>
              </div>

              <div className="ph-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {body()}
              </div>

              <div className="ph-foot">
                <button className="nav-btn">← back</button>
                <span className="prog">phase {pane.n} of 8</span>
                <span style={{ flex: 1 }} />
                <button className="nav-btn primary" disabled={!met}
                  title={met ? "" : g.blocked ? "a blocked source must be cleared or dropped" : "still needed: " + (g.need || `${g.total - g.ok} items`)}>
                  {met ? "approve & continue →" : g.blocked ? "blocked" : `still needed: ${g.total - g.ok}`}
                </button>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
