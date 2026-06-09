// The new Blueprints page (#609 wiring slice) — assembles the library / catalog /
// editor views + the editor header, gist modals, assistant drawer, context menu, and
// toasts into one page, wired to the store (blueprint CRUD + setBlueprintSections) and
// the real gist client (publish / install). Replaces the old BlueprintsTab.

import { useEffect, useState } from "react";
import "../../styles/blueprints.css";
import { useAppStore } from "../../store";
import { tint, hue, CATALOG_FLOW_KINDS, type CatalogEntry } from "./blueprintCatalog";
import { uid, type Blueprint, type BlueprintSection, type BlueprintGist, makeBlueprints, DEFAULT_BLUEPRINT_ID } from "./blueprints";
import { mkStageSection } from "./blueprintEdit";
import { LibraryView, type CardMenuAction } from "./BlueprintLibrary";
import { CatalogView } from "./BlueprintCatalogView";
import { BlueprintEditorView } from "./BlueprintEditor";
import { BlueprintAssistant } from "./BlueprintAssistant";
import {
  PublishModal, ImportModal, PreviewModal, NewBlueprintModal, type PreviewBlueprint, type PublishResult,
} from "./BlueprintModals";
import { blueprintToManifest, manifestToBlueprint } from "./blueprintShare";
import { publishGist, installFromGist } from "../../lib/extensions/gist";

const freshSections = (sections: BlueprintSection[]): BlueprintSection[] =>
  sections.map((s) => ({ ...s, uid: uid("sec"), pipelines: s.pipelines.map((p) => ({ ...p, uid: uid("pl") })) }));

type View = "library" | "catalog" | "editor";
type Modal =
  | { type: "new" } | { type: "import" } | { type: "publish" }
  | { type: "preview"; cat: CatalogEntry } | null;
interface MenuState { x: number; y: number; bp: Blueprint; header?: boolean }
interface Toast { id: string; text: string; accent?: boolean }

function EditorHeader({ bp, onBack, onRename, onRedesc, onPublish, onAssistant, onMenu }: {
  bp: Blueprint; onBack: () => void;
  onRename: (v: string) => void; onRedesc: (v: string) => void;
  onPublish: () => void; onAssistant: () => void; onMenu: (e: React.MouseEvent) => void;
}) {
  const g: BlueprintGist = bp.gist ?? { state: "local" };
  const primary = g.state === "local" ? { label: "Publish to gist", ghost: false }
    : g.state === "dirty" ? { label: "Publish update", ghost: false }
    : { label: "Published ✓", ghost: true };
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
        <button className={"btn sm" + (primary.ghost ? " ghost" : " primary")} onClick={onPublish}>{primary.label}</button>
        <button className="iconbtn" title="More" onClick={onMenu}>⋯</button>
      </div>
    </div>
  );
}

