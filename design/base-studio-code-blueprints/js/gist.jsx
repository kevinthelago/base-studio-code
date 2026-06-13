/* ===== Gist integration: publish · import · preview/fork · history · sync ===== */
const { useState: useStateG, useEffect: useEffectG } = React;

function Modal({ icon, iconBg, iconColor, title, sub, onClose, children, foot, lg }) {
  useEffectG(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={"modal" + (lg ? " lg" : "")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="mh-ico" style={iconBg ? { background: iconBg, color: iconColor } : null}>{icon}</span>
          <div><h2>{title}</h2>{sub && <div className="mh-sub">{sub}</div>}</div>
          <button className="iconbtn x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

function StageSummary({ stages }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {stages.map((s, i) => {
        const k = STAGE_KINDS[s.kind] || { glyph: "?", h: 250, title: s.kind };
        const gates = (s.pipelines || []).filter((p) => p.gate).length;
        return (
          <div key={s.id || i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
            <span className="mono dim" style={{ fontSize: 9.5, width: 16 }}>{String(i + 1).padStart(2, "0")}</span>
            <span className="sicon" style={{ width: 22, height: 22, flex: "0 0 22px", borderRadius: 5, background: tint(k.h, 0.16), color: hue(k.h), display: "flex", alignItems: "center", justifyContent: "center" }}><Ic n={k.glyph} size={13} /></span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg)" }}>{s.title}</span>
            <span style={{ flex: 1 }} />
            {(s.pipelines || []).length > 0 && <span className="hint mono">{s.pipelines.length} pipe</span>}
            {gates > 0 && <span className="tag amber">{gates} gate</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Publish ---------- */
function PublishModal({ bp, onClose, onPublished }) {
  const [pub, setPub] = useStateG(true);
  const [phase, setPhase] = useStateG("config"); // config | publishing | done
  const [copied, setCopied] = useStateG(false);
  const url = `gist.github.com/you/${(bp.gist && bp.gist.id) || "e7a90c41b"}`;

  function go() {
    setPhase("publishing");
    setTimeout(() => setPhase("done"), 1100);
  }
  return (
    <Modal icon={<Ic n="upload" size={15} />} title={phase === "done" ? "Published" : "Publish to gist"}
      sub={phase === "done" ? "Your blueprint is live and shareable" : "Share this blueprint as a GitHub gist"}
      onClose={onClose}
      foot={phase === "done"
        ? <><span className="sp" /><button className="btn primary" onClick={() => { onPublished({ public: pub, url, id: (bp.gist && bp.gist.id) || "e7a90c41b" }); }}>Done</button></>
        : <><span className="hint">Published as <b className="mono" style={{ color: pub ? "var(--success)" : "var(--fg-muted)" }}>{pub ? "public" : "secret"}</b> gist</span><span className="sp" /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={phase === "publishing"} onClick={go}>{phase === "publishing" ? "Publishing…" : "Publish gist"}</button></>}>
      {phase !== "done" ? (
        <>
          <div className="card" style={{ marginBottom: 14, padding: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span className="bp-icon" style={{ width: 28, height: 28, flex: "0 0 28px", fontSize: 13, background: tint(bp.h, 0.16), color: hue(bp.h) }}>{bp.icon}</span>
              <div><div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{bp.name}</div><div className="hint">{bp.stages.length} stages · {bp.stages.reduce((n, s) => n + s.pipelines.length, 0)} pipelines</div></div>
            </div>
            <div className="hint" style={{ marginBottom: 8 }}>Serialized to <span className="kbd">blueprint.json</span> — one gist file. Anyone with the link can preview and fork it.</div>
            <StageSummary stages={bp.stages} />
          </div>
          <div className="field">
            <label>Visibility</label>
            <div style={{ display: "flex", gap: 8 }}>
              <div className={"disp" + (pub ? " on" : "")} style={{ flex: 1 }} onClick={() => setPub(true)}>
                <span className="dgl" style={{ background: tint(145, 0.16), color: hue(145) }}>◉</span>
                <span className="dtxt"><div className="dt">Public</div><div className="dd">Listed & forkable by anyone</div></span>
              </div>
              <div className={"disp" + (!pub ? " on" : "")} style={{ flex: 1 }} onClick={() => setPub(false)}>
                <span className="dgl" style={{ background: tint(250, 0.16), color: hue(250) }}>○</span>
                <span className="dtxt"><div className="dt">Secret</div><div className="dd">Only people with the link</div></span>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="hint" style={{ marginBottom: 10 }}>Share this link — recipients can preview the stage flow and fork it into their own library.</div>
          <div className="linkbox">
            <span className="glyph">⛓</span>
            <span className="lk">{url}</span>
            <button className="btn sm" onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "✓ Copied" : "Copy"}</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <span className="tag green">{pub ? "public" : "secret"}</span>
            <span className="tag">revision r1</span>
            <span className="tag">blueprint.json</span>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------- Import ---------- */
function ImportModal({ onClose, onImport }) {
  const [val, setVal] = useStateG("");
  const [phase, setPhase] = useStateG("input"); // input | loading | preview | error
  const [preview, setPreview] = useStateG(null);

  function fetchGist() {
    if (!val.trim()) return;
    setPhase("loading");
    setTimeout(() => {
      // simulate resolving a gist into a blueprint
      const sample = {
        name: "Event-driven service", icon: "E", h: 230, author: "kafka-kim", rev: "r4",
        stages: [
          mkStage("context"), mkStage("stack"), mkStage("architecture"),
          mkStage("schema", { pipelines: [mkPipe("schema-check", { gate: true })] }),
          mkStage("api", { pipelines: [mkPipe("contract-test", { gate: true })] }),
          mkStage("observability"), mkStage("structure", { pipelines: [mkPipe("issue-gen")] }),
        ],
      };
      setPreview(sample); setPhase("preview");
    }, 900);
  }

  return (
    <Modal icon={<Ic n="cloud_download" size={15} />} title="Import from gist" sub="Pull a blueprint someone shared with you" onClose={onClose}
      foot={phase === "preview"
        ? <><span className="hint">Imports as a linked copy — you can sync upstream later</span><span className="sp" /><button className="btn ghost" onClick={() => setPhase("input")}>Back</button><button className="btn primary" onClick={() => onImport(preview)}>Import to library</button></>
        : <><span className="sp" /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!val.trim() || phase === "loading"} onClick={fetchGist}>{phase === "loading" ? "Resolving…" : "Resolve gist"}</button></>}>
      {phase !== "preview" ? (
        <>
          <div className="field">
            <label>Gist URL or ID</label>
            <input className="input" autoFocus placeholder="gist.github.com/user/a91f3c0e7  ·  or  ·  a91f3c0e7"
              value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") fetchGist(); }} />
            <div className="hint">Paste a full URL or the raw gist ID. We look for a <span className="kbd">blueprint.json</span> file.</div>
          </div>
          {phase === "loading" && <div className="hint mono" style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center" }}><span className="typing"><i /><i /><i /></span> reading gist…</div>}
          <div style={{ marginTop: 16 }} className="seclabel">Recently shared with you<span className="ln" /></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {["mv3-mike/c7d0f1 · Chrome extension", "acme-platform/1a2b3c · B2B SaaS starter"].map((s) => (
              <button key={s} className="chip-sug" style={{ textAlign: "left", borderRadius: 6 }} onClick={() => { setVal(s.split(" · ")[0]); }}>↳ {s}</button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span className="bp-icon" style={{ width: 30, height: 30, flex: "0 0 30px", fontSize: 14, background: tint(preview.h, 0.16), color: hue(preview.h) }}>{preview.icon}</span>
            <div><div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{preview.name}</div><div className="hint mono">by {preview.author} · revision {preview.rev} · {preview.stages.length} stages</div></div>
            <span style={{ flex: 1 }} /><span className="tag info">valid blueprint.json</span>
          </div>
          <div className="card" style={{ padding: 13 }}><StageSummary stages={preview.stages} /></div>
        </>
      )}
    </Modal>
  );
}

/* ---------- Preview (catalog) ---------- */
function PreviewModal({ cat, onClose, onFork, forked }) {
  // synthesize a plausible stage flow from the catalog entry
  const kinds = ["context", "users", "stack", "architecture", "schema", "api", "ux", "structure", "permissions", "testing", "observability", "cicd"];
  const stages = kinds.slice(0, cat.stageCount).map((kk, i) => mkStage(kk, i === 6 ? { pipelines: [mkPipe("render-preview", { gate: true })] } : {}));
  return (
    <Modal lg icon={cat.icon} iconBg={tint(cat.h, 0.16)} iconColor={hue(cat.h)} title={cat.name}
      sub={`by ${cat.author} · ★ ${cat.stars.toLocaleString()} · ${cat.stageCount} stages`} onClose={onClose}
      foot={<><span className="hint mono">gist.github.com/{cat.author}/{cat.gistId}</span><span className="sp" /><button className="btn ghost" onClick={onClose}>Close</button><button className="btn primary" disabled={forked} onClick={() => onFork(cat)}>{forked ? "✓ In your library" : "⑂ Fork to my library"}</button></>}>
      <div className="hbody" style={{ marginBottom: 14 }}>{cat.desc}</div>
      <div className="seclabel">Stage flow<span className="ln" /><span className="dim mono">{stages.length}</span></div>
      <div className="card" style={{ padding: 13 }}><StageSummary stages={stages} /></div>
      <div style={{ display: "flex", gap: 7, marginTop: 12, flexWrap: "wrap" }}>
        {cat.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
        <span className="tag green">public gist</span>
      </div>
    </Modal>
  );
}

/* ---------- Version history (gist revisions) ---------- */
function HistoryModal({ bp, onClose, onRestore }) {
  const revs = bp._revs || [
    { sha: "r7", when: "2026-06-02 · 14:20", msg: "Add contract-test gate to API stage", add: 1, del: 0, cur: true },
    { sha: "r6", when: "2026-05-28 · 09:11", msg: "Reorder schema before API", add: 0, del: 0 },
    { sha: "r5", when: "2026-05-24 · 17:46", msg: "Attach render-preview to UI design", add: 1, del: 0 },
    { sha: "r4", when: "2026-05-20 · 11:02", msg: "Drop separate analytics stage", add: 0, del: 1 },
    { sha: "r3", when: "2026-05-16 · 08:33", msg: "Tighten permissions prompt module", add: 0, del: 0 },
    { sha: "r1", when: "2026-05-09 · 13:15", msg: "Initial publish", add: 10, del: 0 },
  ];
  return (
    <Modal icon={<Ic n="history" size={15} />} title="Version history" sub={`${bp.name} · gist revisions`} onClose={onClose}
      foot={<><span className="hint">Each publish creates a gist revision. Restore rolls the blueprint back.</span><span className="sp" /><button className="btn ghost" onClick={onClose}>Close</button></>}>
      <div className="timeline">
        {revs.map((r) => (
          <div className={"rev" + (r.cur ? " cur" : "")} key={r.sha}>
            <span className="rdot" />
            <div className="rbody">
              <div className="rtop">
                <span className="rsha">{r.sha}</span>
                {r.cur && <span className="tag amber">current</span>}
                <span className="rwhen">{r.when}</span>
                <span style={{ flex: 1 }} />
                {!r.cur && <button className="btn sm ghost" onClick={() => onRestore(r)}>Restore</button>}
              </div>
              <div className="rmsg">{r.msg}</div>
              {(r.add > 0 || r.del > 0) && (
                <div className="rstat">
                  {r.add > 0 && <span className="radd">+{r.add} stage{r.add > 1 ? "s" : ""}</span>}
                  {r.del > 0 && <span className="rdel">−{r.del} stage{r.del > 1 ? "s" : ""}</span>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ---------- Sync / pull upstream ---------- */
function SyncModal({ bp, ribbon, onClose, onPull }) {
  const diff = (ribbon && ribbon.diff) || [
    { type: "add", title: "Observability", note: "new stage after API" },
    { type: "mod", title: "API & contracts", note: "prompt module updated · contract-test trigger → complete" },
    { type: "del", title: "Analytics", note: "stage removed upstream" },
  ];
  const [phase, setPhase] = useStateG("review");
  function pull() { setPhase("pulling"); setTimeout(() => { onPull(diff); }, 900); }
  return (
    <Modal icon={<Ic n="sync" size={15} />} title="Sync with upstream" sub={`${bp.name} · ${(bp.gist && bp.gist.author) || "upstream"} has newer changes`} onClose={onClose}
      foot={<><span className="hint">{diff.length} change{diff.length > 1 ? "s" : ""} · local edits are preserved where possible</span><span className="sp" /><button className="btn ghost" onClick={onClose}>Not now</button><button className="btn primary" disabled={phase === "pulling"} onClick={pull}>{phase === "pulling" ? "Merging…" : "Pull changes"}</button></>}>
      <div className="hint" style={{ marginBottom: 12 }}>Upstream revision <span className="kbd">{(bp.gist && bp.gist.rev) || "r7"}</span> → <span className="kbd" style={{ color: "var(--accent)" }}>r8</span>. Review what changes before merging into your copy.</div>
      {diff.map((d, i) => (
        <div className={"diff-line " + d.type} key={i}>
          <span className="dmark">{d.type === "add" ? "+" : d.type === "del" ? "−" : "~"}</span>
          <span className="dtitle">{d.title}</span>
          <span style={{ flex: 1 }} />
          <span className="dim" style={{ fontSize: 10 }}>{d.note}</span>
        </div>
      ))}
    </Modal>
  );
}

/* ---------- New blueprint ---------- */
function NewBlueprintModal({ onClose, onCreate, onDesignWithClaude }) {
  const [name, setName] = useStateG("");
  const [mode, setMode] = useStateG("blank"); // blank | default | claude
  return (
    <Modal icon={<Ic n="add" size={15} />} title="New blueprint" sub="Start a reusable planning template" onClose={onClose}
      foot={<><span className="sp" /><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim()} onClick={() => mode === "claude" ? onDesignWithClaude(name.trim()) : onCreate(name.trim(), mode)}>
          {mode === "claude" ? "Design with Claude →" : "Create blueprint"}
        </button></>}>
      <div className="field" style={{ marginBottom: 16 }}>
        <label>Name</label>
        <input className="input" autoFocus placeholder="e.g. Internal tool, Data pipeline…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim(), mode); }} />
      </div>
      <div className="field">
        <label>Start from</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className={"disp" + (mode === "blank" ? " on" : "")} onClick={() => setMode("blank")}>
            <span className="dgl" style={{ background: tint(250, 0.16), color: hue(250) }}>○</span>
            <span className="dtxt"><div className="dt">Blank</div><div className="dd">One context stage — build the rest yourself</div></span>
          </div>
          <div className={"disp" + (mode === "default" ? " on" : "")} onClick={() => setMode("default")}>
            <span className="dgl" style={{ background: tint(70, 0.16), color: hue(70) }}>≡</span>
            <span className="dtxt"><div className="dt">Default stages</div><div className="dd">Clone the Default arc and tweak from there</div></span>
          </div>
          <div className={"disp" + (mode === "claude" ? " on" : "")} onClick={() => setMode("claude")}>
            <span className="dgl" style={{ background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 40))", color: "#1a120a" }}>✦</span>
            <span className="dtxt"><div className="dt">Design with Claude</div><div className="dd">Describe the project — Claude drafts the stage flow</div></span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

Object.assign(window, { Modal, StageSummary, PublishModal, ImportModal, PreviewModal, HistoryModal, SyncModal, NewBlueprintModal });
