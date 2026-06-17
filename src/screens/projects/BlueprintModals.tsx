// Blueprint gist + create modals (#609 slice 5) — ported from the design's gist.jsx.
// Faithful UI; the side-effecting flows (publish / import) take async callbacks so the
// page shell can wire them to the real gist client (gist.ts) while these stay testable.

import { useEffect, useState, type ReactNode } from "react";
import "../../styles/blueprints.css";
import { Ic } from "./blueprintIcons";
import { stageKind, tint, hue, type CatalogEntry, CATALOG_FLOW_KINDS } from "./blueprintCatalog";
import { mkStageSection } from "./blueprintEdit";
import { type DiffLine } from "./blueprintDiff";
import { type Blueprint, type BlueprintSection } from "./blueprints";
import { type SkillPayload } from "./blueprintSkills";

/** A resolved import/preview blueprint (subset enough to preview + import). */
export interface PreviewBlueprint {
  name: string; icon: string; h: number; author?: string; rev?: string; sections: BlueprintSection[];
  /** The fully-coerced blueprint (#897) — carried so import preserves blueprint-wide
   *  skills/mcp/category/mode instead of reconstructing from the lossy preview subset. */
  blueprint?: Blueprint;
  /** Skill content embedded in the share (#897 Phase 5b) — reconstituted into the library on import. */
  bundled?: SkillPayload[];
}

