// Design Studio (#2308) — the full-page component workbench, the standalone Rail workspace body (#2303).
// An IDE-style page over the SAME global component library the planner's condensed `PlannerComponentsPane`
// (#2314) browses: a toolbar (kit switcher · search · Library/Graph toggle · ＋Kit/＋Component),
// a resizable kits→components tree rail, a center that flips between a LIBRARY view (live preview +
// variant/theme/viewport switchers + Source/Props/Usage tabs + a generate-variants design bar) and a
// composition GRAPH view, and a resizable inspector (props/API · variants · composes · guidance).
//
// It reuses the pure domain (`lib/model`), the shared specimen renderer (`renderSpecimen`), the shared
// graph stack (`GraphCanvas` + `ZoomControls` + `useGraphViewport` + `layerDag` + `graphEdge` ports
// routing, #2418), and `useDragResize` — so it stays on-architecture and the planner Kickoff pane is
// untouched. Data comes from the global store via the `bsc component` bridge.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { KitShareModal } from "./KitShareModal";
import { KitChangesCard } from "./KitChangesCard";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { Chip } from "@/shared/ui/data/Chip";
import { Code } from "@/shared/ui/data/Code";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { layerDag } from "@/shared/lib/graph/layers";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { slugify } from "@/shared/lib/core/format";
import type { GraphEdge } from "@/shared/lib/graph/types";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { RoleDot, KitChip } from "./kitChrome";
import { matchesQuery, resolveComposes, resolveUsedBy, NO_COMPONENTS_TITLE, type ComponentRecord } from "./lib/model";
import { renderSpecimen, type PreviewTheme } from "./specimens";
import "./designStudio.css";

type View = "library" | "graph";
type Tab = "source" | "props" | "usage";
type Viewport = "sm" | "md" | "auto";
const VP: Record<Viewport, { w: string; label: string }> = {
  sm: { w: "380px", label: "375 · mobile" },
  md: { w: "640px", label: "768 · tablet" },
  auto: { w: "100%", label: "fluid · fills panel" },
};
/** Optimistic delay before generated variants appear (the store generate loop isn't wired yet). */
const GEN_MS = 1600;
/** Graph node box + column/row spacing (world coords). */
const NODE_W = 170, NODE_H = 54, COL_GAP = 230, ROW_GAP = 96, PAD = 60;

// The role dot + kit chip live in kitChrome.tsx (#2420) — shared with the Planner Components pane.

