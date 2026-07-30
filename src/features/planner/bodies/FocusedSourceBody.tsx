// SourceBody — right-pane body for the "source" planning stage (#source-pane).
// The migration Source stage: name the legacy systems you're migrating FROM and connect each
// READ-ONLY so the planner can scan it into the project's Data Model.
//
// The native pre-built connectors were removed (#1976): there is no static catalog or backend preset
// catalog to pick from. Sources are proposed from the pitch (the ★ "Confirm N sources" banner) and the
// agent authors each connector as a runtime REST preset; making source declaration fully dynamic is
// Phase 5. This body keeps the lean surface: the proposed-source banner, the declared-source chips +
// cards (per-source connection FSM), and the scanned-result visualizations.
//
// Per-source state machine: declared → connecting → scanning → scanned (or error). The gate
// (`sourcesConnected`) passes once every declared source is scanned.
//
// SECURITY BOUNDARY (the design's payoff): a secret field's value lives ONLY in local component
// state and is "saved to the device keychain" on connect — it is NEVER written into the persisted
// SourceConfig and never shared with the planning agent, which sees only a redacted handle + the
// discovered object inventory.

import { useEffect, useMemo, useRef, useState } from "react";
import { bscJson, bscWrite } from "@/shared/lib/core/bsc";
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  connector, defaultSourceConfig, newDeclaredSource, sourceChecks, allSourcesConnected,
  deriveDataModel, proposeFromPitch,
  type SourceConfig, type RuntimeConnectorView,
} from "../lib/sourceConfig";
import { proposedSourceIds, connectFieldsFor, type DeclaredIntegration } from "../lib/sourceDiscovery";
import { safeKey } from "../lib/dataModelDerivation";
import { ScanViews } from "./ScanViews";
import { MONO, grpLabel, monoSm } from "./bodyStyles";
import { STATUS_DOT, SourceCard } from "./connectorForm";
import { useSourceConnection } from "./sourceConnection";
import { slugify } from "@/shared/lib/core/format";

// Slug a free-typed system name into a stable, safe connector id (the agent authors a connector
// under this id via `bsc data connector`, so the declared source resolves once it appears in the
// polled runtime list). Keep it conservative: lowercase, hyphen-collapsed, trimmed, capped.
function slugConnectorId(name: string): string {
  return slugify(name, 40) || "source";
}

// ② Build status — the coarse per-source chip (#1986). A declared source whose connector the agent
// hasn't authored yet (not in `runtime`) is "building…"; once it appears it is "ready to connect";
// any further status comes straight from the connection FSM.
const FSM_STATUS_LABEL: Record<string, string> = {
  connecting: "connecting…", scanning: "scanning…", scanned: "scanned", error: "error",
};
function buildStatusLabel(src: { connectorId: string; status: string }, runtime: readonly RuntimeConnectorView[]): string {
  if (src.status === "declared") {
    return runtime.some((r) => r.id === src.connectorId) ? "ready to connect" : "building…";
  }
  return FSM_STATUS_LABEL[src.status] ?? src.status;
}

// ── main component ────────────────────────────────────────────────────────────

