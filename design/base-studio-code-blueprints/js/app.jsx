/* ===== Root app: state, CRUD, gist flows, editor chrome ===== */
const { useState, useEffect, useRef, useCallback } = React;

function uid2(p) { return `${p}_${Math.random().toString(36).slice(2, 8)}`; }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

// synthesize a stage flow for a forked/catalog blueprint
function stagesForCatalog(cat) {
  const kinds = ["context", "users", "stack", "architecture", "schema", "api", "ux", "structure", "permissions", "testing", "observability", "cicd"];
  return kinds.slice(0, cat.stageCount).map((kk, i) =>
    mkStage(kk, kk === "ux" ? { pipelines: [mkPipe("render-preview", { gate: true })] }
      : kk === "api" ? { pipelines: [mkPipe("contract-test", { gate: true })] }
      : kk === "structure" ? { pipelines: [mkPipe("issue-gen")] } : {}));
}

function EditorHeader({ bp, onBack, onRename, onRedesc, onGist, onMenu, onAssistant, onClose }) {
  const g = bp.gist || { state: "local" };
  const primary = g.state === "local"
    ? { label: "Publish to gist", act: "publish" }
    : g.state === "dirty"
    ? { label: "Publish update", act: "publish" }
    : g.behind
    ? { label: "Sync upstream", act: "sync" }
    : { label: "Published ✓", act: "publish", ghost: true };
  const chipCls = g.state === "dirty" ? "gchip dirty" : g.state === "local" ? "gchip local" : "gchip synced";
  const chipLabel = g.state === "local" ? "local only" : g.state === "dirty" ? "unpublished changes" : g.behind ? "update available" : "synced · " + (g.rev || "r1");

  return (
    <div className="ed-head">
      <button className="iconbtn back" title="Back to library" onClick={onBack}>←</button>
      <span className="ed-icon" style={{ background: tint(bp.h, 0.16), color: hue(bp.h) }}>{bp.icon}</span>
      <div className="ed-title-wrap">
        <input className="ed-title" value={bp.name} onChange={(e) => onRename(e.target.value)} />
        <input className="ed-sub" style={{ display: "block", width: 520, maxWidth: "60vw", border: "1px solid transparent", borderRadius: 5, background: "transparent" }}
          value={bp.desc} onChange={(e) => onRedesc(e.target.value)}
          onFocus={(e) => e.target.style.borderColor = "var(--border-soft)"} onBlur={(e) => e.target.style.borderColor = "transparent"} />
      </div>
      <div className="ed-acts">
        <span className={chipCls} title="Gist status"><i />{chipLabel}</span>
        <button className="btn ghost sm" onClick={onAssistant}><span className="glyph">✦</span> Design with Claude</button>
        <button className={"btn sm" + (primary.ghost ? " ghost" : " primary")} onClick={() => onGist(primary.act)}>{primary.label}</button>
        <button className="iconbtn" title="More" onClick={onMenu}>⋯</button>
      </div>
    </div>
  );
}

