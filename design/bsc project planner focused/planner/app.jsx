/* =====================================================================
   app.jsx — the reimagined project-planner page.
   Left: Claude CLI planning session (mock terminal).
   Right: the FOCUSED phase pane — one planning stage at a time,
          full-width, auto-following the live session.
   ===================================================================== */

/* per-phase canned terminal output, appended as the session advances */
const TERM_LOG = {
  context: [
    { c: "pp", t: "▸ claude · planning session · settlement-webhooks-v2" },
    { c: "ph", t: "── phase 1 / 9 · context ─────────────────────────" },
    { t: "Scanning attached specs and the knowledge store…" },
    { c: "tool", t: "  read  settlement-webhooks.spec.md  (4.1k)" },
    { c: "tool", t: "  read  CLAUDE.md  (1.2k)" },
    { c: "tool", t: "  kb    blk_71fe · framing v2 / blk_2199 · sqlite>lmdb" },
    { c: "ok", t: "  ✓ 4 blocks pinned · ~6.6k tok in budget" },
    { t: "Which decisions should anchor the build? Pinning the spec," },
    { t: "framing-v2 notes, and the storage decision." },
  ],
  repos: [
    { c: "ph", t: "── phase 2 / 9 · repos ───────────────────────────" },
    { c: "tool", t: "  link   acme/payments  (primary)" },
    { c: "tool", t: "  clone  acme/payments → ~/.bsc/prj_2fa/payments" },
    { c: "tool", t: "  link   acme/web-dashboard" },
    { c: "ok", t: "  ✓ 2 repos cloned · 6 branches detected" },
  ],
  deploy: [
    { c: "ph", t: "── phase 3 / 9 · deploy ──────────────────────────" },
    { t: "Proposing deploy targets from the detected stacks…" },
    { c: "tool", t: "  web  React·Vite → Vercel (static)" },
    { c: "tool", t: "  api  Rust·axum → Fly.io (container)" },
    { c: "tool", t: "  envs   dev → staging → prod" },
    { c: "tool", t: "  ci     GitHub Actions · build → test → deploy" },
    { c: "dim", t: "  ⚠ ship-check blocks: prod secrets not wired" },
  ],
  ui: [
    { c: "ph", t: "── phase 4 / 9 · ui design ───────────────────────" },
    { t: "Generating screen skeletons from the spec…" },
    { c: "tool", t: "  esbuild-wasm  bundling 5 screens" },
    { c: "tool", t: "  render-preview  serving sandboxed walkthrough" },
    { c: "dim", t: "  awaiting approval — gate blocks until all approved" },
  ],
  structure: [
    { c: "ph", t: "── phase 5 / 9 · structure ───────────────────────" },
    { c: "tool", t: "  plan   2 milestones · 3 epics · 6 issues" },
    { c: "tool", t: "  decompose  #418 → 3 sub-issues" },
    { c: "ok", t: "  ✓ every issue has acceptance criteria" },
  ],
  permissions: [
    { c: "ph", t: "── phase 6 / 9 · permissions ─────────────────────" },
    { c: "tool", t: "  scope  6 streams · least-privilege postures" },
    { c: "ok", t: "  ✓ policy-check: no unscoped push access" },
  ],
  mcp: [
    { c: "ph", t: "── phase 7 / 9 · mcp servers ─────────────────────" },
    { t: "Connecting external tool + data servers…" },
    { c: "tool", t: "  stdio   github · filesystem · postgres" },
    { c: "tool", t: "  http    sentry → acme-payments" },
    { c: "ok", t: "  ✓ 4 servers handshook · 15 tools exposed" },
    { c: "dim", t: "  ⚠ brave-search: missing BRAVE_API_KEY" },
  ],
  automations: [
    { c: "ph", t: "── phase 8 / 9 · automations ─────────────────────" },
    { c: "tool", t: "  cron   nightly schema regen · stale PR sweep" },
    { c: "tool", t: "  inject  retry policy → all workers" },
  ],
  skills: [
    { c: "ph", t: "── phase 9 / 9 · skills ──────────────────────────" },
    { c: "tool", t: "  index  rust-hmac-middleware · webhook-retry-backoff" },
    { c: "ok", t: "  ✓ plan ready to publish to GitHub" },
  ],
};

