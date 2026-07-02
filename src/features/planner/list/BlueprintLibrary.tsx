import { useState, useRef } from "react";
import { useClickOutside } from "@/shared/hooks/useClickOutside";
import { MoreHorizontal, Pencil, Check, Layers, GitFork, Shield, Wrench, Database, Link2, Download, Trash2 } from "lucide-react";
import { useAppStore } from "@/store";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import { timeAgoMs } from "@/shared/lib/core/format";
import { AUTHORING_BLUEPRINT_ID, CATEGORY_META, uid, type Blueprint, type BlueprintGist, type BlueprintCategory, type BlueprintStage } from "../stages/blueprints";
import { PlanGateRow } from "../pane/PlanStageBar";
import { ImportModal, type PreviewBlueprint } from "../blueprints/BlueprintModals";
import { BlueprintImportModal } from "../blueprints/BlueprintImportModal";
import { DEFAULT_GIST_SOURCE } from "../blueprints/blueprintCatalog";
import { manifestToBlueprint, bundledSkillsFromManifest } from "../blueprints/blueprintShare";
import { installFromGist, gistIdFromUrl } from "@/features/planner/lib/gist/gist";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { DraftRow } from "./drafts";

// ── Blueprint display helpers (#…): a hued icon tile keyed by lifecycle category, a visibility
// pill (draft / private gist / public gist), and a shortened gist link. ────────────────────────
const CAT_ICON: Record<BlueprintCategory, typeof Layers> = {
  greenfield: Layers, transform: GitFork, harden: Shield, maintain: Wrench, data: Database,
};
function catHue(cat: BlueprintCategory): string {
  return `oklch(0.75 0.13 ${CATEGORY_META[cat]?.h ?? 70})`;
}
function prettyGist(g?: BlueprintGist): string | undefined {
  if (!g) return undefined;
  if (g.url) {
    const s = g.url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    return s.length > 32 ? s.slice(0, 30) + "…" : s;
  }
  return g.id ? `gist · ${g.id.slice(0, 7)}` : undefined;
}

/** A blueprint surfaced in the Projects page: either a saved library blueprint, or an in-progress
 *  authoring draft (a planning session bound to the blueprint-author lifecycle). */
export interface BpItem {
  id: string;          // library blueprint id, or "draft:<key>" for an authoring draft
  kind: "library" | "draft";
  draftKey?: string;   // present for authoring drafts (its resume / delete target)
  draftTitle?: string;
  draftPitch?: string;
  name: string;
  pitch: string;
  category: BlueprintCategory;
  stages: number;
  sections: BlueprintStage[];   // the blueprint's sections — drives the gate-row preview
  builtIn?: boolean;   // a code-owned app template (can't be deleted)
  gistLabel?: string;
  updatedLabel: string;
  sort: number;        // recency key (epoch ms)
}

/** Build the blueprint list surfaced in the rail: ALL blueprints — the built-in app templates AND
 *  the user's saved library — so a blueprint can be SELECTED for the next project right here
 *  (#blueprints), plus any in-progress authoring drafts not yet saved. The saved/published version
 *  wins the dedup (by name) over a still-open authoring draft. */
export function buildBlueprintItems(
  blueprints: Blueprint[],
  authoringDrafts: DraftRow[],
  planAuthoredBlueprint: Record<string, Blueprint>,
): BpItem[] {
  const items: BpItem[] = [];
  const seen = new Set<string>();
  for (const b of blueprints) {
    seen.add(b.name.toLowerCase());
    const hasGist = !!b.gist?.id;
    const sortMs = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    items.push({
      id: b.id, kind: "library", name: b.name,
      pitch: b.pitch ?? b.desc ?? "",
      category: b.category ?? "greenfield",
      stages: b.sections.length, sections: b.sections,
      builtIn: b.origin === "built-in",
      gistLabel: hasGist ? prettyGist(b.gist) : undefined,
      updatedLabel: timeAgoMs(sortMs), sort: sortMs,
    });
  }
  for (const d of authoringDrafts) {
    const bp = planAuthoredBlueprint[d.key] as Blueprint | undefined;
    const name = bp?.name ?? d.title;
    if (seen.has(name.toLowerCase())) continue;
    items.push({
      id: "draft:" + d.key, kind: "draft", draftKey: d.key, draftTitle: d.title, draftPitch: d.pitch,
      name, pitch: bp?.pitch ?? bp?.desc ?? d.pitch ?? "",
      category: bp?.category ?? "greenfield",
      stages: bp?.sections?.length ?? 0, sections: bp?.sections ?? [],
      updatedLabel: timeAgoMs(d.sort), sort: d.sort,
    });
  }
  return items;
}

