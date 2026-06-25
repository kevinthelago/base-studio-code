// Deploy stage pane (#919, redesign per design/Base studio code deployment) — the focused-pane
// body for the planner's Deploy stage (right after Repos). Pure presentational: reads a DeployConfig
// (+ the locked dependency manifest) and calls onChange with the next config. The `deploymentDefined`
// gate signal is derived from the same deployChecks(); a card turns green once its check passes.
//
// Structure mirrors the design: A · HOW IT SHIPS (target+hosting · pipeline · environments ·
// config+secrets) → B · WHAT IT DEPENDS ON (dependencies, grouped by source) → C · RELEASE & HEALTH
// → D · READINESS (checklist + the stream:deploy issues this config generates at publish).

import { useState } from "react";
import {
  PLATFORMS, platform, WORKLOAD, PIPE_TRIGGERS, RELEASE_STRATEGIES, ORCHESTRATORS, REPLICA_OPTIONS,
  PUBLISH_REGISTRIES, PUBLISH_TRIGGERS, PORT_FORWARD_METHODS,
  hostMeta, serviceChecks, serviceReady, readyServiceCount, serviceMode, serviceTargetDefined, finalStageName,
  type DeployConfig, type DeployService, type Workload, type ReleaseStrategy,
  type DeployMode, type LocalKind, type PublishRegistry, type PublishTrigger, type PortForwardMethod,
} from "../shared/deployConfig";
import { groupDependenciesBySource, type PlanDependency, type DependencyRegistry } from "../issues/dependencies";

const MONO = "var(--mono)";
const grpLabel: React.CSSProperties = {
  fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em",
};
const monoSm: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)" };
const prop: React.CSSProperties = { fontFamily: MONO, fontSize: 9, color: "var(--accent)" };
const chip: React.CSSProperties = {
  padding: "1px 7px", borderRadius: 99, fontFamily: MONO, fontSize: 9, background: "var(--bg-elev2)",
  color: "var(--fg-muted)", border: "1px solid var(--border-soft)", whiteSpace: "nowrap",
};

