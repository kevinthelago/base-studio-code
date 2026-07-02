// The Deploy stage's per-repo "ship" sections (#1636) — extracted verbatim from DeployView.tsx.
// Every repo owns its OWN CI/CD pipeline, environments, config/secrets, and rollout+health; this
// renders them inside an expanded RepoDeployCard once a target is set. Behavior-preserving move.

import {
  PIPE_TRIGGERS, RELEASE_STRATEGIES,
  serviceChecks, finalStageName, serviceMode,
  type DeployService, type ReleaseStrategy,
} from "../lib/deployConfig";
import { MONO, grpLabel, monoSm } from "./bodyStyles";
import { chip, Card, Seg, Toggle } from "./deployPrimitives";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

/** The per-repo ship sections (#1421) — every repo owns its OWN pipeline, environments,
 *  config/secrets, and rollout. Rendered inside each {@link RepoDeployCard} once a target is set. */
export function ServiceDeploySections({ svc, setSvc }: {
  svc: DeployService; setSvc: (patch: Partial<DeployService>) => void;
}) {
  const ck = (id: string) => serviceChecks(svc).find((c) => c.id === id)?.ok ?? false;
  return (
    <>
      {/* 2 · CI/CD pipeline */}
      <Card n="02" title="CI / CD pipeline" accent="var(--accent)" done={ck("pipeline")} right={<Text as="span" style={chip}>{svc.pipeline.provider}</Text>}>
        <Stack gap={6}>
          {svc.pipeline.stages.map((st, i) => {
            const isFinal = i === svc.pipeline.stages.length - 1;
            const stageName = isFinal && (["deploy", "publish", "package"] as string[]).includes(st.name) ? finalStageName(svc) : st.name;
            return (
              <Stack key={st.id} gap={6}>
                <Stack gap={8} style={{ padding: "11px 12px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid " + (st.gate ? "var(--accent-dim)" : "var(--border-soft)") }}>
                  <Row gap={6}>
                    <Box as="span" style={{ width: 7, height: 7, borderRadius: 99, background: st.gate ? "var(--accent)" : i === 0 ? "var(--info)" : "var(--success)" }} />
                    <Text as="span" mono size={11} style={{ color: "var(--fg)", textTransform: "uppercase", letterSpacing: ".04em" }}>{stageName}</Text>
                    <Spacer />
                    {st.gate && <Box as="span" style={{ ...chip, fontSize: 7.5, color: "var(--accent)", borderColor: "var(--accent-dim)", background: "color-mix(in oklch, var(--accent), transparent 85%)" }}>⛒ gate</Box>}
                  </Row>
                  <Text as="span" mono size={8.5} tone="dim" style={{ lineHeight: 1.35 }}>{st.cmd || "—"}</Text>
                  <Seg value={st.trigger} options={PIPE_TRIGGERS}
                    onChange={(v) => setSvc({ pipeline: { ...svc.pipeline, stages: svc.pipeline.stages.map((x) => x.id === st.id ? { ...x, trigger: v } : x) } })} />
                </Stack>
                {i < svc.pipeline.stages.length - 1 && (
                  <Text as="span" mono size={13} style={{ alignSelf: "center", color: svc.pipeline.stages[i + 1].gate ? "var(--accent)" : "var(--fg-dim)" }}>{svc.pipeline.stages[i + 1].gate ? "⟱" : "↓"}</Text>
                )}
              </Stack>
            );
          })}
        </Stack>
      </Card>

      {/* 3 · Environments */}
      <Card n="03" title="Environments" hint="branch → env" done={ck("envs")}>
        <Stack gap={6}>
          {svc.envs.map((e, i) => (
            <Stack key={e.id} gap={6}>
              <Row gap={9} style={{ padding: "9px 11px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>
                <Box as="span" style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 7px", background: e.id === "prod" ? "var(--success)" : "var(--fg-dim)" }} />
                <Text as="span" mono size={11} style={{ color: "var(--fg)", width: 52 }}>{e.name}</Text>
                <Box as="span" style={{ ...chip, fontSize: 7.5, ...(e.auto ? {} : { color: "var(--accent)", borderColor: "var(--accent-dim)" }) }}>{e.auto ? "auto" : "manual"}</Box>
                <Box as="span" style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--info)", padding: "1px 6px", borderRadius: 3, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>⎇ {e.branch}</Box>
                <Spacer />
                <Text as="span" mono size={8.5} tone="dim" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "42%" }}>{e.url || "—"}</Text>
              </Row>
              {i < svc.envs.length - 1 && <Text as="span" mono size={11} tone="dim" style={{ alignSelf: "center" }}>↓</Text>}
            </Stack>
          ))}
        </Stack>
      </Card>

      {/* 4 · Config & secrets */}
      <Card n="04" title="Config & secrets" hint={svc.config.vault} done={ck("secrets")}>
        {svc.config.config.length === 0 && svc.config.secrets.length === 0 ? (
          <Text as="span" style={monoSm}>No config or secrets yet — the planner proposes them per environment.</Text>
        ) : (
          <>
            {/* Horizontal scroll so long values / many env columns scroll WITHIN the card instead of
                overflowing the pane (#1421 follow-up); the table keeps a readable minimum width. */}
            <Box style={{ overflowX: "auto", margin: "0 -2px" }}>
            <table style={{ minWidth: 320, width: "100%", borderCollapse: "collapse", fontFamily: MONO, fontSize: 10.5 }}>
              <thead><tr style={{ color: "var(--fg-dim)", textAlign: "left" }}><th style={{ padding: "3px 6px", fontWeight: 400 }}>variable</th>{svc.envs.map((e) => <th key={e.id} style={{ padding: "3px 6px", fontWeight: 400 }}>{e.name}</th>)}</tr></thead>
              <tbody>
                {svc.config.config.map((row) => (
                  <tr key={row.key} style={{ borderTop: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "4px 6px", color: "var(--fg)" }}><Box as="span" style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: "var(--info)", marginRight: 6 }} />{row.key}</td>
                    {svc.envs.map((e) => <td key={e.id} title={row[e.id] || undefined} style={{ padding: "4px 6px", color: "var(--fg-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row[e.id] || "—"}</td>)}
                  </tr>
                ))}
                {svc.config.secrets.map((row) => (
                  <tr key={row.key} style={{ borderTop: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "4px 6px", color: "var(--fg)" }}><Box as="span" style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: "var(--violet)", marginRight: 6 }} />{row.key}</td>
                    {svc.envs.map((e) => (
                      <td key={e.id} style={{ padding: "4px 6px" }}>
                        {row[e.id]
                          ? <Text as="span" style={{ color: "var(--violet)" }}>••••✓</Text>
                          // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled pill button in a table cell; Button/.btn would change rendering
                          : <button onClick={() => setSvc({ config: { ...svc.config, secrets: svc.config.secrets.map((s) => s.key === row.key ? { ...s, [e.id]: true } : s) } })}
                              style={{ padding: "1px 7px", borderRadius: 99, cursor: "pointer", fontFamily: MONO, fontSize: 9, color: "var(--danger)", background: "transparent", border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)" }}>+ wire</button>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            </Box>
            <Text as="div" mono size={9} tone="dim" style={{ marginTop: 8 }}>🔒 secret values live in the vault, never here — only wiring state is shown.</Text>
          </>
        )}
      </Card>

      {/* 5 · Rollout & health — CLOUD ONLY (#2023): the rollout strategy (recreate/rolling/blue-green/
          canary), health probe, and migrate-with-deploy are running-cloud-service concerns; a local
          build (library publish / application package) ships via its pipeline's publish/package stage,
          so this card is hidden for local mode. Boxed as a collapsible card like the others (#1421). */}
      {serviceMode(svc) === "cloud" && (
        <Card n="05" title="Rollout & health" hint={svc.release.strategy || undefined} done={ck("release")}>
          <Stack gap={12}>
          <Row gap={10} wrap>
            <Text as="span" style={{ ...grpLabel }}>rollout</Text>
            <Row wrap gap={5} align="stretch">
              {RELEASE_STRATEGIES.map((s) => {
                const on = svc.release.strategy === s.id;
                return (
                  // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled pill toggle button; Button/.btn would change rendering
                  <button key={s.id} onClick={() => setSvc({ release: { ...svc.release, strategy: s.id as ReleaseStrategy } })} style={{
                    fontFamily: MONO, fontSize: 9, padding: "3px 8px", borderRadius: 99, cursor: "pointer",
                    background: on ? "color-mix(in oklch, var(--accent), transparent 86%)" : "var(--bg-elev)",
                    border: "1px solid " + (on ? "var(--accent)" : "var(--border-soft)"), color: on ? "var(--accent)" : "var(--fg-dim)",
                  }}>{s.label}</button>
                );
              })}
            </Row>
            <Spacer />
            <Toggle on={svc.release.autoRollback} onClick={() => setSvc({ release: { ...svc.release, autoRollback: !svc.release.autoRollback } })} label="auto-rollback" />
          </Row>
          <Row wrap gap={14} align="stretch">
            <Toggle on={svc.health.probeOn} onClick={() => setSvc({ health: { ...svc.health, probeOn: !svc.health.probeOn } })} label="health probe" value={svc.health.probe} />
            <Toggle on={svc.release.migrateWithDeploy} onClick={() => setSvc({ release: { ...svc.release, migrateWithDeploy: !svc.release.migrateWithDeploy } })} label="migrate with deploy" />
          </Row>
          </Stack>
        </Card>
      )}
    </>
  );
}
