/* =====================================================================
   app.jsx — Blueprint Author: the focused project pane.
   Left: Claude authoring session (mock terminal).
   Right: the focused phase pane — Purpose · Stages · Capabilities ·
          Review & Publish, one stage of authoring at a time.
   ===================================================================== */

const TERM_LOG = {
  purpose: [
    { c: "pp", t: "▸ claude · blueprint author · new blueprint" },
    { c: "ph", t: "── phase 1 / 4 · purpose ─────────────────────────" },
    { t: "Let's define what this blueprint plans. What kind of project?" },
    { c: "tool", t: "  draft  name → \"Realtime API service\"" },
    { c: "tool", t: "  draft  pitch + audience + catalog tags" },
    { c: "ok", t: "  ✓ identity set · accent oklch(195)" },
  ],
  stages: [
    { c: "ph", t: "── phase 2 / 4 · stages ──────────────────────────" },
    { t: "Composing the stage flow, contract-first…" },
    { c: "tool", t: "  + context · users · stack · schema" },
    { c: "tool", t: "  + api · structure · observability" },
    { c: "tool", t: "  link  deps → each stage locked till prereqs land" },
    { c: "ok", t: "  ✓ 7 stages · acyclic dependency graph" },
  ],
  capabilities: [
    { c: "ph", t: "── phase 3 / 4 · capabilities ────────────────────" },
    { c: "tool", t: "  attach  schema-check → Data model (gate)" },
    { c: "tool", t: "  attach  contract-test → API (gate)" },
    { c: "tool", t: "  attach  lint-plan + generate-issues → Structure" },
    { c: "tool", t: "  skills  realtime-ws-patterns · otel-conventions" },
    { c: "ok", t: "  ✓ 3 gates guard the flow" },
  ],
  publish: [
    { c: "ph", t: "── phase 4 / 4 · review & publish ────────────────" },
    { c: "tool", t: "  lint   stages · prompts · deps · gates" },
    { c: "ok", t: "  ✓ all checks pass — ready to publish" },
    { c: "dim", t: "  target: private gist (shareable by link)" },
  ],
};

/* ---------------- terminal ---------------- */
function Terminal({ log }) {
  const ref = React.useRef(null);
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log]);
  return (
    <section className="term">
      <div className="term-head">
        <span className="sdot run" />
        <span style={{ color: "var(--accent)" }}>▸ claude · authoring session</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-dim)" }}>blueprint-author</span>
      </div>
      <div className="term-body" ref={ref}>
        {log.map((l, i) => <div key={i} className="term-line"><span className={l.c || ""}>{l.t}</span></div>)}
        <div className="term-line"><span className="pp">❯ </span><span className="term-caret" /></div>
      </div>
    </section>
  );
}

