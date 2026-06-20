// The new Blueprints page (#609 wiring slice) — assembles the library / catalog /
// editor views + the editor header, gist modals, assistant drawer, context menu, and
// toasts into one page, wired to the store (blueprint CRUD + setBlueprintSections) and
// the real gist client (publish / install). Replaces the old BlueprintsTab.

import { useEffect, useMemo, useState } from "react";
import "../../../styles/blueprints.css";
import { useAppStore } from "../../../store";
import { tint, hue, DEFAULT_GIST_SOURCE } from "./blueprintCatalog";
import { uid, type Blueprint, type BlueprintSection, type BlueprintGist } from "../stages/blueprints";
import { sanitizeProjectKey } from "../../../lib/projectPaths";
import { LibraryView, type CardMenuAction } from "./BlueprintLibrary";
import { CatalogView } from "./BlueprintCatalogView";
import { BlueprintEditorView } from "./BlueprintEditor";
import { buildSkillLibrary } from "./blueprintSkills";
import { buildMcpLibrary } from "./blueprintMcp";
import { blankSkill } from "../../../lib/skills";
import { BlueprintAssistant } from "./BlueprintAssistant";
import {
  PublishModal, ImportModal, NewBlueprintModal, HistoryModal, SyncModal,
  type PreviewBlueprint, type PublishResult, type Revision,
} from "./BlueprintModals";
import { blueprintToManifest, manifestToBlueprint, bundledSkillsFromManifest } from "./blueprintShare";
import { resolveBlueprintSkillPayloads } from "./blueprintSkills";
import { publishGist, updateGist, installFromGist, gistRevisions, installFromGistRevision, gistIdFromUrl } from "../../../lib/extensions/gist";
import { diffBlueprints, type DiffLine } from "./blueprintDiff";

const freshSections = (sections: BlueprintSection[]): BlueprintSection[] =>
  sections.map((s) => ({ ...s, uid: uid("sec") }));

type View = "library" | "catalog" | "editor";
type Modal =
  | { type: "new" } | { type: "import" } | { type: "publish" }
  | { type: "history"; bp: Blueprint; revs: Revision[] }
  | { type: "sync"; bp: Blueprint; diff: DiffLine[]; upstream: Blueprint }
  | null;
interface MenuState { x: number; y: number; bp: Blueprint; header?: boolean }
interface Toast { id: string; text: string; accent?: boolean }

function EditorHeader({ bp, active, onBack, onRename, onRedesc, onUse, onPublish, onAssistant, onMenu }: {
  bp: Blueprint; active: boolean; onBack: () => void;
  onRename: (v: string) => void; onRedesc: (v: string) => void;
  onUse: () => void; onPublish: () => void; onAssistant: () => void; onMenu: (e: React.MouseEvent) => void;
}) {
  const g: BlueprintGist = bp.gist ?? { state: "local" };
  // Once a gist exists (any non-local state), the action UPDATES it in place rather than publishing
  // a duplicate (#970) — so it reads as "Update GitHub", matching the project planner's wording.
  const publishLabel = g.state === "local" ? "Publish to gist" : "⟳ Update GitHub";
  const chipCls = g.state === "dirty" ? "gchip dirty" : g.state === "local" ? "gchip local" : "gchip synced";
  const chipLabel = g.state === "local" ? "local only" : g.state === "dirty" ? "unpublished changes" : "synced · " + (g.rev ?? "r1");
  const h = bp.h ?? 70;
  return (
    <div className="ed-head">
      <button className="iconbtn back" title="Back to library" onClick={onBack}>←</button>
      <span className="ed-icon" style={{ background: tint(h, 0.16), color: hue(h) }}>{bp.icon ?? bp.name[0]?.toUpperCase()}</span>
      <div className="ed-title-wrap">
        <input className="ed-title" value={bp.name} onChange={(e) => onRename(e.target.value)} />
        <input className="ed-sub" style={{ display: "block", width: 520, maxWidth: "60vw", border: "1px solid transparent", borderRadius: 5, background: "transparent" }}
          value={bp.desc} onChange={(e) => onRedesc(e.target.value)} />
      </div>
      <div className="ed-acts">
        <span className={chipCls} title="Gist status"><i />{chipLabel}</span>
        <button className="btn ghost sm" onClick={onAssistant}><span>✦</span> Design with Claude</button>
        {/* Publish-to-gist demoted to a side action; Use is the main CTA (#662). */}
        <button className="btn ghost sm" onClick={onPublish}>{publishLabel}</button>
        <button
          className={"btn sm" + (active ? "" : " primary")}
          onClick={onUse}
          disabled={active}
          title={active ? "This blueprint seeds new projects" : "Use this blueprint for new projects"}
          style={active ? { color: "var(--success)", borderColor: "var(--success)" } : undefined}
        >{active ? "✓ in use" : "Use this blueprint"}</button>
        <button className="iconbtn" title="More" onClick={onMenu}>⋯</button>
      </div>
    </div>
  );
}

