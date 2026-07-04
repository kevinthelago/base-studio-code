// The Component Library pane (#2269) — the condensed, self-measuring design-system surface that is the
// body of the planner's `test_ui` stage. One responsive column: [kit pills · search · picker] (top) ·
// [selected component: preview + Props/Usage/Composes/Source] (scroll) · [✦ new-variant bar] (bottom).
// It measures itself (ResizeObserver → narrow/wide) so it works unchanged in a desktop planner pane and
// on a narrow mobile screen. Data comes from the global component store via the `bsc` bridge (seed for
// now); the generate loop is optimistic + local until the store lands.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { Button } from "@/shared/ui/controls/Button";
import { Chip } from "@/shared/ui/data/Chip";
import { Code } from "@/shared/ui/data/Code";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Text } from "@/shared/ui/typography/Text";
import { ROLE_COLOR, matchesQuery, resolveComposes, resolveUsedBy, type ComponentRecord, type Role } from "./lib/model";
import { componentRules, ruleMessage } from "./lib/rules";
import { renderSpecimen, type PreviewTheme } from "./specimens";
import "./componentLibraryPane.css";

/** Pane width (px) below which the pane switches to its single-column narrow layout. */
const NARROW_MAX = 620;
/** Optimistic delay before a generated variant appears (the store isn't wired yet). */
const GEN_DELAY_MS = 1500;
const VIEWPORT_W: Record<string, number> = { sm: 360, md: 640, lg: 960 };

const roleDot = (role: Role, size = 7) => (
  <Box as="span" className="clib-dot" style={{ width: size, height: size, background: ROLE_COLOR[role] }} />
);

