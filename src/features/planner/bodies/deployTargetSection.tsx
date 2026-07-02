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
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

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
          <Text as="div" style={{ ...grpLabel, marginBottom: 8 }}>platform</Text>
          <Box style={{ position: "relative" }}>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled dropdown trigger button; Button/.btn would change rendering */}
            <button onClick={() => setOpen((v) => !v)} style={{
              width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", cursor: "pointer",
              borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid " + (open ? "var(--accent-dim)" : "var(--border-soft)"),
            }}>
              <Text size={14} style={{ width: 16, textAlign: "center", color: selPlat ? `oklch(0.78 0.12 ${selPlat.h})` : "var(--fg-dim)" }}>{selPlat?.glyph ?? "▢"}</Text>
              <Text mono size={11} style={{ color: selPlat ? "var(--fg)" : "var(--fg-dim)" }}>{selPlat?.name ?? "Select a platform…"}</Text>
              <Box as="span" style={{ flex: 1 }} />
              <Text as="span" style={monoSm}>{PLATFORMS.length} options</Text>
              <Box as="span" style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)", display: "inline-block", transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform .14s" }}>▾</Box>
            </button>
            {open && (
              <Box pad={5} bg="var(--bg-elev)" border radius="md" style={{
                position: "absolute", top: "calc(100% + 5px)", left: 0, right: 0, zIndex: 30, maxHeight: 236, overflowY: "auto", boxShadow: "0 14px 40px rgba(0,0,0,.55)",
              }}>
                {PLATFORMS.map((p) => {
                  const on = svc.platform === p.id;
                  return (
                    // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled dropdown option button; Button/.btn would change rendering
                    <button key={p.id} onClick={() => pickPlatform(p.id)} style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "7px 9px", cursor: "pointer",
                      borderRadius: "var(--r-sm)", border: "1px solid " + (on ? "color-mix(in oklch, var(--accent), transparent 62%)" : "transparent"),
                      background: on ? "color-mix(in oklch, var(--accent), transparent 88%)" : "transparent",
                    }}>
                      <Text size={14} style={{ width: 18, textAlign: "center", color: `oklch(0.78 0.12 ${p.h})` }}>{p.glyph}</Text>
                      <Text mono size={10.5} style={{ color: on ? "var(--fg)" : "var(--fg-muted)" }}>{p.name}</Text>
                      <Box as="span" pad={[1, 6]} border="soft" radius={99} style={{ fontFamily: MONO, fontSize: 8, color: "var(--fg-dim)"}}>{p.kinds.join(" · ")}</Box>
                      <Box as="span" style={{ flex: 1 }} />
                      {on && <Text mono size={10} tone="accent">✓</Text>}
                    </button>
                  );
                })}
              </Box>
            )}
          </Box>

          {svc.platform ? (
            <>
              {/* workload */}
              <Row gap={7} wrap align="stretch" style={{ margin: "11px 0" }}>
                {platform(svc.platform).kinds.map((k) => {
                  const on = svc.workload === k;
                  return (
                    // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled pill toggle button; Button/.btn would change rendering
                    <button key={k} onClick={() => setSvc({ workload: k })} style={{
                      padding: "2px 9px", borderRadius: 99, cursor: "pointer", fontFamily: MONO, fontSize: 9.5,
                      border: "1px solid " + (on ? WORKLOAD[k].c : "var(--border-soft)"), color: on ? WORKLOAD[k].c : "var(--fg-dim)", background: "transparent",
                    }}>{WORKLOAD[k].label}</button>
                  );
                })}
              </Row>
              {/* fields */}
              <Row gap={8} align="stretch">
                <Field label="region" value={svc.region} onChange={(v) => setSvc({ region: v })} />
                <Field label={isContainer ? "image" : "build cmd"} value={svc.build} onChange={(v) => setSvc({ build: v })} />
                {isContainer
                  ? <Field label="runtime" value={svc.runtime} onChange={(v) => setSvc({ runtime: v })} />
                  : <Field label="output dir" value={svc.output} onChange={(v) => setSvc({ output: v })} />}
              </Row>

              {/* containerization & orchestration */}
              <Box pad={[11, 12]} bg={isContainer ? "color-mix(in oklch, var(--violet), transparent 95%)" : "var(--bg-canvas)"} radius="md" style={{
                marginTop: 11,
                border: "1px solid " + (isContainer ? "color-mix(in oklch, var(--violet), transparent 80%)" : "var(--border-soft)"),
              }}>
                <Row gap={7} style={{ marginBottom: isContainer ? 10 : 0 }}>
                  <Text size={11} style={{ color: isContainer ? "var(--violet)" : "var(--fg-dim)" }}>⬢</Text>
                  <Text mono size={9.5} style={{ color: "var(--fg)" }}>Containerization &amp; orchestration</Text>
                  <Spacer />
                  {isContainer
                    ? <Box as="span" style={{ ...chip, fontSize: 7.5, color: "var(--violet)", borderColor: "color-mix(in oklch, var(--violet), transparent 72%)", background: "color-mix(in oklch, var(--violet), transparent 86%)" }}>distributed</Box>
                    : <Box as="span" style={{ ...chip, fontSize: 7.5 }}>{WORKLOAD[svc.workload].label}</Box>}
                </Row>
                {isContainer ? (
                  <>
                    <Grid cols={2} gap={8} style={{ marginBottom: 10 }}>
                      <Stack gap={4}>
                        <Text as="span" style={grpLabel}>engine · image</Text>
                        <Box as="span" pad={[5, 8]} bg="var(--bg-elev)" border="soft" radius="sm" style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Docker · {svc.runtime && svc.runtime !== "—" ? svc.runtime : "base image"}</Box>
                      </Stack>
                      <Field label="image registry" value={svc.registry ?? (svc.repo ? `ghcr.io/${svc.repo}` : "")} onChange={(v) => setSvc({ registry: v })} />
                    </Grid>
                    <Row gap={8} style={{ marginBottom: 9 }}>
                      <Text as="span" style={{ ...grpLabel, flex: "0 0 62px" }}>orchestrator</Text>
                      <Seg value={svc.orchestrator ?? "k8s"} options={ORCHESTRATORS.map((o) => o.id)} onChange={(v) => setSvc({ orchestrator: v })} />
                    </Row>
                    <Row gap={8}>
                      <Text as="span" style={{ ...grpLabel, flex: "0 0 62px" }}>replicas</Text>
                      <Seg value={svc.replicas ?? "3"} options={REPLICA_OPTIONS} onChange={(v) => setSvc({ replicas: v })} />
                      <Spacer />
                      <Text mono size={8} tone="dim">nodes share the workload</Text>
                    </Row>
                  </>
                ) : (
                  <Row gap={9} style={{ marginTop: 9 }}>
                    <Text mono size={9} tone="dim" style={{ lineHeight: 1.45, flex: 1 }}>
                      Not containerized — this <b style={{ color: "var(--fg-muted)" }}>{WORKLOAD[svc.workload].label}</b> service deploys without a container image or orchestrator.
                    </Text>
                    {canContainerize && (
                      // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled pill CTA button; Button/.btn would change rendering
                      <button onClick={() => setSvc({ workload: "container" })} style={{
                        fontFamily: MONO, fontSize: 8.5, color: "var(--violet)", padding: "4px 10px", borderRadius: 99, cursor: "pointer", whiteSpace: "nowrap", flex: "0 0 auto",
                        background: "color-mix(in oklch, var(--violet), transparent 88%)", border: "1px solid color-mix(in oklch, var(--violet), transparent 72%)",
                      }}>containerize →</button>
                    )}
                  </Row>
                )}
              </Box>
            </>
          ) : (
            <Row gap={8} style={{ marginTop: 13, border: "1px dashed color-mix(in oklch, var(--accent), transparent 60%)", borderRadius: "var(--r-md)", padding: "11px 13px", fontFamily: MONO, fontSize: 10, color: "var(--accent)", background: "color-mix(in oklch, var(--accent), transparent 93%)" }}>
              <Text>↑</Text><Text>no target for <b>{svc.id}</b> yet — choose a platform from the list above</Text>
            </Row>
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
      <Text as="div" style={{ ...grpLabel, marginBottom: 8 }}>kind</Text>
      <Box style={{ marginBottom: 11 }}>
        <Seg<LocalKind> value={kind} options={["library", "application"] as const}
          onChange={(v) => setSvc({ localKind: v, proposed: false })} />
      </Box>

      {kind === "library" ? (
        <>
          <Row gap={8} align="stretch" style={{ marginBottom: 9 }}>
            <Select label="publish registry" value={svc.publishRegistry ?? ""} options={PUBLISH_REGISTRIES}
              onChange={(v) => setSvc({ publishRegistry: v as PublishRegistry })} />
            <Field label="package name" value={svc.packageName ?? ""} onChange={(v) => setSvc({ packageName: v })} />
          </Row>
          <Row gap={8} align="stretch">
            <Field label="build cmd" value={svc.build === "—" ? "" : svc.build} onChange={(v) => setSvc({ build: v })} />
            <Select label="publish trigger" value={svc.publishTrigger ?? ""} options={PUBLISH_TRIGGERS}
              onChange={(v) => setSvc({ publishTrigger: v as PublishTrigger })} />
          </Row>
        </>
      ) : (
        <>
          <Row gap={8} align="stretch" style={{ marginBottom: 9 }}>
            <Field label="build target(s)" value={svc.buildTargets ?? ""} onChange={(v) => setSvc({ buildTargets: v })} />
            <Field label="build cmd" value={svc.build === "—" ? "" : svc.build} onChange={(v) => setSvc({ build: v })} />
          </Row>
          <Row gap={8} align="stretch">
            <Field label="output artifact" value={svc.artifact ?? ""} onChange={(v) => setSvc({ artifact: v })} />
            <Field label="run command" value={svc.runCmd ?? ""} onChange={(v) => setSvc({ runCmd: v })} />
          </Row>

          {/* Port forwarding — expose a locally-running app remotely */}
          <Box pad={[11, 12]} bg={pf.enabled ? "color-mix(in oklch, var(--info), transparent 94%)" : "var(--bg-canvas)"} radius="md" style={{
            marginTop: 11,
            border: "1px solid " + (pf.enabled ? "color-mix(in oklch, var(--info), transparent 78%)" : "var(--border-soft)"),
          }}>
            <Toggle on={pf.enabled} onClick={() => setPf({ enabled: !pf.enabled })}
              label="Port forwarding" value={pf.enabled ? `:${pf.port || "NNNN"} via ${pf.method}` : "expose this app remotely"} />
            {pf.enabled && (
              <Row gap={8} align="stretch" style={{ marginTop: 10 }}>
                <Field label="port" value={pf.port} onChange={(v) => setPf({ port: v })} />
                <Select label="method" value={pf.method} options={PORT_FORWARD_METHODS}
                  onChange={(v) => setPf({ method: v as PortForwardMethod })} />
              </Row>
            )}
          </Box>
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
      <Row gap={7} wrap>
        {(() => { const h = hostMeta(svc.host); return (
          <Box as="span" style={{ ...chip, display: "inline-flex", alignItems: "center", gap: 5, color: h.color }}>
            <Box as="span" bg={h.color} radius={99} style={{ width: 6, height: 6}} />{h.domain}
          </Box>
        ); })()}
        {hostMeta(svc.host).kind !== "cloud" && (
          <Box as="span" style={{ ...chip, color: "var(--violet)", borderColor: "color-mix(in oklch, var(--violet), transparent 72%)", background: "color-mix(in oklch, var(--violet), transparent 86%)" }}>self-hosted</Box>
        )}
        <Box as="span" style={{ ...chip, color: "var(--info)" }}>⎇ {svc.repo || "—"}/{svc.path}</Box>
        <Box as="span" style={chip}>{svc.stack}</Box>
        <Spacer />
        {svc.proposed && <Box as="span" style={prop}>✦ proposed</Box>}
      </Row>

      {/* 01 · Target & build — mode + platform/region/build (+ containerization for cloud). Starts
          open only while no target is set, so an unconfigured repo surfaces the picker immediately. */}
      <Card n="01" title="Target & build" hint={targetHint} done={targeted} defaultOpen={!targeted}>
        {/* Cloud · Local mode toggle (#1192) */}
        <Row gap={9} style={{ marginBottom: 12 }}>
          <Text as="span" style={grpLabel}>mode</Text>
          <Seg<DeployMode> value={mode} options={["cloud", "local"] as const}
            onChange={(v) => setSvc({ mode: v, proposed: false })} />
          <Spacer />
          <Text mono size={8.5} tone="dim">
            {mode === "cloud" ? "ships to a hosted platform" : "a library or a build-and-run-here app"}
          </Text>
        </Row>

        {mode === "cloud" ? <CloudBody svc={svc} setSvc={setSvc} /> : <LocalBody svc={svc} setSvc={setSvc} />}
      </Card>
    </>
  );
}
