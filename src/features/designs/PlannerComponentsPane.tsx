// Planner Components pane (#2314) — the UI-Kit blueprint's `test_ui` stage body. A project-scoped lens
// on the proven-component library (direction 1a of the Planner Components Pane design), docked in the
// planner's focused pane. A Components ⇄ Full UI toggle: inspect one component in isolation (list +
// inline-expand preview/props/guidance + pull-into-plan / request / open-in-studio hand-offs) or the
// whole app assembled from the kit (highlighted, with a legend). Reuses the global `bsc ui`
// store + the shared specimen renderer; "Open in studio" hands off to the Design Studio workspace (#2308).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { RoleDot, KitChip } from "./kitChrome";
import { ROLE_COLOR, matchesQuery, NO_COMPONENTS_TITLE, type ComponentRecord, type Role } from "./lib/model";
import "./plannerComponentsPane.css";

type Mode = "components" | "full";
/** Role order for assembling a representative screen (structure first, primitives last). */
const ROLE_RANK: Record<Role, number> = { page: 0, layout: 1, composite: 2, primitive: 3, service: 4 };
/** How many kit components the Full-UI view assembles. */
const ASSEMBLE_MAX = 6;
const TOAST_MS = 1900;

/** A lightweight, non-interactive thumbnail for the list + assembly views (#2824): a framed role dot.
 *  The LIVE render (esbuild + iframe) is the Design Studio's single-component surface — too heavy to run
 *  per list item — so this pane shows a compact role marker (the name/role already label each row) and
 *  links to the studio. Renders NO component-name text (the row owns that). */
function Specimen({ comp, height }: { comp: ComponentRecord; scale?: number; height?: number }) {
  return (
    <Box style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: height ?? "100%", minHeight: 40, padding: 10, pointerEvents: "none", borderRadius: 8, background: "var(--bg-elev, var(--bg-soft))", border: "1px dashed var(--border-soft)" }}>
      <RoleDot role={comp.role} size={12} />
    </Box>
  );
}