/** A compact blueprint card for the right rail — hued icon tile + name + ⋯ menu, then a
 *  category / stages / visibility meta row and an optional gist link. */
function BlueprintCard({ b, onUse, onOpen, onDelete, activeId, menuOpenId, setMenuOpenId }: {
  b: BpItem;
  onUse: (id: string) => void;
  onOpen: (b: BpItem) => void;
  onDelete: (b: BpItem) => void;
  activeId?: string;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
}) {
  const isActive = b.id === activeId;
  const menuId = "bp:" + b.id;
  const isOpen = menuOpenId === menuId;
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuRef, () => setMenuOpenId(null), isOpen);

  const hue = catHue(b.category);
  const Icon = CAT_ICON[b.category] ?? Layers;

  return (
    <Box
      className="bp-rail-card"
      onClick={() => onUse(b.id)}
      title={isActive ? "Selected — new projects use this blueprint" : "Select this blueprint for new projects"}
      pad={[12, 13]} bg={isActive ? "var(--bg-elev2)" : "var(--bg-elev)"} radius={9} style={{
        border: "1px solid " + (isActive ? "var(--accent)" : "var(--border-soft)"), cursor: "pointer", position: "relative",
      }}>
      <Row className="bp-rail-card-head" gap={9}>
        <IconBox size={30} radius={8} background={`color-mix(in oklch, ${hue}, transparent 88%)`} border={`1px solid color-mix(in oklch, ${hue}, transparent 70%)`} color={hue}><Icon size={15} /></IconBox>
        <Row className="bp-rail-card-titlewrap" gap={7} style={{ flex: 1, minWidth: 0 }}>
          <Box as="span" className="bp-rail-card-title" style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</Box>
          <Box as="span" className="bp-rail-card-cat mono" pad={[1, 6]} bg={`color-mix(in oklch, ${hue}, transparent 90%)`} radius={99} style={{
            flex: "0 0 auto", fontSize: 9, color: hue, border: `1px solid color-mix(in oklch, ${hue}, transparent 78%)`,
          }}>{b.category}</Box>
        </Row>
        {/* eslint-disable-next-line no-restricted-syntax -- click-outside menu needs a real DOM ref (Box isn't forwardRef) */}
        <div ref={menuRef} className="bp-rail-card-menu" style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost"
            style={{ height: 22, width: 22, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMenuOpenId(isOpen ? null : menuId)}
            title="More options"
          ><MoreHorizontal size={13} /></Button>
          {isOpen && (
            <Box className="menu" style={{ minWidth: 158 }}>
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onUse(b.id); }}>
                <Check size={12} /> use for new projects
              </button>
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onOpen(b); }}>
                <Pencil size={12} /> modify in planner
              </button>
              {!b.builtIn && (
                <>
                  <Box style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
                  <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete(b); }}>
                    <Trash2 size={12} /> delete blueprint
                  </button>
                </>
              )}
            </Box>
          )}
        </div>
      </Row>
      {/* Gated-stage progression (#blueprints): one segment per enabled, applicable section,
          colored by gate status — a preview of the lifecycle this blueprint walks through. */}
      <Box className="bp-rail-card-gates" style={{ marginTop: 9 }}>
        <PlanGateRow sections={b.sections} signals={{}} />
      </Box>
      {b.gistLabel && (
        <Row className="bp-rail-card-gist mono" gap={5} style={{ marginTop: 7, fontSize: 9, color: "var(--info)" }}>
          <Link2 size={10} />{b.gistLabel}
        </Row>
      )}
    </Box>
  );
}