/* ---------------- terminal pane ---------------- */
function Terminal({ log }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log]);
  return (
    <section className="term">
      <div className="term-head">
        <span className="sdot run" />
        <span style={{ color: "var(--accent)" }}>▸ claude cli · planning session</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-dim)" }}>sonnet-4-6 · acme/payments</span>
      </div>
      <div className="term-body" ref={ref}>
        {log.map((l, i) => (
          <div key={i} className="term-line"><span className={l.c || ""}>{l.t}</span></div>
        ))}
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
          const cls = `step ${st}${i === selectedIdx ? " selected" : ""}`;
          return (
            <React.Fragment key={p.key}>
              <div className={cls} onClick={() => onSelect(i)} title={p.title}>
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
        <span className="num">PHASE {String(phase.n).padStart(2, "0")} / {String(window.PHASES.length).padStart(2, "0")}</span>
        <span>·</span><span>{phase.view}</span>
      </div>
      <div className="ph-title"><h2>{phase.title}</h2></div>
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
  const [activeIdx, setActiveIdx] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [log, setLog] = useState(TERM_LOG.context);

  // mutable plan state
  const [context, setContext] = useState(window.CONTEXT);
  const [screens, setScreens] = useState(window.SCREENS);
  const [agents, setAgents] = useState(window.AGENTS);
  const [mcp, setMcp] = useState(window.MCP_SERVERS);
  const [deploy, setDeploy] = useState(() => ({
    services: window.SERVICES, selService: window.SERVICES[0].id,
    envs: window.ENVIRONMENTS, pipeline: window.PIPELINE,
    config: window.DEPLOY_CONFIG, release: window.RELEASE, health: window.HEALTH,
  }));
  const [automations, setAutomations] = useState(window.AUTOMATIONS);
  const [skills, setSkills] = useState(window.SKILLS);
  const [viewing, setViewing] = useState(null);

  const phase = phases[selectedIdx];
  const isActive = selectedIdx === activeIdx;
  const isDone = selectedIdx < activeIdx;
  const isLocked = selectedIdx > activeIdx;

  // gate readiness for a phase index
  function gateReady(idx) {
    switch (phases[idx].key) {
      case "ui": return screens.every((s) => s.approved);
      case "context": return context.filter((c) => c.pinned).length >= 3;
      case "deploy": return window.deployChecks(deploy).every((c) => c.ok);
      case "mcp": return mcp.every((s) => !(s.on && s.status === "error"));
      default: return true;
    }
  }
  const gateState = phase.gate ? (isDone ? "pass" : gateReady(selectedIdx) ? "pass" : "wait") : null;

  // advance the canonical session to the next phase
  function advance() {
    if (activeIdx >= phases.length - 1) return;
    const next = activeIdx + 1;
    setActiveIdx(next);
    setSelectedIdx(next);
    setLog((l) => [...l, ...(TERM_LOG[phases[next].key] || [])]);
  }

  const allDone = activeIdx === phases.length - 1 && gateReady(activeIdx);

  // ESC closes the context viewer
  useEffect(() => {
    if (!viewing) return;
    const fn = (e) => { if (e.key === "Escape") setViewing(null); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [viewing]);

  // render the focused view
  function renderView() {
    switch (phase.view) {
      case "context": return <window.ContextView context={context}
        onTogglePin={(name) => setContext((c) => c.map((f) => f.name === name ? { ...f, pinned: !f.pinned } : f))}
        onView={setViewing} />;
      case "repos": return <window.ReposView repos={window.REPOS} />;
      case "deploy": return <window.DeployView deploy={deploy} onChange={setDeploy} />;
      case "ui": return <window.UIView screens={screens}
        onApprove={(id) => setScreens((s) => s.map((x) => x.id === id ? { ...x, approved: true } : x))} />;
      case "structure": return <window.StructureView structure={window.STRUCTURE} />;
      case "permissions": return <window.PermissionsView agents={agents}
        onCell={(aid, k, v) => setAgents((ag) => ag.map((a) => a.id === aid ? { ...a, perm: { ...a.perm, [k]: v }, preset: "custom" } : a))}
        onPreset={(aid, p) => setAgents((ag) => ag.map((a) => a.id === aid ? { ...a, preset: p, perm: { ...window.PRESETS[p] } } : a))} />;
      case "mcp": return <window.MCPView servers={mcp}
        onToggle={(id) => setMcp((m) => m.map((x) => x.id === id ? { ...x, on: !x.on } : x))} />;
      case "automations": return <window.AutomationsView automations={automations}
        onToggle={(id) => setAutomations((a) => a.map((x) => x.id === id ? { ...x, on: !x.on } : x))} />;
      case "skills": return <window.SkillsView skills={skills}
        onToggle={(id) => setSkills((s) => s.map((x) => x.id === id ? { ...x, indexed: !x.indexed } : x))} />;
      default: return null;
    }
  }

  return (
    <div className="app">
      {/* titlebar */}
      <div className="titlebar mac">
        <span className="tl-lights"><i /><i /><i /></span>
        <span className="tl-title">base-studio-code — Project Planner</span>
        <span className="tl-meta"><b>prj_2fa</b> · settlement-webhooks-v2</span>
      </div>

      {/* shell */}
      <div className="shell">
        {/* left rail */}
        <div className="rail">
          <div className="logo">B</div>
          <button title="Console">⌘</button>
          <button className="active" title="Projects">◧</button>
          <button title="Knowledge">✦</button>
          <button title="GitHub">⎇</button>
          <button title="Automations">↻</button>
          <div className="spacer" />
          <button title="Settings">⚙</button>
        </div>

        {/* main */}
        <div className="main">
          {/* page header strip */}
          <div style={{ height: 38, flex: "0 0 38px", display: "flex", alignItems: "center", gap: 10,
            padding: "0 16px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>Plan</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>
              guided · blueprint: full-stack web app
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
              {activeIdx + (allDone ? 1 : 0)} / {phases.length} phases complete
            </span>
            <button className="nav-btn primary" disabled={!allDone} title={allDone ? "Publish to GitHub" : "Finish all phases first"}>
              ⎇ Publish to GitHub
            </button>
          </div>

          {/* split */}
          <div className="plan-shell">
            <Terminal log={log} />

            {/* FOCUSED PANE */}
            <aside className="fp">
              <div className="fp-top">
                <span className="glyph" />
                <span className="name">settlement-webhooks-v2</span>
                <span style={{ flex: 1 }} />
                <span className="pulse"><span className="sdot run" /> planning</span>
                <span className="id">prj_2fa</span>
              </div>

              <Stepper phases={phases} activeIdx={activeIdx} selectedIdx={selectedIdx} onSelect={setSelectedIdx} />

              <PhaseHeader phase={phase} gateState={gateState} />

              {isLocked && (
                <div className="lock-banner">
                  🔒 <span><b>Locked.</b> Complete <b>{phases[activeIdx].title}</b> to unlock this phase. Previewing only.</span>
                </div>
              )}
              {isDone && (
                <div className="lock-banner" style={{ background: "color-mix(in oklch,var(--success),transparent 91%)", borderColor: "color-mix(in oklch,var(--success),transparent 72%)" }}>
                  ✓ <span style={{ color: "var(--fg-muted)" }}><b style={{ color: "var(--success)" }}>Completed.</b> Edits here re-open the phase for review.</span>
                </div>
              )}

              <div className="ph-body">{renderView()}</div>

              {/* footer / advance bar */}
              <div className="ph-foot">
                <button className="nav-btn" disabled={selectedIdx === 0}
                  onClick={() => setSelectedIdx((i) => Math.max(0, i - 1))}>← back</button>
                <span className="prog">phase {phase.n} of {phases.length}</span>
                <span style={{ flex: 1 }} />
                {isLocked ? (
                  <button className="nav-btn" onClick={() => setSelectedIdx(activeIdx)}>↩ back to current</button>
                ) : isDone ? (
                  <button className="nav-btn" onClick={() => setSelectedIdx(activeIdx)}>jump to current →</button>
                ) : allDone ? (
                  <button className="nav-btn primary">⎇ Publish to GitHub</button>
                ) : (
                  <button className="nav-btn primary" disabled={!gateReady(activeIdx)}
                    onClick={advance} title={gateReady(activeIdx) ? "" : "Gate must pass first"}>
                    {gateReady(activeIdx) ? "approve & continue →" : "gate blocking…"}
                  </button>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>

      {/* context viewer modal */}
      {viewing && (
        <div className="modal-bg" onClick={() => setViewing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px",
              borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: window.CTX_KIND[viewing.kind].c }} />
              <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{viewing.name}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{viewing.tok} · {viewing.scope}</span>
              <span onClick={() => setViewing(null)} style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-muted)", paddingLeft: 8 }}>✕</span>
            </div>
            <pre style={{ margin: 0, padding: "14px 16px", overflow: "auto", flex: 1, fontFamily: "var(--mono)",
              fontSize: 11, lineHeight: 1.6, color: "var(--fg-muted)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {viewing.content || "(empty)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
