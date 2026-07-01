// The Deploy stage's target editor (#1636) — extracted verbatim from DeployView.tsx. Owns the
// per-repo TARGET selection: the host/stack meta row, the Cloud · Local mode toggle, and the two
// bodies behind it — CloudBody (platform dropdown → workload → region/build/runtime → container
// orchestration) and LocalBody (a Library publish or a build-and-run-here Application + optional
// port-forward). Behavior-preserving move; no markup/style/handler changes.

import { useState } from "react";
import {
  PLATFORMS, platform, WORKLOAD, ORCHESTRATORS, REPLICA_OPTIONS,
  PUBLISH_REGISTRIES, PUBLISH_TRIGGERS, PORT_FORWARD_METHODS,
  hostMeta, serviceMode, serviceTargetDefined,
  type DeployService, type Workload,
  type DeployMode, type LocalKind, type PublishRegistry, type PublishTrigger, type PortForwardMethod,
} from "../lib/deployConfig";
import { MONO, grpLabel, monoSm } from "./bodyStyles";
import { prop, chip, Card, Seg, Field, Toggle, Select } from "./deployPrimitives";

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

/** The selected service's target editor (#1192): host/stack meta + the cloud·local mode toggle +
 *  the Cloud or Local body. Extracted (#1399) so the merged Repositories & Deployment pane can
 *  expand it inline under each repo, while the standalone Deploy stage keeps its service tabs. */
export function ServiceTargetEditor({ svc, setSvc }: {
  svc: DeployService; setSvc: (patch: Partial<DeployService>) => void;
}) {
  const mode: DeployMode = serviceMode(svc);
  const targeted = serviceTargetDefined(svc);
  // Collapsed-header summary of the chosen target (platform / local kind), or a prompt when unset.
  const targetHint = targeted
    ? (mode === "local" ? (svc.localKind ?? "local") : (platform(svc.platform).name || "target set"))
    : "not set";
  return (
    <>
      {/* selected service meta — bare identity line (#1421 follow-up, 1a): what this repo IS, not a
          config field, so it stays above the numbered cards rather than inside one. */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
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

      {/* 01 · Target & build — mode + platform/region/build (+ containerization for cloud). Starts
          open only while no target is set, so an unconfigured repo surfaces the picker immediately. */}
      <Card n="01" title="Target & build" hint={targetHint} done={targeted} defaultOpen={!targeted}>
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
      </Card>
    </>
  );
}
