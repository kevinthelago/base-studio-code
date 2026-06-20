// Deploy stage pane (#919) — the focused-pane body for the planner's Deploy stage (right after
// Repos). Ported from design/bsc project planner focused/planner/phaseViews.jsx (DeployView).
// Pure presentational: reads a DeployConfig, calls onChange with the next config. The
// `deploymentDefined` gate signal is derived from the same deployChecks().

import {
  PLATFORMS, platform, WORKLOAD, PIPE_TRIGGERS, RELEASE_STRATEGIES, deployChecks,
  type DeployConfig, type Workload, type ReleaseStrategy,
} from "../deployConfig";

const MONO = "var(--mono)";
const card: React.CSSProperties = {
  background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
  borderRadius: "var(--r-lg)", padding: "13px 14px",
};
const grpLabel: React.CSSProperties = {
  fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".08em",
};
const monoSm: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)" };
const prop: React.CSSProperties = { fontFamily: MONO, fontSize: 9, color: "var(--accent)" };
const chip: React.CSSProperties = {
  padding: "1px 7px", borderRadius: 99, fontFamily: MONO, fontSize: 9, background: "var(--bg-elev2)",
  color: "var(--fg-muted)", border: "1px solid var(--border-soft)", whiteSpace: "nowrap",
};

function Section({ label, hint, proposed, children }: { label: string; hint?: string; proposed?: boolean; children: React.ReactNode }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
        <span style={grpLabel}>{label}</span>
        {proposed && <span style={prop}>✦ proposed</span>}
        <span style={{ flex: 1 }} />
        {hint && <span style={monoSm}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
      {options.map((o, i) => (
        <button key={o} onClick={() => onChange(o)} style={{
          height: 22, padding: "0 9px", border: 0, borderLeft: i ? "1px solid var(--border-soft)" : "none", cursor: "pointer",
          fontFamily: MONO, fontSize: 9.5, background: value === o ? "var(--bg-elev2)" : "transparent", color: value === o ? "var(--fg)" : "var(--fg-dim)",
        }}>{o}</button>
      ))}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
      <span style={grpLabel}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={{
        height: 26, padding: "0 8px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-sm)", outline: "none", fontFamily: MONO, fontSize: 11, color: "var(--fg)",
      }} />
    </label>
  );
}

function Toggle({ on, onClick, label, value }: { on: boolean; onClick: () => void; label: string; value?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <span onClick={onClick} style={{
        width: 26, height: 15, borderRadius: 99, flexShrink: 0, cursor: "pointer", position: "relative",
        background: on ? "color-mix(in oklch, var(--success), transparent 50%)" : "var(--bg-elev2)",
        border: "1px solid " + (on ? "var(--success)" : "var(--border-soft)"), transition: "all .12s",
      }}>
        <span style={{ position: "absolute", top: 1, left: on ? 12 : 1, width: 11, height: 11, borderRadius: 99, background: on ? "var(--success)" : "var(--fg-dim)", transition: "all .12s" }} />
      </span>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: on ? "var(--fg)" : "var(--fg-muted)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {value && <span style={{ fontFamily: MONO, fontSize: 10, color: on ? "var(--fg-muted)" : "var(--fg-dim)" }}>{value}</span>}
    </div>
  );
}