export function BlueprintsPage() {
  const blueprints = useAppStore((s) => s.blueprints);
  const githubToken = useAppStore((s) => s.githubToken);
  const setActiveBlueprint = useAppStore((s) => s.setActiveBlueprint);
  const addBlueprint = useAppStore((s) => s.addBlueprint);
  const duplicateBlueprint = useAppStore((s) => s.duplicateBlueprint);
  const updateBlueprintMeta = useAppStore((s) => s.updateBlueprintMeta);
  const setBlueprintSections = useAppStore((s) => s.setBlueprintSections);
  const removeBlueprint = useAppStore((s) => s.removeBlueprint);
  const importBlueprintStore = useAppStore((s) => s.importBlueprint);

  const [view, setView] = useState<View>("library");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selStage, setSelStage] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [drawer, setDrawer] = useState<{ draftName?: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const active = blueprints.find((b) => b.id === activeId) ?? null;
  // forked blueprints carry their source catalog id in tags (e.g. "cat_rust").
  const forkedIds = blueprints.flatMap((b) => (b.tags ?? []).filter((t) => t.startsWith("cat_")));

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

  function openBp(id: string) {
    const b = blueprints.find((x) => x.id === id);
    setActiveId(id);
    setActiveBlueprint(id);
    setSelStage(b?.sections[0]?.uid ?? null);
    setView("editor");
  }

  // ── create / duplicate / delete ──
  function newBlueprint(name: string, mode: "blank" | "default") {
    const id = addBlueprint();
    const defaultArc = makeBlueprints().find((b) => b.id === DEFAULT_BLUEPRINT_ID)?.sections ?? [];
    updateBlueprintMeta(id, { name, desc: "A custom planning blueprint.", origin: "local", icon: name[0]?.toUpperCase(), gist: { state: "local" } });
    setBlueprintSections(id, mode === "default" ? freshSections(defaultArc) : [mkStageSection("context")]);
    setModal(null);
    openBp(id);
    toast("Blueprint created", true);
  }
  function designWithClaude(name: string) {
    const id = addBlueprint();
    updateBlueprintMeta(id, { name, desc: "Drafted with Claude.", origin: "local", icon: name[0]?.toUpperCase(), gist: { state: "local" } });
    setBlueprintSections(id, [mkStageSection("context")]);
    setModal(null);
    openBp(id);
    setDrawer({ draftName: name });
  }
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

  // ── catalog fork ──
  function forkCatalog(cat: CatalogEntry) {
    const sections = CATALOG_FLOW_KINDS.slice(0, cat.stageCount).map((k) => mkStageSection(k));
    const bp: Blueprint = {
      id: "tmp", name: cat.name, desc: cat.desc, sections,
      icon: cat.icon, h: cat.h, origin: "forked", tags: [...cat.tags, "forked", cat.id],
      gist: { state: "forked", author: cat.author, id: cat.gistId, rev: "r1", public: true },
    };
    const id = importBlueprintStore(bp);
    setModal(null);
    toast(`Forked "${cat.name}" into your library`, true);
    openBp(id);
  }

  // ── gist publish / import ──
  async function doPublish(isPublic: boolean): Promise<{ url?: string; id?: string; rev?: string }> {
    if (!active) throw new Error("no active blueprint");
    const res = await publishGist(githubToken, blueprintToManifest(active), { public: isPublic });
    return { url: res.htmlUrl, id: res.id, rev: "r1" };
  }
  function onPublished(r: PublishResult) {
    if (active) updateBlueprintMeta(active.id, { gist: { state: "synced", id: r.id, url: r.url, public: r.public, rev: r.rev ?? "r1", author: "you" } });
    setModal(null);
    toast("Published to gist", true);
  }
  async function resolveImport(ref: string): Promise<PreviewBlueprint> {
    const r = await installFromGist(ref, githubToken);
    if (!r.ok) throw new Error(r.error);
    const bpRes = manifestToBlueprint(r.manifest);
    if (!bpRes.ok) throw new Error(bpRes.error);
    const bp = bpRes.blueprint;
    return { name: bp.name, icon: bp.icon ?? bp.name[0]?.toUpperCase() ?? "B", h: bp.h ?? 70, sections: bp.sections };
  }
  function importPreview(preview: PreviewBlueprint) {
    const bp: Blueprint = {
      id: "tmp", name: preview.name, desc: "Imported from gist.", sections: preview.sections,
      icon: preview.icon, h: preview.h, origin: "imported", tags: ["imported"],
      gist: { state: "synced", author: preview.author, rev: preview.rev ?? "r1", public: true },
    };
    const id = importBlueprintStore(bp);
    setModal(null);
    toast("Imported to library", true);
    openBp(id);
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
          <EditorHeader bp={active} onBack={() => setView("library")}
            onRename={(v) => updateBlueprintMeta(active.id, { name: v })}
            onRedesc={(v) => updateBlueprintMeta(active.id, { desc: v })}
            onPublish={() => setModal({ type: "publish" })} onAssistant={() => setDrawer({})} onMenu={headerMenu} />
          <BlueprintEditorView sections={active.sections} selectedUid={selStage} onSelect={setSelStage} onChange={onSectionsChange} />
        </>
      ) : view === "catalog" ? (
        <div className="scroll">
          <CatalogView forkedIds={forkedIds} onFork={forkCatalog}
            onPreview={(c) => setModal({ type: "preview", cat: c })}
            onBack={() => setView("library")} onManualImport={() => setModal({ type: "import" })} />
        </div>
      ) : (
        <div className="scroll">
          <LibraryView blueprints={blueprints} onOpen={openBp} onMenu={onCardMenu}
            onNew={() => setModal({ type: "new" })} onImport={() => setView("catalog")} />
        </div>
      )}

      {/* modals */}
      {modal?.type === "new" && <NewBlueprintModal onClose={() => setModal(null)} onCreate={newBlueprint} onDesignWithClaude={designWithClaude} />}
      {modal?.type === "import" && <ImportModal onClose={() => setModal(null)} onResolve={resolveImport} onImport={importPreview} />}
      {modal?.type === "publish" && active && <PublishModal bp={active} onClose={() => setModal(null)} onPublish={doPublish} onPublished={onPublished} />}
      {modal?.type === "preview" && <PreviewModal cat={modal.cat} forked={forkedIds.includes(modal.cat.id)} onClose={() => setModal(null)} onFork={forkCatalog} />}

      {/* assistant drawer */}
      {drawer && active && (
        <BlueprintAssistant sections={active.sections} name={active.name} draftName={drawer.draftName}
          onApply={onSectionsChange} onClose={() => setDrawer(null)} onToast={(t) => toast(t, true)} />
      )}

      {/* context menu */}
      {menu && (
        <div className="bp-page" style={{ position: "fixed", inset: 0, pointerEvents: "none" }}>
          <div className="menu" style={{ position: "absolute", left: menu.x, top: menu.y, pointerEvents: "auto", zIndex: 50, minWidth: 168, background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", boxShadow: "0 14px 40px rgba(0,0,0,.5)", padding: 5 }} onClick={(e) => e.stopPropagation()}>
            {!menu.header && <button onClick={() => { openBp(menu.bp.id); setMenu(null); }}>✎ Open editor</button>}
            <button onClick={() => { duplicateBp(menu.bp.id); setMenu(null); }}>⧉ Duplicate</button>
            <button onClick={() => { if (!menu.header) openBp(menu.bp.id); setModal({ type: "publish" }); setMenu(null); }}>↑ Publish to gist</button>
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
