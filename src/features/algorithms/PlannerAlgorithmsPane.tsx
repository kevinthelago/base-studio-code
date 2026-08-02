// Planner Algorithms pane (#4265) — the twin of the Design Studio's `PlannerComponentsPane` (#2314),
// docked in the project planner. A project-scoped lens on the ALGORITHMS knowledge graph: the same
// shape as the components lens (facet + search + list + inline inspect + open-in-studio), over the
// other half of the artifact surface.
//
// Why it exists: the planner's features directive tells the session to CHECK THE LIBRARY BEFORE
// COMMISSIONING — `bsc graph impl list` before `bsc-commission librarian` — and the user had no way to
// see that library while it happened. The component half had a pane; the computation half never did.
//
// Reads the LIVE graph (`useKnowledgeGraph` polls `bsc graph dump`), not the packaged seed alone, so a
// librarian curating in the background shows up here — the store is the source of truth, the seed is a
// cache (the golden rule).
import { useMemo, useState, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { useKnowledgeGraph } from "./useKnowledgeGraph";
import {
  TECH_META, kitTechs, kitImpls, matchesImpl, usedByImpl,
  type AlgoImpl, type ImplRole, type Tech,
} from "./lib/knowledge";

/** Algorithms before primitives: a primitive DESCRIBES a language built-in (#2972), so it's reference
 *  material under the composed work rather than a peer of it. */
const ROLE_RANK: Record<ImplRole, number> = { algorithm: 0, primitive: 1 };
const ROLE_COLOR: Record<ImplRole, string> = {
  algorithm: "var(--accent, #58a6ff)",
  primitive: "var(--muted, #8b949e)",
};

/** How much of an implementation's body the inline inspector shows before it becomes noise. The full
 *  text is a `bsc graph impl get` away, and the studio renders it properly. */
const CODE_PREVIEW_CHARS = 600;

/** One inspected implementation: what the planner actually needs to decide "reuse this or commission a
 *  new one" — what it does, what it builds on, where it came from, and how it's faceted. */
function ImplDetail({ impl, usedBy, pullControl }: {
  impl: AlgoImpl; usedBy: AlgoImpl[]; pullControl?: (artifactId: string) => ReactNode;
}) {
  const facets: [string, string][] = [];
  if (impl.kind) facets.push(["kind", impl.kind]);
  if (impl.domain) facets.push(["domain", impl.domain]);
  if (impl.tags?.length) facets.push(["tags", impl.tags.join(", ")]);
  if (impl.ref) facets.push(["describes", impl.ref]);
  // PROVENANCE (#4091/#4107) — surfaced because an impl with no `src` cannot sit in the folder tree the
  // rail organizes by, and that gap is invisible everywhere else in the app (#4136).
  facets.push(["source", impl.src ?? "— not recorded"]);
  if (impl.folder) facets.push(["folder", impl.folder]);

  return (
    <Stack gap={6} style={{ padding: "8px 10px 10px 26px" }}>
      {impl.summary && <Text size={11.5}>{impl.summary}</Text>}
      {impl.composes.length > 0 && (
        <Text tone="muted" size={11}>builds on: {impl.composes.join(" · ")}</Text>
      )}
      {usedBy.length > 0 && (
        <Text tone="muted" size={11}>used by: {usedBy.map((u) => u.name).join(" · ")}</Text>
      )}
      {facets.map(([k, v]) => (
        <Text key={k} tone="muted" size={11}><b>{k}</b> — {v}</Text>
      ))}
      {impl.code && (
        <Box
          as="pre"
          style={{
            margin: 0, padding: "6px 8px", borderRadius: 4, overflow: "auto", maxHeight: 160,
            fontSize: 10.5, lineHeight: 1.45, background: "var(--bg-elev2, var(--bg-soft))",
            border: "1px solid var(--border-soft)",
          }}
        >
          {impl.code.slice(0, CODE_PREVIEW_CHARS)}{impl.code.length > CODE_PREVIEW_CHARS ? "\n…" : ""}
        </Box>
      )}
      {/* #4267: the plan -> library edge. A render prop, so this lens never learns what a plan is —
          the planner supplies the control, and the pane rendered anywhere else simply has none. */}
      {pullControl?.(impl.id)}
    </Stack>
  );
}

export function PlannerAlgorithmsPane(
  { pullControl }: { pullControl?: (artifactId: string) => ReactNode } = {},
) {
  const graph = useKnowledgeGraph();
  const navigate = useAppStore((s) => s.navigate);

  const techs = useMemo(() => kitTechs(graph), [graph]);
  const [tech, setTech] = useState<Tech | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  // The selected language, falling back to the first the graph actually carries — so the pane never
  // shows an empty list because it defaulted to a language nothing was curated in.
  const activeTech: Tech | undefined = (tech && techs.includes(tech) ? tech : techs[0]);

  const impls = useMemo(() => {
    if (!activeTech) return [];
    return kitImpls(graph, activeTech)
      .filter((im) => matchesImpl(im, query))
      .slice()
      .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.name.localeCompare(b.name));
  }, [graph, activeTech, query]);

  const total = activeTech ? kitImpls(graph, activeTech).length : 0;

  if (techs.length === 0) {
    return (
      <EmptyState
        iconVariant="dashed"
        icon="∑"
        title="No algorithms in the library yet — the librarian curates them into the graph"
      />
    );
  }

  return (
    <Stack gap={8} style={{ flex: 1, minHeight: 0, padding: 10 }}>
      <Row gap={8} wrap align="center">
        {techs.length > 1 && (
          <SegmentedControl
            options={techs.map((t) => ({
              label: TECH_META[t].label, on: activeTech === t, onClick: () => setTech(t),
            }))}
          />
        )}
        <Box style={{ flex: 1, minWidth: 120 }}>
          <SearchField value={query} onChange={setQuery} placeholder="Search algorithms…" />
        </Box>
        <Button size="sm" onClick={() => navigate({ workspace: "projects", page: "algorithms" })}>
          Open in studio
        </Button>
      </Row>

      <Text tone="muted" size={11}>
        {query ? `${impls.length} of ${total}` : `${total}`} in the library — reuse before commissioning a new one
      </Text>

      <Stack gap={2} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {impls.length === 0 ? (
          <EmptyState iconVariant="dashed" icon="∅" title={`Nothing matches “${query}”`} />
        ) : (
          impls.map((im) => {
            const isOpen = openId === im.id;
            return (
              <Box
                key={im.id}
                style={{
                  borderRadius: 6,
                  border: "1px solid " + (isOpen ? "var(--border)" : "transparent"),
                  background: isOpen ? "var(--bg-elev, var(--bg-soft))" : "transparent",
                }}
              >
                <Row
                  gap={8}
                  align="center"
                  onClick={() => setOpenId(isOpen ? null : im.id)}
                  style={{ cursor: "pointer", padding: "5px 8px" }}
                >
                  <StatusDot color={ROLE_COLOR[im.role]} size={8} />
                  <Text size={12} style={{ flex: 1, minWidth: 0 }}>{im.name}</Text>
                  <Text tone="dim" size={10} mono>{im.role}</Text>
                  {/* An algorithm with no provenance can't sit in the folder tree (#4136) — mark it
                      here rather than leaving the gap silent. */}
                  {im.role === "algorithm" && !im.src && (
                    <Text tone="dim" size={10} title="No source path recorded — it can't be placed in the folder tree">
                      no source
                    </Text>
                  )}
                </Row>
                {isOpen && <ImplDetail impl={im} usedBy={usedByImpl(graph, im.id)} pullControl={pullControl} />}
              </Box>
            );
          })
        )}
      </Stack>
    </Stack>
  );
}
