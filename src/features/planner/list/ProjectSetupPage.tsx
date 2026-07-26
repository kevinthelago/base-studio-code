// ProjectSetupPage (#3802) — the create-a-project setup PAGE. It sits BETWEEN the projects list and
// the planner: name the project, pick the blueprint (locked at creation, #3785), then "start
// planning →". Recast from the old `BlueprintPickerModal` — same guts (the blueprint library as
// selectable `BlueprintCard`s), but the shared inline `Pane` (a full-height header/body frame, #1824)
// so the create flow reads list → setup → planner. The back/cancel/start actions live in the pane
// header (no footer); the content is TOP-aligned. The composer (`ProjectsList`) runs the collision
// check + create + bind via `onStart`; the blueprint is the one consent point (frozen at creation).
//
// The gist-import affordance is no longer a modal (#3802): a persistent right-side `CloudBlueprints`
// column lists the not-yet-downloaded gist blueprints beside the local ones, with inline download.
// A downloaded blueprint drops into the left column, already selectable (`setSelected(newId)`).
import { useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { uid, DEFAULT_BLUEPRINT_ID, type Blueprint, type BlueprintStage, type BlueprintDesign } from "../stages/blueprints";
import { type PreviewBlueprint } from "../blueprints/BlueprintModals";
import { DesignReconcileModal } from "@/features/designs";
import { reconcileDesign } from "@/shared/ui/kit";
import { DEFAULT_GIST_SOURCE } from "../blueprints/blueprintCatalog";
import { manifestToBlueprint, bundledSkillsFromManifest } from "../blueprints/blueprintShare";
import { installFromGist, gistIdFromUrl } from "@/features/planner/lib/gist/gist";
import { Pane } from "@/shared/ui/overlay/Pane";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { Button } from "@/shared/ui/controls/Button";
import { TextField } from "@/shared/ui/controls/Field";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { BlueprintCard } from "./BlueprintCard";
import { buildBlueprintItems } from "./blueprintLibrary.helpers";
import { CloudBlueprints } from "./CloudBlueprints";

export interface ProjectSetupPageProps {
  /** ← back to the projects list (also the header "cancel"). */
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
  const [reconcileTarget, setReconcileTarget] = useState<{ source: string; label: string; missing: string[]; themeRef?: string } | null>(null);

  const items = useMemo(() => buildBlueprintItems(blueprints), [blueprints]);
  // Gist ids already in the library — the cloud column hides these ("not yet downloaded" only).
  const downloadedGistIds = useMemo(
    () => new Set(blueprints.filter((b) => b.gist?.id).map((b) => b.gist!.id!)),
    [blueprints],
  );
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
  }

  // The cloud column's inline download: resolve the gist → import into the library (which selects
  // the new blueprint, so it lands in the left column ready to use). Rejections surface on the row.
  const downloadBlueprint = (gistId: string) => resolveBlueprintImport(gistId).then((p) => importBlueprintPreview(p));

  return (
    <>
      <Pane
        mode="inline"
        flush
        className="project-setup"
        header={
          <>
            <BackButton
              variant="text" label="projects" aria-label="Back to projects" onClick={onBack} className="mono"
              style={{ background: "none", border: "none", padding: 0, color: "var(--fg-muted)", cursor: "pointer", fontSize: 12 }}
            />
            <Box as="span" style={{ width: 1, height: 16, background: "var(--border-soft)" }} />
            <Text as="span" size={14} weight={600} style={{ color: "var(--fg)" }}>New project</Text>
            <Box as="span" style={{ flex: 1 }} />
            <Text as="span" size={11} tone="dim" style={{ marginRight: 2 }}>
              {canStart ? "ready" : "name + pick a blueprint"}
            </Text>
            <Button variant="ghost" onClick={onBack}>cancel</Button>
            <Button variant="primary" disabled={!canStart} onClick={start}>start planning →</Button>
          </>
        }
      >
        {/* body — two columns, content TOP-aligned: the setup form on the left, the persistent
            "Cloud blueprints" column on the right. Each column scrolls on its own. */}
        <Row style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
          <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: "22px 22px 28px" }}>
            <Box style={{ maxWidth: 640 }}>
              {/* project name (moved out of the list header's inline form) — autofocused on open. */}
              <TextField
                label="Project name"
                aria-label="Project name"
                autoFocus
                hint="The name IS the project — it names its files, sessions, and GitHub project, and is locked once created."
                placeholder="Name your project…"
                value={title}
                onChange={setTitle}
                onKeyDown={(e) => { if (e.key === "Enter") start(); }}
              />

              {/* blueprint selection — the selectable local card list, defaulting to the active/Default
                  blueprint. Gist import lives in the right column (no button here). */}
              <Row gap={10} align="center" style={{ margin: "24px 0 10px" }}>
                <Text as="span" size={13} weight={600} style={{ color: "var(--fg)" }}>Blueprint</Text>
                <Text as="span" size={11} tone="muted">seeds the plan · locked at creation</Text>
              </Row>

              {items.length === 0 ? (
                <Text as="div" mono size={11} tone="dim" style={{ lineHeight: 1.6, padding: "6px 2px" }}>
                  No blueprints yet. Download one from the cloud column, or generate one from a triaged project.
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

          {/* right — the persistent cloud-blueprint column (not-yet-downloaded gists + inline download). */}
          <CloudBlueprints
            defaultSource={githubUser?.login ?? DEFAULT_GIST_SOURCE}
            token={githubToken}
            downloadedGistIds={downloadedGistIds}
            onDownload={downloadBlueprint}
          />
        </Row>
      </Pane>

      {/* design reconcile — fires AFTER a download completes if the imported blueprint's design is
          missing kit pieces (this is NOT an import modal; it stays). */}
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