export function SourceBody({ projectId, onInject }: {
  projectId?: string;
  /** Inject a nudge into the live planner terminal when a new source is declared (#1986). */
  onInject?: (text: string) => void;
}) {
  const pid = projectId ?? "";
  const stored = useAppStore((s) => s.planSourceConfig[pid]);
  const setPlanSourceConfig = useAppStore((s) => s.setPlanSourceConfig);
  const planningPitch = useAppStore((s) => s.planningPitch);
  const cfg: SourceConfig = stored ?? defaultSourceConfig();

  // The integrations the user CONFIRMED during Discovery, filtered to migration sources (#4054).
  // Polled rather than read once because Discovery runs alongside this pane — the planner may declare
  // an integration while the Source stage is already on screen, and the proposal should follow.
  const [declared, setDeclared] = useState<DeclaredIntegration[]>([]);
  usePoll(async (isCancelled) => {
    if (!pid) return;
    const rows = await bscJson<DeclaredIntegration[]>(
      pid, ["plan", "discovery", "integration", "list", "--direction", "source", "--json"], [],
    );
    if (!isCancelled()) setDeclared(Array.isArray(rows) ? rows : []);
  }, 2500, [pid]);

  // Seed the "Confirm N sources" banner: on first open of a fresh config (nothing declared, nothing
  // already proposed), stage the proposals as `proposed`; the banner + `confirmProposed` then declare
  // them on a single click. Guarded per-project so re-renders and a later user edit (clearing
  // `proposed`) don't re-seed.
  //
  // #4054: DISCOVERY WINS. The pitch keyword scan (#1349) survives only as the fallback for a project
  // whose Discovery predates #4024 or never worked the `integrations` topic — so whenever the user has
  // actually said which systems they are migrating from, the banner reflects that decision instead of
  // a guess. Seeding waits for the first poll to land, otherwise a project WITH declared integrations
  // would be seeded from the pitch on the opening render and then never re-seeded (the guard fires
  // once per project).
  const seededRef = useRef<Set<string>>(new Set());
  const polledRef = useRef<Set<string>>(new Set());
  useEffect(() => { if (pid) polledRef.current.add(pid); }, [pid, declared]);
  useEffect(() => {
    if (!pid || seededRef.current.has(pid) || !polledRef.current.has(pid)) return;
    if ((stored?.sources.length ?? 0) > 0 || (stored?.proposed.length ?? 0) > 0) {
      seededRef.current.add(pid); // already declared/proposed — don't override
      return;
    }
    const { ids } = proposedSourceIds(declared, proposeFromPitch(planningPitch));
    seededRef.current.add(pid);
    if (ids.length === 0) return;
    const base = stored ?? defaultSourceConfig();
    setPlanSourceConfig(pid, { ...base, proposed: ids });
  }, [pid, planningPitch, declared, stored, setPlanSourceConfig]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Poll the app-wide agent-authored connector list (#1980) so a declared source resolves its REAL
  // connector name/auth/category instead of the generic fallback. Light read every ~2.5s (matching
  // the planner skill poll); an absent store ⇒ []. The full declare/build-status picker is Phase 5b.
  const [runtime, setRuntime] = useState<RuntimeConnectorView[]>([]);
  usePoll(async (isCancelled) => {
    // `bsc data connector list` emits the FULL RuntimePreset[]; the pane needs only the reduced view
    // (id/label/category/auth), so project it down here (#2114/#2130). Global store — no project key.
    const presets = await bscJson<Array<Partial<RuntimeConnectorView>>>(null, ["data", "connector", "list", "--json"], []);
    if (isCancelled()) return;
    setRuntime(presets.map((p) => ({
      id: p.id ?? "", label: p.label ?? "", category: p.category ?? "", auth: p.auth ?? "",
    })));
  }, 2500, []);

  // ① Declare — the "+ Add a source" inline input (#1986): name the system (+ optional base URL /
  // OpenAPI link). Submitting stages a declared source and nudges the planner to author its connector.
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const seq = useRef(0);
  const persist = (next: SourceConfig) => setPlanSourceConfig(pid, next);

  // Per-source connection FSM + secret-masking state (declared → connecting → scanning → scanned).
  const { secrets, revealed, patchSource, setField, setSecret, toggleReveal, connect, retry, revokeSecrets } =
    useSourceConnection(pid, cfg, persist);

  const total = cfg.sources.length;
  const scanned = cfg.sources.filter((s) => s.status === "scanned").length;
  const ready = allSourcesConnected(cfg);
  const dataModelName = cfg.dataModelName || "your Data Model";
  const proposedPending = cfg.proposed.filter((id) => !cfg.sources.some((s) => s.connectorId === id));

  // ③ Confirm mapping (#1986) — the human gate on persisting the derived model. Confirmation is keyed
  // to the derived-model signature, NOT a bare boolean: confirming records the signature it approved,
  // and the gate counts as confirmed only while the live model still matches. So adding, removing, or
  // re-scanning a source (which changes the model) transparently re-arms the gate — no reset effect.
  const model = useMemo(() => deriveDataModel(cfg, `dm-source-${pid}`), [cfg, pid]);
  const modelSig = useMemo(() => JSON.stringify(model), [model]);
  const [confirmedSig, setConfirmedSig] = useState("");
  const mappingConfirmed = ready && confirmedSig === modelSig;

  // Close the "data dictates structure" loop (#1205): once every declared source is scanned AND the
  // user confirms the inferred mapping (#1986 — the human gate, replacing the old auto-persist),
  // persist the derived canonical Data Model to the project's DuckDB store (#1446) — what the planner's
  // features/structure stages design over. Re-persists only when the derived model changes.
  const persistedSig = useRef("");
  useEffect(() => {
    if (!ready || !pid || !mappingConfirmed) return;
    if (modelSig === persistedSig.current) return;
    persistedSig.current = modelSig;
    void bscWrite(pid, ["data", "model", "set", "--refined"], model);
  }, [ready, pid, mappingConfirmed, modelSig, model]);

  // ── actions ──
  // ① Stage a free-typed source + nudge the planner to author its connector via the build-integration
  // dev-loop (#1986). The slug id is what the agent authors under, so the source resolves once the
  // connector lands in the polled `runtime` list.
  function addSource() {
    const name = newName.trim();
    if (!name) return;
    const url = newUrl.trim();
    const connectorId = slugConnectorId(name);
    const src = newDeclaredSource(connectorId, `src-${connectorId}-${++seq.current}`);
    persist({ ...cfg, sources: [...cfg.sources, src] });
    setExpanded((p) => new Set(p).add(src.uid));
    onInject?.(
      `I want to integrate ${name}${url ? ` (${url})` : ""}. Use the build-integration skill: probe it, ` +
      `then author the connector with bsc data connector using the id "${connectorId}" ` +
      `(the app links it to this declared source by that exact id), then I'll connect + scan it.`,
    );
    setNewName("");
    setNewUrl("");
  }

  function confirmProposed() {
    // #4054: carry through what Discovery already captured (base URL / docs) so an agent authoring
    // this connector starts from the vendor reference the user gave, not a blank form. Only plain
    // URLs cross — nothing secret exists on this path.
    const add = proposedPending.map((id) => ({
      ...newDeclaredSource(id, `src-${id}-${++seq.current}`),
      fields: connectFieldsFor(id, declared),
    }));
    persist({ ...cfg, proposed: [], sources: [...cfg.sources, ...add] });
    setExpanded((p) => { const n = new Set(p); add.forEach((s) => n.add(s.uid)); return n; });
  }
  function removeSource(uid: string) {
    revokeSecrets(uid);
    persist({ ...cfg, sources: cfg.sources.filter((s) => s.uid !== uid) });
  }
  function toggleExpand(uid: string) {
    setExpanded((p) => { const n = new Set(p); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  }

  // ── readiness line ──
  const checks = sourceChecks(cfg);

  // ③ Confirm mapping — the inferred source object → canonical entity rows (#1986). Each scanned
  // source's discovered objects map to the canonical entity key the Data Model derivation produces
  // (`safeKey(object name)`), so the user can eyeball the inference before it's persisted.
  const mappingRows = cfg.sources
    .filter((s) => s.status === "scanned")
    .flatMap((s) =>
      (s.objects ?? []).map((o) => ({
        key: `${s.uid}:${o.name}`,
        source: connector(s.connectorId, runtime).name,
        object: o.name,
        entity: safeKey(o.name) || "entity",
      })),
    );

  return (
    <Stack data-testid="source-body" gap={12}>
      {/* top readiness banner */}
      <Banner tone={ready ? "success" : "accent"} dot loud right={
        <Text as="span" style={monoSm}>{ready ? `both feed «${dataModelName}»` : "read-only integrations · credentials never leave this device"}</Text>
      }>
        {total === 0 ? "Declare your sources" : ready ? "✓ sources connected" : `${scanned} / ${total} connected`}
      </Banner>

      {/* planner-proposed sources */}
      {proposedPending.length > 0 && (
        <Stack gap={9} style={{ background: "color-mix(in oklch, var(--accent), transparent 93%)", border: "1px solid color-mix(in oklch, var(--accent), transparent 78%)", borderRadius: "var(--r-md)", padding: "11px 12px" }}>
          <Row align="start" gap={8}>
            <Text as="span" size={13} tone="accent">★</Text>
            <Text as="div" size={12.5} style={{ color: "var(--fg)", lineHeight: 1.5 }}>
              Detected from your pitch — migrating from {proposedPending.map((id) => connector(id, runtime).name).join(" + ")}. Connect them?
            </Text>
          </Row>
          <Row gap={9}>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled accent CTA (not a `.btn`); Button would change rendering */}
            <button data-testid="proposed-confirm" onClick={confirmProposed} style={{ fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, color: "oklch(0.20 0.04 70)", background: "var(--accent)", border: "none", borderRadius: "var(--r-md)", padding: "7px 13px", cursor: "pointer" }}>
              Confirm {proposedPending.length} source{proposedPending.length !== 1 ? "s" : ""}
            </button>
          </Row>
        </Stack>
      )}

      {/* ① declare — "+ Add a source" (#1986): name the system (+ optional base URL / OpenAPI link).
          Submitting stages the source and nudges the planner to author its connector (the dev-loop). */}
      <form
        data-testid="add-source"
        onSubmit={(e) => { e.preventDefault(); addSource(); }}
        style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", padding: "9px 10px", border: "1px dashed var(--border)", borderRadius: "var(--r-md)", background: "var(--bg-elev)" }}
      >
        <Text as="span" size={13} weight={600} tone="accent">+</Text>
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled input in a flex form row; TextField's .field wrapper would change layout */}
        <input
          data-testid="add-source-name"
          value={newName}
          placeholder="Add a source — name the system (e.g. Stripe)"
          aria-label="Source name"
          onChange={(e) => setNewName(e.target.value)}
          style={{ flex: "2 1 180px", minWidth: 0, height: 30, padding: "0 11px", background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", outline: "none", fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)" }}
        />
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled input in a flex form row; TextField's .field wrapper would change layout */}
        <input
          data-testid="add-source-url"
          value={newUrl}
          placeholder="base URL / OpenAPI link · optional"
          aria-label="Source base URL or OpenAPI link"
          onChange={(e) => setNewUrl(e.target.value)}
          style={{ flex: "1 1 160px", minWidth: 0, height: 30, padding: "0 11px", background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", outline: "none", fontFamily: MONO, fontSize: 11.5, color: "var(--fg)" }}
        />
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled accent submit CTA (not a `.btn`); Button would change rendering */}
        <button
          data-testid="add-source-submit"
          type="submit"
          disabled={!newName.trim()}
          style={{ fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, color: "oklch(0.20 0.04 70)", background: "var(--accent)", border: "none", borderRadius: "var(--r-md)", padding: "7px 13px", cursor: newName.trim() ? "pointer" : "not-allowed", opacity: newName.trim() ? 1 : 0.45 }}
        >Add</button>
      </form>

      {/* chip bar — declared sources */}
      {total > 0 && (
        <Row data-testid="source-chips" gap={8} wrap>
          <Text as="span" style={grpLabel}>sources</Text>
          {cfg.sources.map((s) => {
            const c = connector(s.connectorId, runtime);
            const done = s.status === "scanned";
            const buildLabel = buildStatusLabel(s, runtime);
            const building = s.status === "declared" && !runtime.some((r) => r.id === s.connectorId);
            return (
              <Box as="span" key={s.uid} onClick={() => { setExpanded((p) => new Set(p).add(s.uid)); }} title={c.name} pad={[4, 11]} bg="var(--bg-elev)" radius={99} style={{
                display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, cursor: "pointer",
                border: `1px solid color-mix(in oklch, ${done ? "var(--success)" : "var(--accent)"}, transparent ${done ? 70 : 64}%)`,
              }}>
                <Box as="span" bg={STATUS_DOT[s.status]} radius={99} style={{ width: 7, height: 7, animation: (s.status === "connecting" || s.status === "scanning" || building) ? "pulse 1.2s ease-in-out infinite" : undefined }} />
                {c.name}{done && <Text as="span" size={10} tone="success">✓</Text>}
                {/* ② build status — coarse per-source chip (#1986) */}
                <Text as="span" data-testid={`build-status-${s.uid}`} mono size={9} style={{ color: building ? "var(--fg-dim)" : done ? "var(--success)" : "var(--accent)" }}>{buildLabel}</Text>
              </Box>
            );
          })}
        </Row>
      )}

      {/* boundary legend — the security payoff, quiet */}
      {total > 0 && (
        <Row align="stretch" style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden", fontFamily: MONO, fontSize: 9.5 }}>
          <Row gap={7} style={{ flex: 1, padding: "7px 11px", background: "var(--bg-elev)" }}>
            <Box as="span">🔒</Box><Text as="span" tone="muted">entered here · device keychain</Text>
          </Row>
          <Row gap={7} style={{ flex: 1, padding: "7px 11px", background: "color-mix(in oklch, var(--info), transparent 93%)", borderLeft: "1px solid var(--border-soft)" }}>
            <Text as="span" style={{ color: "var(--info)" }}>↗</Text><Text as="span" style={{ color: "var(--info)" }}>planner sees: handle + objects only</Text>
          </Row>
        </Row>
      )}

      {/* per-source cards */}
      {cfg.sources.map((src) => (
        <SourceCard
          key={src.uid}
          src={src}
          runtime={runtime}
          dataModelName={dataModelName}
          expanded={expanded.has(src.uid)}
          revealed={revealed.has(src.uid)}
          secrets={secrets[src.uid] ?? {}}
          onToggle={() => toggleExpand(src.uid)}
          onField={(k, v) => setField(src.uid, k, v)}
          onSecret={(k, v) => setSecret(src.uid, k, v)}
          onReveal={() => toggleReveal(src.uid)}
          onEnv={(env) => patchSource(src.uid, { env })}
          onConnect={() => connect(src.uid)}
          onRetry={() => retry(src.uid)}
          onRemove={() => removeSource(src.uid)}
        />
      ))}

      {/* readiness checklist */}
      {total > 0 && (
        <Stack gap={5} style={{ borderRadius: "var(--r-lg)", border: "1px solid var(--border-soft)", background: "var(--bg-canvas)", padding: "11px 13px" }}>
          {checks.map((c) => (
            <Row key={c.id} gap={8} style={{ padding: "6px 9px", borderRadius: "var(--r-sm)", background: "var(--bg-elev)" }}>
              <Text as="span" mono size={11} style={{ width: 15, textAlign: "center", color: c.ok ? "var(--success)" : "var(--fg-dim)" }}>{c.ok ? "✓" : "○"}</Text>
              <Text as="span" size={11} style={{ fontFamily: "var(--sans)", color: c.ok ? "var(--fg)" : "var(--fg-muted)" }}>{c.label}</Text>
              <Spacer />
              <Text as="span" mono size={9} style={{ color: c.ok ? "var(--fg-muted)" : "var(--fg-dim)" }}>{c.detail}</Text>
            </Row>
          ))}
        </Stack>
      )}

      {/* ③ confirm mapping — the human gate (#1986). Once every source is scanned, surface the
          inferred source→canonical mapping; confirming it (and only then) persists the derived model. */}
      {ready && mappingRows.length > 0 && (
        <Stack data-testid="mapping-confirm" gap={8} style={{ borderRadius: "var(--r-lg)", border: `1px solid ${mappingConfirmed ? "color-mix(in oklch, var(--success), transparent 70%)" : "var(--border-soft)"}`, background: "var(--bg-canvas)", padding: "11px 13px" }}>
          <Row gap={8}>
            <Text as="span" style={grpLabel}>source → canonical entity</Text>
            <Spacer />
            {mappingConfirmed
              ? <Text as="span" data-testid="mapping-confirmed" mono size={10} tone="success">✓ mapping confirmed</Text>
              : (
                // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled accent CTA (not a `.btn`); Button would change rendering
                <button data-testid="confirm-mapping" onClick={() => setConfirmedSig(modelSig)} style={{ fontFamily: "var(--sans)", fontSize: 11.5, fontWeight: 600, color: "oklch(0.20 0.04 70)", background: "var(--accent)", border: "none", borderRadius: "var(--r-md)", padding: "6px 12px", cursor: "pointer" }}>Confirm mapping</button>
              )}
          </Row>
          <Stack gap={4}>
            {mappingRows.map((m) => (
              <Row key={m.key} gap={8} style={{ padding: "5px 9px", borderRadius: "var(--r-sm)", background: "var(--bg-elev)", fontSize: 11.5 }}>
                <Text as="span" tone="muted">{m.object}</Text>
                <Text as="span" mono size={10} tone="dim">· {m.source}</Text>
                <Spacer />
                <Text as="span" tone="dim">→</Text>
                <Text as="span" mono size={11} tone="accent">{m.entity}</Text>
              </Row>
            ))}
          </Stack>
        </Stack>
      )}

      {/* scanned-result visualizations — the "data dictates structure" payoff (#1205/#1209):
          Graph · List · Process over the derived model + captured behaviors. The header carries
          the downstream-impact recap. */}
      {ready && <ScanViews cfg={cfg} dataModelName={cfg.dataModelName || "Source Data Model"} />}
    </Stack>
  );
}