/** A card with a numbered (or ✓-when-done) tile, title, optional accent + right slot. */
export function Card({ n, title, hint, right, accent, done, children }: {
  n: string; title: string; hint?: string; right?: React.ReactNode; accent?: string; done?: boolean;
  children: React.ReactNode;
}) {
  const tileColor = done ? "var(--success)" : accent ?? "var(--fg-dim)";
  return (
    <div style={{
      borderRadius: "var(--r-lg)", padding: "13px 14px",
      border: "1px solid " + (done ? "color-mix(in oklch, var(--success), transparent 58%)" : accent ? `color-mix(in oklch, ${accent}, transparent 78%)` : "var(--border-soft)"),
      background: done ? "color-mix(in oklch, var(--success), transparent 93%)" : "var(--bg-panel)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
        <span style={{
          width: 20, height: 20, borderRadius: 6, flex: "0 0 20px", display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: MONO, fontSize: 9, color: tileColor,
          background: done ? "color-mix(in oklch, var(--success), transparent 80%)" : "var(--bg-elev)",
          border: "1px solid " + (done ? "var(--success)" : accent ? `color-mix(in oklch, ${accent}, transparent 65%)` : "var(--border-soft)"),
        }}>{done ? "✓" : n}</span>
        <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{title}</span>
        {hint && <span style={monoSm}>{hint}</span>}
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </div>
  );
}

/** Group divider — "A · HOW IT SHIPS", colored rule. */
export function Divider({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
      <span style={{ fontFamily: MONO, fontSize: 9.5, color, letterSpacing: ".1em", fontWeight: 600 }}>{label}</span>
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
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
      <span style={{ fontFamily: MONO, fontSize: 10, color: on ? "var(--fg)" : "var(--fg-muted)", lineHeight: 1.3 }}>{label}</span>
      <span style={{ flex: 1 }} />
      {value && <span style={{ fontFamily: MONO, fontSize: 9.5, color: on ? "var(--fg-muted)" : "var(--fg-dim)" }}>{value}</span>}
    </div>
  );
}

/** Cloud body (#1192) — today's card: platform dropdown → workload → region/build/runtime →
 *  containerization & orchestration for container workloads. Unchanged from the original. */
function CloudBody({ svc, setSvc }: { svc: DeployService; setSvc: (patch: Partial<DeployService>) => void }) {
  const [open, setOpen] = useState(false);
  const pickPlatform = (pid: string) => {
    setOpen(false);
    if (svc?.platform === pid) { setSvc({ platform: "", proposed: false }); return; }
    const p = platform(pid);
    const wl: Workload = svc && p.kinds.includes(svc.workload) ? svc.workload : (p.kinds[0] ?? "static");
    setSvc({ platform: pid, proposed: false, workload: wl });
  };
  const selPlat = svc.platform ? platform(svc.platform) : null;
  const isContainer = svc.workload === "container";
  const canContainerize = platform(svc.platform).kinds.includes("container");

  return (
    <>
          {/* platform dropdown */}
          <div style={{ ...grpLabel, marginBottom: 8 }}>platform</div>
          <div style={{ position: "relative" }}>
            <button onClick={() => setOpen((v) => !v)} style={{
              width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", cursor: "pointer",
              borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid " + (open ? "var(--accent-dim)" : "var(--border-soft)"),
            }}>
              <span style={{ fontSize: 14, width: 16, textAlign: "center", color: selPlat ? `oklch(0.78 0.12 ${selPlat.h})` : "var(--fg-dim)" }}>{selPlat?.glyph ?? "▢"}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: selPlat ? "var(--fg)" : "var(--fg-dim)" }}>{selPlat?.name ?? "Select a platform…"}</span>
              <span style={{ flex: 1 }} />
              <span style={monoSm}>{PLATFORMS.length} options</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)", display: "inline-block", transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform .14s" }}>▾</span>
            </button>
            {open && (
              <div style={{
                position: "absolute", top: "calc(100% + 5px)", left: 0, right: 0, zIndex: 30, maxHeight: 236, overflowY: "auto",
                padding: 5, borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border)", boxShadow: "0 14px 40px rgba(0,0,0,.55)",
              }}>
                {PLATFORMS.map((p) => {
                  const on = svc.platform === p.id;
                  return (
                    <button key={p.id} onClick={() => pickPlatform(p.id)} style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "7px 9px", cursor: "pointer",
                      borderRadius: "var(--r-sm)", border: "1px solid " + (on ? "color-mix(in oklch, var(--accent), transparent 62%)" : "transparent"),
                      background: on ? "color-mix(in oklch, var(--accent), transparent 88%)" : "transparent",
                    }}>
                      <span style={{ fontSize: 14, width: 18, textAlign: "center", color: `oklch(0.78 0.12 ${p.h})` }}>{p.glyph}</span>
                      <span style={{ fontFamily: MONO, fontSize: 10.5, color: on ? "var(--fg)" : "var(--fg-muted)" }}>{p.name}</span>
                      <span style={{ fontFamily: MONO, fontSize: 8, color: "var(--fg-dim)", padding: "1px 6px", borderRadius: 99, border: "1px solid var(--border-soft)" }}>{p.kinds.join(" · ")}</span>
                      <span style={{ flex: 1 }} />
                      {on && <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--accent)" }}>✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {svc.platform ? (
            <>
              {/* workload */}
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
              {/* fields */}
              <div style={{ display: "flex", gap: 8 }}>
                <Field label="region" value={svc.region} onChange={(v) => setSvc({ region: v })} />
                <Field label={isContainer ? "image" : "build cmd"} value={svc.build} onChange={(v) => setSvc({ build: v })} />
                {isContainer
                  ? <Field label="runtime" value={svc.runtime} onChange={(v) => setSvc({ runtime: v })} />
                  : <Field label="output dir" value={svc.output} onChange={(v) => setSvc({ output: v })} />}
              </div>

              {/* containerization & orchestration */}
              <div style={{
                marginTop: 11, borderRadius: "var(--r-md)", padding: "11px 12px",
                border: "1px solid " + (isContainer ? "color-mix(in oklch, var(--violet), transparent 80%)" : "var(--border-soft)"),
                background: isContainer ? "color-mix(in oklch, var(--violet), transparent 95%)" : "var(--bg-canvas)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: isContainer ? 10 : 0 }}>
                  <span style={{ fontSize: 11, color: isContainer ? "var(--violet)" : "var(--fg-dim)" }}>⬢</span>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg)" }}>Containerization &amp; orchestration</span>
                  <span style={{ flex: 1 }} />
                  {isContainer
                    ? <span style={{ ...chip, fontSize: 7.5, color: "var(--violet)", borderColor: "color-mix(in oklch, var(--violet), transparent 72%)", background: "color-mix(in oklch, var(--violet), transparent 86%)" }}>distributed</span>
                    : <span style={{ ...chip, fontSize: 7.5 }}>{WORKLOAD[svc.workload].label}</span>}
                </div>
                {isContainer ? (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={grpLabel}>engine · image</span>
                        <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", padding: "5px 8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Docker · {svc.runtime && svc.runtime !== "—" ? svc.runtime : "base image"}</span>
                      </div>
                      <Field label="image registry" value={svc.registry ?? (svc.repo ? `ghcr.io/${svc.repo}` : "")} onChange={(v) => setSvc({ registry: v })} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
                      <span style={{ ...grpLabel, flex: "0 0 62px" }}>orchestrator</span>
                      <Seg value={svc.orchestrator ?? "k8s"} options={ORCHESTRATORS.map((o) => o.id)} onChange={(v) => setSvc({ orchestrator: v })} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ ...grpLabel, flex: "0 0 62px" }}>replicas</span>
                      <Seg value={svc.replicas ?? "3"} options={REPLICA_OPTIONS} onChange={(v) => setSvc({ replicas: v })} />
                      <span style={{ flex: 1 }} />
                      <span style={{ fontFamily: MONO, fontSize: 8, color: "var(--fg-dim)" }}>nodes share the workload</span>
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 9 }}>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)", lineHeight: 1.45, flex: 1 }}>
                      Not containerized — this <b style={{ color: "var(--fg-muted)" }}>{WORKLOAD[svc.workload].label}</b> service deploys without a container image or orchestrator.
                    </span>
                    {canContainerize && (
                      <button onClick={() => setSvc({ workload: "container" })} style={{
                        fontFamily: MONO, fontSize: 8.5, color: "var(--violet)", padding: "4px 10px", borderRadius: 99, cursor: "pointer", whiteSpace: "nowrap", flex: "0 0 auto",
                        background: "color-mix(in oklch, var(--violet), transparent 88%)", border: "1px solid color-mix(in oklch, var(--violet), transparent 72%)",
                      }}>containerize →</button>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ marginTop: 13, border: "1px dashed color-mix(in oklch, var(--accent), transparent 60%)", borderRadius: "var(--r-md)", padding: "11px 13px", display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 10, color: "var(--accent)", background: "color-mix(in oklch, var(--accent), transparent 93%)" }}>
              <span>↑</span><span>no target for <b>{svc.id}</b> yet — choose a platform from the list above</span>
            </div>
          )}
    </>
  );
}

