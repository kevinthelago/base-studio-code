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
  hostMeta, deployChecks, deployIssues, serviceMode, finalStageName,
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

/** Target & hosting — service tabs (host badge + status dot), a Cloud · Local mode toggle (#1192),
 *  then either the cloud platform card or the local library/application card. */
function TargetCard({ d, svc, set, setSvc, done }: {
  d: DeployConfig; svc: DeployService | undefined;
  set: (patch: Partial<DeployConfig>) => void; setSvc: (patch: Partial<DeployService>) => void; done: boolean;
}) {
  const right = <span style={monoSm}>{d.services.length} service{d.services.length !== 1 ? "s" : ""}</span>;
  return (
    <Card n="01" title="Target & hosting" hint="per service" right={right} done={done}>
      {/* service tabs */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 11 }}>
        {d.services.map((s) => {
          const p = platform(s.platform);
          const on = svc && s.id === svc.id;
          const host = hostMeta(s.host);
          const local = serviceMode(s) === "local";
          const sub = local
            ? (s.localKind === "library" ? `⬢ library${s.publishRegistry ? ` · ${s.publishRegistry}` : ""}` : `⬢ app${s.buildTargets ? ` · ${s.buildTargets}` : ""}`)
            : (s.platform ? `${p.glyph} ${p.name}` : "no target yet");
          const targeted = local
            ? (s.localKind === "library" ? !!s.publishRegistry && !!s.packageName?.trim() : !!s.buildTargets?.trim() && !!s.artifact?.trim())
            : !!s.platform;
          return (
            <button key={s.id} onClick={() => set({ selService: s.id })} style={{
              flex: 1, minWidth: 120, display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start", padding: "8px 11px", cursor: "pointer",
              borderRadius: "var(--r-md)", border: "1px solid " + (on ? "var(--accent-dim)" : "var(--border-soft)"),
              background: on ? "color-mix(in oklch, var(--accent), transparent 90%)" : "var(--bg-elev)",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg)" }}>{s.id}</span>
                <span style={{ flex: 1 }} />
                <span style={{ width: 6, height: 6, borderRadius: 99, background: targeted ? "var(--success)" : "var(--fg-dim)" }} />
              </span>
              <span style={{ fontFamily: MONO, fontSize: 9, color: on ? "var(--accent)" : "var(--fg-dim)" }}>{sub}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: MONO, fontSize: 8, color: local ? "var(--violet)" : host.color }}>
                <span style={{ width: 5, height: 5, borderRadius: 99, background: local ? "var(--violet)" : host.color }} />{local ? "local" : host.domain}
              </span>
            </button>
          );
        })}
      </div>

      {svc && <ServiceTargetEditor svc={svc} setSvc={setSvc} />}
    </Card>
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
function DependenciesCard({ deps, registries, done }: {
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

export function FocusedDeployBody({ deploy, onChange, dependencies = [], registries = {}, view = "full" }: {
  deploy?: DeployConfig;
  onChange?: (next: DeployConfig) => void;
  dependencies?: PlanDependency[];
  registries?: Record<string, DependencyRegistry>;
  /** "full" — the standalone Deploy stage (banner + Target & hosting card + the rest). "tail" —
   *  the merged Repositories & Deployment pane (#1399) renders the header + repo-target card itself,
   *  so this skips the readiness banner, the "HOW IT SHIPS" divider, and the Target card, picking up
   *  at the CI/CD pipeline. The shared `deploy.selService` keeps both halves in sync. */
  view?: "full" | "tail";
}) {
  if (!deploy) {
    return <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg-dim)", padding: "8px 2px" }}>Deployment config loads once the repos are linked.</div>;
  }
  const d = deploy;
  const set = (patch: Partial<DeployConfig>) => onChange?.({ ...d, ...patch });
  const svc = d.services.find((s) => s.id === d.selService) ?? d.services[0];
  const setSvc = (patch: Partial<DeployService>) => svc && set({ services: d.services.map((s) => s.id === svc.id ? { ...s, ...patch } : s) });

  const checks = deployChecks(d);
  const ck = (id: string) => checks.find((c) => c.id === id)?.ok ?? false;
  const ready = checks.filter((c) => c.ok).length;
  // The Deploy GATE needs both shipping AND ≥1 locked dependency (#1127).
  const depsOk = dependencies.length > 0;
  const allReady = ready === checks.length && depsOk;
  const missing = [...checks.filter((c) => !c.ok).map((c) => c.id), ...(depsOk ? [] : ["dependencies"])];
  const issues = deployIssues(d);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {view === "full" && (
        <>
          {/* readiness banner */}
          <div style={{
            display: "flex", alignItems: "center", gap: 9, padding: "9px 13px", borderRadius: "var(--r-md)",
            background: `color-mix(in oklch, ${allReady ? "var(--success)" : "var(--accent)"}, transparent 90%)`,
            border: `1px solid color-mix(in oklch, ${allReady ? "var(--success)" : "var(--accent)"}, transparent 72%)`,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: allReady ? "var(--success)" : "var(--accent)" }} />
            <span style={{ fontFamily: MONO, fontSize: 11, color: allReady ? "var(--success)" : "var(--accent)" }}>{allReady ? "Ready to ship" : `${ready}/${checks.length} defined`}</span>
            <span style={{ flex: 1 }} />
            <span style={monoSm}>{allReady ? "deployment issues ready to generate" : "missing: " + missing.join(", ")}</span>
          </div>

          {/* ───────── A · HOW IT SHIPS ───────── */}
          <Divider label="A · HOW IT SHIPS" color="var(--accent)" />

          <TargetCard d={d} svc={svc} set={set} setSvc={setSvc} done={ck("target")} />
        </>
      )}

      {/* CI/CD pipeline */}
      <Card n="02" title="CI / CD pipeline" accent="var(--accent)" done={ck("pipeline")}
        right={<span style={chip}>{d.pipeline.provider}</span>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {d.pipeline.stages.map((st, i) => {
            // The final stage's label adapts to the selected service's mode (#1192) when it's a
            // default ship-stage name; a planner-renamed stage is shown verbatim.
            const isFinal = i === d.pipeline.stages.length - 1;
            const stageName = isFinal && (["deploy", "publish", "package"] as string[]).includes(st.name)
              ? finalStageName(svc) : st.name;
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
                  onChange={(v) => set({ pipeline: { ...d.pipeline, stages: d.pipeline.stages.map((x) => x.id === st.id ? { ...x, trigger: v } : x) } })} />
              </div>
              {i < d.pipeline.stages.length - 1 && (
                <span style={{ alignSelf: "center", fontFamily: MONO, fontSize: 13, color: d.pipeline.stages[i + 1].gate ? "var(--accent)" : "var(--fg-dim)" }}>{d.pipeline.stages[i + 1].gate ? "⟱" : "↓"}</span>
              )}
            </div>
          );
          })}
        </div>
      </Card>

      {/* Environments */}
      <Card n="03" title="Environments" hint="branch → env" done={ck("envs")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {d.envs.map((e, i) => (
            <div key={e.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 7px", background: e.id === "prod" ? "var(--success)" : "var(--fg-dim)" }} />
                <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)", width: 52 }}>{e.name}</span>
                <span style={{ ...chip, fontSize: 7.5, ...(e.auto ? {} : { color: "var(--accent)", borderColor: "var(--accent-dim)" }) }}>{e.auto ? "auto" : "manual"}</span>
                <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--info)", padding: "1px 6px", borderRadius: 3, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>⎇ {e.branch}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "42%" }}>{e.url || "—"}</span>
              </div>
              {i < d.envs.length - 1 && <span style={{ alignSelf: "center", fontFamily: MONO, fontSize: 11, color: "var(--fg-dim)" }}>↓</span>}
            </div>
          ))}
        </div>
      </Card>

      {/* Config & secrets */}
      <Card n="04" title="Config & secrets" hint={d.config.vault} done={ck("secrets")}>
        {d.config.config.length === 0 && d.config.secrets.length === 0 ? (
          <span style={monoSm}>No config or secrets yet — the planner proposes them per environment.</span>
        ) : (
          <>
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
                    <td style={{ padding: "4px 6px", color: "var(--fg)" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: "var(--violet)", marginRight: 6 }} />{row.key}</td>
                    {d.envs.map((e) => (
                      <td key={e.id} style={{ padding: "4px 6px" }}>
                        {row[e.id]
                          ? <span style={{ color: "var(--violet)" }}>••••✓</span>
                          : <button onClick={() => set({ config: { ...d.config, secrets: d.config.secrets.map((s) => s.key === row.key ? { ...s, [e.id]: true } : s) } })}
                              style={{ padding: "1px 7px", borderRadius: 99, cursor: "pointer", fontFamily: MONO, fontSize: 9, color: "var(--danger)", background: "transparent", border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)" }}>+ wire</button>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10, fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>
              <span><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, marginRight: 5, background: "var(--info)" }} />config</span>
              <span><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, marginRight: 5, background: "var(--violet)" }} />secret</span>
              <span style={{ flex: 1 }} />
              <span>values live in the vault, never here</span>
            </div>
          </>
        )}
      </Card>

      {/* ───────── B · WHAT IT DEPENDS ON ───────── */}
      <Divider label="B · WHAT IT DEPENDS ON" color="var(--violet)" />
      <DependenciesCard deps={dependencies} registries={registries} done={depsOk} />

      {/* ───────── C · RELEASE & HEALTH ───────── */}
      <Divider label="C · RELEASE & HEALTH" color="var(--fg-muted)" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
        <Card n="06" title="Release" done={ck("release")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 11 }}>
            {RELEASE_STRATEGIES.map((s) => {
              const on = d.release.strategy === s.id;
              return (
                <button key={s.id} onClick={() => set({ release: { ...d.release, strategy: s.id as ReleaseStrategy } })} style={{
                  fontFamily: MONO, fontSize: 9, padding: "3px 8px", borderRadius: 99, cursor: "pointer",
                  background: on ? "color-mix(in oklch, var(--accent), transparent 86%)" : "var(--bg-elev)",
                  border: "1px solid " + (on ? "var(--accent)" : "var(--border-soft)"), color: on ? "var(--accent)" : "var(--fg-dim)",
                }}>{s.label}</button>
              );
            })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Toggle on={d.release.autoRollback} onClick={() => set({ release: { ...d.release, autoRollback: !d.release.autoRollback } })} label="Auto-rollback on failed health check" />
            <Toggle on={d.release.migrateWithDeploy} onClick={() => set({ release: { ...d.release, migrateWithDeploy: !d.release.migrateWithDeploy } })} label="Run migrations with deploy" />
          </div>
        </Card>
        <Card n="07" title="Health" done>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Toggle on={d.health.probeOn} onClick={() => set({ health: { ...d.health, probeOn: !d.health.probeOn } })} label="Health probe" value={d.health.probe} />
            <Toggle on={d.health.sloOn} onClick={() => set({ health: { ...d.health, sloOn: !d.health.sloOn } })} label="SLO / uptime" value={d.health.slo || "—"} />
            <Toggle on={d.health.alertsOn} onClick={() => set({ health: { ...d.health, alertsOn: !d.health.alertsOn } })} label="Alerts route to" value={d.health.alerts || "—"} />
          </div>
        </Card>
      </div>

      {/* ───────── D · READINESS ───────── */}
      <Divider label="D · READINESS" color="var(--fg-muted)" />
      <div style={{ borderRadius: "var(--r-lg)", border: "1px solid var(--border-soft)", background: "var(--bg-canvas)", padding: "13px 14px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 14 }}>
          {checks.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: "var(--r-sm)", background: "var(--bg-elev)" }}>
              <span style={{ width: 15, textAlign: "center", fontFamily: MONO, fontSize: 11, color: c.ok ? "var(--success)" : "var(--fg-dim)" }}>{c.ok ? "✓" : "○"}</span>
              <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: c.ok ? "var(--fg)" : "var(--fg-muted)" }}>{c.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 9, color: c.ok ? "var(--fg-muted)" : "var(--fg-dim)" }}>{c.detail}</span>
            </div>
          ))}
          {/* dependencies isn't in deployChecks (it gates separately, #1127) — show it here too */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: "var(--r-sm)", background: "var(--bg-elev)" }}>
            <span style={{ width: 15, textAlign: "center", fontFamily: MONO, fontSize: 11, color: depsOk ? "var(--success)" : "var(--fg-dim)" }}>{depsOk ? "✓" : "○"}</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: depsOk ? "var(--fg)" : "var(--fg-muted)" }}>Dependencies locked</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: MONO, fontSize: 9, color: depsOk ? "var(--fg-muted)" : "var(--fg-dim)" }}>{depsOk ? `${dependencies.length} locked` : "none yet"}</span>
          </div>
        </div>
        <div style={{ ...grpLabel, marginBottom: 9, display: "flex", alignItems: "center", gap: 6 }}>
          deployment issues at publish
          <span style={{ flex: 1 }} />
          <span style={{ textTransform: "none", letterSpacing: 0 }}>stream</span>
          <span style={{ ...chip, color: "var(--accent)", borderColor: "var(--accent-dim)", background: "color-mix(in oklch, var(--accent), transparent 86%)" }}>deploy</span>
        </div>
        {issues.length === 0 ? (
          <span style={monoSm}>Issues generate once a deploy target is set — one workflow per service, env provisioning, secret wiring, and a prod health check.</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {issues.map((iss, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: "var(--r-sm)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>
                <span style={{ fontFamily: MONO, fontSize: 11, color: iss.blocking ? "var(--fg-dim)" : "var(--success)" }}>＋</span>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: iss.blocking ? "var(--fg-muted)" : "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{iss.text}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: MONO, fontSize: 7.5, padding: "1px 6px", borderRadius: 99, background: "var(--bg-canvas)",
                  color: iss.blocking ? "var(--danger)" : "var(--fg-dim)",
                  border: "1px solid " + (iss.blocking ? "color-mix(in oklch, var(--danger), transparent 60%)" : "var(--border-soft)") }}>{iss.blocking ? "blocking" : iss.tag}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
