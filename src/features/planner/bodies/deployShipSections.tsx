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
            {/* Horizontal scroll so long values / many env columns scroll WITHIN the card instead of
                overflowing the pane (#1421 follow-up); the table keeps a readable minimum width. */}
            <div style={{ overflowX: "auto", margin: "0 -2px" }}>
            <table style={{ minWidth: 320, width: "100%", borderCollapse: "collapse", fontFamily: MONO, fontSize: 10.5 }}>
              <thead><tr style={{ color: "var(--fg-dim)", textAlign: "left" }}><th style={{ padding: "3px 6px", fontWeight: 400 }}>variable</th>{svc.envs.map((e) => <th key={e.id} style={{ padding: "3px 6px", fontWeight: 400 }}>{e.name}</th>)}</tr></thead>
              <tbody>
                {svc.config.config.map((row) => (
                  <tr key={row.key} style={{ borderTop: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "4px 6px", color: "var(--fg)" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 2, background: "var(--info)", marginRight: 6 }} />{row.key}</td>
                    {svc.envs.map((e) => <td key={e.id} title={row[e.id] || undefined} style={{ padding: "4px 6px", color: "var(--fg-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row[e.id] || "—"}</td>)}
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
            </div>
            <div style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)", marginTop: 8 }}>🔒 secret values live in the vault, never here — only wiring state is shown.</div>
          </>
        )}
      </Card>

      {/* 5 · Rollout & health — CLOUD ONLY (#2023): the rollout strategy (recreate/rolling/blue-green/
          canary), health probe, and migrate-with-deploy are running-cloud-service concerns; a local
          build (library publish / application package) ships via its pipeline's publish/package stage,
          so this card is hidden for local mode. Boxed as a collapsible card like the others (#1421). */}
      {serviceMode(svc) === "cloud" && (
        <Card n="05" title="Rollout & health" hint={svc.release.strategy || undefined} done={ck("release")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <Toggle on={svc.health.probeOn} onClick={() => setSvc({ health: { ...svc.health, probeOn: !svc.health.probeOn } })} label="health probe" value={svc.health.probe} />
            <Toggle on={svc.release.migrateWithDeploy} onClick={() => setSvc({ release: { ...svc.release, migrateWithDeploy: !svc.release.migrateWithDeploy } })} label="migrate with deploy" />
          </div>
          </div>
        </Card>
      )}
    </>
  );
}