function App() {
  const [blueprints, setBlueprints] = useState(() => {
    const bps = buildBlueprints();
    // give the synced one an available upstream update → drives the ribbon + Sync
    const fs = bps.find((b) => b.id === "bp_fullstack");
    if (fs) fs.gist.behind = true;
    return bps;
  });
  const [view, setView] = useState("library");
  const [activeId, setActiveId] = useState(null);
  const [selStage, setSelStage] = useState(null);
  const [modal, setModal] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [menu, setMenu] = useState(null);
  const [seeded] = useState(1284);

  const active = blueprints.find((b) => b.id === activeId);
  const mineCatalogIds = blueprints.filter((b) => b.origin === "forked").map((b) => b._catId).filter(Boolean);

  const pushToast = useCallback((text, kind) => {
    const id = uid2("t");
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  useEffect(() => {
    const h = (e) => { if (menu) setMenu(null); };
    if (menu) { window.addEventListener("click", h); return () => window.removeEventListener("click", h); }
  }, [menu]);

  // ---- blueprint-level helpers ----
  function patchBp(id, fn) {
    setBlueprints((bps) => bps.map((b) => {
      if (b.id !== id) return b;
      const nb = fn(clone(b));
      // any structural edit marks a published blueprint dirty
      if (nb.gist && (nb.gist.state === "synced" || nb.gist.state === "forked") && nb._touch) {
        nb.gist = { ...nb.gist, state: "dirty" };
      }
      delete nb._touch;
      return nb;
    }));
  }
  const touchStages = (b, fn) => { b._touch = true; b.stages = fn(b.stages); return b; };

  function openBp(id) {
    const b = blueprints.find((x) => x.id === id);
    setActiveId(id); setSelStage(b && b.stages[0] ? b.stages[0].id : null); setView("editor");
  }

  function newBlueprint(name, mode) {
    const id = uid2("bp");
    const stages = mode === "default" ? buildBlueprints()[0].stages.map((s) => ({ ...clone(s), id: uid("st") })) : [mkStage("context")];
    const hueList = [70, 230, 295, 195, 145, 350];
    const bp = { id, name, desc: "A custom planning blueprint.", icon: name[0].toUpperCase(), h: hueList[blueprints.length % hueList.length],
      origin: "local", tags: ["custom"], gist: { state: "local" }, uses: 0, updatedAt: "just now", stages };
    setBlueprints((b) => [bp, ...b]); setModal(null); openBp(id);
    pushToast("Blueprint created", "am");
  }

  function designWithClaude(name) {
    const id = uid2("bp");
    const bp = { id, name, desc: "Drafted with Claude.", icon: name[0].toUpperCase(), h: 70,
      origin: "local", tags: ["custom"], gist: { state: "local" }, uses: 0, updatedAt: "just now", stages: [mkStage("context")] };
    setBlueprints((b) => [bp, ...b]); setModal(null); openBp(id); setDrawer({ draftName: name });
  }

  function duplicateBp(bp) {
    const id = uid2("bp");
    const copy = { ...clone(bp), id, name: bp.name + " copy", origin: "local", gist: { state: "local" }, uses: 0, updatedAt: "just now",
      stages: bp.stages.map((s) => ({ ...clone(s), id: uid("st") })) };
    // remap dependency ids
    const idMap = {}; bp.stages.forEach((s, i) => idMap[s.id] = copy.stages[i].id);
    copy.stages.forEach((s) => s.dependsOn = s.dependsOn.map((d) => idMap[d]).filter(Boolean));
    copy.stages.forEach((s) => s.pipelines = s.pipelines.map((p) => ({ ...p, id: uid("pp") })));
    setBlueprints((b) => [copy, ...b]); pushToast("Duplicated", "am");
  }

  function deleteBp(id) {
    setBlueprints((b) => b.filter((x) => x.id !== id));
    if (activeId === id) { setView("library"); setActiveId(null); }
    pushToast("Blueprint deleted");
  }

  function forkCatalog(cat) {
    const id = uid2("bp");
    const bp = { id, name: cat.name, desc: cat.desc, icon: cat.icon, h: cat.h, origin: "forked", _catId: cat.id,
      tags: [...cat.tags, "forked"], gist: { state: "forked", author: cat.author, id: cat.gistId, rev: "r1", public: true }, uses: 0, updatedAt: "just now",
      stages: stagesForCatalog(cat) };
    setBlueprints((b) => [bp, ...b]); pushToast(`Forked "${cat.name}" into your library`, "am");
    setModal(null);
  }

  // ---- stage CRUD ----
  const updateStage = (sid, patch) => patchBp(activeId, (b) => touchStages(b, (ss) => ss.map((s) => s.id === sid ? { ...s, ...patch } : s)));
  const reorderStages = (from, to) => patchBp(activeId, (b) => touchStages(b, (ss) => { const a = [...ss]; const [m] = a.splice(from, 1); a.splice(to, 0, m); return a; }));
  function addStage(kind) {
    const ns = mkStage(kind);
    patchBp(activeId, (b) => touchStages(b, (ss) => [...ss, ns]));
    setSelStage(ns.id);
  }
  function deleteStage(sid) {
    patchBp(activeId, (b) => touchStages(b, (ss) => ss.filter((s) => s.id !== sid).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== sid) }))));
    const remaining = active.stages.filter((s) => s.id !== sid);
    setSelStage(remaining[0] ? remaining[0].id : null);
  }
  function duplicateStage(sid) {
    patchBp(activeId, (b) => touchStages(b, (ss) => {
      const i = ss.findIndex((s) => s.id === sid); if (i < 0) return ss;
      const copy = { ...clone(ss[i]), id: uid("st"), title: ss[i].title + " copy", pipelines: ss[i].pipelines.map((p) => ({ ...p, id: uid("pp") })) };
      const a = [...ss]; a.splice(i + 1, 0, copy); return a;
    }));
  }
  const toggleDep = (sid, depId) => patchBp(activeId, (b) => touchStages(b, (ss) => ss.map((s) => s.id === sid ? { ...s, dependsOn: s.dependsOn.includes(depId) ? s.dependsOn.filter((d) => d !== depId) : [...s.dependsOn, depId] } : s)));
  const addPipe = (sid, key) => patchBp(activeId, (b) => touchStages(b, (ss) => ss.map((s) => s.id === sid ? { ...s, pipelines: [...s.pipelines, mkPipe(key)] } : s)));
  const updatePipe = (sid, pid, patch) => patchBp(activeId, (b) => touchStages(b, (ss) => ss.map((s) => s.id === sid ? { ...s, pipelines: s.pipelines.map((p) => p.id === pid ? { ...p, ...patch } : p) } : s)));
  const removePipe = (sid, pid) => patchBp(activeId, (b) => touchStages(b, (ss) => ss.map((s) => s.id === sid ? { ...s, pipelines: s.pipelines.filter((p) => p.id !== pid) } : s)));

  // ---- assistant apply ----
  function applyAssistant(actions) {
    patchBp(activeId, (b) => touchStages(b, (ss) => {
      let a = [...ss];
      for (const act of actions) {
        if (act.op === "add") {
          const pipes = (act.pipes || []).map(([k, g]) => mkPipe(k, { gate: g }));
          a.push(mkStage(act.kind, { pipelines: pipes }));
        } else if (act.op === "remove") {
          const victim = a.find((s) => s.kind === act.kind);
          a = a.filter((s) => s.kind !== act.kind);
          if (victim) a = a.map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== victim.id) }));
        } else if (act.op === "gatePipe") {
          a = a.map((s) => {
            if (s.kind !== act.kind) return s;
            const has = s.pipelines.find((p) => p.key === act.pipeKey);
            return has ? { ...s, pipelines: s.pipelines.map((p) => p.key === act.pipeKey ? { ...p, gate: true } : p) }
              : { ...s, pipelines: [...s.pipelines, mkPipe(act.pipeKey, { gate: true })] };
          });
        }
      }
      return a;
    }));
  }

  // ---- gist flows ----
  function onGistAction(act) {
    if (act === "publish") setModal({ type: "publish" });
    else if (act === "sync") setModal({ type: "sync" });
  }
  function onPublished(info) {
    patchBp(activeId, (b) => { b.gist = { ...(b.gist || {}), state: "synced", public: info.public, id: info.id, url: info.url, rev: bumpRev(b.gist && b.gist.rev), author: "you" }; return b; });
    setModal(null); pushToast("Published to gist", "am");
  }
  function bumpRev(r) { const n = r ? parseInt(String(r).replace(/\D/g, "")) || 0 : 0; return "r" + (n + 1); }
  function importBlueprint(preview) {
    const id = uid2("bp");
    const bp = { id, name: preview.name, desc: "Imported from gist.", icon: preview.icon, h: preview.h, origin: "imported",
      tags: ["imported"], gist: { state: "synced", author: preview.author, rev: preview.rev, id: "imp" + Math.random().toString(36).slice(2, 7), public: true }, uses: 0, updatedAt: "just now",
      stages: preview.stages.map((s) => ({ ...clone(s), id: uid("st") })) };
    setBlueprints((b) => [bp, ...b]); setModal(null); pushToast("Imported to library", "am"); openBp(id);
  }
  function pullUpstream(diff) {
    patchBp(activeId, (b) => {
      b._touch = false;
      // apply the canned diff: add Observability, remove Analytics(none), etc.
      let ss = [...b.stages];
      if (!ss.find((s) => s.kind === "observability")) {
        const apiIdx = ss.findIndex((s) => s.kind === "api");
        ss.splice(apiIdx >= 0 ? apiIdx + 1 : ss.length, 0, mkStage("observability"));
      }
      b.stages = ss;
      b.gist = { ...b.gist, state: "synced", behind: false, rev: "r8" };
      return b;
    });
    setModal(null); pushToast("Synced with upstream → r8", "am");
  }
  function restoreRev(r) { setModal(null); pushToast(`Restored ${r.sha}`, "am"); }

  // ---- card / header menus ----
  function onCardMenu(action, bp, e) {
    if (action === "duplicate") return duplicateBp(bp);
    if (action === "open-menu") {
      const rect = e.currentTarget.getBoundingClientRect();
      setMenu({ x: rect.right - 168, y: rect.bottom + 4, bp });
    }
  }
  function headerMenu(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right - 168, y: rect.bottom + 4, bp: active, header: true });
  }

  return (
    <div className="page">
      {view === "editor" && active ? (
        <>
          <EditorHeader bp={active} onBack={() => { setView("library"); }} onRename={(v) => patchBp(activeId, (b) => { b.name = v; return b; })}
            onRedesc={(v) => patchBp(activeId, (b) => { b.desc = v; return b; })}
            onGist={onGistAction} onMenu={headerMenu} onAssistant={() => setDrawer({})} />
          <EditorView bp={active} selectedId={selStage} onSelect={setSelStage} onReorder={reorderStages} onAddStage={addStage}
            ribbon={active.gist && active.gist.behind ? { author: active.gist.author, label: "revision r8", summary: "adds an Observability stage, updates the API prompt" } : null}
            onResolveRibbon={(a) => { if (a === "review") setModal({ type: "sync" }); else patchBp(activeId, (b) => { b.gist = { ...b.gist, behind: false }; return b; }); }}
            onUpdateStage={updateStage} onToggleDep={toggleDep} onAddPipe={addPipe} onUpdatePipe={updatePipe} onRemovePipe={removePipe}
            onDeleteStage={deleteStage} onDuplicateStage={duplicateStage} />
        </>
      ) : view === "catalog" ? (
        <div className="scroll">
          <CatalogView catalog={CATALOG} mineIds={mineCatalogIds} onFork={forkCatalog}
            onPreview={(c) => setModal({ type: "preview", cat: c })}
            onBack={() => setView("library")} onManualImport={() => setModal({ type: "import" })} />
        </div>
      ) : (
        <div className="scroll">
          <LibraryView blueprints={blueprints} stats={{ seeded }} onOpen={openBp} onMenu={onCardMenu} onNew={() => setModal({ type: "new" })} onImport={() => setView("catalog")} />
        </div>
      )}

      {/* modals */}
      {modal && modal.type === "new" && <NewBlueprintModal onClose={() => setModal(null)} onCreate={newBlueprint} onDesignWithClaude={designWithClaude} />}
      {modal && modal.type === "import" && <ImportModal onClose={() => setModal(null)} onImport={importBlueprint} />}
      {modal && modal.type === "publish" && active && <PublishModal bp={active} onClose={() => setModal(null)} onPublished={onPublished} />}
      {modal && modal.type === "history" && active && <HistoryModal bp={active} onClose={() => setModal(null)} onRestore={restoreRev} />}
      {modal && modal.type === "sync" && active && <SyncModal bp={active} onClose={() => setModal(null)} onPull={pullUpstream} />}
      {modal && modal.type === "preview" && <PreviewModal cat={modal.cat} forked={mineCatalogIds.includes(modal.cat.id)} onClose={() => setModal(null)} onFork={forkCatalog} />}

      {/* assistant drawer */}
      {drawer && active && <Drawer bp={active} draftName={drawer.draftName} onApply={applyAssistant} onClose={() => setDrawer(null)} pushToast={pushToast} />}

      {/* context menu */}
      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {!menu.header && <button onClick={() => { openBp(menu.bp.id); setMenu(null); }}>✎ Open editor</button>}
          <button onClick={() => { duplicateBp(menu.bp); setMenu(null); }}>⧉ Duplicate</button>
          {menu.bp.gist && menu.bp.gist.state !== "local"
            ? <button onClick={() => { if (menu.header) setModal({ type: "history" }); else { openBp(menu.bp.id); setModal({ type: "history" }); } setMenu(null); }}>◷ Version history</button>
            : <button onClick={() => { if (!menu.header) openBp(menu.bp.id); setModal({ type: "publish" }); setMenu(null); }}>↑ Publish to gist</button>}
          {menu.header && menu.bp.gist && menu.bp.gist.state !== "local" && <button onClick={() => { setModal({ type: "publish" }); setMenu(null); }}>↑ Publish update</button>}
          <div className="sep" />
          <button className="danger" onClick={() => { deleteBp(menu.bp.id); setMenu(null); }}>🗑 Delete</button>
        </div>
      )}

      {/* toasts */}
      <div className="toast-wrap">
        {toasts.map((t) => <div className={"toast" + (t.kind === "am" ? " am" : "")} key={t.id}><i />{t.text}</div>)}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