interface BlueprintLibraryProps {
  /** The filtered + sorted blueprint list to render (the composer owns search/sort). */
  fBlueprints: BpItem[];
  /** The active search query — drives the empty-state copy. */
  query: string;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  /** Resume an authoring draft's planning session (shared with the Drafts chips). */
  reopenDraft: (d: { key: string; title: string; pitch: string }) => void;
  /** Arm the shared draft-delete confirmation (an authoring draft is a folder on disk). */
  setDraftDeleteTarget: (d: DraftRow | null) => void;
}

/** The Blueprints rail — the lifecycle catalog (select / author / modify / delete) plus the
 *  import-from-gist surface. The composer owns the shared search/sort + menu state and the project
 *  scan; this component owns its local author/import UI and the blueprint + import handlers. */
export function BlueprintLibrary({ fBlueprints, query, menuOpenId, setMenuOpenId, reopenDraft, setDraftDeleteTarget }: BlueprintLibraryProps) {
  const {
    blueprints, activeBlueprintId, setActiveBlueprint, removeBlueprint, setBlueprintStages, updateBlueprintMeta,
    importBlueprint, installBundledSkills, githubToken, githubUser, setProjectBlueprintId, setAuthoredBlueprint,
    setPlanningTitle, setPlanningContext, setActiveProjectMeta, addDraftProject, setPlanningSession, setProjectsView,
  } = useAppStore();
  const [bpNewOpen, setBpNewOpen] = useState(false);   // rail "+ author a blueprint" inline form
  const [bpTitle, setBpTitle]     = useState("");
  const [importOpen, setImportOpen]   = useState(false); // manual "paste a gist URL / ID" modal
  const [catalogOpen, setCatalogOpen] = useState(false); // browse-my-gists catalog overlay
  // Drag-resizable blueprints rail (mirrors the GitHub / planning splitters). It sits on the
  // right, so it grows as the pointer moves left → invert. Wider default to seat each card's
  // gated-icon progression comfortably.
  const blueprintsRail = useDragResize({ initial: 460, min: 340, max: 760, axis: "x", invert: true });

  const q = query.trim().toLowerCase();

  // "open & edit" a blueprint always lands in the project planning page (#…): an in-progress
  // authoring draft resumes its session; a saved library blueprint re-opens an authoring session
  // keyed by its name, seeded with the blueprint so the planner + focused pane edit it in place.
  function openBlueprint(b: BpItem) {
    if (b.kind === "draft" && b.draftKey) {
      reopenDraft({ key: b.draftKey, title: b.draftTitle ?? b.name, pitch: b.draftPitch ?? "" });
      return;
    }
    const full = blueprints.find(x => x.id === b.id);
    const key = sanitizeProjectKey(b.name);
    setProjectBlueprintId(key, AUTHORING_BLUEPRINT_ID);
    if (full) setAuthoredBlueprint(key, full);
    setPlanningTitle(b.name);
    setPlanningContext(b.pitch || "Design a reusable blueprint to publish as a gist.", "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(key, { title: b.name, pitch: b.pitch ?? "", createdAt: Date.now() });
    setPlanningSession(key);
    setProjectsView("planning");
  }
  function deleteBlueprint(b: BpItem) {
    // An in-progress authoring draft is a folder on disk — confirm before destroying it (#1216),
    // same as a normal draft chip. A saved library blueprint is store-only, no confirm needed.
    if (b.kind === "draft" && b.draftKey) {
      setDraftDeleteTarget({ key: b.draftKey, title: b.draftTitle ?? b.name, pitch: b.draftPitch ?? "", sort: b.sort });
    } else removeBlueprint(b.id);
  }

  // The rail "+" authors a NEW blueprint: bind a fresh key to the authoring lifecycle and open the
  // planner seeded for it (the blueprint-author lifecycle), which designs + publishes a gist.
  function startNewBlueprint() {
    const title = bpTitle.trim();
    if (!title) return;
    const key = sanitizeProjectKey(title);
    setProjectBlueprintId(key, AUTHORING_BLUEPRINT_ID);
    setPlanningTitle(title);
    setPlanningContext("Design a reusable blueprint to publish as a gist.", "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(key, { title, pitch: "Design a reusable blueprint.", createdAt: Date.now() });
    setPlanningSession(key);
    setBpNewOpen(false);
    setBpTitle("");
    setProjectsView("planning");
  }

  // ── Import a blueprint from a gist (#blueprints): the only piece kept from the removed
  // Blueprints tab — resolve a gist ref to a previewable blueprint, then add/update it in the
  // library (dedupe by source gist id, #955). Editing happens via "modify in planner".
  const freshSections = (s: BlueprintStage[]): BlueprintStage[] => s.map((x) => ({ ...x, uid: uid("sec") }));
  async function resolveBlueprintImport(ref: string): Promise<PreviewBlueprint> {
    const r = await installFromGist(ref, githubToken);
    if (!r.ok) throw new Error(r.error);
    const bpRes = manifestToBlueprint(r.manifest);
    if (!bpRes.ok) throw new Error(bpRes.error);
    const bp = bpRes.blueprint;
    return {
      name: bp.name, icon: bp.icon ?? bp.name[0]?.toUpperCase() ?? "B", h: bp.h ?? 70,
      sections: bp.sections, blueprint: bp,
      bundled: bundledSkillsFromManifest(r.manifest), gistId: gistIdFromUrl(ref) ?? undefined,
    };
  }
  function importBlueprintPreview(preview: PreviewBlueprint, opts: { updatedAt?: string } = {}) {
    // Reconstitute the share's embedded skills so the blueprint's skill refs resolve once imported.
    if (preview.bundled?.length) installBundledSkills(preview.bundled);
    const base = preview.blueprint;
    const gId = preview.gistId;
    // Dedupe (#955): a gist already in the library updates in place rather than duplicating.
    const existing = gId ? blueprints.find((b) => b.gist?.id === gId) : undefined;
    if (existing) {
      setBlueprintStages(existing.id, freshSections(base?.sections ?? preview.sections));
      updateBlueprintMeta(existing.id, {
        ...(base?.name ? { name: base.name } : {}),
        gist: {
          ...(existing.gist ?? { state: "synced" }), state: "synced", id: gId,
          author: preview.author ?? existing.gist?.author, rev: preview.rev ?? existing.gist?.rev ?? "r1",
          updatedAt: opts.updatedAt ?? existing.gist?.updatedAt, behind: false,
        },
      });
      // Close only the manual paste dialog; the catalog stays open so its rows update live.
      setImportOpen(false);
      return;
    }
    const bp: Blueprint = {
      ...(base ?? { id: "tmp", name: preview.name, desc: "Imported from gist.", sections: preview.sections }),
      icon: preview.icon, h: preview.h, origin: "imported", tags: ["imported"],
      gist: { state: "synced", id: gId, author: preview.author, rev: preview.rev ?? "r1", public: true, updatedAt: opts.updatedAt },
    };
    importBlueprint(bp);
    setImportOpen(false);
  }

  return (
    <>
      {/* ░░ RAIL — blueprints ░░ (drag-resizable; wider default to seat each card's gate-row, #blueprints)
          Shrinkable (`0 1`, not `0 0`) with a min floor so a narrow / half window reclaims width from
          the rail instead of it overflowing the clipped section and getting cut off. `overflow:hidden`
          keeps its cards from forcing it back wide. */}
      <Box className="resize-x" {...blueprintsRail.handleProps} title="Drag to resize" />
      <Stack style={{ flex: `0 1 ${blueprintsRail.size}px`, minWidth: 240, overflow: "hidden", background: "var(--bg-panel)", borderLeft: "1px solid var(--border-soft)" }}>
        <Box style={{ flex: "0 0 auto", padding: "20px 18px 14px", borderBottom: "1px solid var(--border-soft)" }}>
          <Row gap={9}>
            <Box as="span" bg="var(--bg-elev2)" border="soft" radius={6} style={{ width: 23, height: 23, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-muted)" }}>
              <Layers size={13} />
            </Box>
            <Text as="h3" mono size={13} weight={600} style={{ margin: 0, color: "var(--fg)" }}>Blueprints</Text>
            <Box as="span" className="mono" pad={[0, 6]} bg="var(--bg-elev2)" border="soft" radius={8} style={{ fontSize: 9.5, color: "var(--fg-muted)"}}>{fBlueprints.length}</Box>
            <Spacer />
            <Button
              variant="ghost"
              title="Import a blueprint from a gist"
              onClick={() => setCatalogOpen(true)}
              style={{ height: 24, width: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            ><Download size={12} /></Button>
            <Button
              variant="ghost"
              title="Author a new blueprint"
              onClick={() => { setBpNewOpen(o => !o); setBpTitle(""); }}
              style={{ height: 24, width: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            >+</Button>
          </Row>
          {bpNewOpen && (
            <Row gap={6} style={{ marginTop: 10 }}>
              <input
                autoFocus
                value={bpTitle}
                onChange={e => setBpTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") startNewBlueprint(); if (e.key === "Escape") { setBpNewOpen(false); setBpTitle(""); } }}
                placeholder="blueprint name…"
                className="mono"
                style={{ flex: 1, minWidth: 0, height: 26, padding: "0 8px", background: "var(--bg-canvas)", border: "1px solid var(--accent-dim)", borderRadius: 6, outline: "none", fontSize: 11, color: "var(--fg)" }}
              />
              <Button
                variant="primary"
                onClick={startNewBlueprint}
                disabled={!bpTitle.trim()}
                style={{ height: 26, fontSize: 10, whiteSpace: "nowrap", opacity: bpTitle.trim() ? 1 : 0.4 }}
              >author →</Button>
            </Row>
          )}
          <Text as="div" mono size={9.5} tone="dim" style={{ marginTop: 9, lineHeight: 1.5 }}>reusable plan templates · published as gists</Text>
        </Box>
        <Stack gap={9} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 16px" }}>
          {fBlueprints.length === 0 ? (
            <Text as="div" mono size={10.5} tone="dim" style={{ lineHeight: 1.6, padding: "6px 2px" }}>
              {q ? "No blueprints match your search." : <>No blueprints yet. Press <b style={{ color: "var(--fg-muted)" }}>+</b> to author one.</>}
            </Text>
          ) : (
            fBlueprints.map(b => (
              <BlueprintCard key={b.id} b={b} onUse={setActiveBlueprint} onOpen={openBlueprint} onDelete={deleteBlueprint} activeId={activeBlueprintId} menuOpenId={menuOpenId} setMenuOpenId={setMenuOpenId} />
            ))
          )}
        </Stack>
      </Stack>

      {/* Import a blueprint from a gist (moved here from the removed Blueprints tab) */}
      {catalogOpen && (
        <BlueprintImportModal
          source={githubUser?.login ?? DEFAULT_GIST_SOURCE}
          token={githubToken}
          importedById={Object.fromEntries(blueprints.filter(b => b.gist?.id).map(b => [b.gist!.id!, { updatedAt: b.gist!.updatedAt }]))}
          onImport={(gistId, updatedAt) => resolveBlueprintImport(gistId).then(p => importBlueprintPreview(p, { updatedAt }))}
          onPreview={resolveBlueprintImport}
          onManualImport={() => { setCatalogOpen(false); setImportOpen(true); }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)} onResolve={resolveBlueprintImport} onImport={importBlueprintPreview} />
      )}
    </>
  );
}