export function FocusedDeployBody({ deploy, onChange }: { deploy?: DeployConfig; onChange?: (next: DeployConfig) => void }) {
  if (!deploy) {
    return <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg-dim)", padding: "8px 2px" }}>Deployment config loads once the repos are linked.</div>;
  }
  const d = deploy;
  const set = (patch: Partial<DeployConfig>) => onChange?.({ ...d, ...patch });
  const svc = d.services.find((s) => s.id === d.selService) ?? d.services[0];
  const checks = deployChecks(d);
  const ready = checks.filter((c) => c.ok).length;
  const allReady = ready === checks.length;

  const setSvc = (patch: Partial<typeof svc>) => svc && set({ services: d.services.map((s) => s.id === svc.id ? { ...s, ...patch } : s) });
  const pickPlatform = (pid: string) => {
    const p = platform(pid);
    const wl: Workload = svc && p.kinds.includes(svc.workload) ? svc.workload : (p.kinds[0] ?? "static");
    setSvc({ platform: pid, proposed: false, workload: wl });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* readiness banner */}
      <div style={{
        display: "flex", alignItems: "center", gap: 9, padding: "9px 13px", borderRadius: "var(--r-md)",
        background: `color-mix(in oklch, ${allReady ? "var(--success)" : "var(--accent)"}, transparent 90%)`,
        border: `1px solid color-mix(in oklch, ${allReady ? "var(--success)" : "var(--accent)"}, transparent 72%)`,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: allReady ? "var(--success)" : "var(--accent)" }} />
        <span style={{ fontFamily: MONO, fontSize: 11, color: allReady ? "var(--success)" : "var(--accent)" }}>{allReady ? "Ready to ship" : `${ready}/${checks.length} defined`}</span>
        <span style={{ flex: 1 }} />
        <span style={monoSm}>{allReady ? "deployment issues ready to generate" : "missing: " + checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}</span>
      </div>

      {/* 1 · TARGET & HOSTING */}
      <Section label="target · hosting" hint={`${d.services.length} service${d.services.length !== 1 ? "s" : ""}`}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {d.services.map((s) => {
            const p = platform(s.platform);
            const on = svc && s.id === svc.id;
            return (
              <button key={s.id} onClick={() => set({ selService: s.id })} style={{
                display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-start", padding: "5px 10px", cursor: "pointer",
                borderRadius: "var(--r-md)", border: "1px solid " + (on ? "var(--accent)" : "var(--border-soft)"),
                background: on ? "var(--bg-elev)" : "transparent",
              }}>
                <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)" }}>{s.id}</span>
                <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>{s.platform ? `${p.glyph} ${p.name}` : "no target"}</span>
              </button>
            );
          })}
        </div>
        {svc && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
              <span style={{ ...chip, color: "var(--fg-muted)" }}>⎇ {svc.repo || "—"}/{svc.path}</span>
              <span style={chip}>{svc.stack}</span>
              <span style={{ flex: 1 }} />
              {svc.proposed && <span style={prop}>✦ proposed</span>}
            </div>
            <div style={{ ...grpLabel, marginBottom: 8 }}>platform</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 6 }}>
              {PLATFORMS.map((p) => {
                const on = svc.platform === p.id;
                return (
                  <button key={p.id} onClick={() => pickPlatform(p.id)} style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", cursor: "pointer",
                    borderRadius: "var(--r-md)", border: "1px solid " + (on ? `oklch(0.78 0.12 ${p.h})` : "var(--border-soft)"),
                    background: on ? `color-mix(in oklch, oklch(0.78 0.12 ${p.h}), transparent 88%)` : "transparent",
                  }}>
                    <span style={{ color: `oklch(0.78 0.12 ${p.h})`, fontSize: 12 }}>{p.glyph}</span>
                    <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", margin: "11px 0" }}>
              {platform(svc.platform).kinds.map((k) => {
                const on = svc.workload === k;
                return (
                  <button key={k} onClick={() => setSvc({ workload: k })} style={{
                    padding: "2px 9px", borderRadius: 99, cursor: "pointer", fontFamily: MONO, fontSize: 9.5,
                    border: "1px solid " + (on ? WORKLOAD[k].c : "var(--border-soft)"), color: on ? WORKLOAD[k].c : "var(--fg-dim)", background: "transparent",
                  }}>{WORKLOAD[k].label}</button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Field label="region" value={svc.region} onChange={(v) => setSvc({ region: v })} />
              <Field label={svc.workload === "container" ? "image" : "build cmd"} value={svc.build} onChange={(v) => setSvc({ build: v })} />
              {svc.workload === "container"
                ? <Field label="runtime" value={svc.runtime} onChange={(v) => setSvc({ runtime: v })} />
                : <Field label="output dir" value={svc.output} onChange={(v) => setSvc({ output: v })} />}
            </div>
          </>
        )}
      </Section>

      {/* 2 · ENVIRONMENTS */}
      <Section label="environments" hint="branch → env" proposed>
        <div style={{ display: "flex", alignItems: "stretch", gap: 6, flexWrap: "wrap" }}>
          {d.envs.map((e, i) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <span style={{ color: "var(--fg-dim)", fontFamily: MONO }}>→</span>}
              <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px", borderRadius: "var(--r-md)", border: "1px solid var(--border-soft)", background: "var(--bg-elev)", minWidth: 120 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: e.id === "prod" ? "var(--accent)" : "var(--fg-dim)" }} />
                  <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)" }}>{e.name}</span>
                  <span style={{ ...chip, fontSize: 8, ...(e.auto ? {} : { color: "var(--accent)", borderColor: "var(--accent-dim)" }) }}>{e.auto ? "auto" : "manual"}</span>
                </div>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--info)" }}>⎇ {e.branch}</span>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)" }}>{e.url || "—"}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* 3 · CI/CD PIPELINE */}
      <Section label="ci/cd pipeline" hint={d.pipeline.provider}>
        <div style={{ display: "flex", alignItems: "stretch", gap: 6, flexWrap: "wrap" }}>
          {d.pipeline.stages.map((st, i) => (
            <div key={st.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <span style={{ color: st.gate ? "var(--accent)" : "var(--fg-dim)", fontFamily: MONO }}>{st.gate ? "⟫" : "→"}</span>}
              <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "8px 10px", borderRadius: "var(--r-md)", minWidth: 130, border: "1px solid " + (st.gate ? "var(--accent-dim)" : "var(--border-soft)"), background: "var(--bg-elev)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)" }}>{st.name}</span>
                  {st.gate && <span style={{ ...chip, fontSize: 8, color: "var(--accent)", borderColor: "var(--accent-dim)" }}>gate</span>}
                </div>
                <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130 }}>{st.cmd || "—"}</span>
                <Seg value={st.trigger} options={PIPE_TRIGGERS}
                  onChange={(v) => set({ pipeline: { ...d.pipeline, stages: d.pipeline.stages.map((x) => x.id === st.id ? { ...x, trigger: v } : x) } })} />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* 4 · CONFIG & SECRETS */}
      <Section label="config · secrets" hint={d.config.vault}>
        {d.config.config.length === 0 && d.config.secrets.length === 0 ? (
          <span style={monoSm}>No config or secrets yet — the planner proposes them per environment.</span>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MONO, fontSize: 10.5 }}>
            <thead><tr style={{ color: "var(--fg-dim)", textAlign: "left" }}><th style={{ padding: "3px 6px", fontWeight: 400 }}>variable</th>{d.envs.map((e) => <th key={e.id} style={{ padding: "3px 6px", fontWeight: 400 }}>{e.name}</th>)}</tr></thead>
            <tbody>
              {d.config.config.map((row) => (
                <tr key={row.key} style={{ borderTop: "1px solid var(--border-soft)" }}>
                  <td style={{ padding: "4px 6px", color: "var(--fg)" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: "var(--info)", marginRight: 6 }} />{row.key}</td>
                  {d.envs.map((e) => <td key={e.id} style={{ padding: "4px 6px", color: "var(--fg-muted)" }}>{row[e.id] || "—"}</td>)}
                </tr>
              ))}
              {d.config.secrets.map((row) => (
                <tr key={row.key} style={{ borderTop: "1px solid var(--border-soft)" }}>
                  <td style={{ padding: "4px 6px", color: "var(--fg)" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: "var(--accent)", marginRight: 6 }} />{row.key}</td>
                  {d.envs.map((e) => (
                    <td key={e.id} style={{ padding: "4px 6px" }}>
                      {row[e.id]
                        ? <span style={{ color: "var(--success)" }}>••••✓</span>
                        : <button onClick={() => set({ config: { ...d.config, secrets: d.config.secrets.map((s) => s.key === row.key ? { ...s, [e.id]: true } : s) } })}
                            style={{ padding: "1px 7px", borderRadius: 99, cursor: "pointer", fontFamily: MONO, fontSize: 9, color: "var(--accent)", background: "transparent", border: "1px solid var(--accent-dim)" }}>+ wire</button>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* 5 · RELEASE & ROLLBACK */}
      <Section label="release · rollback">
        <div style={{ ...grpLabel, marginBottom: 7 }}>strategy</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
          {RELEASE_STRATEGIES.map((s) => {
            const on = d.release.strategy === s.id;
            return (
              <button key={s.id} onClick={() => set({ release: { ...d.release, strategy: s.id as ReleaseStrategy } })} style={{
                display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start", textAlign: "left", padding: "8px 10px", cursor: "pointer",
                borderRadius: "var(--r-md)", border: "1px solid " + (on ? "var(--accent)" : "var(--border-soft)"), background: on ? "var(--bg-elev)" : "transparent",
              }}>
                <span style={{ fontFamily: MONO, fontSize: 11, color: on ? "var(--accent)" : "var(--fg)" }}>{s.label}</span>
                <span style={{ fontSize: 10, color: "var(--fg-dim)", lineHeight: 1.4 }}>{s.desc}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          <Toggle on={d.release.autoRollback} onClick={() => set({ release: { ...d.release, autoRollback: !d.release.autoRollback } })} label="Auto-rollback on failed health check" />
          <Toggle on={d.release.migrateWithDeploy} onClick={() => set({ release: { ...d.release, migrateWithDeploy: !d.release.migrateWithDeploy } })} label="Run migrations with deploy" />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg-muted)" }}>Keep previous releases</span>
            <span style={{ flex: 1 }} />
            <Seg value={String(d.release.keep)} options={["1", "3", "5", "10"] as const} onChange={(v) => set({ release: { ...d.release, keep: +v } })} />
          </div>
        </div>
      </Section>

      {/* 6 · HEALTH & OBSERVABILITY */}
      <Section label="health · observability">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Toggle on={d.health.probeOn} onClick={() => set({ health: { ...d.health, probeOn: !d.health.probeOn } })} label="Health probe" value={d.health.probe} />
          <Toggle on={d.health.sloOn} onClick={() => set({ health: { ...d.health, sloOn: !d.health.sloOn } })} label="SLO / uptime check" value={d.health.slo || "—"} />
          <Toggle on={d.health.alertsOn} onClick={() => set({ health: { ...d.health, alertsOn: !d.health.alertsOn } })} label="Alerts route to" value={d.health.alerts || "—"} />
        </div>
      </Section>

      {/* 7 · READINESS */}
      <Section label="readiness" hint={allReady ? "gate met" : `${ready}/${checks.length}`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {checks.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
              <span style={{ color: c.ok ? "var(--success)" : "var(--fg-dim)", fontFamily: MONO }}>{c.ok ? "✓" : "○"}</span>
              <span style={{ color: c.ok ? "var(--fg)" : "var(--fg-muted)" }}>{c.label}</span>
              <span style={{ flex: 1 }} />
              <span style={monoSm}>{c.detail}</span>
            </div>
          ))}
        </div>
        <div style={{ ...grpLabel, margin: "13px 0 6px", display: "flex", alignItems: "center", gap: 6 }}>
          deployment issues at publish · stream
          <span style={{ ...chip, color: "var(--accent)", borderColor: "var(--accent-dim)" }}>deploy</span>
        </div>
        <span style={monoSm}>One deploy workflow per service, environment provisioning, secret wiring, and a prod health check — generated as issues when this config is complete.</span>
      </Section>
    </div>
  );
}
