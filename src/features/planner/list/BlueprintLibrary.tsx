import { useState } from "react";
import { Layers, Download } from "lucide-react";
import { useAppStore } from "@/store";
import { projectSlug } from "@/shared/lib/core/projectPaths";
import { AUTHORING_BLUEPRINT_ID, uid, type Blueprint, type BlueprintStage, type BlueprintDesign } from "../stages/blueprints";
import { ImportModal, type PreviewBlueprint } from "../blueprints/BlueprintModals";
import { BlueprintImportModal } from "../blueprints/BlueprintImportModal";
import { DesignReconcileModal } from "@/features/components";
import { reconcileDesign } from "@/shared/ui/kit";
import { DEFAULT_GIST_SOURCE } from "../blueprints/blueprintCatalog";
import { manifestToBlueprint, bundledSkillsFromManifest } from "../blueprints/blueprintShare";
import { installFromGist, gistIdFromUrl } from "@/features/planner/lib/gist/gist";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { DraftRow } from "./drafts";
import { BlueprintCard } from "./BlueprintCard";
import { buildBlueprintItems, type BpItem } from "./blueprintLibrary.helpers";

// Re-exported so importers of BlueprintLibrary keep resolving the list-building helper + item type.
export { buildBlueprintItems };
export type { BpItem };

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
    removeDesignContribution,
  } = useAppStore();
  const [bpNewOpen, setBpNewOpen] = useState(false);   // rail "+ author a blueprint" inline form
  const [bpTitle, setBpTitle]     = useState("");
  const [importOpen, setImportOpen]   = useState(false); // manual "paste a gist URL / ID" modal
  const [catalogOpen, setCatalogOpen] = useState(false); // browse-my-gists catalog overlay
  // Blueprint-download reconciliation (#2658): when an imported blueprint introduces design categories
  // the contract doesn't define, alert the user with the confirm-list to generate + register them.
  const [reconcileTarget, setReconcileTarget] = useState<{ source: string; label: string; missing: string[]; themeRef?: string } | null>(null);
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
    // The authoring session keys off the blueprint's NAME — the same name-derived key rule as
    // projects (#2409), so its draft/hub are derivable from the name alone.
    const key = projectSlug(b.name);
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
    } else {
      removeBlueprint(b.id);
      // Drop any design overlay this blueprint contributed (#2658) — compose-don't-mutate: removing the
      // blueprint recomputes the applied look without its tokens (a no-op if it never contributed one).
      removeDesignContribution(b.id);
    }
  }

  // The rail "+" authors a NEW blueprint: bind a fresh key to the authoring lifecycle and open the
  // planner seeded for it (the blueprint-author lifecycle), which designs + publishes a gist.
  function startNewBlueprint() {
    const title = bpTitle.trim();
    if (!title) return;
    const key = projectSlug(title);
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
  // Reconcile a just-imported blueprint's design contribution (#2658): if it introduces categories the
  // contract doesn't define, arm the confirm-list so the user can generate + register them (no silent
  // holes). A `complete` design (or none) is a no-op. `source` is the local blueprint id so a later
  // removal drops exactly that overlay.
  function reconcileImportedDesign(source: string, label: string, design: BlueprintDesign | undefined) {
    const r = reconcileDesign(design);
    if (!r.complete) setReconcileTarget({ source, label, missing: r.missingCategories, themeRef: r.themeRef });
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
      reconcileImportedDesign(existing.id, base?.name ?? existing.name, base?.design);
      // Close only the manual paste dialog; the catalog stays open so its rows update live.
      setImportOpen(false);
      return;
    }
    const bp: Blueprint = {
      ...(base ?? { id: "tmp", name: preview.name, desc: "Imported from gist.", sections: preview.sections }),
      icon: preview.icon, h: preview.h, origin: "imported", tags: ["imported"],
      gist: { state: "synced", id: gId, author: preview.author, rev: preview.rev ?? "r1", public: true, updatedAt: opts.updatedAt },
    };
    // importBlueprint mints a FRESH id (it never reuses the manifest's bp.id) — key the design
    // contribution off that stored id, not the pre-import id (#2663), so removeDesignContribution(b.id)
    // on delete matches and a second same-manifest-id import can't clobber the first's overlay.
    const newId = importBlueprint(bp);
    reconcileImportedDesign(newId, bp.name, bp.design);
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
              {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline rail input (custom sizing/border, not a Field stack) */}
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
      {reconcileTarget && (
        <DesignReconcileModal
          source={reconcileTarget.source}
          label={reconcileTarget.label}
          missingCategories={reconcileTarget.missing}
          themeRef={reconcileTarget.themeRef}
          onClose={() => setReconcileTarget(null)}
        />
      )}
    </>
  );
}
