// ProjectSetupPage (#3802) — the create-a-project setup PAGE. It sits BETWEEN the projects list and
// the planner: name the project, pick the blueprint (locked at creation, #3785), optionally import a
// blueprint from a gist, then "start planning →". Recast from the old `BlueprintPickerModal` — same
// guts (the blueprint library as selectable `BlueprintCard`s + the gist-import affordance), but a
// FULL PANE (not a `ModalScrim`) so the create flow reads list → setup → planner. The composer
// (`ProjectsList`) runs the collision check + create + bind via `onStart`; the blueprint is the one
// consent point (frozen at creation).
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { useAppStore } from "@/store";
import { uid, DEFAULT_BLUEPRINT_ID, type Blueprint, type BlueprintStage, type BlueprintDesign } from "../stages/blueprints";
import { ImportModal, type PreviewBlueprint } from "../blueprints/BlueprintModals";
import { BlueprintImportModal } from "../blueprints/BlueprintImportModal";
import { DesignReconcileModal } from "@/features/designs";
import { reconcileDesign } from "@/shared/ui/kit";
import { DEFAULT_GIST_SOURCE } from "../blueprints/blueprintCatalog";
import { manifestToBlueprint, bundledSkillsFromManifest } from "../blueprints/blueprintShare";
import { installFromGist, gistIdFromUrl } from "@/features/planner/lib/gist/gist";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { Button } from "@/shared/ui/controls/Button";
import { TextField } from "@/shared/ui/controls/Field";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { BlueprintCard } from "./BlueprintCard";
import { buildBlueprintItems } from "./blueprintLibrary.helpers";

export interface ProjectSetupPageProps {
  /** ← back to the projects list (also the footer "cancel"). */
  onBack: () => void;
  /** Start planning with the entered name + chosen blueprint. The composer runs the name-collision
   *  check, then the create + bind (the blueprint is LOCKED once the project is created). */
  onStart: (title: string, bpId: string) => void;
}