/* ---------------- stepper ---------------- */
function Stepper({ phases, activeIdx, selectedIdx, onSelect }) {
  const statusOf = (i) => i < activeIdx ? "done" : i === activeIdx ? "active" : "upcoming";
  return (
    <div className="stepper">
      <div className="stepper-track">
        {phases.map((p, i) => {
          const st = statusOf(i);
          return (
            <React.Fragment key={p.key}>
              <div className={`step ${st}${i === selectedIdx ? " selected" : ""}`} onClick={() => onSelect(i)} title={p.title}>
                <div className="step-node">
                  {st === "done" ? "✓" : st === "upcoming" ? <span style={{ fontSize: 9 }}>🔒</span> : p.n}
                  {st === "active" && <span className="live-ring" />}
                </div>
                <span className="step-label">{p.title}</span>
              </div>
              {i < phases.length - 1 && <span className={"step-conn" + (i < activeIdx ? " fill" : "")} />}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- phase header ---------------- */
function PhaseHeader({ phase, gateState }) {
  return (
    <div className="ph-head">
      <div className="ph-eyebrow">
        <span className="num">STAGE {String(phase.n).padStart(2, "0")} / {String(window.PHASES.length).padStart(2, "0")}</span>
        <span>·</span><span>{phase.view}</span>
      </div>
      <div className="ph-title">
        <span style={{ width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
          background: window.tint(phase.h, 0.16), color: window.hue(phase.h) }}><window.Ic n={phase.glyph} size={15} /></span>
        <h2>{phase.title}</h2>
      </div>
      <p className="ph-blurb">{phase.blurb}</p>
      {phase.gate && (
        <span className={"ph-gate " + gateState}>
          <span className="gd" />
          gate · {phase.gate.name} — {gateState === "pass" ? "passing" : gateState === "fail" ? "failed" : "waiting"}
          <span style={{ color: "var(--fg-dim)" }}> · {phase.gate.note}</span>
        </span>
      )}
    </div>
  );
}

/* ---------------- main ---------------- */
function App() {
  const phases = window.PHASES;
  const [activeIdx, setActiveIdx] = React.useState(0);
  const [selectedIdx, setSelectedIdx] = React.useState(0);
  const [log, setLog] = React.useState(TERM_LOG.purpose);
  const [bp, setBp] = React.useState(window.BLUEPRINT);
  const [selStage, setSelStage] = React.useState(window.BLUEPRINT.stages[0]?.uid || null);
  const [published, setPublished] = React.useState(false);

  const phase = phases[selectedIdx];
  const isDone = selectedIdx < activeIdx;
  const isLocked = selectedIdx > activeIdx;

  // validation checks for the publish phase
  const checks = [
    { id: "name", label: "Name & pitch set", ok: !!bp.name.trim() && !!bp.pitch.trim(), detail: bp.name ? "ok" : "missing" },
    { id: "tags", label: "At least one catalog tag", ok: bp.bestFor.length > 0, detail: bp.bestFor.length + " tags" },
    { id: "count", label: "Two or more stages", ok: bp.stages.length >= 2, detail: bp.stages.length + " stages" },
    { id: "prompts", label: "Every stage has a prompt module", ok: bp.stages.every((s) => s.prompt.trim().length > 0), detail: bp.stages.filter((s) => !s.prompt.trim()).length + " empty" },
    { id: "gate", label: "At least one gate guards the flow", ok: bp.stages.some((s) => window.gateCount(s) > 0), detail: bp.stages.reduce((n, s) => n + window.gateCount(s), 0) + " gates" },
  ];

  function gateReady(idx) {
    switch (phases[idx].key) {
      case "purpose": return !!bp.name.trim() && !!bp.pitch.trim() && bp.bestFor.length > 0;
      case "stages": return bp.stages.length >= 2 && bp.stages.every((s) => s.prompt.trim().length > 0);
      case "capabilities": return bp.stages.some((s) => window.gateCount(s) > 0);
      case "publish": return checks.every((c) => c.ok);
      default: return true;
    }
  }
  const gateState = phase.gate ? (isDone ? "pass" : gateReady(selectedIdx) ? "pass" : "wait") : null;
  const allDone = activeIdx === phases.length - 1 && published;

  function advance() {
    if (activeIdx >= phases.length - 1) return;
    const next = activeIdx + 1;
    setActiveIdx(next); setSelectedIdx(next);
    setLog((l) => [...l, ...(TERM_LOG[phases[next].key] || [])]);
  }

  function renderView() {
    switch (phase.view) {
      case "purpose": return <window.PurposeView bp={bp} onChange={setBp} />;
      case "stages": return <window.StagesView bp={bp} onChange={setBp} selectedUid={selStage} onSelect={setSelStage} />;
      case "capabilities": return <window.CapabilitiesView bp={bp} onChange={setBp} />;
      case "publish": return <window.PublishView bp={bp} checks={checks} published={published}
        onVisibility={(v) => setBp({ ...bp, visibility: v })} onPublish={() => setPublished(true)} />;
      default: return null;
    }
  }

  return (
    <div className="app">
      <div className="titlebar mac">
        <span className="tl-lights"><i /><i /><i /></span>
        <span className="tl-title">base-studio-code — Blueprint Author</span>
        <span className="tl-meta"><b>blueprint</b> · {bp.name}</span>
      </div>

      <div className="shell">
        <div className="rail">
          <div className="logo">B</div>
          <button title="Console">⌘</button>
          <button title="Projects">◧</button>
          <button className="active" title="Blueprints">▤</button>
          <button title="Knowledge">✦</button>
          <button title="GitHub">⎇</button>
          <div className="spacer" />
          <button title="Settings">⚙</button>
        </div>

        <div className="main">
          <div style={{ height: 38, flex: "0 0 38px", display: "flex", alignItems: "center", gap: 10,
            padding: "0 16px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>Author</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>guided · blueprint: Blueprint Author</span>
            <span style={{ flex: 1 }} />
            <span className="gchip dirty" style={{ height: 26 }}><i />{published ? "published" : "draft · unsaved"}</span>
          </div>

          <div className="plan-shell">
            <Terminal log={log} />

            <aside className="fp" style={{ flexBasis: 560 }}>
              <div className="fp-top">
                <span className="glyph" style={{ background: `linear-gradient(135deg, ${window.hue(bp.h)}, ${window.hue(bp.h + 40)})` }} />
                <span className="name">{bp.name}</span>
                <span style={{ flex: 1 }} />
                <span className="pulse"><span className="sdot run" /> authoring</span>
              </div>

              <Stepper phases={phases} activeIdx={activeIdx} selectedIdx={selectedIdx} onSelect={setSelectedIdx} />
              <PhaseHeader phase={phase} gateState={gateState} />

              {isLocked && (
                <div className="lock-banner">
                  🔒 <span><b>Locked.</b> Complete <b>{phases[activeIdx].title}</b> to unlock this stage. Previewing only.</span>
                </div>
              )}
              {isDone && (
                <div className="lock-banner" style={{ background: "color-mix(in oklch,var(--success),transparent 91%)", borderColor: "color-mix(in oklch,var(--success),transparent 72%)" }}>
                  ✓ <span style={{ color: "var(--fg-muted)" }}><b style={{ color: "var(--success)" }}>Done.</b> Edits here re-open the stage.</span>
                </div>
              )}

              <div className="ph-body bp-page bpwrap">{renderView()}</div>

              <div className="ph-foot">
                <button className="nav-btn" disabled={selectedIdx === 0} onClick={() => setSelectedIdx((i) => Math.max(0, i - 1))}>← back</button>
                <span className="prog">stage {phase.n} of {phases.length}</span>
                <span style={{ flex: 1 }} />
                {isLocked ? (
                  <button className="nav-btn" onClick={() => setSelectedIdx(activeIdx)}>↩ back to current</button>
                ) : isDone ? (
                  <button className="nav-btn" onClick={() => setSelectedIdx(activeIdx)}>jump to current →</button>
                ) : selectedIdx === phases.length - 1 ? (
                  <button className="nav-btn primary" disabled={!published} onClick={() => {}}>{published ? "✓ published" : "publish above"}</button>
                ) : (
                  <button className="nav-btn primary" disabled={!gateReady(activeIdx)} onClick={advance}
                    title={gateReady(activeIdx) ? "" : "Gate must pass first"}>
                    {gateReady(activeIdx) ? "approve & continue →" : "gate blocking…"}
                  </button>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
