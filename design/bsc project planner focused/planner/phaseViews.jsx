/* =====================================================================
   phaseViews.jsx — the seven focused phase views + shared primitives.
   Each view owns the full pane width for its phase of planning.
   ===================================================================== */
const { useState, useEffect, useRef } = React;

/* ---------- shared primitives ---------- */
function Avatar({ id, sz = 18 }) {
  const a = window.AGENTS.find((x) => x.id === id);
  const color = a ? a.color : "var(--fg-dim)";
  const initial = a ? a.initial : "?";
  return <span className="av" style={{ width: sz, height: sz, background: color, fontSize: sz * 0.5 }}>{initial}</span>;
}
function RoleChip({ role, mute }) {
  const R = window.ROLES[role] || { c: "var(--fg-dim)", label: role };
  return (
    <span className="role-chip" style={{
      background: `color-mix(in oklch, ${R.c}, transparent ${mute ? 88 : 82}%)`,
      color: R.c, border: `1px solid color-mix(in oklch, ${R.c}, transparent 72%)`,
    }}><i style={{ background: R.c }} />{R.label}</span>
  );
}
function Tile({ v, unit, k }) {
  return <div className="tile"><div className="v">{v}{unit && <small> {unit}</small>}</div><div className="k">{k}</div></div>;
}
function GrpLabel({ children, right }) {
  return (
    <div className="row" style={{ gap: 6, padding: "0 1px 8px", marginTop: 4 }}>
      <span className="grp-label">{children}</span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}

/* ===================================================================
   1 · CONTEXT
   =================================================================== */
function ContextView({ context, onTogglePin, onView }) {
  const pinned = context.filter((f) => f.pinned);
  const lib = context.filter((f) => !f.pinned);
  const totalTok = pinned.reduce((s, f) => s + parseFloat(f.tok), 0);

  function Card({ f }) {
    const kind = window.CTX_KIND[f.kind];
    return (
      <div className={"ctx-card" + (f.pinned ? " pinned" : "")} onClick={() => onView(f)}>
        <span className="ctx-kind" style={{ background: kind.c }} />
        <span className="ctx-name">{f.name}</span>
        <span className="chip" style={{ fontSize: 8.5 }}>{kind.label}</span>
        <span className="ctx-meta">{f.scope}</span>
        <span className="ctx-meta">{f.tok}</span>
        <span className="ctx-pin" style={{ color: f.pinned ? "var(--accent)" : "var(--fg-dim)" }}
          onClick={(e) => { e.stopPropagation(); onTogglePin(f.name); }}>{f.pinned ? "✦" : "+"}</span>
      </div>
    );
  }

  // budget bar segmented by kind
  const segs = pinned.map((f) => ({ w: parseFloat(f.tok), c: window.CTX_KIND[f.kind].c }));
  const sum = segs.reduce((s, x) => s + x.w, 0) || 1;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div>
        <div className="row" style={{ gap: 8, marginBottom: 7 }}>
          <span className="grp-label">context budget</span>
          <span style={{ flex: 1 }} />
          <span className="mono-sm" style={{ color: "var(--accent)" }}>✦ {pinned.length} pinned</span>
          <span className="mono-sm">{totalTok.toFixed(1)}k / 200k tok</span>
        </div>
        <div className="budget">
          {segs.map((s, i) => <i key={i} style={{ width: `${(s.w / sum) * (totalTok / 200) * 100}%`, background: s.c }} />)}
          <i style={{ flex: 1, background: "transparent" }} />
        </div>
        <div className="row" style={{ gap: 10, marginTop: 7, flexWrap: "wrap" }}>
          {Object.entries(window.CTX_KIND).map(([k, v]) => (
            <span key={k} className="row" style={{ gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: v.c }} />
              <span className="mono-sm">{v.label}</span>
            </span>
          ))}
        </div>
      </div>

      <div>
        <GrpLabel right={<span className="mono-sm">drag to reorder priority</span>}>pinned to context</GrpLabel>
        <div className="col" style={{ gap: 6 }}>{pinned.map((f) => <Card key={f.name} f={f} />)}</div>
      </div>

      <div>
        <GrpLabel right={<span className="mono-sm">{lib.length} available</span>}>library</GrpLabel>
        <div className="col" style={{ gap: 5 }}>{lib.map((f) => <Card key={f.name} f={f} />)}</div>
      </div>

      <div className="dropzone">＋ drop a spec, doc, or knowledge block to add context</div>
    </div>
  );
}

/* ===================================================================
   2 · REPOS
   =================================================================== */