function Modal({ icon, iconBg, iconColor, title, sub, onClose, children, foot, lg }: {
  icon: ReactNode; iconBg?: string; iconColor?: string; title: string; sub?: string;
  onClose: () => void; children: ReactNode; foot?: ReactNode; lg?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="bp-page" style={{ position: "fixed", inset: 0 }}>
      <div className="overlay" style={{ position: "fixed", inset: 0, background: "oklch(0.08 0.005 250 / 0.66)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 30 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal" style={{ width: lg ? 720 : 540, maxWidth: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "0 24px 70px rgba(0,0,0,.55)", overflow: "hidden" }}
          onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-head" style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
            <span className="mh-ico" style={{ width: 30, height: 30, flex: "0 0 30px", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 13, background: iconBg ?? "color-mix(in oklch, var(--accent), transparent 84%)", color: iconColor ?? "var(--accent)" }}>{icon}</span>
            <div><h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600 }}>{title}</h2>{sub && <div style={{ fontSize: 10.5, color: "var(--fg-dim)", marginTop: 1 }}>{sub}</div>}</div>
            <button className="iconbtn" style={{ marginLeft: "auto" }} onClick={onClose}>✕</button>
          </div>
          <div className="modal-body" style={{ padding: 20, overflowY: "auto" }}>{children}</div>
          {foot && <div className="modal-foot" style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 20px", borderTop: "1px solid var(--border-soft)" }}>{foot}</div>}
        </div>
      </div>
    </div>
  );
}

export function StageSummary({ sections }: { sections: BlueprintSection[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {sections.map((s, i) => {
        const k = stageKind(s.key);
        const caps = (s.skills?.length ?? 0) + (s.mcp?.length ?? 0);
        return (
          <div key={s.uid ?? i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 0" }}>
            <span className="mono dim" style={{ fontSize: 9.5, width: 16 }}>{String(i + 1).padStart(2, "0")}</span>
            <span style={{ width: 22, height: 22, flex: "0 0 22px", borderRadius: 5, background: tint(k.h, 0.16), color: hue(k.h), display: "flex", alignItems: "center", justifyContent: "center" }}><Ic n={k.glyph} size={13} /></span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg)" }}>{s.name}</span>
            <span style={{ flex: 1 }} />
            {caps > 0 && <span className="hint mono">{caps} attached</span>}
            {s.gateRule && <span className="tag amber">gate</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ── Publish ── */
export interface PublishResult { url?: string; id?: string; rev?: string; public: boolean }
export function PublishModal({ bp, onClose, onPublish, onPublished }: {
  bp: Blueprint; onClose: () => void;
  /** Perform the real publish; resolves with the gist info. */
  onPublish: (isPublic: boolean) => Promise<{ url?: string; id?: string; rev?: string }>;
  onPublished: (r: PublishResult) => void;
}) {
  const [pub, setPub] = useState(true);
  const [phase, setPhase] = useState<"config" | "publishing" | "done" | "error">("config");
  const [info, setInfo] = useState<{ url?: string; id?: string; rev?: string }>({});
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const caps = bp.sections.reduce((n, s) => n + (s.skills?.length ?? 0) + (s.mcp?.length ?? 0), 0)
    + (bp.skills?.length ?? 0) + (bp.mcp?.length ?? 0);

  async function go() {
    setPhase("publishing");
    try {
      setInfo(await onPublish(pub));
      setPhase("done");
    } catch (e) { setErr(String(e)); setPhase("error"); }
  }

  return (
    <Modal icon={<Ic n="upload" size={15} />} title={phase === "done" ? "Published" : "Publish to gist"}
      sub={phase === "done" ? "Your blueprint is live and shareable" : "Share this blueprint as a GitHub gist"} onClose={onClose}
      foot={phase === "done"
        ? <><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => onPublished({ ...info, public: pub })}>Done</button></>
        : <><span className="hint">Published as <b className="mono" style={{ color: pub ? "var(--success)" : "var(--fg-muted)" }}>{pub ? "public" : "secret"}</b> gist</span><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={phase === "publishing"} onClick={go}>{phase === "publishing" ? "Publishing…" : "Publish gist"}</button></>}>
      {phase === "done" ? (
        <>
          <div className="hint" style={{ marginBottom: 10 }}>Share this link — recipients can preview the stage flow and fork it into their own library.</div>
          <div className="linkbox" style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>
            <span>⛓</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.url ?? "gist published"}</span>
            <button className="btn sm" onClick={() => { if (info.url) void navigator.clipboard?.writeText(info.url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "✓ Copied" : "Copy"}</button>
          </div>
        </>
      ) : phase === "error" ? (
        <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11 }}>Publish failed: {err}</div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14, padding: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span className="bp-icon" style={{ width: 28, height: 28, flex: "0 0 28px", fontSize: 13, background: tint(bp.h ?? 70, 0.16), color: hue(bp.h ?? 70), display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7, fontFamily: "var(--mono)", fontWeight: 700 }}>{bp.icon ?? bp.name[0]}</span>
              <div><div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{bp.name}</div><div className="hint">{bp.sections.length} stages · {caps} attached</div></div>
            </div>
            <StageSummary sections={bp.sections} />
          </div>
          <div className="field"><label style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Visibility</label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <div className={"disp" + (pub ? " on" : "")} style={{ flex: 1 }} onClick={() => setPub(true)}>
                <span className="dgl" style={{ background: tint(145, 0.16), color: hue(145) }}>◉</span>
                <span className="dtxt"><div className="dt">Public</div><div className="dd">Listed &amp; forkable by anyone</div></span>
              </div>
              <div className={"disp" + (!pub ? " on" : "")} style={{ flex: 1 }} onClick={() => setPub(false)}>
                <span className="dgl" style={{ background: tint(250, 0.16), color: hue(250) }}>○</span>
                <span className="dtxt"><div className="dt">Secret</div><div className="dd">Only people with the link</div></span>
              </div>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ── Import ── */
export function ImportModal({ onClose, onResolve, onImport }: {
  onClose: () => void;
  onResolve: (ref: string) => Promise<PreviewBlueprint>;
  onImport: (preview: PreviewBlueprint) => void;
}) {
  const [val, setVal] = useState("");
  const [phase, setPhase] = useState<"input" | "loading" | "preview" | "error">("input");
  const [preview, setPreview] = useState<PreviewBlueprint | null>(null);
  const [err, setErr] = useState("");

  async function resolve() {
    if (!val.trim()) return;
    setPhase("loading");
    try { setPreview(await onResolve(val.trim())); setPhase("preview"); }
    catch (e) { setErr(String(e)); setPhase("error"); }
  }

  return (
    <Modal icon={<Ic n="cloud_download" size={15} />} title="Import from gist" sub="Pull a blueprint someone shared with you" onClose={onClose}
      foot={phase === "preview" && preview
        ? <><span className="hint">Imports as a linked copy — you can sync upstream later</span><span style={{ flex: 1 }} /><button className="btn ghost" onClick={() => setPhase("input")}>Back</button><button className="btn primary" onClick={() => onImport(preview)}>Import to library</button></>
        : <><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!val.trim() || phase === "loading"} onClick={resolve}>{phase === "loading" ? "Resolving…" : "Resolve gist"}</button></>}>
      {phase === "preview" && preview ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span className="bp-icon" style={{ width: 30, height: 30, flex: "0 0 30px", fontSize: 14, background: tint(preview.h, 0.16), color: hue(preview.h), display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, fontFamily: "var(--mono)", fontWeight: 700 }}>{preview.icon}</span>
            <div><div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{preview.name}</div><div className="hint mono">{preview.author ? `by ${preview.author} · ` : ""}{preview.rev ? `revision ${preview.rev} · ` : ""}{preview.sections.length} stages</div></div>
            <span style={{ flex: 1 }} /><span className="tag info">valid blueprint</span>
          </div>
          <div className="card" style={{ padding: 13 }}><StageSummary sections={preview.sections} /></div>
        </>
      ) : (
        <div className="field">
          <label style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Gist URL or ID</label>
          <input className="input" autoFocus style={{ marginTop: 6 }} placeholder="gist.github.com/user/a91f3c0e7  ·  or  ·  a91f3c0e7"
            value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void resolve(); }} />
          <div className="hint" style={{ marginTop: 6 }}>Paste a full URL or the raw gist ID.</div>
          {phase === "error" && <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11, marginTop: 10 }}>Couldn't resolve: {err}</div>}
        </div>
      )}
    </Modal>
  );
}

/* ── Preview (catalog) ── */
export function PreviewModal({ cat, forked, onClose, onFork }: {
  cat: CatalogEntry; forked: boolean; onClose: () => void; onFork: (cat: CatalogEntry) => void;
}) {
  const sections = CATALOG_FLOW_KINDS.slice(0, cat.stageCount).map((k) => mkStageSection(k));
  return (
    <Modal lg icon={cat.icon} iconBg={tint(cat.h, 0.16)} iconColor={hue(cat.h)} title={cat.name}
      sub={`by ${cat.author} · ★ ${cat.stars.toLocaleString()} · ${cat.stageCount} stages`} onClose={onClose}
      foot={<><span className="hint mono">gist.github.com/{cat.author}/{cat.gistId}</span><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>Close</button><button className="btn primary" disabled={forked} onClick={() => onFork(cat)}>{forked ? "✓ In your library" : "⑂ Fork to my library"}</button></>}>
      <div className="hbody" style={{ marginBottom: 14 }}>{cat.desc}</div>
      <div className="seclabel">Stage flow<span className="ln" /><span className="dim mono">{sections.length}</span></div>
      <div className="card" style={{ padding: 13 }}><StageSummary sections={sections} /></div>
      <div style={{ display: "flex", gap: 7, marginTop: 12, flexWrap: "wrap" }}>
        {cat.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
        <span className="tag green">public gist</span>
      </div>
    </Modal>
  );
}

/* ── Version history (gist revisions) ── */
export interface Revision { sha: string; when: string; msg: string; add?: number; del?: number; cur?: boolean; version?: string }
export function HistoryModal({ bp, revs, onClose, onRestore }: {
  bp: Blueprint; revs: Revision[]; onClose: () => void; onRestore: (r: Revision) => void;
}) {
  return (
    <Modal icon={<Ic n="history" size={15} />} title="Version history" sub={`${bp.name} · gist revisions`} onClose={onClose}
      foot={<><span className="hint">Each publish creates a gist revision. Restore rolls the blueprint back.</span><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>Close</button></>}>
      <div className="timeline" style={{ position: "relative", paddingLeft: 6 }}>
        {revs.map((r) => (
          <div className={"rev" + (r.cur ? " cur" : "")} key={r.sha} style={{ position: "relative", display: "flex", gap: 14, padding: "0 0 4px 22px" }}>
            <span className="rdot" style={{ position: "absolute", left: 0, top: 4, width: 9, height: 9, borderRadius: "50%", background: r.cur ? "var(--accent)" : "var(--bg-elev2)", border: r.cur ? "2px solid var(--accent)" : "2px solid var(--border)" }} />
            <div style={{ flex: 1, paddingBottom: 16, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>{r.sha}</span>
                {r.cur && <span className="tag amber">current</span>}
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-dim)" }}>{r.when}</span>
                <span style={{ flex: 1 }} />
                {!r.cur && <button className="btn sm ghost" onClick={() => onRestore(r)}>Restore</button>}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 3 }}>{r.msg}</div>
              {(!!r.add || !!r.del) && (
                <div style={{ display: "flex", gap: 8, marginTop: 6, fontFamily: "var(--mono)", fontSize: 10 }}>
                  {!!r.add && <span style={{ color: "var(--success)" }}>+{r.add}</span>}
                  {!!r.del && <span style={{ color: "var(--danger)" }}>−{r.del}</span>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ── Sync / pull upstream ── */
export function SyncModal({ bp, diff, toRev, onClose, onPull }: {
  bp: Blueprint; diff: DiffLine[]; toRev?: string; onClose: () => void; onPull: (diff: DiffLine[]) => void;
}) {
  const [phase, setPhase] = useState<"review" | "pulling">("review");
  const mark = (t: DiffLine["type"]) => (t === "add" ? "+" : t === "del" ? "−" : "~");
  const color = (t: DiffLine["type"]) => (t === "add" ? "var(--success)" : t === "del" ? "var(--danger)" : "var(--info)");
  return (
    <Modal icon={<Ic n="sync" size={15} />} title="Sync with upstream" sub={`${bp.name} · ${bp.gist?.author ?? "upstream"} has newer changes`} onClose={onClose}
      foot={<><span className="hint">{diff.length} change{diff.length > 1 ? "s" : ""} · local edits are preserved where possible</span><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>Not now</button><button className="btn primary" disabled={phase === "pulling"} onClick={() => { setPhase("pulling"); onPull(diff); }}>{phase === "pulling" ? "Merging…" : "Pull changes"}</button></>}>
      <div className="hint" style={{ marginBottom: 12 }}>Upstream <span className="kbd">{bp.gist?.rev ?? "r1"}</span> → <span className="kbd" style={{ color: "var(--accent)" }}>{toRev ?? "latest"}</span>. Review the changes before merging into your copy.</div>
      {diff.map((d, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 11px", borderRadius: "var(--r-sm)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 4, background: "color-mix(in oklch, " + color(d.type) + ", transparent 90%)", color: color(d.type) }}>
          <span style={{ width: 14, textAlign: "center", fontWeight: 700 }}>{mark(d.type)}</span>
          <span style={{ color: "var(--fg)" }}>{d.title}</span>
          <span style={{ flex: 1 }} />
          <span className="dim" style={{ fontSize: 10 }}>{d.note}</span>
        </div>
      ))}
    </Modal>
  );
}

/* ── New blueprint ── */
export function NewBlueprintModal({ onClose, onCreate, onDesignWithClaude }: {
  onClose: () => void;
  onCreate: (name: string, mode: "blank" | "default") => void;
  onDesignWithClaude: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"blank" | "default" | "claude">("blank");
  const submit = () => { if (!name.trim()) return; if (mode === "claude") onDesignWithClaude(name.trim()); else onCreate(name.trim(), mode); };
  return (
    <Modal icon={<Ic n="add" size={15} />} title="New blueprint" sub="Start a reusable planning template" onClose={onClose}
      foot={<><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={submit}>{mode === "claude" ? "Design with Claude →" : "Create blueprint"}</button></>}>
      <div className="field" style={{ marginBottom: 16 }}>
        <label style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Name</label>
        <input className="input" autoFocus style={{ marginTop: 6 }} placeholder="e.g. Internal tool, Data pipeline…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
      </div>
      <div className="field">
        <label style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Start from</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
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