export function ProjectSetupPage({ onBack, onStart }: ProjectSetupPageProps) {
  const {
    blueprints, activeBlueprintId, removeBlueprint, setBlueprintStages, updateBlueprintMeta,
    importBlueprint, installBundledSkills, githubToken, githubUser, removeDesignContribution,
  } = useAppStore();

  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string>(activeBlueprintId || DEFAULT_BLUEPRINT_ID);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);   // manual "paste a gist URL / ID" modal
  const [catalogOpen, setCatalogOpen] = useState(false); // browse-gists catalog overlay
  const [reconcileTarget, setReconcileTarget] = useState<{ source: string; label: string; missing: string[]; themeRef?: string } | null>(null);

  const items = useMemo(() => buildBlueprintItems(blueprints), [blueprints]);
  const canStart = title.trim().length > 0 && !!selected;
  const start = () => { if (canStart) onStart(title.trim(), selected); };

  function deleteBlueprint(id: string) {
    removeBlueprint(id);
    removeDesignContribution(id);
    if (selected === id) setSelected(DEFAULT_BLUEPRINT_ID);
  }

  // ── Import a blueprint from a gist (ported verbatim from BlueprintPickerModal) ─────────────────
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
  function reconcileImportedDesign(source: string, label: string, design: BlueprintDesign | undefined) {
    const r = reconcileDesign(design);
    if (!r.complete) setReconcileTarget({ source, label, missing: r.missingCategories, themeRef: r.themeRef });
  }
  function importBlueprintPreview(preview: PreviewBlueprint, opts: { updatedAt?: string } = {}) {
    if (preview.bundled?.length) installBundledSkills(preview.bundled);
    const base = preview.blueprint;
    const gId = preview.gistId;
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
      setSelected(existing.id);
      setImportOpen(false);
      return;
    }
    const bp: Blueprint = {
      ...(base ?? { id: "tmp", name: preview.name, desc: "Imported from gist.", sections: preview.sections }),
      icon: preview.icon, h: preview.h, origin: "imported", tags: ["imported"],
      gist: { state: "synced", id: gId, author: preview.author, rev: preview.rev ?? "r1", public: true, updatedAt: opts.updatedAt },
    };
    const newId = importBlueprint(bp);
    reconcileImportedDesign(newId, bp.name, bp.design);
    setSelected(newId);
    setImportOpen(false);
  }

  return (
    <Stack style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* header — back to the list + title, over the same slim 52px bar the list header uses. */}
      <Row gap={10} align="center" style={{ height: 52, flex: "none", padding: "0 16px", background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)" }}>
        <BackButton
          variant="text" label="projects" aria-label="Back to projects" onClick={onBack} className="mono"
          style={{ background: "none", border: "none", padding: 0, color: "var(--fg-muted)", cursor: "pointer", fontSize: 12 }}
        />
        <Box as="span" style={{ width: 1, height: 16, background: "var(--border-soft)" }} />
        <Text as="span" size={14} weight={600} style={{ color: "var(--fg)" }}>New project</Text>
      </Row>

      {/* scroll body — a centered single column (name · blueprint selection · gist import). */}
      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: "22px 22px 90px" }}>
        <Box style={{ maxWidth: 640, margin: "0 auto" }}>
          {/* project name (moved out of the list header's inline form). */}
          <TextField
            label="Project name"
            aria-label="Project name"
            hint="The name IS the project — it names its files, sessions, and GitHub project, and is locked once created."
            placeholder="Name your project…"
            value={title}
            onChange={setTitle}
            onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          />

          {/* blueprint selection — the same selectable card list the picker used, defaulting to the
              active/Default blueprint. The gist-import surface is folded in here (a single modal over
              this page, no longer a modal nested inside a picker modal). */}
          <Row gap={10} align="center" style={{ margin: "24px 0 10px" }}>
            <Text as="span" size={13} weight={600} style={{ color: "var(--fg)" }}>Blueprint</Text>
            <Text as="span" size={11} tone="muted">seeds the plan · locked at creation</Text>
            <Box as="span" style={{ flex: 1 }} />
            <Button
              variant="ghost" title="Import a blueprint from a gist" onClick={() => setCatalogOpen(true)}
              style={{ height: 26, display: "flex", alignItems: "center", gap: 6, flex: "none" }}
            ><Download size={13} /> import</Button>
          </Row>

          {items.length === 0 ? (
            <Text as="div" mono size={11} tone="dim" style={{ lineHeight: 1.6, padding: "6px 2px" }}>
              No blueprints yet. Import one from a gist, or generate one from a triaged project.
            </Text>
          ) : (
            <Stack gap={9}>
              {items.map((b) => (
                <BlueprintCard
                  key={b.id}
                  b={b}
                  onUse={setSelected}
                  onDelete={(bp) => deleteBlueprint(bp.id)}
                  activeId={selected}
                  menuOpenId={menuOpenId}
                  setMenuOpenId={setMenuOpenId}
                />
              ))}
            </Stack>
          )}
        </Box>
      </Box>

      {/* footer advance bar — start is gated on a name AND a chosen blueprint. */}
      <Row gap={10} align="center" justify="end" style={{ flex: "none", padding: "12px 22px", background: "var(--bg-elev)", borderTop: "1px solid var(--border-soft)" }}>
        <Text as="span" size={11} tone="dim" style={{ marginRight: "auto" }}>
          {canStart ? "ready" : "name your project + pick a blueprint to continue"}
        </Text>
        <Button variant="ghost" onClick={onBack}>cancel</Button>
        <Button variant="primary" disabled={!canStart} onClick={start}>start planning →</Button>
      </Row>

      {/* ── import overlays (a single modal over the page) ─────────────────────────────────────── */}
      {catalogOpen && (
        <BlueprintImportModal
          source={githubUser?.login ?? DEFAULT_GIST_SOURCE}
          token={githubToken}
          importedById={Object.fromEntries(blueprints.filter((b) => b.gist?.id).map((b) => [b.gist!.id!, { updatedAt: b.gist!.updatedAt }]))}
          onImport={(gistId, updatedAt) => resolveBlueprintImport(gistId).then((p) => importBlueprintPreview(p, { updatedAt }))}
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
    </Stack>
  );
}