function ReposView({ repos }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="tiles" style={{ marginBottom: 2 }}>
        <Tile v={repos.length} k="repositories" />
        <Tile v={repos.filter((r) => r.cloned).length} k="cloned" />
        <Tile v={repos.reduce((s, r) => s + r.branches.length, 0)} k="branches" />
      </div>
      {repos.map((r) => (
        <div key={r.id} className={"repo-card" + (r.primary ? " primary" : "")}>
          <div className="row" style={{ gap: 8 }}>
            <span className="sdot on" />
            <span className="repo-name">{r.id}</span>
            {r.primary && <span className="chip" style={{ color: "var(--accent)", borderColor: "var(--accent-dim)" }}>primary</span>}
            <span style={{ flex: 1 }} />
            <span className="chip">{r.lang}</span>
            <span className="mono-sm" style={{ color: "var(--success)" }}>● cloned</span>
          </div>
          <div className="mono-sm" style={{ margin: "7px 0 9px", color: "var(--fg-muted)" }}>{r.desc}</div>
          <div className="row" style={{ gap: 8, marginBottom: 9 }}>
            <span className="branch-chip" style={{ color: "var(--fg-muted)" }}>⎇ {r.branch}</span>
            <span className="mono-sm" style={{ color: "var(--success)" }}>↑{r.ahead}</span>
            <span className="mono-sm" style={{ color: "var(--info)" }}>↓{r.behind}</span>
            <span style={{ flex: 1 }} />
            <span className="row" style={{ gap: -4 }}>
              {r.agents.map((id, i) => (
                <span key={id} style={{ marginLeft: i ? -5 : 0 }}><Avatar id={id} sz={16} /></span>
              ))}
            </span>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {r.branches.map((b) => (
              <span key={b.n} className="branch-chip"
                style={{ color: b.state === "review" ? "var(--success)" : b.state === "draft" ? "var(--fg-dim)" : "var(--info)" }}>
                ⎇ {b.n} <span style={{ color: "var(--fg-dim)" }}>#{b.issue}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
      <div className="dropzone">＋ link another repository</div>
    </div>
  );
}

/* ===================================================================
   3 · DEPLOY — deployment & infrastructure
   =================================================================== */
// readiness checks (shared with the gate in app.jsx)
function deployChecks(d) {
  const prodSecrets = d.config.secrets.every((s) => s.prod);
  return [
    { id: "target",   label: "Deploy target per service", ok: d.services.every((s) => s.platform), detail: d.services.filter((s) => s.platform).length + "/" + d.services.length + " services" },
    { id: "envs",     label: "Environment ladder defined", ok: d.envs.length >= 2, detail: d.envs.length + " environments" },
    { id: "pipeline", label: "CI/CD pipeline staged",       ok: d.pipeline.stages.length >= 2, detail: d.pipeline.provider },
    { id: "secrets",  label: "Secrets wired for every env", ok: prodSecrets, detail: prodSecrets ? "all set" : "missing prod" },
    { id: "release",  label: "Release & rollback strategy",  ok: !!d.release.strategy, detail: d.release.strategy },
  ];
}

function DeploySection({ label, hint, children, proposed }) {
  return (
    <div className="dcard">
      <div className="row" style={{ gap: 8, marginBottom: 11 }}>
        <span className="grp-label">{label}</span>
        {proposed && <span className="prop">✦ proposed</span>}
        <span style={{ flex: 1 }} />
        {hint && <span className="mono-sm">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
function Seg({ value, options, onChange, sm }) {
  return (
    <div className={"seg" + (sm ? " sm" : "")}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{l}</button>;
      })}
    </div>
  );
}

function DeployView({ deploy, onChange }) {
  const d = deploy;
  const set = (patch) => onChange({ ...d, ...patch });
  const svc = d.services.find((s) => s.id === d.selService) || d.services[0];
  const checks = deployChecks(d);
  const ready = checks.filter((c) => c.ok).length;
  const allReady = ready === checks.length;
  const WL = window.WORKLOAD;

  const setSvc = (patch) => set({ services: d.services.map((s) => s.id === svc.id ? { ...s, ...patch } : s) });
  const pickPlatform = (pid) => {
    const p = window.platform(pid);
    setSvc({ platform: pid, proposed: false, workload: p.kinds.includes(svc.workload) ? svc.workload : p.kinds[0] });
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      {/* readiness banner */}
      <div className={"ship-banner " + (allReady ? "ok" : "wait")}>
        <span className="sb-dot" />
        <span className="sb-txt">{allReady ? "Ready to ship" : `${ready}/${checks.length} defined`}</span>
        <span style={{ flex: 1 }} />
        <span className="mono-sm">{allReady ? "deployment issues ready to generate" : "missing: " + checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}</span>
      </div>

      {/* 1 · TARGET & HOSTING (per service) */}
      <DeploySection label="target · hosting" hint={`${d.services.length} services`}>
        <div className="svc-tabs">
          {d.services.map((s) => {
            const p = window.platform(s.platform);
            return (
              <button key={s.id} className={"svc-tab" + (s.id === svc.id ? " on" : "")} onClick={() => set({ selService: s.id })}>
                <span className="svc-name">{s.id}</span>
                <span className="svc-sub">{p.glyph} {p.name}</span>
              </button>
            );
          })}
        </div>

        <div className="svc-meta">
          <span className="branch-chip" style={{ color: "var(--fg-muted)" }}>⎇ {svc.repo}/{svc.path}</span>
          <span className="chip">{svc.stack}</span>
          <span style={{ flex: 1 }} />
          {svc.proposed && <span className="prop">✦ proposed</span>}
        </div>

        <div className="grp-label" style={{ margin: "13px 0 8px" }}>platform</div>
        <div className="plat-grid">
          {window.PLATFORMS.map((p) => (
            <button key={p.id} className={"plat-tile" + (svc.platform === p.id ? " on" : "")}
              style={svc.platform === p.id ? { "--ph": p.h } : undefined} onClick={() => pickPlatform(p.id)}>
              <span className="pt-glyph" style={{ color: `oklch(0.78 0.12 ${p.h})` }}>{p.glyph}</span>
              <span className="pt-name">{p.name}</span>
            </button>
          ))}
        </div>

        {/* workload + platform fields */}
        <div className="row" style={{ gap: 7, margin: "13px 0 11px", flexWrap: "wrap" }}>
          {window.platform(svc.platform).kinds.map((k) => (
            <button key={k} className={"wl-chip" + (svc.workload === k ? " on" : "")}
              style={svc.workload === k ? { color: WL[k].c, borderColor: WL[k].c } : undefined}
              onClick={() => setSvc({ workload: k })}>{WL[k].label}</button>
          ))}
        </div>
        <div className="field-grid">
          <Field label="region" value={svc.region} onChange={(v) => setSvc({ region: v })} />
          <Field label={svc.workload === "container" ? "image" : "build cmd"} value={svc.build} onChange={(v) => setSvc({ build: v })} />
          {svc.workload === "container"
            ? <Field label="runtime" value={svc.runtime} onChange={(v) => setSvc({ runtime: v })} />
            : <Field label="output dir" value={svc.output} onChange={(v) => setSvc({ output: v })} />}
        </div>
      </DeploySection>

      {/* 2 · ENVIRONMENTS */}
      <DeploySection label="environments" hint="branch → env" proposed>
        <div className="env-ladder">
          {d.envs.map((e, i) => (
            <React.Fragment key={e.id}>
              {i > 0 && <span className="env-arrow">→</span>}
              <div className="env-step">
                <div className="env-top">
                  <span className={"sdot " + (e.id === "prod" ? "on" : "idle")} />
                  <span className="env-name">{e.name}</span>
                  {e.auto ? <span className="chip" style={{ fontSize: 8 }}>auto</span> : <span className="chip" style={{ fontSize: 8, color: "var(--accent)", borderColor: "var(--accent-dim)" }}>manual</span>}
                </div>
                <span className="branch-chip" style={{ color: "var(--info)" }}>⎇ {e.branch}</span>
                <span className="env-url">{e.url}</span>
              </div>
            </React.Fragment>
          ))}
          <button className="env-add" title="Add environment">＋</button>
        </div>
      </DeploySection>

      {/* 3 · CI/CD PIPELINE */}
      <DeploySection label="ci/cd pipeline" hint={d.pipeline.provider}>
        <div className="pipe-chain">
          {d.pipeline.stages.map((st, i) => (
            <React.Fragment key={st.id}>
              {i > 0 && <span className={"pc-arrow" + (st.gate ? " gated" : "")}>{st.gate ? "⟫" : "→"}</span>}
              <div className={"pc-stage" + (st.gate ? " gated" : "")}>
                <div className="pc-head">
                  <span className="pc-name">{st.name}</span>
                  {st.gate && <span className="pc-gate" title="Blocks promotion until green">gate</span>}
                </div>
                <span className="pc-cmd">{st.cmd}</span>
                <Seg sm value={st.trigger} options={window.PIPE_TRIGGERS}
                  onChange={(v) => set({ pipeline: { ...d.pipeline, stages: d.pipeline.stages.map((x) => x.id === st.id ? { ...x, trigger: v } : x) } })} />
              </div>
            </React.Fragment>
          ))}
        </div>
      </DeploySection>

      {/* 4 · CONFIG & SECRETS */}
      <DeploySection label="config · secrets" hint={d.config.vault}>
        <table className="cfg-table">
          <thead><tr><th className="k">variable</th>{d.envs.map((e) => <th key={e.id}>{e.name}</th>)}</tr></thead>
          <tbody>
            {d.config.config.map((row) => (
              <tr key={row.key}>
                <td className="k"><span className="cfg-dot config" />{row.key}</td>
                {d.envs.map((e) => <td key={e.id} className="cfg-val">{row[e.id] || "—"}</td>)}
              </tr>
            ))}
            {d.config.secrets.map((row) => (
              <tr key={row.key}>
                <td className="k"><span className="cfg-dot secret" />{row.key}</td>
                {d.envs.map((e) => (
                  <td key={e.id}>
                    {row[e.id]
                      ? <span className="secret-set" title="managed in vault">••••<span className="sec-tick">✓</span></span>
                      : <button className="secret-add" title={`Wire ${row.key} for ${e.name}`}
                          onClick={() => onChange((prev) => ({ ...prev, config: { ...prev.config, secrets: prev.config.secrets.map((s) => s.key === row.key ? { ...s, [e.id]: true } : s) } }))}>+ wire</button>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mono-sm" style={{ marginTop: 9 }}>
          <span className="cfg-dot config" /> config &nbsp; <span className="cfg-dot secret" /> secret — values live in the host vault, never here
        </div>
      </DeploySection>

      {/* 5 · RELEASE & ROLLBACK */}
      <DeploySection label="release · rollback">
        <div className="grp-label" style={{ marginBottom: 7 }}>strategy</div>
        <div className="strat-grid">
          {window.RELEASE_STRATEGIES.map((s) => (
            <button key={s.id} className={"strat" + (d.release.strategy === s.id ? " on" : "")}
              onClick={() => set({ release: { ...d.release, strategy: s.id } })}>
              <span className="strat-name">{s.label}</span>
              <span className="strat-desc">{s.desc}</span>
            </button>
          ))}
        </div>
        <div className="col" style={{ gap: 8, marginTop: 12 }}>
          <ToggleRow on={d.release.autoRollback} onClick={() => set({ release: { ...d.release, autoRollback: !d.release.autoRollback } })}
            label="Auto-rollback on failed health check" />
          <ToggleRow on={d.release.migrateWithDeploy} onClick={() => set({ release: { ...d.release, migrateWithDeploy: !d.release.migrateWithDeploy } })}
            label="Run migrations with deploy" />
          <div className="row" style={{ gap: 8 }}>
            <span className="mono-sm" style={{ color: "var(--fg-muted)" }}>Keep previous releases</span>
            <span style={{ flex: 1 }} />
            <Seg sm value={String(d.release.keep)} options={["1", "3", "5", "10"]}
              onChange={(v) => set({ release: { ...d.release, keep: +v } })} />
          </div>
        </div>
      </DeploySection>

      {/* 6 · HEALTH & OBSERVABILITY */}
      <DeploySection label="health · observability">
        <div className="col" style={{ gap: 8 }}>
          <ToggleRow on={d.health.probeOn} onClick={() => set({ health: { ...d.health, probeOn: !d.health.probeOn } })}
            label="Health probe" value={d.health.probe} />
          <ToggleRow on={d.health.sloOn} onClick={() => set({ health: { ...d.health, sloOn: !d.health.sloOn } })}
            label="SLO / uptime check" value={d.health.slo} />
          <ToggleRow on={d.health.alertsOn} onClick={() => set({ health: { ...d.health, alertsOn: !d.health.alertsOn } })}
            label="Alerts route to" value={d.health.alerts} />
        </div>
      </DeploySection>

      {/* 7 · READINESS SUMMARY */}
      <DeploySection label="readiness" hint={allReady ? "gate met" : `${ready}/${checks.length}`}>
        <div className="col" style={{ gap: 5, marginBottom: 13 }}>
          {checks.map((c) => (
            <div key={c.id} className={"ready-row " + (c.ok ? "ok" : "miss")}>
              <span className="rr-mark">{c.ok ? "✓" : "○"}</span>
              <span className="rr-label">{c.label}</span>
              <span style={{ flex: 1 }} />
              <span className="mono-sm">{c.detail}</span>
            </div>
          ))}
        </div>
        <div className="grp-label" style={{ marginBottom: 8 }}>
          deployment issues at publish · stream <span className="stream-chip">deploy</span>
        </div>
        <div className="col" style={{ gap: 5 }}>
          {window.DEPLOY_ISSUES.map((iss, i) => {
            const blocked = iss.blocking && !d.config.secrets.every((s) => s.prod);
            return (
              <div key={i} className="dep-issue">
                <span className="di-plus">＋</span>
                <span className="di-txt" style={blocked ? { color: "var(--fg-muted)" } : undefined}>{iss.t}</span>
                <span style={{ flex: 1 }} />
                {blocked
                  ? <span className="chip" style={{ fontSize: 8, color: "var(--danger)", borderColor: "color-mix(in oklch,var(--danger),transparent 60%)" }}>blocking</span>
                  : <span className="chip" style={{ fontSize: 8 }}>{iss.env}</span>}
              </div>
            );
          })}
        </div>
      </DeploySection>
    </div>
  );
}

function Field({ label, value, onChange }) {
  return (
    <label className="field">
      <span className="field-k">{label}</span>
      <input className="field-in" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
function ToggleRow({ on, onClick, label, value }) {
  return (
    <div className="row" style={{ gap: 9 }}>
      <span className={"toggle" + (on ? " on" : "")} onClick={onClick} />
      <span className="mono-sm" style={{ color: on ? "var(--fg)" : "var(--fg-muted)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {value && <span className="mono-sm" style={{ color: on ? "var(--fg-muted)" : "var(--fg-dim)" }}>{value}</span>}
    </div>
  );
}

/* ===================================================================
   4 · UI DESIGN — render-preview walkthrough
   =================================================================== */
function UIView({ screens, onApprove }) {
  const firstUnapproved = screens.find((s) => !s.approved) || screens[0];
  const [active, setActive] = useState(firstUnapproved.id);
  const cur = screens.find((s) => s.id === active);
  const approvedCount = screens.filter((s) => s.approved).length;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="grp-label">live preview</span>
        <span style={{ flex: 1 }} />
        <span className="mono-sm">{approvedCount}/{screens.length} screens approved</span>
      </div>

      {/* preview stage */}
      <div className="preview-stage">
        <div className="preview-bar">
          <span className="preview-light" /><span className="preview-light" /><span className="preview-light" />
          <span style={{ marginLeft: 6 }}>{cur.route}</span>
          <span style={{ flex: 1 }} />
          <span>esbuild-wasm · sandboxed</span>
        </div>
        <div className="preview-screen">
          {cur.blocks.map((b, i) => (
            <div key={b} className="skl" style={{
              height: b === "topbar" ? 22 : i === 1 ? 30 : "auto",
              flex: b === "topbar" || i === 1 ? "0 0 auto" : "1 1 0",
              display: "flex", alignItems: "center", paddingLeft: 9,
            }}>
              <span className="mono-sm" style={{ color: "var(--fg-dim)" }}>{b}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="nav-btn" onClick={() => {
          const i = screens.findIndex((s) => s.id === active);
          setActive(screens[(i - 1 + screens.length) % screens.length].id);
        }}>← prev</button>
        <button className={"nav-btn" + (cur.approved ? "" : " primary")}
          onClick={() => onApprove(cur.id)} disabled={cur.approved}>
          {cur.approved ? "✓ approved" : "approve screen →"}
        </button>
        <span style={{ flex: 1 }} />
        <button className="nav-btn" onClick={() => {
          const i = screens.findIndex((s) => s.id === active);
          setActive(screens[(i + 1) % screens.length].id);
        }}>next →</button>
      </div>

      {/* thumbnails */}
      <GrpLabel>screen skeletons</GrpLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))", gap: 10 }}>
        {screens.map((s) => (
          <div key={s.id} className={"screen-frame" + (s.id === active ? " sel" : "")} onClick={() => setActive(s.id)}>
            <div className="screen-canvas">
              {s.blocks.slice(0, 4).map((b, i) => (
                <div key={i} className="skl" style={{ height: i === 0 ? 8 : "auto", flex: i === 0 ? "0 0 auto" : "1 1 0" }} />
              ))}
            </div>
            <div className="screen-cap">
              <span style={{ color: s.approved ? "var(--success)" : "var(--fg-dim)" }}>{s.approved ? "✓" : "○"}</span>
              <span style={{ color: "var(--fg)" }}>{s.name}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===================================================================
   5 · STRUCTURE — milestone → epic → issue → sub-issue
   =================================================================== */
function StructureView({ structure }) {
  const [open, setOpen] = useState(() => new Set(structure.flatMap((m) => [m.id, ...m.epics.map((e) => e.id)])));
  const [openIssue, setOpenIssue] = useState(() => new Set([418, 417]));
  const tog = (set, setter, id) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n); };
  const issueCount = structure.flatMap((m) => m.epics.flatMap((e) => e.issues)).length;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="tiles">
        <Tile v={structure.length} k="milestones" />
        <Tile v={structure.flatMap((m) => m.epics).length} k="epics" />
        <Tile v={issueCount} k="issues" />
      </div>

      {structure.map((m) => (
        <div key={m.id} className="node" style={{ background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 9, padding: "9px 10px" }}>
          <div className="node-row" onClick={() => tog(open, setOpen, m.id)} style={{ cursor: "pointer" }}>
            <span style={{ color: "var(--fg-dim)", fontSize: 9 }}>{open.has(m.id) ? "▼" : "▶"}</span>
            <span className="chip" style={{ color: "var(--info)", borderColor: "color-mix(in oklch,var(--info),transparent 65%)" }}>{m.id}</span>
            <span style={{ color: "var(--fg)", fontSize: 12 }}>{m.title}</span>
            <span style={{ flex: 1 }} />
            <span className="mono-sm">{m.repo.split("/")[1]}</span>
            <span className="track" style={{ width: 46, display: "block" }}><i style={{ width: `${m.pct * 100}%` }} /></span>
          </div>
          {open.has(m.id) && m.epics.map((e) => (
            <div key={e.id} style={{ paddingLeft: 16, borderLeft: "1px solid var(--border-soft)", marginLeft: 8 }}>
              <div className="node-row" onClick={() => tog(open, setOpen, e.id)} style={{ cursor: "pointer" }}>
                <span style={{ color: "var(--fg-dim)", fontSize: 9 }}>{open.has(e.id) ? "▼" : "▶"}</span>
                <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>◆ {e.title}</span>
                <span style={{ flex: 1 }} />
                <span className="track" style={{ width: 36, display: "block" }}><i className="green" style={{ width: `${e.pct * 100}%` }} /></span>
              </div>
              {open.has(e.id) && e.issues.map((iss) => (
                <div key={iss.n} style={{ paddingLeft: 16, borderLeft: "1px solid var(--border-soft)", marginLeft: 8 }}>
                  <div className="node-row" onClick={() => tog(openIssue, setOpenIssue, iss.n)} style={{ cursor: "pointer" }}>
                    <span className="sdot" style={{ background: window.ISSUE_STATE[iss.state] }} />
                    <span className="issue-num">#{iss.n}</span>
                    <span style={{ color: "var(--fg)", fontSize: 10.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{iss.t}</span>
                    <Avatar id={iss.owner} sz={15} />
                    <span className="chip" style={{ fontSize: 8 }}>{iss.ac} AC</span>
                  </div>
                  {openIssue.has(iss.n) && iss.sub.length > 0 && (
                    <div style={{ paddingLeft: 26, paddingBottom: 4, display: "flex", flexDirection: "column", gap: 4 }}>
                      {iss.sub.map((s, si) => (
                        <div key={si} className="subitem">
                          <span className={"subbox" + (s.done ? " done" : "")}>{s.done ? "✓" : ""}</span>
                          <span style={{ textDecoration: s.done ? "line-through" : "none" }}>{s.t}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ===================================================================
   6 · PERMISSIONS — the full-width matrix
   =================================================================== */
function PermissionsView({ agents, onCell, onPreset }) {
  const CAPS = window.CAPS, PRESETS = window.PRESETS;
  const cycle = (v) => (v === "allow" ? "ask" : v === "ask" ? "deny" : "allow");
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="mono-sm" style={{ lineHeight: 1.5 }}>
        Each work stream runs under its own least-privilege posture. Click a cell to cycle
        <span style={{ color: "var(--success)" }}> allow</span> →
        <span style={{ color: "var(--accent)" }}> ask</span> →
        <span style={{ color: "var(--danger)" }}> deny</span>.
      </div>

      <table className="matrix">
        <thead>
          <tr>
            <th className="agent-th">stream</th>
            {CAPS.map((c) => <th key={c.k} title={c.label}>{c.g}</th>)}
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td className="agent-td">
                <span className="row" style={{ gap: 6 }}>
                  <Avatar id={a.id} sz={16} />
                  <span style={{ color: "var(--fg)", fontSize: 10 }}>{a.name}</span>
                </span>
              </td>
              {CAPS.map((c) => (
                <td key={c.k}>
                  <div className={"mcell " + a.perm[c.k]} title={`${a.name} · ${c.label}: ${a.perm[c.k]}`}
                    onClick={() => onCell(a.id, c.k, cycle(a.perm[c.k]))}>
                    {a.perm[c.k] === "allow" ? "✓" : a.perm[c.k] === "ask" ? "?" : "✕"}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <GrpLabel>per-stream detail</GrpLabel>
      <div className="col" style={{ gap: 8 }}>
        {agents.map((a) => (
          <div key={a.id} className="list-card" style={{ flexWrap: "wrap", rowGap: 8 }}>
            <Avatar id={a.id} sz={20} />
            <div className="col" style={{ gap: 4, flex: 1, minWidth: 120 }}>
              <span className="row" style={{ gap: 6 }}>
                <span style={{ color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 11 }}>{a.name}</span>
                <RoleChip role={a.role} mute />
              </span>
              <span className="mono-sm" style={{ color: "var(--info)" }}>⎇ {a.repo} · owns {a.owns[0]}{a.owns.length > 1 ? ` +${a.owns.length - 1}` : ""}</span>
            </div>
            <div className="row" style={{ gap: 5 }}>
              {Object.keys(PRESETS).map((p) => (
                <span key={p} className={"preset-pill" + (a.preset === p ? " on" : "")}
                  onClick={() => onPreset(a.id, p)}>{p}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===================================================================
   7 · MCP SERVERS — external tool/data connections
   =================================================================== */
function MCPView({ servers, onToggle }) {
  const TR = window.MCP_TRANSPORT;
  const [open, setOpen] = useState(() => new Set([servers.find((s) => s.status === "error")?.id].filter(Boolean)));
  const toggle = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const connected = servers.filter((s) => s.on && s.status === "connected").length;
  const toolCount = servers.filter((s) => s.on).reduce((n, s) => n + s.tools.length, 0);
  const errored = servers.filter((s) => s.on && s.status === "error").length;

  const STATUS = {
    connected: { c: "var(--success)", dot: "on",  label: "connected" },
    available: { c: "var(--fg-dim)",  dot: "idle", label: "available" },
    error:     { c: "var(--danger)",  dot: "",     label: "handshake failed" },
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="tiles">
        <Tile v={connected} unit={`/ ${servers.length}`} k="connected" />
        <Tile v={toolCount} k="tools exposed" />
        <Tile v={errored} k={errored === 1 ? "needs attention" : "need attention"} />
      </div>

      <div className="col" style={{ gap: 8 }}>
        {servers.map((s) => {
          const tr = TR[s.transport];
          const stat = STATUS[s.status];
          const isOpen = open.has(s.id);
          const dim = !s.on;
          return (
            <div key={s.id} style={{ borderRadius: 9, background: "var(--bg-canvas)",
              border: "1px solid " + (s.status === "error" && s.on ? "color-mix(in oklch, var(--danger), transparent 60%)" : isOpen ? "var(--border)" : "var(--border-soft)"),
              overflow: "hidden", opacity: dim ? 0.72 : 1 }}>
              {/* header row */}
              <div className="row" style={{ gap: 10, padding: "10px 12px" }}>
                <span className="mcp-glyph" style={{ borderColor: `color-mix(in oklch, ${tr.c}, transparent 55%)`, color: tr.c }}>
                  {s.name[0].toUpperCase()}
                </span>
                <div className="col" style={{ gap: 3, flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => toggle(s.id)}>
                  <span className="row" style={{ gap: 7 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{s.name}</span>
                    {s.official && <span className="chip" style={{ fontSize: 8 }}>official</span>}
                    <span className="chip" style={{ fontSize: 8, color: tr.c, borderColor: `color-mix(in oklch, ${tr.c}, transparent 70%)` }}>{tr.label}</span>
                  </span>
                  <span className="mono-sm" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.desc}</span>
                </div>
                <div className="col" style={{ alignItems: "flex-end", gap: 5 }}>
                  <span className="row" style={{ gap: 5 }}>
                    <span className={"sdot " + stat.dot} style={s.status === "error" ? { background: "var(--danger)" } : undefined} />
                    <span className="mono-sm" style={{ color: stat.c }}>{stat.label}</span>
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="mono-sm">{s.tools.length} tools</span>
                    <span className={"toggle" + (s.on ? " on" : "")} onClick={() => onToggle(s.id)} />
                  </span>
                </div>
              </div>

              {/* error strip */}
              {s.on && s.status === "error" && (
                <div className="row" style={{ gap: 7, padding: "0 12px 10px" }}>
                  <span className="mono-sm" style={{ color: "var(--danger)" }}>⚠ {s.err}</span>
                  <span style={{ flex: 1 }} />
                  <button className="preset-pill">retry handshake</button>
                </div>
              )}

              {/* expanded detail */}
              {isOpen && (
                <div style={{ padding: "10px 12px 12px", borderTop: "1px solid var(--border-soft)" }}>
                  <div className="mono-sm" style={{ color: "var(--fg-dim)", marginBottom: 4 }}>command</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", background: "var(--bg-canvas)",
                    border: "1px solid var(--border-soft)", borderRadius: 6, padding: "6px 9px", marginBottom: 11,
                    overflowX: "auto", whiteSpace: "nowrap" }}>
                    <span style={{ color: "var(--accent)" }}>$ </span>{s.cmd}
                  </div>

                  <div className="grp-label" style={{ marginBottom: 6 }}>exposed tools</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 11 }}>
                    {s.tools.map((t) => <span key={t} className="glob">{t}</span>)}
                  </div>

                  <div className="grp-label" style={{ marginBottom: 6 }}>scope · {s.scope}</div>
                  {s.agents.length > 0 ? (
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      {s.agents.map((id) => {
                        const ag = window.AGENTS.find((a) => a.id === id);
                        return (
                          <span key={id} className="row" style={{ gap: 5, padding: "2px 8px 2px 3px", borderRadius: 99,
                            background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>
                            <Avatar id={id} sz={15} />
                            <span className="mono-sm" style={{ color: "var(--fg)" }}>{ag ? ag.name : id}</span>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="mono-sm" style={{ color: "var(--fg-dim)" }}>no agents wired yet — enable to grant access</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="dropzone">＋ add an MCP server — paste a command or remote URL</div>
    </div>
  );
}

/* ===================================================================
   8 · AUTOMATIONS
   =================================================================== */
function AutomationsView({ automations, onToggle }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="tiles">
        <Tile v={automations.filter((a) => a.on).length} unit={`/ ${automations.length}`} k="active" />
        <Tile v={automations.filter((a) => a.kind === "command").length} k="commands" />
        <Tile v={automations.filter((a) => a.kind === "knowledge").length} k="injections" />
      </div>
      <div className="col" style={{ gap: 8 }}>
        {automations.map((a) => (
          <div key={a.id} className="list-card">
            <div className={"toggle" + (a.on ? " on" : "")} onClick={() => onToggle(a.id)} />
            <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
              <span className="row" style={{ gap: 7 }}>
                <span style={{ color: a.on ? "var(--fg)" : "var(--fg-muted)", fontSize: 11.5 }}>{a.name}</span>
                <span className="chip" style={{ fontSize: 8,
                  color: a.kind === "command" ? "var(--accent)" : "var(--info)",
                  borderColor: a.kind === "command" ? "color-mix(in oklch,var(--accent),transparent 70%)" : "color-mix(in oklch,var(--info),transparent 70%)" }}>
                  {a.kind === "command" ? "⌘ command" : "✦ knowledge"}
                </span>
              </span>
              <span className="mono-sm" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.detail}</span>
            </div>
            <div className="col" style={{ alignItems: "flex-end", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--fg-muted)" }}>{a.cron}</span>
              <span className="mono-sm">{a.target}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="dropzone">＋ schedule a command or knowledge injection</div>
    </div>
  );
}

/* ===================================================================
   9 · SKILLS
   =================================================================== */
function SkillsView({ skills, onToggle }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="grp-label">reusable skills</span>
        <span style={{ flex: 1 }} />
        <span className="mono-sm">{skills.filter((s) => s.indexed).length} indexed for this project</span>
      </div>
      <div className="col" style={{ gap: 8 }}>
        {skills.map((s) => (
          <div key={s.id} className="list-card" style={{ alignItems: "flex-start" }}>
            <div className="col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <span className="row" style={{ gap: 7 }}>
                <span style={{ color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 11.5 }}>{s.name}</span>
                {s.tags.map((t) => <span key={t} className="glob">{t}</span>)}
              </span>
              <span className="mono-sm" style={{ color: "var(--fg-muted)", lineHeight: 1.45, whiteSpace: "normal" }}>{s.desc}</span>
            </div>
            <button className={"preset-pill" + (s.indexed ? " on" : "")} onClick={() => onToggle(s.id)}
              style={{ flex: "0 0 auto" }}>{s.indexed ? "✓ indexed" : "+ index"}</button>
          </div>
        ))}
      </div>
      <div className="dropzone">＋ author a new skill from this project's patterns</div>
    </div>
  );
}

Object.assign(window, {
  ContextView, ReposView, DeployView, UIView, StructureView, PermissionsView, MCPView, AutomationsView, SkillsView,
  deployChecks, PV_Avatar: Avatar, PV_RoleChip: RoleChip,
});