/** A small native <select>, styled to match the card's fields (#1192). */
function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T | ""; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
      <span style={grpLabel}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} style={{
        height: 28, padding: "0 8px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-sm)", outline: "none", fontFamily: MONO, fontSize: 11, color: "var(--fg)",
      }}>
        <option value="" disabled>—</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

/** Local body (#1192) — a Library (publish to a registry) or an Application (build + run here),
 *  with an optional port-forward for a locally-running app. No cloud-host / region fields. */
function LocalBody({ svc, setSvc }: { svc: DeployService; setSvc: (patch: Partial<DeployService>) => void }) {
  const kind: LocalKind = svc.localKind ?? "application";
  const pf = svc.portForward ?? { enabled: false, port: "", method: "cloudflared" as PortForwardMethod };
  const setPf = (patch: Partial<typeof pf>) => setSvc({ portForward: { ...pf, ...patch } });
  return (
    <>
      {/* Kind sub-toggle */}
      <div style={{ ...grpLabel, marginBottom: 8 }}>kind</div>
      <div style={{ marginBottom: 11 }}>
        <Seg<LocalKind> value={kind} options={["library", "application"] as const}
          onChange={(v) => setSvc({ localKind: v, proposed: false })} />
      </div>

      {kind === "library" ? (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 9 }}>
            <Select label="publish registry" value={svc.publishRegistry ?? ""} options={PUBLISH_REGISTRIES}
              onChange={(v) => setSvc({ publishRegistry: v as PublishRegistry })} />
            <Field label="package name" value={svc.packageName ?? ""} onChange={(v) => setSvc({ packageName: v })} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Field label="build cmd" value={svc.build === "—" ? "" : svc.build} onChange={(v) => setSvc({ build: v })} />
            <Select label="publish trigger" value={svc.publishTrigger ?? ""} options={PUBLISH_TRIGGERS}
              onChange={(v) => setSvc({ publishTrigger: v as PublishTrigger })} />
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 9 }}>
            <Field label="build target(s)" value={svc.buildTargets ?? ""} onChange={(v) => setSvc({ buildTargets: v })} />
            <Field label="build cmd" value={svc.build === "—" ? "" : svc.build} onChange={(v) => setSvc({ build: v })} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Field label="output artifact" value={svc.artifact ?? ""} onChange={(v) => setSvc({ artifact: v })} />
            <Field label="run command" value={svc.runCmd ?? ""} onChange={(v) => setSvc({ runCmd: v })} />
          </div>

          {/* Port forwarding — expose a locally-running app remotely */}
          <div style={{
            marginTop: 11, borderRadius: "var(--r-md)", padding: "11px 12px",
            border: "1px solid " + (pf.enabled ? "color-mix(in oklch, var(--info), transparent 78%)" : "var(--border-soft)"),
            background: pf.enabled ? "color-mix(in oklch, var(--info), transparent 94%)" : "var(--bg-canvas)",
          }}>
            <Toggle on={pf.enabled} onClick={() => setPf({ enabled: !pf.enabled })}
              label="Port forwarding" value={pf.enabled ? `:${pf.port || "NNNN"} via ${pf.method}` : "expose this app remotely"} />
            {pf.enabled && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Field label="port" value={pf.port} onChange={(v) => setPf({ port: v })} />
                <Select label="method" value={pf.method} options={PORT_FORWARD_METHODS}
                  onChange={(v) => setPf({ method: v as PortForwardMethod })} />
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** The per-repo ship sections (#1421) — every repo owns its OWN pipeline, environments,
 *  config/secrets, and rollout. Rendered inside each {@link RepoDeployCard} once a target is set. */
export function ServiceDeploySections({ svc, setSvc }: {
  svc: DeployService; setSvc: (patch: Partial<DeployService>) => void;
}) {
  const ck = (id: string) => serviceChecks(svc).find((c) => c.id === id)?.ok ?? false;
  return (
    <>
      {/* 2 · CI/CD pipeline */}
      <Card n="02" title="CI / CD pipeline" accent="var(--accent)" done={ck("pipeline")} right={<span style={chip}>{svc.pipeline.provider}</span>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {svc.pipeline.stages.map((st, i) => {
            const isFinal = i === svc.pipeline.stages.length - 1;
            const stageName = isFinal && (["deploy", "publish", "package"] as string[]).includes(st.name) ? finalStageName(svc) : st.name;
            return (
              <div key={st.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "11px 12px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid " + (st.gate ? "var(--accent-dim)" : "var(--border-soft)") }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 99, background: st.gate ? "var(--accent)" : i === 0 ? "var(--info)" : "var(--success)" }} />
                    <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)", textTransform: "uppercase", letterSpacing: ".04em" }}>{stageName}</span>
                    <span style={{ flex: 1 }} />
                    {st.gate && <span style={{ ...chip, fontSize: 7.5, color: "var(--accent)", borderColor: "var(--accent-dim)", background: "color-mix(in oklch, var(--accent), transparent 85%)" }}>⛒ gate</span>}
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)", lineHeight: 1.35 }}>{st.cmd || "—"}</span>
                  <Seg value={st.trigger} options={PIPE_TRIGGERS}
                    onChange={(v) => setSvc({ pipeline: { ...svc.pipeline, stages: svc.pipeline.stages.map((x) => x.id === st.id ? { ...x, trigger: v } : x) } })} />
                </div>
                {i < svc.pipeline.stages.length - 1 && (
                  <span style={{ alignSelf: "center", fontFamily: MONO, fontSize: 13, color: svc.pipeline.stages[i + 1].gate ? "var(--accent)" : "var(--fg-dim)" }}>{svc.pipeline.stages[i + 1].gate ? "⟱" : "↓"}</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* 3 · Environments */}
      <Card n="03" title="Environments" hint="branch → env" done={ck("envs")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {svc.envs.map((e, i) => (
            <div key={e.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 7px", background: e.id === "prod" ? "var(--success)" : "var(--fg-dim)" }} />
                <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)", width: 52 }}>{e.name}</span>
                <span style={{ ...chip, fontSize: 7.5, ...(e.auto ? {} : { color: "var(--accent)", borderColor: "var(--accent-dim)" }) }}>{e.auto ? "auto" : "manual"}</span>
                <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--info)", padding: "1px 6px", borderRadius: 3, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>⎇ {e.branch}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "42%" }}>{e.url || "—"}</span>
              </div>
              {i < svc.envs.length - 1 && <span style={{ alignSelf: "center", fontFamily: MONO, fontSize: 11, color: "var(--fg-dim)" }}>↓</span>}
            </div>
          ))}
        </div>
      </Card>

      {/* 4 · Config & secrets */}
      <Card n="04" title="Config & secrets" hint={svc.config.vault} done={ck("secrets")}>
        {svc.config.config.length === 0 && svc.config.secrets.length === 0 ? (
          <span style={monoSm}>No config or secrets yet — the planner proposes them per environment.</span>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MONO, fontSize: 10.5 }}>
              <thead><tr style={{ color: "var(--fg-dim)", textAlign: "left" }}><th style={{ padding: "3px 6px", fontWeight: 400 }}>variable</th>{svc.envs.map((e) => <th key={e.id} style={{ padding: "3px 6px", fontWeight: 400 }}>{e.name}</th>)}</tr></thead>
              <tbody>
                {svc.config.config.map((row) => (
                  <tr key={row.key} style={{ borderTop: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "4px 6px", color: "var(--fg)" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: "var(--info)", marginRight: 6 }} />{row.key}</td>
                    {svc.envs.map((e) => <td key={e.id} style={{ padding: "4px 6px", color: "var(--fg-muted)" }}>{row[e.id] || "—"}</td>)}
                  </tr>
                ))}
                {svc.config.secrets.map((row) => (
                  <tr key={row.key} style={{ borderTop: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "4px 6px", color: "var(--fg)" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: "var(--violet)", marginRight: 6 }} />{row.key}</td>
                    {svc.envs.map((e) => (
                      <td key={e.id} style={{ padding: "4px 6px" }}>
                        {row[e.id]
                          ? <span style={{ color: "var(--violet)" }}>••••✓</span>
                          : <button onClick={() => setSvc({ config: { ...svc.config, secrets: svc.config.secrets.map((s) => s.key === row.key ? { ...s, [e.id]: true } : s) } })}
                              style={{ padding: "1px 7px", borderRadius: 99, cursor: "pointer", fontFamily: MONO, fontSize: 9, color: "var(--danger)", background: "transparent", border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)" }}>+ wire</button>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)", marginTop: 8 }}>🔒 secret values live in the vault, never here — only wiring state is shown.</div>
          </>
        )}
      </Card>

      {/* Rollout (release strategy + auto-rollback) + a compact health row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "9px 12px", flexWrap: "wrap" }}>
        <span style={{ ...grpLabel }}>rollout</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {RELEASE_STRATEGIES.map((s) => {
            const on = svc.release.strategy === s.id;
            return (
              <button key={s.id} onClick={() => setSvc({ release: { ...svc.release, strategy: s.id as ReleaseStrategy } })} style={{
                fontFamily: MONO, fontSize: 9, padding: "3px 8px", borderRadius: 99, cursor: "pointer",
                background: on ? "color-mix(in oklch, var(--accent), transparent 86%)" : "var(--bg-elev)",
                border: "1px solid " + (on ? "var(--accent)" : "var(--border-soft)"), color: on ? "var(--accent)" : "var(--fg-dim)",
              }}>{s.label}</button>
            );
          })}
        </div>
        <span style={{ flex: 1 }} />
        <Toggle on={svc.release.autoRollback} onClick={() => setSvc({ release: { ...svc.release, autoRollback: !svc.release.autoRollback } })} label="auto-rollback" />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "2px 4px" }}>
        <Toggle on={svc.health.probeOn} onClick={() => setSvc({ health: { ...svc.health, probeOn: !svc.health.probeOn } })} label="health probe" value={svc.health.probe} />
        <Toggle on={svc.release.migrateWithDeploy} onClick={() => setSvc({ release: { ...svc.release, migrateWithDeploy: !svc.release.migrateWithDeploy } })} label="migrate with deploy" />
      </div>
    </>
  );
}

/** One collapsible per-repo deployment card (#1421) — the unit of the new design. Collapsed row =
 *  status · id · target · workload · ready/✓ · chevron; expanded = the target editor + (once a
 *  target is set) the repo's ship sections. `lead` lets the merged Repos & Deployment pane inject
 *  the repo's git identity row. */
export function RepoDeployCard({ svc, setSvc, open, onToggle, lead, primary, meta, trailing }: {
  svc: DeployService; setSvc: (patch: Partial<DeployService>) => void;
  open: boolean; onToggle: () => void; lead?: React.ReactNode;
  /** Mark the project's primary repo (collapsed-row tag). */
  primary?: boolean;
  /** Collapsed-row identity extras shown after the repo name (language · branch · ahead/behind ·
   *  agents) — the merged Repositories & Deployment pane folds the repo's git identity in here. */
  meta?: React.ReactNode;
  /** Collapsed-row trailing slot before the chevron (e.g. the per-repo visibility toggle). */
  trailing?: React.ReactNode;
}) {
  const targeted = serviceTargetDefined(svc);
  const ready = serviceReady(svc);
  const local = serviceMode(svc) === "local";
  const p = svc.platform ? platform(svc.platform) : null;
  const dot = ready ? "var(--success)" : targeted ? "var(--accent)" : "var(--warn)";
  return (
    <div style={{ background: "var(--bg-elev)", border: "1px solid " + (open ? "var(--accent-dim)" : "var(--border-soft)"), borderRadius: "var(--r-lg)", overflow: "hidden" }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 13px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 7px", background: dot, boxShadow: ready ? `0 0 7px color-mix(in oklch, ${dot}, transparent 60%)` : undefined }} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg)" }}>{svc.repo || svc.id}</span>
        {primary && <span style={{ fontFamily: MONO, fontSize: 8, padding: "1px 7px", borderRadius: 99, color: "var(--accent)", border: "1px solid var(--accent-dim)", background: "color-mix(in oklch, var(--accent), transparent 86%)" }}>primary</span>}
        {meta}
        <span style={{ flex: 1 }} />
        {targeted ? (
          <>
            <span style={{ ...chip, color: local ? "var(--violet)" : "var(--accent)", borderColor: local ? "color-mix(in oklch, var(--violet), transparent 60%)" : "var(--accent-dim)", background: `color-mix(in oklch, ${local ? "var(--violet)" : "var(--accent)"}, transparent 86%)` }}>
              {local ? `⬢ ${svc.localKind ?? "local"}` : <>{p && <span style={{ color: `oklch(0.78 0.12 ${p.h})` }}>{p.glyph} </span>}{p?.name}</>}
            </span>
            {!local && <span style={{ ...chip, fontSize: 8, color: WORKLOAD[svc.workload].c, borderColor: `color-mix(in oklch, ${WORKLOAD[svc.workload].c}, transparent 60%)` }}>{WORKLOAD[svc.workload].label}</span>}
            <span style={{ width: 18, height: 18, borderRadius: 99, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: ready ? "var(--success)" : "var(--fg-dim)", background: ready ? "color-mix(in oklch, var(--success), transparent 84%)" : "var(--bg-elev2)" }}>{ready ? "✓" : "·"}</span>
          </>
        ) : (
          <span style={{ ...chip, color: "var(--warn)", borderColor: "color-mix(in oklch, var(--warn), transparent 55%)", background: "transparent", borderStyle: "dashed" }}>set target →</span>
        )}
        {trailing}
        <span style={{ color: "var(--fg-dim)", fontFamily: MONO, fontSize: 11, width: 12, textAlign: "center" }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--border-soft)", padding: "12px 13px", display: "flex", flexDirection: "column", gap: 12 }}>
          {lead}
          <ServiceTargetEditor svc={svc} setSvc={setSvc} />
          {targeted && <ServiceDeploySections svc={svc} setSvc={setSvc} />}
        </div>
      )}
    </div>
  );
}

/** The selected service's target editor (#1192): host/stack meta + the cloud·local mode toggle +
 *  the Cloud or Local body. Extracted (#1399) so the merged Repositories & Deployment pane can
 *  expand it inline under each repo, while the standalone Deploy stage keeps its service tabs. */
export function ServiceTargetEditor({ svc, setSvc }: {
  svc: DeployService; setSvc: (patch: Partial<DeployService>) => void;
}) {
  const mode: DeployMode = serviceMode(svc);
  return (
    <>
      {/* selected service meta */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 11 }}>
        {(() => { const h = hostMeta(svc.host); return (
          <span style={{ ...chip, display: "inline-flex", alignItems: "center", gap: 5, color: h.color }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: h.color }} />{h.domain}
          </span>
        ); })()}
        {hostMeta(svc.host).kind !== "cloud" && (
          <span style={{ ...chip, color: "var(--violet)", borderColor: "color-mix(in oklch, var(--violet), transparent 72%)", background: "color-mix(in oklch, var(--violet), transparent 86%)" }}>self-hosted</span>
        )}
        <span style={{ ...chip, color: "var(--info)" }}>⎇ {svc.repo || "—"}/{svc.path}</span>
        <span style={chip}>{svc.stack}</span>
        <span style={{ flex: 1 }} />
        {svc.proposed && <span style={prop}>✦ proposed</span>}
      </div>

      {/* Cloud · Local mode toggle (#1192) */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
        <span style={grpLabel}>mode</span>
        <Seg<DeployMode> value={mode} options={["cloud", "local"] as const}
          onChange={(v) => setSvc({ mode: v, proposed: false })} />
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)" }}>
          {mode === "cloud" ? "ships to a hosted platform" : "a library or a build-and-run-here app"}
        </span>
      </div>

      {mode === "cloud" ? <CloudBody svc={svc} setSvc={setSvc} /> : <LocalBody svc={svc} setSvc={setSvc} />}
    </>
  );
}

/** Dependencies grouped by the source each package is pulled from (#1127). */
export function DependenciesCard({ deps, registries, done }: {
  deps: PlanDependency[]; registries: Record<string, DependencyRegistry>; done: boolean;
}) {
  const groups = groupDependenciesBySource(deps, registries);
  const ecoColor = (eco: string) => (eco === "cargo" ? "var(--accent)" : "var(--info)");
  const right = (
    <span style={{ ...chip, color: "var(--violet)", borderColor: "color-mix(in oklch, var(--violet), transparent 72%)", background: "color-mix(in oklch, var(--violet), transparent 86%)" }}>
      {deps.length} locked · {groups.length} source{groups.length !== 1 ? "s" : ""}
    </span>
  );
  return (
    <Card n="05" title="Dependencies" accent="var(--violet)" done={done} right={right}>
      {deps.length === 0 ? (
        <span style={monoSm}>No dependencies locked yet — the planner lists each repo&apos;s libraries here as it works this stage. They become each repo&apos;s package.json / Cargo.toml at publish.</span>
      ) : (
        <>
          <div style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)", lineHeight: 1.5, marginBottom: 12 }}>
            Locked once so the parallel fleet never redefines them — grouped by the <span style={{ color: "var(--fg-muted)" }}>source</span> each package is pulled from.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {groups.map((g) => (
              <div key={g.key} style={{
                borderRadius: "var(--r-md)", padding: "10px 11px",
                border: "1px solid " + (g.private ? "color-mix(in oklch, var(--violet), transparent 74%)" : "var(--border-soft)"),
                background: g.private ? "color-mix(in oklch, var(--violet), transparent 93%)" : "var(--bg-canvas)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 11, color: g.private ? "var(--violet)" : "var(--fg-muted)" }}>{g.private ? "⛁" : "◇"}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: g.private ? "var(--violet)" : "var(--fg)" }}>{g.name}</span>
                  <span style={{ ...chip, fontSize: 7.5, ...(g.private ? { color: "var(--violet)", borderColor: "color-mix(in oklch, var(--violet), transparent 72%)", background: "color-mix(in oklch, var(--violet), transparent 86%)" } : {}) }}>{g.private ? "private" : "public · default"}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: MONO, fontSize: 8, color: "var(--fg-dim)" }}>{g.deps.length} package{g.deps.length !== 1 ? "s" : ""}</span>
                </div>
                {g.private ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginTop: 7 }}>
                    <span style={{ fontFamily: MONO, fontSize: 8, color: "var(--fg-muted)" }}>{g.url}</span>
                    {g.scope && <span style={{ ...chip, fontSize: 8, background: "var(--bg-canvas)" }}>scope {g.scope}</span>}
                    <span style={{ flex: 1 }} />
                    {g.auth && <span style={{ ...chip, fontSize: 8, color: "var(--violet)", borderColor: "color-mix(in oklch, var(--violet), transparent 74%)", background: "color-mix(in oklch, var(--violet), transparent 88%)" }}>secret {g.auth}</span>}
                  </div>
                ) : (
                  <div style={{ fontFamily: MONO, fontSize: 8, color: "var(--fg-dim)", marginTop: 4 }}>{g.url}</div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 9 }}>
                  {g.deps.map((dep, i) => (
                    <div key={`${dep.ecosystem}-${dep.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: "var(--r-sm)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>
                      <span style={{ fontFamily: MONO, fontSize: 7.5, color: ecoColor(dep.ecosystem), padding: "1px 5px", borderRadius: 3, border: `1px solid color-mix(in oklch, ${ecoColor(dep.ecosystem)}, transparent 70%)`, flex: "0 0 auto" }}>{dep.ecosystem}</span>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg)", whiteSpace: "nowrap" }}>{dep.name}<span style={{ color: "var(--fg-dim)" }}>{dep.version ? `@${dep.version}` : ""}</span></span>
                      {dep.dev && <span style={{ ...chip, fontSize: 7.5, color: "var(--info)", borderColor: "color-mix(in oklch, var(--info), transparent 74%)", background: "color-mix(in oklch, var(--info), transparent 88%)" }}>dev</span>}
                      <span style={{ flex: 1 }} />
                      <span style={{ fontFamily: MONO, fontSize: 8, color: "var(--fg-dim)", padding: "1px 6px", borderRadius: 3, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "46%" }}>⎇ {dep.repo ?? "all repos"}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 8, color: "var(--fg-dim)", lineHeight: 1.5, marginTop: 11 }}>
            Each source maps to a repo&apos;s <span style={{ color: "var(--fg-muted)" }}>package.json</span> / <span style={{ color: "var(--fg-muted)" }}>Cargo.toml</span>; private sources also write <span style={{ color: "var(--fg-muted)" }}>.npmrc</span> / <span style={{ color: "var(--fg-muted)" }}>.cargo/config.toml</span> with the token from the vault secret.
          </div>
        </>
      )}
    </Card>
  );
}

/** The Deployment pane header — title + the "N of M repos deploy-ready" counter (#1421). */
function DeployHeader({ ready, total }: { ready: number; total: number }) {
  const allReady = total > 0 && ready === total;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 19, height: 19, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--accent)", background: "color-mix(in oklch, var(--accent), transparent 84%)", border: "1px solid var(--accent-dim)" }}>⎇</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>Deployment</span>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-muted)" }}>how each repository ships — defined per repo</span>
      </div>
      <span style={{ flex: 1 }} />
      {total > 0 && (
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: allReady ? "var(--success)" : "var(--fg-muted)" }}>
          <span style={{ color: "var(--fg)" }}>{ready}</span> of {total} repos deploy-ready
        </span>
      )}
    </div>
  );
}

/** The Deployment stage body (#1421) — one collapsible card per repo, each a self-contained
 *  deployable unit (target & build · pipeline · environments · config & secrets · rollout). The
 *  project-wide locked dependency manifest follows as a tail (it gates separately, #1127). */
export function FocusedDeployBody({ deploy, onChange, dependencies = [], registries = {} }: {
  deploy?: DeployConfig;
  onChange?: (next: DeployConfig) => void;
  dependencies?: PlanDependency[];
  registries?: Record<string, DependencyRegistry>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!deploy) {
    return <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg-dim)", padding: "8px 2px" }}>Deployment config loads once the repos are linked.</div>;
  }
  const d = deploy;
  const setSvcFor = (id: string, patch: Partial<DeployService>) =>
    onChange?.({ ...d, services: d.services.map((s) => s.id === id ? { ...s, ...patch } : s) });
  const ready = readyServiceCount(d);
  const depsOk = dependencies.length > 0;

  if (d.services.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <DeployHeader ready={0} total={0} />
        <div style={{ border: "1px dashed var(--border)", borderRadius: "var(--r-lg)", padding: "40px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", background: "var(--bg-canvas)" }}>
          <span style={{ fontSize: 26, opacity: 0.5 }}>⎇</span>
          <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No repositories linked</span>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg-muted)", maxWidth: 380, lineHeight: 1.6 }}>Deployment is configured per repository — each repo carries its own pipeline, environments and secrets. Link one to define how it ships.</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <DeployHeader ready={ready} total={d.services.length} />
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {d.services.map((svc) => (
          <RepoDeployCard key={svc.id} svc={svc} setSvc={(patch) => setSvcFor(svc.id, patch)}
            open={openId === svc.id} onToggle={() => setOpenId((cur) => (cur === svc.id ? null : svc.id))} />
        ))}
      </div>

      {/* The locked dependency manifest is project-wide (#1127) — it gates separately and renders here. */}
      <Divider label="DEPENDENCIES" color="var(--violet)" />
      <DependenciesCard deps={dependencies} registries={registries} done={depsOk} />
    </div>
  );
}
