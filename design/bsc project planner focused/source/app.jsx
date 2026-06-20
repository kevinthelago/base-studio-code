/* =====================================================================
   app.jsx — Migration / Source pane shell + state switcher.
   Left: live Claude session. Right: the focused Source pane body,
   shown across six states. Source sits BEFORE features/structure.
   ===================================================================== */

const TERM_LOG = {
  empty: [
    { c: "pp", t: "▸ claude · planning session · acme-crm-rebuild" },
    { c: "ph", t: "── stage 3 / 6 · source ──────────────────────────" },
    { t: "Your pitch mentions an existing Salesforce CRM." },
    { c: "tool", t: "  detect  system of record → Salesforce" },
    { c: "dim", t: "  awaiting a read-only connection to inventory it…" },
  ],
  connecting: [
    { c: "ph", t: "── stage 3 / 6 · source ──────────────────────────" },
    { c: "tool", t: "  connect  Salesforce · OAuth · scope=read" },
    { c: "ok", t: "  ✓ handshake — read-only, no writes" },
    { c: "tool", t: "  sample   Account · Contact · Opportunity · Project__c" },
    { c: "tool", t: "  infer    types · identity · refs · enums from records" },
    { c: "dim", t: "  building canonical model…" },
  ],
  inferred: [
    { c: "ph", t: "── stage 3 / 6 · source ──────────────────────────" },
    { c: "ok", t: "  ✓ inventoried 4 objects · 49,427 records" },
    { c: "tool", t: "  inferred  CRM Core · 4 entities · 37 fields" },
    { c: "tool", t: "  picklist Health__c → enum {Green,Yellow,Red}" },
    { c: "tool", t: "  lookup   Account__c → ref → Account" },
    { c: "dim", t: "  ⚠ Legacy_Code__c 2% populated — drop candidate" },
    { c: "dim", t: "  review the derived schema to continue" },
  ],
  refined: [
    { c: "ph", t: "── stage 3 / 6 · source ──────────────────────────" },
    { c: "tool", t: "  refine   dropped legacyCode, fax · renamed arr" },
    { c: "tool", t: "  identity Account.domain · Contact.email" },
    { c: "ok", t: "  ✓ schema confirmed — seeds features + structure" },
    { c: "ok", t: "  ✓ load preview: 49,427 rows · 98.6% valid" },
  ],
  multi: [
    { c: "ph", t: "── stage 3 / 6 · source ──────────────────────────" },
    { c: "tool", t: "  connect  Salesforce + SQL billing export (read)" },
    { c: "tool", t: "  merge    by identity · precedence SF > SQL" },
    { c: "ok", t: "  ✓ 11,902 matched · 7 conflicts resolved" },
    { c: "ok", t: "  ✓ +Invoice net-new entity from SQL" },
  ],
  skipped: [
    { c: "ph", t: "── stage 3 / 6 · source ──────────────────────────" },
    { t: "No existing system detected — greenfield project." },
    { c: "dim", t: "  source inference is optional here — skipping" },
    { c: "ok", t: "  ✓ structure will design the schema from scratch" },
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
        <span style={{ color: "var(--fg-dim)" }}>sonnet-4-6 · acme-crm-rebuild</span>
      </div>
      <div className="term-body" ref={ref}>
        {log.map((l, i) => <div key={i} className="term-line"><span className={l.c || ""}>{l.t}</span></div>)}
        <div className="term-line"><span className="pp">❯ </span><span className="term-caret" /></div>
      </div>
    </section>
  );
}