export function BlueprintsPage() {
  const blueprints = useAppStore((s) => s.blueprints);
  const githubToken = useAppStore((s) => s.githubToken);
  const setActiveBlueprint = useAppStore((s) => s.setActiveBlueprint);
  const activeBlueprintId = useAppStore((s) => s.activeBlueprintId);
  const duplicateBlueprint = useAppStore((s) => s.duplicateBlueprint);
  const updateBlueprintMeta = useAppStore((s) => s.updateBlueprintMeta);
  const setBlueprintSections = useAppStore((s) => s.setBlueprintSections);
  const removeBlueprint = useAppStore((s) => s.removeBlueprint);
  const importBlueprintStore = useAppStore((s) => s.importBlueprint);
  const skillDefs = useAppStore((s) => s.skills);
  const kbBlocks = useAppStore((s) => s.kbBlocks);
  const addSkill = useAppStore((s) => s.addSkill);
  const skillLibrary = useMemo(() => buildSkillLibrary(skillDefs, kbBlocks), [skillDefs, kbBlocks]);
  const extensions = useAppStore((s) => s.extensions);
  const mcpLibrary = useMemo(() => buildMcpLibrary(extensions), [extensions]);
  const installBundledSkills = useAppStore((s) => s.installBundledSkills);

  const [view, setView] = useState<View>("library");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selStage, setSelStage] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [drawer, setDrawer] = useState<{ draftName?: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const active = blueprints.find((b) => b.id === activeId) ?? null;

  function toast(text: string, accent = false) {
    const id = uid("t");
    setToasts((t) => [...t, { id, text, accent }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }

  useEffect(() => {
    if (!menu) return;
    const h = () => setMenu(null);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [menu]);

  // Opening a card edits it — it does NOT make it the active blueprint. Only the explicit
  // "use" / "Use this blueprint" CTA selects (#662).
  function openBp(id: string) {
    const b = blueprints.find((x) => x.id === id);
    setActiveId(id);
    setSelStage(b?.sections[0]?.uid ?? null);
    setView("editor");
  }
  function selectBlueprint(id: string) {
    setActiveBlueprint(id);
    toast(`"${blueprints.find((b) => b.id === id)?.name ?? id}" selected — it'll seed new projects`, true);
  }

  // "New blueprint" (#923): the user names the project; we create its folder (a draft) and open the
  // project planner seeded with the authoring lifecycle, which designs the blueprint and publishes it
  // to a gist (no fleet/triage). The authoring lifecycle drives the planner via the active blueprint.
  function authorBlueprint(name: string) {
    const title = name.trim();
    if (!title) return;
    const st = useAppStore.getState();
    const key = sanitizeProjectKey(title);
    // Bind THIS project to the authoring lifecycle per-project (#923) — not via the global active
    // blueprint, which would leak "blueprint-author" into the next normal project. Planning resolves
    // projectBlueprintId[key] ?? activeBlueprintId.
    st.setProjectBlueprintId(key, "blueprint-author");
    st.setPlanningTitle(title);
    st.setPlanningContext("Design a reusable blueprint to publish as a gist.", "");
    st.setActiveProjectMeta(null, "", "", 0);
    st.addDraftProject(key, { title, pitch: "Design a reusable blueprint.", createdAt: Date.now() });
    st.setPlanningSession(key);
    st.setProjectsPageMode("projects");
    st.setProjectsView("planning");
    setModal(null);
  }

  // ── duplicate / delete ── (new blueprints are authored in the planner, see authorBlueprint)
  function duplicateBp(id: string) { duplicateBlueprint(id); toast("Duplicated", true); }
  function deleteBp(id: string) {
    removeBlueprint(id);
    if (activeId === id) { setView("library"); setActiveId(null); }
    toast("Blueprint deleted");
  }

  // ── editor edits ──
  function onSectionsChange(sections: BlueprintSection[]) {
    if (!active) return;
    setBlueprintSections(active.id, sections);
    // a structural edit marks a published blueprint dirty
    const g = active.gist;
    if (g && (g.state === "synced" || g.state === "forked")) updateBlueprintMeta(active.id, { gist: { ...g, state: "dirty" } });
  }

  // ── import a blueprint gist from the source (#923) ──
  function importFromGistId(id: string, updatedAt?: string) {
    void resolveImport(id)
      .then((p) => importPreview(p, { updatedAt }))
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }

  // ── gist publish / import ──
  async function doPublish(isPublic: boolean): Promise<{ url?: string; id?: string; rev?: string }> {
    if (!active) throw new Error("no active blueprint");
    // Bundle the attached skills' content (#897 Phase 5b) so the share is self-contained for
    // knowledge; MCP servers stay by reference (their names are already in the blueprint).
    const bundled = resolveBlueprintSkillPayloads(active, skillDefs, kbBlocks);
    const manifest = blueprintToManifest(active, bundled);
    // Update the ORIGINAL gist in place when one already exists (#970) — re-publishing must not mint
    // a duplicate gist (the publish-side counterpart to the import dedupe in #955).
    const existingId = active.gist?.id;
    const res = existingId
      ? await updateGist(githubToken, existingId, manifest)
      : await publishGist(githubToken, manifest, { public: isPublic });
    return { url: res.htmlUrl, id: res.id, rev: "r1" };
  }
  function onPublished(r: PublishResult) {
    if (active) {
      const prior = active.gist;
      const wasUpdate = !!prior?.id;
      updateBlueprintMeta(active.id, {
        // On an UPDATE (#970) keep the gist's original visibility — it can't change via PATCH —
        // and its author/url rather than overwriting them with the modal's stale defaults.
        gist: {
          state: "synced", id: r.id, url: r.url ?? prior?.url,
          public: wasUpdate ? prior?.public : r.public,
          rev: r.rev ?? "r1", author: prior?.author ?? "you",
        },
      });
    }
    setModal(null);
    toast(active?.gist?.id ? "Updated on GitHub" : "Published to gist", true);
  }
  async function resolveImport(ref: string): Promise<PreviewBlueprint> {
    const r = await installFromGist(ref, githubToken);
    if (!r.ok) throw new Error(r.error);
    const bpRes = manifestToBlueprint(r.manifest);
    if (!bpRes.ok) throw new Error(bpRes.error);
    const bp = bpRes.blueprint;
    // Carry the full coerced blueprint + embedded skill content through the preview so import
    // preserves blueprint-wide skills/mcp/category/mode and reconstitutes the skills (#897).
    // Record the source gist id (#955) so a re-import is recognized (dedupe → update in place).
    return { name: bp.name, icon: bp.icon ?? bp.name[0]?.toUpperCase() ?? "B", h: bp.h ?? 70, sections: bp.sections, blueprint: bp, bundled: bundledSkillsFromManifest(r.manifest), gistId: gistIdFromUrl(ref) ?? undefined };
  }
  function importPreview(preview: PreviewBlueprint, opts: { updatedAt?: string } = {}) {
    // Reconstitute the share's embedded skills into the library first (#897 Phase 5b) so the
    // blueprint's skill refs resolve once it's imported.
    if (preview.bundled?.length) installBundledSkills(preview.bundled);
    // Prefer the fully-coerced blueprint (keeps blueprint-wide skills/mcp/category/mode);
    // fall back to the lossy preview fields for older callers.
    const base = preview.blueprint;
    const gId = preview.gistId;
    // Dedupe (#955): a gist already in the library UPDATES in place instead of adding a duplicate —
    // for both the catalog and manual URL import. The recorded `updatedAt` drives the next freshness
    // check on the import page.
    const existing = gId ? blueprints.find((b) => b.gist?.id === gId) : undefined;
    if (existing) {
      setBlueprintSections(existing.id, freshSections(base?.sections ?? preview.sections));
      updateBlueprintMeta(existing.id, {
        ...(base?.name ? { name: base.name } : {}),
        gist: {
          ...(existing.gist ?? { state: "synced" }), state: "synced", id: gId,
          author: preview.author ?? existing.gist?.author, rev: preview.rev ?? existing.gist?.rev ?? "r1",
          updatedAt: opts.updatedAt ?? existing.gist?.updatedAt, behind: false,
        },
      });
      setModal(null);
      toast("Updated from gist", true);
      openBp(existing.id);
      return;
    }
    const bp: Blueprint = {
      ...(base ?? { id: "tmp", name: preview.name, desc: "Imported from gist.", sections: preview.sections }),
      icon: preview.icon, h: preview.h, origin: "imported", tags: ["imported"],
      gist: { state: "synced", id: gId, author: preview.author, rev: preview.rev ?? "r1", public: true, updatedAt: opts.updatedAt },
    };
    const id = importBlueprintStore(bp);
    setModal(null);
    toast("Imported to library", true);
    openBp(id);
  }

  // ── gist history / sync (real gist data) ──
  const gistId = (bp: Blueprint): string | undefined => bp.gist?.id;

  async function openHistory(bp: Blueprint) {
    const id = gistId(bp);
    if (!id) { toast("No gist to show history for"); return; }
    const revs = await gistRevisions(id, githubToken);
    if (revs.length === 0) { toast("Couldn't load gist revisions"); return; }
    setModal({ type: "history", bp, revs: revs.map((r, i) => ({
      sha: r.version.slice(0, 7), when: r.committedAt ? r.committedAt.replace("T", " · ").replace("Z", "") : "—",
      msg: `revision by ${r.login}`, add: r.additions, del: r.deletions, cur: i === 0, version: r.version,
    })) });
  }
  async function restoreRev(bp: Blueprint, r: Revision) {
    const id = gistId(bp);
    if (!id || !r.version) return;
    const res = await installFromGistRevision(id, r.version, githubToken);
    if (!res.ok) { toast(res.error); return; }
    const got = manifestToBlueprint(res.manifest);
    if (!got.ok) { toast(got.error); return; }
    setBlueprintSections(bp.id, freshSections(got.blueprint.sections));
    setModal(null);
    toast(`Restored ${r.sha}`, true);
  }
  async function openSync(bp: Blueprint) {
    const id = gistId(bp);
    if (!id) { toast("No upstream gist linked"); return; }
    const res = await installFromGist(id, githubToken);
    if (!res.ok) { toast(res.error); return; }
    const got = manifestToBlueprint(res.manifest);
    if (!got.ok) { toast(got.error); return; }
    const diff = diffBlueprints(bp, got.blueprint);
    if (diff.length === 0) { toast("Already up to date with upstream", true); return; }
    setModal({ type: "sync", bp, diff, upstream: got.blueprint });
  }
  function pullUpstream(bp: Blueprint, upstream: Blueprint) {
    setBlueprintSections(bp.id, freshSections(upstream.sections));
    updateBlueprintMeta(bp.id, { gist: { ...(bp.gist ?? { state: "synced" }), state: "synced", behind: false } });
    setModal(null);
    toast("Synced with upstream", true);
  }

  // ── menus ──
  function onCardMenu(action: CardMenuAction, bp: Blueprint, e: React.MouseEvent) {
    if (action === "duplicate") return duplicateBp(bp.id);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.right - 168, y: r.bottom + 4, bp });
  }
  function headerMenu(e: React.MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (active) setMenu({ x: r.right - 168, y: r.bottom + 4, bp: active, header: true });
  }

  return (
    <div className="bp-page">
      {view === "editor" && active ? (
        <>
          <EditorHeader bp={active} active={active.id === activeBlueprintId} onBack={() => setView("library")}
            onRename={(v) => updateBlueprintMeta(active.id, { name: v })}
            onRedesc={(v) => updateBlueprintMeta(active.id, { desc: v })}
            onUse={() => selectBlueprint(active.id)}
            onPublish={() => setModal({ type: "publish" })} onAssistant={() => setDrawer({})} onMenu={headerMenu} />
          <BlueprintEditorView sections={active.sections} selectedUid={selStage} onSelect={setSelStage} onChange={onSectionsChange} skillLibrary={skillLibrary} mcpLibrary={mcpLibrary} />
        </>
      ) : view === "catalog" ? (
        <div className="scroll">
          <CatalogView source={DEFAULT_GIST_SOURCE} token={githubToken}
            importedById={Object.fromEntries(blueprints.filter((b) => b.gist?.id).map((b) => [b.gist!.id!, { updatedAt: b.gist!.updatedAt }]))}
            onImport={importFromGistId}
            onBack={() => setView("library")} onManualImport={() => setModal({ type: "import" })} />
        </div>
      ) : (
        <div className="scroll">
          <LibraryView blueprints={blueprints} onOpen={openBp} onMenu={onCardMenu}
            activeId={activeBlueprintId}
            onUse={selectBlueprint}
            onNew={() => setModal({ type: "new" })} onImport={() => setView("catalog")} />
        </div>
      )}

      {/* modals */}
      {modal?.type === "new" && <NewBlueprintModal onClose={() => setModal(null)} onCreate={authorBlueprint} />}
      {modal?.type === "import" && <ImportModal onClose={() => setModal(null)} onResolve={resolveImport} onImport={importPreview} />}
      {modal?.type === "publish" && active && <PublishModal bp={active} onClose={() => setModal(null)} onPublish={doPublish} onPublished={onPublished} />}
      {modal?.type === "history" && <HistoryModal bp={modal.bp} revs={modal.revs} onClose={() => setModal(null)} onRestore={(r) => void restoreRev(modal.bp, r)} />}
      {modal?.type === "sync" && <SyncModal bp={modal.bp} diff={modal.diff} onClose={() => setModal(null)} onPull={() => pullUpstream(modal.bp, modal.upstream)} />}

      {/* assistant drawer */}
      {drawer && active && (
        <BlueprintAssistant sections={active.sections} name={active.name} draftName={drawer.draftName}
          onApply={onSectionsChange} library={skillLibrary}
          onCreateSkill={(skName, content) => addSkill({ ...blankSkill(), name: skName, desc: content.split("\n")[0].slice(0, 80), prompt: content })}
          onClose={() => setDrawer(null)} onToast={(t) => toast(t, true)} />
      )}

      {/* context menu */}
      {menu && (
        <div className="bp-page" style={{ position: "fixed", inset: 0, pointerEvents: "none" }}>
          <div className="menu" style={{ position: "absolute", left: menu.x, top: menu.y, pointerEvents: "auto", zIndex: 50, minWidth: 168, background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", boxShadow: "0 14px 40px rgba(0,0,0,.5)", padding: 5 }} onClick={(e) => e.stopPropagation()}>
            {!menu.header && <button onClick={() => { openBp(menu.bp.id); setMenu(null); }}>✎ Open editor</button>}
            <button onClick={() => { duplicateBp(menu.bp.id); setMenu(null); }}>⧉ Duplicate</button>
            <button onClick={() => { if (!menu.header) openBp(menu.bp.id); setModal({ type: "publish" }); setMenu(null); }}>↑ Publish to gist</button>
            {menu.bp.gist?.id && <button onClick={() => { const bp = menu.bp; setMenu(null); void openHistory(bp); }}>◷ Version history</button>}
            {menu.bp.gist?.id && (menu.bp.origin === "imported" || menu.bp.origin === "forked") &&
              <button onClick={() => { const bp = menu.bp; setMenu(null); void openSync(bp); }}>⟳ Sync upstream</button>}
            <div style={{ height: 1, background: "var(--border-soft)", margin: "4px 6px" }} />
            <button className="danger" onClick={() => { deleteBp(menu.bp.id); setMenu(null); }}>🗑 Delete</button>
          </div>
        </div>
      )}

      {/* toasts */}
      <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 80, display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
        {toasts.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 9, background: "var(--bg-elev2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "9px 14px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", boxShadow: "0 10px 30px rgba(0,0,0,.4)" }}>
            <i style={{ width: 7, height: 7, borderRadius: "50%", background: t.accent ? "var(--accent)" : "var(--success)" }} />{t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