export function DesignStudio() {
  const components = useAppStore((s) => s.components);
  const kits = useAppStore((s) => s.kits);

  const firstFor = (kitId: string) => components.find((c) => c.kitId === kitId);
  const [kitId, setKitId] = useState(() => kits[0]?.id ?? "");
  const [compId, setCompId] = useState(() => firstFor(kits[0]?.id ?? "")?.id ?? "");
  const [view, setView] = useState<View>("library");
  const [tab, setTab] = useState<Tab>("props");
  const [variant, setVariant] = useState(() => firstFor(kits[0]?.id ?? "")?.variants[0] ?? "default");
  const [theme, setTheme] = useState<PreviewTheme>("dark");
  const [vp, setVpKind] = useState<Viewport>("auto");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({ [kits[0]?.id ?? ""]: true }));
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep] = useState(1);
  const [genVariants, setGenVariants] = useState<Record<string, string[]>>({});
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [renderKey, setRenderKey] = useState(0); // bumped by "Retry render" after a preview error
  const [shareOpen, setShareOpen] = useState(false); // the share/import kits modal (#2305 slice 1c)

  const rail = useDragResize({ initial: 266, min: 200, max: 400, axis: "x" });
  const insp = useDragResize({ initial: 322, min: 240, max: 460, axis: "x", invert: true });
  const genTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => genTimers.current.forEach(clearTimeout), []);

  const match = (c: ComponentRecord) => matchesQuery(c, query);
  const kit = kits.find((k) => k.id === kitId) ?? kits[0];
  const kitComps = useMemo(() => components.filter((c) => c.kitId === kitId), [components, kitId]);
  // The shown component: the selection when still visible under the current search, else the first match.
  const selById = components.find((c) => c.id === compId && c.kitId === kitId);
  const sel = selById && match(selById) ? selById : kitComps.filter(match)[0] ?? null;

  const allVariants = sel ? [...sel.variants, ...(genVariants[sel.id] ?? [])] : [];
  const activeVariant = allVariants.includes(variant) ? variant : allVariants[0] ?? "default";
  const composes = sel ? resolveComposes(sel, components) : [];
  const usedBy = sel ? resolveUsedBy(sel, components) : [];

  const selectKit = (id: string) => {
    const first = components.find((c) => c.kitId === id && match(c)) ?? firstFor(id);
    setKitId(id); setCompId(first?.id ?? ""); setVariant(first?.variants[0] ?? "default");
    setExpanded((e) => ({ ...e, [id]: true })); setTab("props"); setCandidates(null); setView("library");
  };
  const selectComp = (c: ComponentRecord) => {
    if (c.kitId !== kitId) setKitId(c.kitId);
    setCompId(c.id); setVariant(c.variants[0] ?? "default"); setTab("props"); setCandidates(null);
  };

  const generate = () => {
    if (generating || !prompt.trim() || !sel) return;
    const slug = slugify(prompt).split("-").filter(Boolean).slice(0, 2).join("-") || "variant";
    const existing = new Set(allVariants);
    const name = existing.has(slug) ? `${slug}-2` : slug;
    setGenerating(true); setGenStep(1); setCandidates(null);
    genTimers.current.forEach(clearTimeout);
    genTimers.current = [
      setTimeout(() => setGenStep(2), GEN_MS * 0.25),
      setTimeout(() => setGenStep(3), GEN_MS * 0.5),
      setTimeout(() => setGenStep(4), GEN_MS * 0.72),
      setTimeout(() => {
        setGenVariants((g) => ({ ...g, [sel.id]: [...(g[sel.id] ?? []), name] }));
        setCandidates([...sel.variants, name].slice(-4));
        setGenerating(false); setPrompt("");
      }, GEN_MS),
    ];
  };
  const accept = (name: string) => { setVariant(name); setCandidates(null); };

  // ── graph layout (shared layerer) ──
  const graph = useMemo(() => {
    const nodeIds = kitComps.map((c) => c.id);
    const idByName = new Map(kitComps.map((c) => [c.name, c.id] as const));
    const edges: GraphEdge[] = [];
    for (const c of kitComps) for (const dep of c.composes) {
      const to = idByName.get(dep);
      if (to) edges.push({ id: `${c.id}->${to}`, from: c.id, to });
    }
    const layer = layerDag(nodeIds, edges); // dependency sits deeper (further right)
    const rows: Record<number, number> = {};
    const pos = new Map<string, { x: number; y: number }>();
    for (const c of kitComps) {
      const L = layer[c.id] ?? 0;
      const row = rows[L] ?? 0; rows[L] = row + 1;
      pos.set(c.id, { x: PAD + L * COL_GAP, y: PAD + row * ROW_GAP });
    }
    let w = 400, h = 300;
    for (const p of pos.values()) { w = Math.max(w, p.x + NODE_W + PAD); h = Math.max(h, p.y + NODE_H + PAD); }
    return { pos, edges, world: { w, h } };
  }, [kitComps]);

  const gvp = useGraphViewport(graph.world);
  const gvpFit = gvp.fit;
  useEffect(() => { if (view === "graph") gvpFit(); }, [view, kitId, gvpFit]);

  if (!kit) return <StudioEmpty />;

  // The live preview node, guarded — a specimen that throws surfaces the error card, not a crash.
  let previewEl: ReactNode = null, previewErr: string | null = null;
  if (sel) {
    try { void renderKey; previewEl = renderSpecimen(sel, activeVariant, theme); }
    catch (e) { previewErr = e instanceof Error ? e.message : String(e); }
  }

  return (
    <Box className="ds-root">
      {/* ── toolbar ── */}
      <Box className="ds-toolbar">
        <Box style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}>
          <Text weight={600} size={13.5} style={{ letterSpacing: "-.01em" }}>Design Studio</Text>
        </Box>
        <Box className="ds-sep" />
        <Box style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
          <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase", marginRight: 2 }}>Kit</Text>
          {kits.map((k) => (
            <KitChip key={k.id} kit={k} on={k.id === kitId} className="ds-kitchip" title={k.stack} onClick={() => selectKit(k.id)}>
              <Text mono size="xxs" style={{ opacity: .7 }}>{components.filter((c) => c.kitId === k.id).length}</Text>
            </KitChip>
          ))}
        </Box>
        <Box style={{ flex: 1, display: "flex", justifyContent: "center", minWidth: 80 }}>
          <Box className="ds-search">
            <Text tone="dim" size={13}>⌕</Text>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke bare search box (Field imposes a labelled layout) */}
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search components by intent — “confirm dialog”, “data table”…" aria-label="Search components" />
            <Text as="span" className="ds-kbd">⌘K</Text>
          </Box>
        </Box>
        <SegmentedControl
          label=""
          options={[
            { label: "▦ Library", on: view === "library", onClick: () => setView("library") },
            { label: "⬡ Graph", on: view === "graph", onClick: () => setView("graph") },
          ]}
        />
        <Box style={{ display: "flex", alignItems: "center", gap: 7, flex: "none" }}>
          <Box as="button" className="ds-act" title="Share or import a kit (gist / share code)" onClick={() => setShareOpen(true)}><Text as="span" tone="dim">⇅</Text> Share</Box>
          <Box as="button" className="ds-act accent" title="Add a new component"><Text as="span">＋</Text> Component</Box>
        </Box>
      </Box>

      {shareOpen && (
        <KitShareModal
          kit={kit ?? null}
          components={kitComps}
          onClose={() => setShareOpen(false)}
          onImported={(k) => selectKit(k.id)}
        />
      )}

      {/* kit-change propagation notify surface (#2277) — renders only when changes are pending */}
      <KitChangesCard />

      {/* ── body ── */}
      <Box className="ds-body">
        {/* left rail */}
        <Box className="ds-col ds-rail" style={{ width: rail.size, flexBasis: rail.size }}>
          <Box className="ds-colhead">
            <Text className="ds-eyebrow" as="span">Kits · Components</Text>
            <Text mono size="xxs" tone="dim">{kitComps.length} comps</Text>
          </Box>
          <Box className="ds-scroll" style={{ flex: 1, padding: "8px 8px 16px" }}>
            {kits.map((k) => {
              const open = !!expanded[k.id];
              const inKit = components.filter((c) => c.kitId === k.id);
              const rows = inKit.filter(match);
              return (
                <Box key={k.id} style={{ marginBottom: 4 }}>
                  <Box as="button" className={`ds-kithead${k.id === kitId ? " active" : ""}`} onClick={() => setExpanded((e) => ({ ...e, [k.id]: !e[k.id] }))}>
                    <Text as="span" className="ds-caret" style={{ transform: open ? "rotate(90deg)" : "none" }}>▸</Text>
                    <ColorSwatch color={k.dot} size={7} />
                    <Text as="span" weight={500} style={{ flex: 1, textAlign: "left" }}>{k.name}</Text>
                    <Text mono size="xxs" tone="dim">{inKit.length}</Text>
                  </Box>
                  {open && (
                    <Box style={{ margin: "2px 0 6px", paddingLeft: 6 }}>
                      {rows.map((c) => (
                        <Box as="button" key={c.id} className={`ds-comprow${c.id === compId && k.id === kitId ? " on" : ""}`} onClick={() => selectComp(c)}>
                          <RoleDot role={c.role} size={7} glow={3} />
                          <Text as="span" style={{ flex: 1, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</Text>
                          <Text mono size="xxs" tone="dim" style={{ padding: "1px 5px", background: "var(--bg-soft)", borderRadius: 4 }}>×{c.used}</Text>
                        </Box>
                      ))}
                      {open && rows.length === 0 && query && (
                        <Text size={11} tone="dim" as="div" style={{ padding: "6px 10px", fontStyle: "italic" }}>no matches</Text>
                      )}
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
        <Box className="ds-handle" {...rail.handleProps} />

        {/* center — keyed on the active view so flipping Library ⇄ Graph remounts it → the incoming view drills in (#2344) */}
        <Box className="ds-col ds-center">
          {view === "graph"
            ? <GraphView graph={graph} comps={kitComps} selId={sel?.id ?? ""} kitName={kit.name} gvp={gvp} onSelect={selectComp} />
            : <LibraryView
                sel={sel} kitName={kit.name} tab={tab} setTab={setTab}
                allVariants={allVariants} activeVariant={activeVariant} setVariant={setVariant}
                theme={theme} setTheme={setTheme} vp={vp} setVpKind={setVpKind}
                previewEl={previewEl} previewErr={previewErr} onRetry={() => setRenderKey((k) => k + 1)}
                generating={generating} genStep={genStep} candidates={candidates} onAccept={accept}
                prompt={prompt} setPrompt={setPrompt} onGenerate={generate}
                composes={composes} usedBy={usedBy}
              />}
        </Box>
        <Box className="ds-handle" {...insp.handleProps} />

        {/* inspector */}
        <Inspector width={insp.size} sel={sel} kitName={kit.name} activeVariant={activeVariant} allVariants={allVariants} composes={composes} onSelect={selectComp} />
      </Box>
    </Box>
  );
}

// ── Library view ─────────────────────────────────────────────────────────────
interface LibProps {
  sel: ComponentRecord | null; kitName: string; tab: Tab; setTab: (t: Tab) => void;
  allVariants: string[]; activeVariant: string; setVariant: (v: string) => void;
  theme: PreviewTheme; setTheme: (t: PreviewTheme) => void; vp: Viewport; setVpKind: (v: Viewport) => void;
  previewEl: ReactNode; previewErr: string | null; onRetry: () => void;
  generating: boolean; genStep: number; candidates: string[] | null; onAccept: (v: string) => void;
  prompt: string; setPrompt: (v: string) => void; onGenerate: () => void;
  composes: ReturnType<typeof resolveComposes>; usedBy: ComponentRecord[];
}
function LibraryView(p: LibProps) {
  if (!p.sel) return <StudioEmpty inline />;
  const sel = p.sel;
  return (
    <>
      {/* preview */}
      <Box className="ds-preview">
        <Box className="ds-colhead" style={{ height: 38 }}>
          <Text className="ds-eyebrow" as="span">Live preview</Text>
          <Box style={{ flex: 1 }} />
          <SegmentedControl label="" options={p.allVariants.map((v) => ({ label: v, on: v === p.activeVariant, onClick: () => p.setVariant(v) }))} />
          <SegmentedControl label="" options={(["dark", "light"] as PreviewTheme[]).map((th) => ({ label: th === "dark" ? "◐ dark" : "◑ light", on: th === p.theme, onClick: () => p.setTheme(th) }))} />
          <SegmentedControl label="" options={(["sm", "md", "auto"] as Viewport[]).map((k) => ({ label: k === "auto" ? "⤢ fluid" : k, on: k === p.vp, onClick: () => p.setVpKind(k) }))} />
        </Box>
        <Box className="ds-surface">
          {p.generating && (
            <Box className="ds-overlay" style={{ background: "color-mix(in srgb, var(--bg) 72%, transparent)", backdropFilter: "blur(2px)" }}>
              <Box style={{ textAlign: "center" }}>
                <Box className="ds-spinner" />
                <Text weight={500} size={13} as="div" style={{ marginBottom: 4 }}>Generating variants…</Text>
                <Text mono size="xxs" tone="dim" as="div" style={{ animation: "ds-pulse 1.4s infinite" }}>rendering candidate {p.genStep} / 4</Text>
              </Box>
            </Box>
          )}
          {p.previewErr ? (
            <Box className="ds-overlay" style={{ padding: 24 }}>
              <Box style={{ maxWidth: 400, width: "100%", background: "var(--bg-elev, var(--bg-soft))", border: "1px solid color-mix(in srgb, var(--danger) 40%, var(--border))", borderRadius: 12, overflow: "hidden" }}>
                <Box style={{ height: 30, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", background: "color-mix(in srgb, var(--danger) 12%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)" }}>
                  <StatusDot color="var(--danger)" size={8} />
                  <Text mono size="xxs" tone="danger" style={{ letterSpacing: ".05em", textTransform: "uppercase" }}>Preview failed to render</Text>
                </Box>
                <Box style={{ padding: "14px 16px" }}>
                  <Code maxHeight={140} wrap>{p.previewErr}</Code>
                  <Box style={{ display: "flex", gap: 8, marginTop: 14 }}>
                    <Button variant="primary" size="sm" onClick={p.onRetry}>↻ Retry render</Button>
                  </Box>
                </Box>
              </Box>
            </Box>
          ) : (
            <Box className="ds-frame">
              {/* centered on the surface (#2333); the width transition + fixed VP width are layout, not the removed motion pass */}
              <Box style={{ width: VP[p.vp].w, maxWidth: "100%", transition: "width .25s ease", display: "flex", justifyContent: "center" }}>{p.previewEl}</Box>
            </Box>
          )}
          <Text as="div" className="ds-vplabel">{VP[p.vp].label}</Text>
        </Box>
      </Box>

      {/* tabs */}
      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Box className="ds-tabs">
          {(["source", "props", "usage"] as Tab[]).map((t) => (
            <Box as="button" key={t} role="tab" aria-selected={p.tab === t} className={`ds-tab${p.tab === t ? " on" : ""}`} onClick={() => p.setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</Box>
          ))}
          <Box style={{ flex: 1 }} />
          <Text mono size="xxs" tone="dim">{sel.name}.tsx</Text>
        </Box>
        <Box className="ds-panel">
          {p.tab === "source" && (
            <Box style={{ padding: "14px 16px" }}>
              <Text mono size="xxs" tone="dim" as="div" style={{ marginBottom: 6 }}>{sel.src}</Text>
              <Code maxHeight={9999} wrap={false}>{sel.srcText}</Code>
            </Box>
          )}
          {p.tab === "props" && (
            <Box style={{ padding: "12px 14px" }}>
              {sel.props.length ? (
                <Box style={{ display: "grid", gridTemplateColumns: "150px 130px 1fr", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
                  {["prop", "type", "description"].map((h, i) => (
                    <Text key={h} mono size="xxs" tone="dim" style={{ padding: "8px 11px", letterSpacing: ".05em", textTransform: "uppercase", background: "var(--bg-soft)", borderBottom: "1px solid var(--border)", borderRight: i < 2 ? "1px solid var(--border-soft, var(--border))" : "none" }}>{h}</Text>
                  ))}
                  {sel.props.map((pr) => (
                    <PropRow key={pr.name} pr={pr} />
                  ))}
                </Box>
              ) : (
                <Text mono size={11.5} tone="dim" as="div" style={{ padding: "8px 2px" }}>No public props — this component reads from the global store.</Text>
              )}
            </Box>
          )}
          {p.tab === "usage" && (
            <Box style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 820 }}>
              <GuideCard tone="success" title="✓ When to use" items={sel.whenUse} glyph="→" />
              <GuideCard tone="danger" title="✗ When NOT to use" items={sel.whenNot} glyph="✕" />
            </Box>
          )}
        </Box>
      </Box>

      {/* design bar */}
      <Box className="ds-designbar">
        {p.candidates && p.candidates.length > 0 && (
          <Box className="ds-candstrip">
            {p.candidates.map((v) => (
              <Box key={v} className="ds-cand">
                <Box style={{ height: 78, display: "flex", alignItems: "center", justifyContent: "center", borderBottom: "1px solid var(--border-soft, var(--border))", overflow: "hidden" }}>
                  <Box style={{ transform: "scale(.62)" }}>{renderSpecimen(sel, v, "dark")}</Box>
                </Box>
                <Box style={{ padding: "6px 9px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <Text mono size="xxs" tone="muted">{v}</Text>
                  <Box as="button" onClick={() => p.onAccept(v)} style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 5, border: "1px solid color-mix(in srgb, var(--success) 45%, transparent)", background: "color-mix(in srgb, var(--success) 14%, transparent)", color: "var(--success)", cursor: "pointer" }}>accept</Box>
                </Box>
              </Box>
            ))}
          </Box>
        )}
        <Box className="ds-designrow">
          <Box className="ds-spark">✦</Box>
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline prompt box for the generate loop */}
          <input value={p.prompt} onChange={(e) => p.setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") p.onGenerate(); }} disabled={p.generating} placeholder="Describe a change or a new variant — “add a loading state”, “tighter, pill-shaped”…" aria-label="Describe a variant" />
          <Button variant="primary" size="sm" onClick={p.onGenerate} disabled={p.generating || !p.prompt.trim()}>{p.generating ? "generating…" : "✦ Generate variants"}</Button>
        </Box>
      </Box>
    </>
  );
}

function PropRow({ pr }: { pr: ComponentRecord["props"][number] }) {
  const cell = { padding: "8px 11px", borderBottom: "1px solid var(--border-soft, var(--border))" } as const;
  return (
    <>
      <Box style={{ ...cell, borderRight: "1px solid var(--border-soft, var(--border))", display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        <Text mono size={11.5}>{pr.name}</Text>{pr.req && <Text mono size={11} tone="danger">*</Text>}
      </Box>
      <Text mono size={11} tone="accent" style={{ ...cell, borderRight: "1px solid var(--border-soft, var(--border))", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{pr.type}</Text>
      <Text size={11.5} tone="muted" style={{ ...cell, lineHeight: 1.5 }}>{pr.desc}</Text>
    </>
  );
}

function GuideCard({ tone, title, items, glyph }: { tone: "success" | "danger"; title: string; items: string[]; glyph: string }) {
  const c = tone === "success" ? "var(--success)" : "var(--danger)";
  return (
    <Box style={{ border: `1px solid color-mix(in srgb, ${c} 30%, var(--border))`, borderRadius: 10, overflow: "hidden" }}>
      <Text mono size="xxs" as="div" style={{ padding: "8px 12px", background: `color-mix(in srgb, ${c} 10%, transparent)`, letterSpacing: ".05em", textTransform: "uppercase", color: c }}>{title}</Text>
      <Box style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
        {items.map((w) => (
          <Box key={w} style={{ display: "flex", gap: 9 }}>
            <Text as="span" style={{ color: c, flex: "0 0 auto" }}>{glyph}</Text><Text size={12.5} tone="muted" style={{ lineHeight: 1.5 }}>{w}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ── Graph view ───────────────────────────────────────────────────────────────
interface GraphProps {
  graph: { pos: Map<string, { x: number; y: number }>; edges: GraphEdge[]; world: { w: number; h: number } };
  comps: ComponentRecord[]; selId: string; kitName: string;
  gvp: ReturnType<typeof useGraphViewport>; onSelect: (c: ComponentRecord) => void;
}
function GraphView({ graph, comps, selId, kitName, gvp, onSelect }: GraphProps) {
  // The pan/zoom shell is the shared GraphCanvas template (#2208) — viewport ref/wheel/pan + the world
  // transform + the infinite dotted grid all live there; this brings only the toolbar + world content.
  const EDGE_COLOR = "var(--border-strong, #3a434d)";
  return (
    <GraphCanvas
      vp={gvp}
      world={graph.world}
      grid gridSize={22} gridColor="var(--border-soft, var(--border))"
      canvasBackground="var(--bg-canvas, var(--bg))"
      toolbar={
        <>
          <Text className="ds-eyebrow" as="span">Composition graph · {kitName}</Text>
          <Box style={{ flex: 1 }} />
          <ZoomControls vp={gvp} step={1.15} />
          <Box as="button" className="ds-act" onClick={() => gvp.fit()}>fit</Box>
        </>
      }
    >
      <svg width={graph.world.w} height={graph.world.h} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}>
        {graph.edges.map((e) => {
          const a = graph.pos.get(e.from), b = graph.pos.get(e.to);
          if (!a || !b) return null;
          // The shared graph line-type (#2222) with SIDE-PORT routing (#2226) — the composition graph
          // is a layered left→right DAG, same columnar flow as Glance.
          const g = graphEdge({ ...a, w: NODE_W, h: NODE_H }, { ...b, w: NODE_W, h: NODE_H }, { routing: "ports" });
          return (
            <g key={e.id}>
              <path d={g.d} stroke={EDGE_COLOR} strokeWidth={1.5} fill="none" />
              <path d={g.arrow} fill={EDGE_COLOR} />
            </g>
          );
        })}
      </svg>
      {comps.map((c) => {
        const pos = graph.pos.get(c.id); if (!pos) return null;
        return (
          <Box key={c.id} data-node onClick={() => onSelect(c)} className={`ds-node${c.id === selId ? " on" : ""}`} style={{ left: pos.x, top: pos.y, width: NODE_W }}>
            <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <RoleDot role={c.role} /><Text weight={600} size={13}>{c.name}</Text>
            </Box>
            <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Text size={10} tone="dim">{c.role}</Text><Text mono size="xxs" tone="muted">×{c.used}</Text>
            </Box>
          </Box>
        );
      })}
    </GraphCanvas>
  );
}

// ── Inspector ────────────────────────────────────────────────────────────────
function Inspector({ width, sel, kitName, activeVariant, allVariants, composes, onSelect }: {
  width: number; sel: ComponentRecord | null; kitName: string; activeVariant: string; allVariants: string[];
  composes: ReturnType<typeof resolveComposes>; onSelect: (c: ComponentRecord) => void;
}) {
  // The width splitter is the parent's handle (it drives `width`); the inspector just fills it.
  return (
    <Box className="ds-col ds-insp" style={{ width, flexBasis: width }}>
      <Box className="ds-colhead">
        <Text className="ds-eyebrow" as="span">Inspector</Text>
        <Text size={10} tone="dim" style={{ display: "flex", alignItems: "center", gap: 5 }}><StatusDot color="var(--success)" size={6} />editable</Text>
      </Box>
      {!sel ? (
        <Box style={{ padding: 16 }}><Text size={12} tone="dim">Select a component to inspect it.</Text></Box>
      ) : (
        <Box className="ds-scroll" style={{ flex: 1, padding: "16px 14px" }}>
          {/* title */}
          <Box style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
            <RoleDot role={sel.role} size={9} glow={4} style={{ marginTop: 5 }} />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text weight={600} size={16} style={{ letterSpacing: "-.01em" }}>{sel.name}</Text>
              <Text size={11.5} tone="muted" as="div" style={{ marginTop: 2 }}>{sel.role} · {kitName}</Text>
            </Box>
            <Text mono size={10} tone="muted" style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "2px 7px" }}>v{sel.version}</Text>
          </Box>
          {/* meta pills */}
          <Box style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
            <Chip color="var(--accent)">used ×{sel.used}</Chip>
            {sel.tags.map((t) => <Chip key={t}>{t}</Chip>)}
          </Box>
          {/* props */}
          <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8 }}>Props / API</Text>
          <Box className="ds-inspbox" style={{ marginBottom: 18 }}>
            {sel.props.length ? sel.props.map((pr) => (
              <Box key={pr.name} className="ds-insprow">
                <Box style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                  <Text mono size={11} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pr.name}</Text>{pr.req && <Text mono size={11} tone="danger">*</Text>}
                </Box>
                <Text mono size={10.5} tone="accent" style={{ maxWidth: 120, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pr.type}</Text>
              </Box>
            )) : <Box className="ds-insprow"><Text size={11.5} tone="dim">No public props.</Text></Box>}
          </Box>
          {/* variants */}
          <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8 }}>Variants</Text>
          <Box style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
            {allVariants.map((v) => (
              <Text key={v} size={11.5} tone={v === activeVariant ? "accent" : "muted"} style={{ background: "var(--bg-soft)", border: `1px solid ${v === activeVariant ? "var(--accent-dim, var(--accent))" : "var(--border)"}`, borderRadius: 6, padding: "3px 9px" }}>{v}</Text>
            ))}
          </Box>
          {/* composes */}
          <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8 }}>Composes</Text>
          <Box style={{ border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-soft)", padding: 12, marginBottom: 18 }}>
            {composes.length ? (
              <>
                <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <Text size={11.5} weight={600} style={{ background: "var(--bg-elev, var(--bg-canvas))", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px" }}>{sel.name}</Text>
                  <Text tone="dim" size={11}>depends on ↓</Text>
                </Box>
                <Box style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12, borderLeft: "1px dashed var(--border)" }}>
                  {composes.map(({ name, comp }) => (
                    <Box as={comp ? "button" : "span"} key={name} className="ds-rel" onClick={comp ? () => onSelect(comp) : undefined} aria-disabled={!comp} style={comp ? undefined : { opacity: .55, cursor: "default" }}>
                      <Text as="span" tone="dim" size={11}>└</Text><RoleDot role={comp?.role ?? "primitive"} size={6} /><Text as="span" size={11.5} tone="accent">{name}</Text>
                    </Box>
                  ))}
                </Box>
              </>
            ) : <Text size={11.5} tone="dim" style={{ fontStyle: "italic" }}>Primitive — composes nothing.</Text>}
          </Box>
          {/* guidance */}
          <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8 }}>Guidance</Text>
          <Box className="ds-inspbox">
            <Box style={{ padding: "9px 11px", borderBottom: "1px solid var(--border-soft, var(--border))" }}>
              <Text size={10} as="div" tone="success" style={{ marginBottom: 4 }}>✓ Use when</Text>
              <Text size={11.5} tone="muted" style={{ lineHeight: 1.5 }}>{sel.whenUse[0] ?? "—"}</Text>
            </Box>
            <Box style={{ padding: "9px 11px" }}>
              <Text size={10} as="div" tone="danger" style={{ marginBottom: 4 }}>✗ Avoid when</Text>
              <Text size={11.5} tone="muted" style={{ lineHeight: 1.5 }}>{sel.whenNot[0] ?? "—"}</Text>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────
function StudioEmpty({ inline }: { inline?: boolean } = {}) {
  return (
    <EmptyState
      icon="⬡" iconVariant="dashed"
      title={NO_COMPONENTS_TITLE}
      description={<>A <b style={{ color: "var(--fg)" }}>kit</b> is a technology-scoped namespace of proven components. Seed one from the UI already living in your repo, or start an empty kit.</>}
      style={{ height: inline ? undefined : "100%" }}
    />
  );
}