/* stepper — Source (index 2) sits BEFORE features/structure */
function Stepper({ state }) {
  const steps = window.STEPS;
  const sourceDone = state === "refined";
  const statusOf = (i, key) => {
    if (key === "context" || key === "repos") return "done";
    if (key === "source") return sourceDone ? "done" : "active";
    if (key === "features" && sourceDone) return "active";
    return "upcoming";
  };
  return (
    <div className="stepper">
      <div className="stepper-track">
        {steps.map((p, i) => {
          const st = statusOf(i, p.key);
          const isSource = p.key === "source";
          return (
            <React.Fragment key={p.key}>
              <div className={`step ${st}${isSource ? " selected" : ""}`} title={p.title}>
                <div className="step-node">
                  {st === "done" ? "✓" : st === "upcoming" ? <span style={{ fontSize: 9 }}>🔒</span> : i + 1}
                  {st === "active" && <span className="live-ring" />}
                </div>
                <span className="step-label">{p.title}</span>
              </div>
              {i < steps.length - 1 && <span className={"step-conn" + (statusOf(i, p.key) === "done" ? " fill" : "")} />}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* live inference progress — the "watch it happen" moment */
function LiveInference() {
  return (
    <div className="scard" style={{ borderColor: "color-mix(in oklch, var(--accent), transparent 70%)" }}>
      <div className="scard-head">
        <span className="scard-label">inferring model</span>
        <span className="why-chip" style={{ color: "var(--accent)" }}><span className="sdot run" />live</span>
        <span style={{ flex: 1 }} />
        <span className="mono-sm">no writes — read-only sampling</span>
      </div>
      <div className="live-steps">
        <div className="live-step done"><span className="lv-mark">✓</span>objects discovered<span className="lv-n">4</span></div>
        <div className="live-step done"><span className="lv-mark">✓</span>records sampled<span className="lv-n">49,427</span></div>
        <div className="live-step run"><span className="lv-mark"><span className="sdot run" /></span>fields typed<span className="lv-n">31 / 37</span></div>
        <div className="live-step run"><span className="lv-mark"><span className="sdot run" /></span>identity & refs resolved<span className="lv-n">…</span></div>
        <div className="live-step idle"><span className="lv-mark">○</span>enums extracted from picklists<span className="lv-n">queued</span></div>
      </div>
      <div className="live-bar"><i style={{ width: "72%" }} /></div>
      <div className="live-stream">
        <span className="ls-line"><span className="mono-sm" style={{ color: "var(--success)" }}>✓</span> Account.Type → <span className="mono" style={{ color: "oklch(0.78 0.12 300)" }}>enum</span> {"{Customer, Partner, Prospect}"}</span>
        <span className="ls-line"><span className="mono-sm" style={{ color: "var(--success)" }}>✓</span> Project__c.Account__c → <span className="mono" style={{ color: "oklch(0.78 0.12 230)" }}>ref → Account</span></span>
        <span className="ls-line"><span className="mono-sm" style={{ color: "var(--accent)" }}>◷</span> sampling Contact.Email for uniqueness…</span>
      </div>
    </div>
  );
}

/* skipped / greenfield state */
function SkippedState() {
  return (
    <div className="skip-wrap">
      <div className="skip-icon">⤼</div>
      <div className="skip-title">No existing system to migrate from</div>
      <div className="skip-sub">This project is greenfield — there's no source of record to infer a schema from. The Source stage is <b>optional</b> and only matters when you're migrating off an existing system.</div>
      <div className="skip-flow">
        <span className="ds-node dim">Source</span>
        <span className="skip-skip">skipped</span>
        <span className="ds-arrow">→</span>
        <span className="ds-node on">Structure designs the schema from scratch</span>
      </div>
      <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 4 }}>
        <button className="btn-ghost">Skip this stage →</button>
        <button className="btn-ghost">＋ Actually, connect a source</button>
      </div>
    </div>
  );
}

/* empty state */
function EmptyExtra() {
  return (
    <div className="empty-reassure">
      <span className="er-icon">🔒</span>
      <span className="mono-sm">base-studio-code only ever <b style={{ color: "var(--success)" }}>reads</b> from your source — it maps and loads into the new system, and never writes back into your system of record.</span>
    </div>
  );
}

function App() {
  const [state, setState] = React.useState("inferred");
  const log = TERM_LOG[state];
  const checks = window.gateChecks(state);
  const met = checks.filter((c) => c.ok).length;
  const gateMet = state === "refined" || state === "multi";
  const refineMode = false;

  const GATE = {
    empty:      { cls: "wait", txt: "connect a source", note: "no source connected" },
    connecting: { cls: "wait", txt: "inferring…", note: "sampling + building model" },
    inferred:   { cls: "wait", txt: `review derived schema · ${met}/4`, note: "needs: schema refined" },
    refined:    { cls: "pass", txt: "schema confirmed", note: "4/4 · seeds downstream" },
    multi:      { cls: "pass", txt: "schema confirmed · 2 sources", note: "merged + reconciled" },
    skipped:    { cls: "wait", txt: "optional — skippable", note: "greenfield project" },
  }[state];

  function body() {
    if (state === "skipped") return <SkippedState />;
    if (state === "empty") return (<><ConnectionCardW /><EmptyExtra /></>);
    if (state === "connecting") return (<><ConnectionCardW /><LiveInference /></>);
    // inferred / refined / multi
    return (
      <>
        <ConnectionCardW />
        <window.InventoryCard />
        <window.InferredModelCard state={state} refineMode={refineMode} />
        <window.RefineCard state={state} />
        <window.MappingCard state={state} />
        {(state === "refined" || state === "multi") && <window.LoadPreviewCard state={state} />}
        <window.DownstreamCard state={state} />
      </>
    );
  }
  function ConnectionCardW() { return <window.ConnectionCard state={state} />; }

  return (
    <div className="app">
      <div className="titlebar mac">
        <span className="tl-lights"><i /><i /><i /></span>
        <span className="tl-title">base-studio-code — Project Planner</span>
        <span className="tl-meta"><b>acme-crm-rebuild</b> · migrating from Salesforce</span>
      </div>

      {/* state switcher (design review affordance) */}
      <div className="state-switch">
        <span className="ss-label">Source pane · states</span>
        <div className="ss-seg">
          {window.STATES.map((s) => (
            <button key={s.id} className={state === s.id ? "on" : ""} onClick={() => setState(s.id)} title={s.sub}>{s.label}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span className="ss-sub">{window.STATES.find((s) => s.id === state).sub}</span>
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
                <span className="name">acme-crm-rebuild</span>
                <span style={{ flex: 1 }} />
                <span className="pulse"><span className="sdot run" /> planning</span>
              </div>

              <Stepper state={state} />

              {/* stage header */}
              <div className="ph-head">
                <div className="ph-eyebrow">
                  <span className="num">STAGE 03 / 06</span><span>·</span><span>source</span>
                  <span className="before-pill">before features · structure</span>
                </div>
                <div className="ph-title"><h2>Source</h2></div>
                <p className="ph-blurb">Connect read-only to your existing system, watch a canonical Data Model get inferred from the real records, refine it, and confirm — the schema your new app is built over.</p>
                <span className={"ph-gate " + GATE.cls}>
                  <span className="gd" />
                  gate · {GATE.cls === "pass" ? "✓ " : ""}{GATE.txt}
                  <span style={{ color: "var(--fg-dim)" }}> · {GATE.note}</span>
                </span>
              </div>

              <div className="ph-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {body()}
              </div>

              {/* footer advance */}
              <div className="ph-foot">
                <button className="nav-btn">← back</button>
                <span className="prog">stage 3 of 6</span>
                <span style={{ flex: 1 }} />
                {state === "skipped"
                  ? <button className="nav-btn primary">skip & continue →</button>
                  : <button className="nav-btn primary" disabled={!gateMet}
                      title={gateMet ? "" : "still needed: " + checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join(", ")}>
                      {gateMet ? "approve & continue →" : `still needed: ${checks.filter((c) => !c.ok).length}`}
                    </button>}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