export function PlannerComponentsPane(
  { pullControl }: { pullControl?: (artifactId: string) => ReactNode } = {},
) {
  const components = useAppStore((s) => s.components);
  const kits = useAppStore((s) => s.kits);
  const navigate = useAppStore((s) => s.navigate);

  const [kitId, setKitId] = useState(() => kits[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("components");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const flash = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  const kit = kits.find((k) => k.id === kitId) ?? kits[0];
  const inKit = useMemo(() => components.filter((c) => c.kitId === kitId), [components, kitId]);
  const list = useMemo(() => inKit.filter((c) => matchesQuery(c, query)), [inKit, query]);
  // The whole-app assembly: structure-first, capped — the "app built from this kit".
  const assembled = useMemo(
    () => [...inKit].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role]).slice(0, ASSEMBLE_MAX),
    [inKit],
  );

  // The Design Studio is now a Planner tab (#move-to-planner): open the Planner Workspace on its "designs"
  // page rather than a standalone rail Workspace.
  const openInStudio = () => navigate({ workspace: "projects", page: "designs" });

  if (!kit) {
    return (
      <Box className="pcp-root">
        <EmptyState
          size="sm"
          title={NO_COMPONENTS_TITLE}
          description="The proven-component library is empty — seed a kit to browse it here."
        />
      </Box>
    );
  }

  return (
    <Box className="pcp-root">
      {/* ── header ── */}
      <Box className="pcp-head">
        <Box className="pcp-headrow">
          <Text weight={600} size={13}>Components</Text>
          <Box style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Text mono size="xxs" tone="dim">ACTIVE KIT{kits.length > 1 ? "S" : ""}</Text>
            {kits.map((k) => (
              <KitChip key={k.id} kit={k} on={k.id === kitId} className="pcp-kitchip" title={k.stack}
                onClick={() => { setKitId(k.id); setOpenId(null); }} />
            ))}
          </Box>
        </Box>
        <Box className="pcp-toggle">
          <SegmentedControl
            label=""
            options={[
              { label: "▤ Components", on: mode === "components", onClick: () => setMode("components") },
              { label: "▦ Full UI", on: mode === "full", onClick: () => setMode("full") },
            ]}
          />
        </Box>
      </Box>

      {mode === "components" ? (
        <>
          {/* search */}
          <Box className="pcp-search">
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search components this app needs…"
              aria-label="Search components"
              inputStyle={{ fontSize: 12 }}
              trailing={<Text mono size="xxs" tone="dim">{list.length}/{inKit.length}</Text>}
            />
          </Box>

          {/* list */}
          <Box className="pcp-scroll pcp-list">
            {list.map((c) => {
              const open = openId === c.id;
              return (
                <Box key={c.id} className="pcp-item">
                  <Box as="button" className={`pcp-row${open ? " on" : ""}`} onClick={() => setOpenId(open ? null : c.id)}>
                    <Box className="pcp-thumb"><Specimen comp={c} scale={0.5} /></Box>
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Box style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <RoleDot role={c.role} size={7} />
                        <Text weight={600} size={12.5}>{c.name}</Text>
                      </Box>
                      <Text mono size="xxs" tone="dim" as="div" style={{ marginTop: 3 }}>{kit.name} · {c.role}</Text>
                    </Box>
                    <Text as="span" className="pcp-status">in library ✓</Text>
                  </Box>

                  {open && (
                    <Box className="pcp-detail">
                      <Box className="pcp-preview">
                        <Specimen comp={c} scale={0.85} height={126} />
                        <Text as="span" className="pcp-preview-tag">read-only preview</Text>
                      </Box>
                      <Box style={{ padding: "12px 14px" }}>
                        <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 7 }}>Props</Text>
                        <Box style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 13 }}>
                          {c.props.slice(0, 4).map((p) => (
                            <Box key={p.name} className="pcp-proprow">
                              <Text mono tone="muted" size={11.5}>{p.name}</Text><Text mono tone="accent" size={10.5}>{p.type}</Text>
                            </Box>
                          ))}
                          {c.props.length === 0 && <Text mono size={11} tone="dim">No public props.</Text>}
                        </Box>
                        <Box style={{ display: "flex", gap: 12, marginBottom: 14 }}>
                          <Box style={{ flex: 1 }}>
                            <Text size={10} tone="success" as="div" style={{ marginBottom: 4 }}>✓ Use when</Text>
                            <Text size={11} tone="muted" style={{ lineHeight: 1.5 }}>{c.whenUse[0] ?? "—"}</Text>
                          </Box>
                          <Box style={{ flex: 1 }}>
                            <Text size={10} tone="danger" as="div" style={{ marginBottom: 4 }}>✗ Avoid</Text>
                            <Text size={11} tone="muted" style={{ lineHeight: 1.5 }}>{c.whenNot[0] ?? "—"}</Text>
                          </Box>
                        </Box>
                        {/* #4267: the real hand-off. This used to be a "Pull into plan" button that
                            only flashed a toast — nothing was recorded, so nothing reached the fleet.
                            The planner now supplies a control that writes the id onto a feature's
                            `requires`, the plan → library edge workers actually read (#4191). */}
                        {pullControl && (
                          <Box style={{ padding: "8px 0 2px" }}>{pullControl(c.id)}</Box>
                        )}
                        <Box className="pcp-actions">
                          <Button variant="ghost" size="sm" onClick={openInStudio}>Open in studio ↗</Button>
                        </Box>
                      </Box>
                    </Box>
                  )}
                </Box>
              );
            })}
            {list.length === 0 && (
              <Text size={11.5} tone="dim" as="div" style={{ padding: "10px 2px", fontStyle: "italic" }}>No components match “{query}”.</Text>
            )}
            <Box as="button" className="pcp-req" onClick={() => flash("Requested a new component — handed off to Design studio")}>
              <Text as="span" tone="dim">＋</Text> Request a new component
            </Box>
          </Box>
        </>
      ) : (
        <>
          <Box className="pcp-full-head">
            <Text size={11.5} tone="muted">Assembled from <b style={{ color: "var(--fg)" }}>{assembled.length}</b> kit components</Text>
            <Box style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Toggle size="sm" on={highlight} onClick={() => setHighlight((h) => !h)} role="switch" ariaChecked={highlight} />
              <Text size={11} tone="muted">highlight</Text>
            </Box>
          </Box>
          <Box className="pcp-scroll pcp-full">
            <Box className="pcp-assembled">
              {assembled.map((c, i) => (
                <Box key={c.id} className={`pcp-cell${highlight ? " hl" : ""}`} style={{ padding: 8 }}>
                  {highlight && <Box as="span" className="pcp-cell-tag" style={{ background: ROLE_COLOR[c.role] }}>{i + 1}</Box>}
                  <Box style={{ display: "flex", justifyContent: "center", overflow: "hidden" }}>
                    <Specimen comp={c} scale={0.8} />
                  </Box>
                </Box>
              ))}
            </Box>
            <Box style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 2 }}>Legend</Text>
              {assembled.map((c, i) => (
                <Box as="button" key={c.id} className="pcp-legend-row" onClick={() => { setMode("components"); setOpenId(c.id); }}>
                  <Box as="span" className="pcp-legend-n" style={{ background: ROLE_COLOR[c.role] }}>{i + 1}</Box>
                  <Text size={12} weight={500}>{c.name}</Text>
                  <Text mono size="xxs" tone="dim">{c.role}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        </>
      )}

      {toast && (
        <Box className="pcp-toast">
          <StatusDot color="var(--success)" size={7} />
          <Text size={12}>{toast}</Text>
        </Box>
      )}
    </Box>
  );
}