export function ComponentLibraryPane() {
  const components = useAppStore((s) => s.components);
  const kits = useAppStore((s) => s.kits);

  const firstFor = (kitId: string) => components.find((c) => c.kitId === kitId);
  const [kitId, setKitId] = useState(() => kits[0]?.id ?? "");
  const [compId, setCompId] = useState(() => firstFor(kits[0]?.id ?? "")?.id ?? "");
  const [query, setQuery] = useState("");
  const [variant, setVariant] = useState(() => firstFor(kits[0]?.id ?? "")?.variants[0] ?? "default");
  const [theme, setTheme] = useState<PreviewTheme>("dark");
  const [viewport, setViewport] = useState<"sm" | "md" | "lg">("md");
  const [tab, setTab] = useState<"props" | "usage" | "composes" | "rules" | "source">("props");
  const [genPrompt, setGenPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genVariants, setGenVariants] = useState<Record<string, string[]>>({});
  const [narrow, setNarrow] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const genTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Self-measure: narrow layout under NARROW_MAX so the same pane fits mobile + a desktop pane.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setNarrow(entries[0].contentRect.width < NARROW_MAX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => { if (genTimer.current) clearTimeout(genTimer.current); }, []);

  const inKit = useMemo(() => components.filter((c) => c.kitId === kitId), [components, kitId]);
  const filtered = useMemo(() => inKit.filter((c) => matchesQuery(c, query)), [inKit, query]);
  // The component shown in the detail: the selected one when it's still visible (in the current kit +
  // matching the search), else the first match — so a search that filters the selection out shows a
  // matching component, and a search that matches NOTHING shows the empty state (sel === null). Derived
  // (no selection-repair effect, which cascades renders).
  const selById = components.find((c) => c.id === compId && c.kitId === kitId);
  const sel = selById && matchesQuery(selById, query) ? selById : filtered[0] ?? null;

  const selectKit = (id: string) => {
    const first = components.find((c) => c.kitId === id && matchesQuery(c, query)) ?? firstFor(id);
    setKitId(id);
    setCompId(first?.id ?? "");
    setVariant(first?.variants[0] ?? "default");
    setTab("props");
  };
  const selectComp = (c: ComponentRecord) => {
    setCompId(c.id); setKitId(c.kitId); setVariant(c.variants[0] ?? "default");
    setTab("props"); setTheme("dark"); setViewport("md");
  };

  const doGenerate = () => {
    if (generating || !genPrompt.trim() || !sel) return;
    const slug = genPrompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").split("-").filter(Boolean).slice(0, 2).join("-") || "variant";
    const existing = new Set([...sel.variants, ...(genVariants[sel.id] ?? [])]);
    const name = existing.has(slug) ? `${slug}-2` : slug;
    setGenerating(true);
    genTimer.current = setTimeout(() => {
      setGenVariants((g) => ({ ...g, [sel.id]: [...(g[sel.id] ?? []), name] }));
      setVariant(name);
      setGenerating(false);
      setGenPrompt("");
    }, GEN_DELAY_MS);
  };

  const kit = kits.find((k) => k.id === kitId) ?? kits[0];
  const allVariants = sel ? [...sel.variants, ...(genVariants[sel.id] ?? [])] : [];
  const activeVariant = allVariants.includes(variant) ? variant : allVariants[0] ?? "default";
  const composes = sel ? resolveComposes(sel, components) : [];
  const usedBy = sel ? resolveUsedBy(sel, components) : [];
  const rules = sel ? componentRules(sel) : [];

  return (
    // eslint-disable-next-line no-restricted-syntax -- DOM ref for the ResizeObserver that drives the narrow/wide layout
    <div className="clib-pane" ref={rootRef} data-narrow={narrow} data-testid="clib-pane">
      {/* ── head ── */}
      <Box className="clib-head">
        <Box className="clib-pills clib-scroll">
          {kits.map((k) => (
            <Box as="button" key={k.id} className={`clib-pill${k.id === kitId ? " on" : ""}`} title={k.stack} onClick={() => selectKit(k.id)}>
              <Box as="span" className="clib-dot" style={{ background: k.dot }} />{k.name}
            </Box>
          ))}
        </Box>
        <Box className="clib-search">
          <Text mono tone="dim" size={13}>⌕</Text>
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke bare search box (Field imposes a labelled layout) */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${kit?.name ?? ""} components…`}
            aria-label="Search components"
          />
          <Text mono tone="dim" size="xxs">{filtered.length} / {inKit.length}</Text>
        </Box>
        <Box className="clib-picker clib-scroll">
          {filtered.map((c) => (
            <Box as="button" key={c.id} className={`clib-chip${c.id === compId ? " on" : ""}`} onClick={() => selectComp(c)}>
              <Box as="span" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {roleDot(c.role)}
                <Text mono weight={600} size={12}>{c.name}</Text>
              </Box>
              <Text mono tone="dim" size="xxs">{c.role} · {c.used}×</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* ── body ── */}
      <Box className="clib-body clib-scroll">
        {sel ? (
          <Box className="clib-detail">
            {/* header */}
            <Box className="clib-detail-head">
              <Box style={{ flex: 1, minWidth: 180 }}>
                <Box style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                  <Text mono as="h2" weight={600} size={19} style={{ margin: 0, letterSpacing: "-.01em" }}>{sel.name}</Text>
                  <Chip color={ROLE_COLOR[sel.role]} dot>{sel.role}</Chip>
                </Box>
                <Text mono tone="muted" size="xxs" as="div" style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 8 }}>
                  <Box as="span" className="clib-dot" style={{ background: kit?.dot }} />{kit?.name}
                  <Box as="span">·</Box>v{sel.version}<Box as="span">·</Box>used {sel.used}×
                </Text>
              </Box>
              <Box style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {sel.tags.map((tg) => <Chip key={tg}>{tg}</Chip>)}
              </Box>
            </Box>

            {/* preview */}
            <Box className="clib-preview">
              <Box className="clib-preview-controls">
                <SegmentedControl label="variant" options={allVariants.map((v) => ({ label: v, on: v === activeVariant, onClick: () => setVariant(v) }))} />
                <Box style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <SegmentedControl label="theme" options={(["dark", "light"] as PreviewTheme[]).map((th) => ({ label: th, on: th === theme, onClick: () => setTheme(th) }))} />
                  <SegmentedControl label="width" options={(["sm", "md", "lg"] as const).map((vp) => ({ label: vp, on: vp === viewport, onClick: () => setViewport(vp) }))} />
                </Box>
              </Box>
              <Box className="clib-preview-surface">
                <Box className="clib-preview-frame" style={{ width: VIEWPORT_W[viewport] }}>
                  {renderSpecimen(sel, activeVariant, theme)}
                </Box>
              </Box>
            </Box>

            {/* tabs */}
            <Box className="clib-tabs" role="tablist">
              {(["props", "usage", "composes", "rules", "source"] as const).map((tb) => {
                const count = tb === "props" ? sel.props.length : tb === "composes" ? composes.length + usedBy.length : tb === "rules" ? rules.length : null;
                return (
                  <Box as="button" key={tb} role="tab" aria-selected={tab === tb} className={`clib-tab${tab === tb ? " on" : ""}`} onClick={() => setTab(tb)}>
                    {tb}{count != null && <Box as="span" className="clib-tab-count">{count}</Box>}
                  </Box>
                );
              })}
            </Box>

            <Box className="clib-tabpanel">
              {tab === "props" && (
                sel.props.length ? (
                  <Box>
                    <Box className="clib-proprow" style={{ padding: "0 10px 6px" }}>
                      <Text mono tone="dim" size="xxs" style={{ textTransform: "uppercase", letterSpacing: ".07em" }}>prop</Text>
                      <Text mono tone="dim" size="xxs" style={{ textTransform: "uppercase", letterSpacing: ".07em" }}>type</Text>
                      <Text mono tone="dim" size="xxs" style={{ textTransform: "uppercase", letterSpacing: ".07em" }}>description</Text>
                    </Box>
                    {sel.props.map((pr, i) => (
                      <Box key={pr.name} className={`clib-proprow${i % 2 ? "" : " alt"}`}>
                        <Box as="span" style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                          <Text mono size={11.5}>{pr.name}</Text>{pr.req && <Text mono size={11} tone="danger">*</Text>}
                        </Box>
                        <Text mono size={11} tone="accent" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{pr.type}</Text>
                        <Text size={11.5} tone="muted" style={{ lineHeight: 1.5 }}>{pr.desc}</Text>
                      </Box>
                    ))}
                  </Box>
                ) : (
                  <Text mono tone="dim" size={11.5} as="div" style={{ padding: "8px 10px" }}>No public props — this component reads from the global store.</Text>
                )
              )}

              {tab === "usage" && (
                <Box style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <Box>
                    <Text mono size="xxs" as="div" style={{ textTransform: "uppercase", letterSpacing: ".07em", color: "var(--success)", marginBottom: 8 }}>When to use</Text>
                    {sel.whenUse.map((w) => (
                      <Box key={w} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
                        <Text tone="success" style={{ flex: "0 0 auto" }}>✓</Text><Text size={12.5} style={{ lineHeight: 1.55 }}>{w}</Text>
                      </Box>
                    ))}
                  </Box>
                  <Box>
                    <Text mono size="xxs" as="div" style={{ textTransform: "uppercase", letterSpacing: ".07em", color: "var(--danger)", marginBottom: 8 }}>When not to</Text>
                    {sel.whenNot.map((w) => (
                      <Box key={w} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
                        <Text tone="danger" style={{ flex: "0 0 auto" }}>✕</Text><Text size={12.5} style={{ lineHeight: 1.55 }}>{w}</Text>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}

              {tab === "composes" && (
                <Box className="clib-graph">
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text mono size="xxs" as="div" tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 9 }}>used by ↑ {usedBy.length}</Text>
                    {usedBy.length ? (
                      <Box style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                        {usedBy.map((c) => (
                          <Box as="button" key={c.id} className="clib-rel" onClick={() => selectComp(c)}>{roleDot(c.role, 6)}{c.name}</Box>
                        ))}
                      </Box>
                    ) : <Text mono tone="dim" size={11}>Nothing composes this yet.</Text>}
                  </Box>
                  <Box style={{ flex: "0 0 auto", display: "flex", justifyContent: narrow ? "flex-start" : "center", alignItems: "center", padding: "0 4px" }}>
                    <Box as="span" style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, color: "var(--accent)", padding: "7px 13px", borderRadius: 8, background: "var(--accent-soft)", border: "1px solid var(--accent-dim)", whiteSpace: "nowrap" }}>{sel.name}</Box>
                  </Box>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text mono size="xxs" as="div" tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 9 }}>composes ↓ {composes.length}</Text>
                    {composes.length ? (
                      <Box style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                        {composes.map(({ name, comp }) => comp ? (
                          <Box as="button" key={name} className="clib-rel" onClick={() => selectComp(comp)}>{roleDot(comp.role, 6)}{name}</Box>
                        ) : (
                          <Box as="span" key={name} className="clib-rel disabled" aria-disabled>{roleDot("primitive", 6)}{name}</Box>
                        ))}
                      </Box>
                    ) : <Text mono tone="dim" size={11}>A leaf primitive — composes nothing.</Text>}
                  </Box>
                </Box>
              )}

              {tab === "rules" && (
                rules.length ? (
                  <Box style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    <Text mono tone="dim" size="xxs" as="div" style={{ textTransform: "uppercase", letterSpacing: ".07em" }}>
                      lint rules an app using this kit auto-fires
                    </Text>
                    {rules.map((r) => (
                      <Box key={r.id} pad="sm" border="soft" radius="md" bg="var(--bg-canvas)">
                        <Box style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 5 }}>
                          <Chip color={r.derived ? "var(--info)" : "var(--accent)"}>{r.derived ? "derived" : "authored"}</Chip>
                          <Text mono size={11.5}>
                            {r.kind === "forbid-element" ? `<${r.target}>` : `"${r.target}"`}
                          </Text>
                          <Text mono tone="dim" size={11}>→</Text>
                          <Text mono size={11.5} tone="accent">{r.use}</Text>
                        </Box>
                        <Text size={11.5} tone="muted" style={{ lineHeight: 1.5 }}>{ruleMessage(r)}</Text>
                      </Box>
                    ))}
                  </Box>
                ) : (
                  <Text mono tone="dim" size={11.5} as="div" style={{ padding: "8px 10px" }}>
                    No lint rules yet — set a `wraps` hint or author a rule to enforce this component.
                  </Text>
                )
              )}

              {tab === "source" && (
                <Box>
                  <Text mono tone="dim" size="xxs" as="div" style={{ marginBottom: 6 }}>{sel.src}</Text>
                  <Code maxHeight={320} wrap={false}>{sel.srcText}</Code>
                </Box>
              )}
            </Box>
          </Box>
        ) : (
          <EmptyState
            icon="◫"
            iconVariant="dashed"
            title={`No match in ${kit?.name ?? "this kit"}`}
            description="Clear the search or switch kits to browse the proven-component library."
          />
        )}
      </Box>

      {/* ── generate bar ── */}
      <Box className="clib-genbar">
        {generating && <Box className="clib-scan" />}
        <Box className="clib-genbar-row">
          <Text mono tone="accent" size="xxs" style={{ textTransform: "uppercase", letterSpacing: ".07em", whiteSpace: "nowrap" }}>✦ new variant</Text>
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline prompt box for the generate loop */}
          <input
            value={genPrompt}
            onChange={(e) => setGenPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doGenerate(); }}
            disabled={generating || !sel}
            placeholder={sel ? `Describe a new ${sel.name} variant — e.g. 'a loading state'` : "Select a component first"}
            aria-label="New variant prompt"
          />
          <Button variant="primary" size="sm" onClick={doGenerate} disabled={generating || !genPrompt.trim() || !sel}>
            {generating ? "generating…" : "Generate"}
          </Button>
        </Box>
      </Box>
    </div>
  );
}
