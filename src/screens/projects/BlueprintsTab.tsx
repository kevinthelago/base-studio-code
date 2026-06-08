// Blueprints tab (#513/#514). Center stage: an expandable list of planning
// SECTIONS, each owning its prompt module + its PIPELINES. Secondary: the blueprint
// library. The active blueprint seeds every new project's planning session.
//
// Matches design/base-studio-code-projects/Blueprints.html, wired to the store.

import { useState, useRef } from "react";
import { useAppStore } from "../../store";
import {
  PIPELINE_LIB, TRIGGERS, SECTION_DEFS, computeStatus, reorder, uid,
  type Blueprint, type BlueprintSection, type Pipeline, type PipelineDef, type PipelineKind, type PipelineTrigger,
} from "./blueprints";
import { blueprintToManifest, manifestToBlueprint } from "./blueprintShare";
import { encodeShareCode, decodeShareCode, parseManifest } from "../../lib/extensions/manifest";
import { gistIdFromUrl, installFromGist, publishGist } from "../../lib/extensions/gist";

const KIND_COLOR: Record<PipelineKind, string> = { builtin: "var(--accent)", external: "var(--info)", custom: "var(--violet, oklch(0.72 0.12 300))" };
const pad2 = (n: number) => String(n).padStart(2, "0");

// The set of edit operations the rows call — each computes a new sections array and
// persists it via the store (setBlueprintSections), mirroring the design's `patch`.
interface BpApi {
  toggleSection: (u: string) => void;
  toggleExpand: (u: string) => void;
  editPrompt: (u: string, v: string) => void;
  moveSection: (from: string, to: string, before: boolean) => void;
  removeSection: (u: string) => void;
  addSection: (name: string) => void;
  addPipeline: (su: string, pl: Pipeline) => void;
  removePipeline: (su: string, pu: string) => void;
  togglePipeline: (su: string, pu: string) => void;
  setTrigger: (su: string, pu: string, v: PipelineTrigger) => void;
  setGate: (su: string, pu: string, gate: boolean) => void;
  movePipeline: (su: string, from: string, to: string, before: boolean) => void;
}

// Drag tracking shared across sibling rows. Exposed as callbacks (not a raw ref)
// so children never mutate a prop — the ref is owned here, satisfying the compiler.
interface DragCtl { start: (u: string) => void; get: () => string | null; clear: () => void }
function useDragCtl(): DragCtl {
  const ref = useRef<string | null>(null);
  return { start: (u) => { ref.current = u; }, get: () => ref.current, clear: () => { ref.current = null; } };
}

function Switch({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <div
      className={"sw" + (on ? " on" : "") + (disabled ? " dis" : "")}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
    ><i /></div>
  );
}

// ── pipeline row ───────────────────────────────────────────────────────────────
function PipelineRow({ pl, secUid, locked, api, drag }: {
  pl: Pipeline; secUid: string; locked: boolean; api: BpApi; drag: DragCtl;
}) {
  const [over, setOver] = useState<"before" | "after" | null>(null);
  return (
    <div
      draggable={!locked}
      onDragStart={(e) => { e.stopPropagation(); drag.start(pl.uid); }}
      onDragOver={(e) => { const d = drag.get(); if (d && d !== pl.uid) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setOver(e.clientY < r.top + r.height / 2 ? "before" : "after"); } }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const d = drag.get(); if (d && d !== pl.uid) api.movePipeline(secUid, d, pl.uid, over === "before"); drag.clear(); setOver(null); }}
      className={over ? "drop-" + over : ""}
      style={{
        display: "grid", gridTemplateColumns: "16px 30px 1fr auto auto auto", gap: 10, alignItems: "center",
        padding: "9px 12px", background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-md)", opacity: pl.enabled ? 1 : 0.55,
      }}
    >
      <span className="drag-handle" title="Drag to reorder">⠿</span>
      <Switch on={pl.enabled} disabled={locked} onClick={() => api.togglePipeline(secUid, pl.uid)} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", whiteSpace: "nowrap" }}>{pl.name}</span>
          <span className="tag" style={{ color: KIND_COLOR[pl.kind], borderColor: "color-mix(in oklch," + KIND_COLOR[pl.kind] + ",transparent 70%)" }}>{pl.kind}</span>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 2 }}>{pl.desc}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="hint">trigger</span>
        <select className="sel" value={pl.trigger} disabled={locked}
          onChange={(e) => api.setTrigger(secUid, pl.uid, e.target.value as PipelineTrigger)}>
          {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <span
        className="tag"
        title={pl.gate ? "Gate: blocks the stage until this passes" : "Mark as a gate (blocks the stage until it passes)"}
        onClick={() => api.setGate(secUid, pl.uid, !pl.gate)}
        style={{
          cursor: "pointer", fontSize: 9.5,
          color: pl.gate ? "var(--accent)" : "var(--fg-dim)",
          borderColor: pl.gate ? "color-mix(in oklch,var(--accent),transparent 65%)" : "var(--border-soft)",
          background: pl.gate ? "color-mix(in oklch,var(--accent),transparent 90%)" : "transparent",
        }}
      >⛉ gate</span>
      <button className="icon-btn danger" title="Remove pipeline" disabled={locked}
        onClick={() => api.removePipeline(secUid, pl.uid)}>✕</button>
    </div>
  );
}

// ── add-pipeline picker ──────────────────────────────────────────────────────
function PickItem({ p, onPick }: { p: PipelineDef; onPick: (p: PipelineDef) => void }) {
  return (
    <div onClick={() => onPick(p)} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer",
      borderRadius: "var(--r-md)", border: "1px solid var(--border-soft)", background: "var(--bg-panel)",
    }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent-dim)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-soft)")}>
      <span className="tag" style={{ color: KIND_COLOR[p.kind], borderColor: "color-mix(in oklch," + KIND_COLOR[p.kind] + ",transparent 70%)" }}>{p.kind}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{p.name}</div>
        <div style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>{p.desc}</div>
      </div>
      <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 14 }}>+</span>
    </div>
  );
}
function PickGroup({ label, items, onPick }: { label: string; items: PipelineDef[]; onPick: (p: PipelineDef) => void }) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="hint" style={{ textTransform: "uppercase", letterSpacing: ".08em", margin: "12px 2px 6px" }}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{items.map((p) => <PickItem key={p.id} p={p} onPick={onPick} />)}</div>
    </>
  );
}

function AddPipelineModal({ section, api, onClose }: { section: BlueprintSection; api: BpApi; onClose: () => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const suggested = PIPELINE_LIB.filter((p) => p.suits.includes(section.key));
  const others = PIPELINE_LIB.filter((p) => !p.suits.includes(section.key) && p.suits.includes("*"));
  const more = PIPELINE_LIB.filter((p) => !p.suits.includes(section.key) && !p.suits.includes("*"));
  const pick = (p: PipelineDef) => { api.addPipeline(section.uid, { ...p, uid: uid("pl"), trigger: "on completion", enabled: true }); onClose(); };

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 15 }}>{section.glyph}</span>
          <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 14 }}>Add pipeline to {section.name}</h3>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="hint" style={{ marginBottom: 4 }}>Pipelines run on this stage's output. Pick a built-in, an integration, or wire your own.</div>
        <PickGroup label={"suggested for " + section.name} items={suggested} onPick={pick} />
        <PickGroup label="works on any stage" items={others} onPick={pick} />
        <PickGroup label="more" items={more} onPick={pick} />

        <div className="hint" style={{ textTransform: "uppercase", letterSpacing: ".08em", margin: "14px 2px 6px" }}>custom / external tool</div>
        <div style={{ padding: 12, borderRadius: "var(--r-md)", border: "1px dashed var(--border)", background: "var(--bg-canvas)", display: "flex", flexDirection: "column", gap: 8 }}>
          <input className="ti" placeholder="pipeline name (e.g. Run Storybook build)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="ti" placeholder="command or webhook — what it does" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="hint">▸ runs your own command, container, or HTTP webhook</span>
            <div style={{ flex: 1 }} />
            <button className="btn primary sm" disabled={!name.trim()}
              onClick={() => { api.addPipeline(section.uid, { uid: uid("pl"), id: "custom-" + uid("c"), name: name.trim(), desc: desc.trim() || "Custom integration", kind: "custom", suits: ["*"], trigger: "manual", enabled: true }); onClose(); }}>
              add custom →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── section row ──────────────────────────────────────────────────────────────
function SectionRow({ s, idx, status, statusAll, byKey, api, drag, onAdd }: {
  s: BlueprintSection; idx: number;
  status: { locked: boolean; unmet: string[]; satisfied: boolean };
  statusAll: Record<string, { satisfied: boolean }>;
  byKey: Record<string, BlueprintSection>;
  api: BpApi; drag: DragCtl;
  onAdd: (s: BlueprintSection) => void;
}) {
  const [over, setOver] = useState<"before" | "after" | null>(null);
  const plDrag = useDragCtl();
  const disabled = !s.enabled;
  const locked = status.locked;

  const statusChip = disabled
    ? <span className="tag" style={{ color: "var(--fg-dim)" }}>○ off</span>
    : locked
      ? <span className="tag" style={{ color: "var(--accent)", borderColor: "color-mix(in oklch,var(--accent),transparent 65%)", background: "color-mix(in oklch,var(--accent),transparent 90%)" }}>
          🔒 locked · needs {status.unmet.map((d) => byKey[d]?.name || d).join(", ")}</span>
      : <span className="tag" style={{ color: "var(--success)", borderColor: "color-mix(in oklch,var(--success),transparent 70%)" }}><span className="pulse-dot" /> ready</span>;

  return (
    <div className={over ? "drop-" + over : ""}
      style={{ border: "1px solid " + (s.expanded ? "var(--border)" : "var(--border-soft)"), borderRadius: "var(--r-lg)", background: "var(--bg-panel)", overflow: "hidden" }}>
      <div
        draggable
        onDragStart={() => { drag.start(s.uid); }}
        onDragOver={(e) => { const d = drag.get(); if (d && d !== s.uid) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setOver(e.clientY < r.top + r.height / 2 ? "before" : "after"); } }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => { e.preventDefault(); const d = drag.get(); if (d && d !== s.uid) api.moveSection(d, s.uid, over === "before"); drag.clear(); setOver(null); }}
        onClick={() => api.toggleExpand(s.uid)}
        style={{ display: "flex", flexDirection: "column", gap: 7, padding: "12px 14px", cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span className="drag-handle" title="Drag to reorder stage" onClick={(e) => e.stopPropagation()}>⠿</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: disabled ? "var(--fg-dim)" : "var(--accent)", width: 18 }}>{pad2(idx + 1)}</span>
          <Switch on={s.enabled} onClick={() => api.toggleSection(s.uid)} />
          <span style={{ fontSize: 16, opacity: disabled ? 0.5 : 1 }}>{s.glyph}</span>
          <span style={{ fontFamily: "var(--sans)", fontSize: 14, fontWeight: 600, color: disabled ? "var(--fg-dim)" : "var(--fg)" }}>{s.name}</span>
          {statusChip}
          <div style={{ flex: 1 }} />
          <span className="tag">{`${s.pipelines.length} ${s.pipelines.length === 1 ? "pipeline" : "pipelines"}`}</span>
          <button
            className="icon-btn danger"
            title="Delete stage"
            onClick={(e) => { e.stopPropagation(); api.removeSection(s.uid); }}
          >✕</button>
          <span style={{ color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12, transform: s.expanded ? "rotate(90deg)" : "none", transition: "transform .15s", width: 14, textAlign: "center" }}>›</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 29, opacity: disabled ? 0.6 : 1, flexWrap: "wrap" }}>
          <span className="hint" style={{ color: "var(--fg-muted)" }}>{s.blurb}</span>
          <span className="tag" style={{ color: "var(--fg-muted)" }}>gate: {s.gate}</span>
          {s.deps.length > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span className="hint">after</span>
              {s.deps.map((d) => {
                const dep = byKey[d];
                const label = SECTION_DEFS[d]?.name || dep?.name || d;
                if (!dep) return <span key={d} className="tag" title="not part of this blueprint — treated as met" style={{ color: "var(--fg-dim)" }}>◦ {label}</span>;
                const met = statusAll[d]?.satisfied;
                const c = met ? "var(--success)" : "var(--danger)";
                return <span key={d} className="tag" style={{ color: c, borderColor: "color-mix(in oklch," + c + ",transparent 70%)" }}>{met ? "✓" : "✕"} {label}</span>;
              })}
            </span>
          )}
        </div>
      </div>

      {s.expanded && (
        <div style={{ borderTop: "1px solid var(--border-soft)", padding: "14px 16px 16px", background: "var(--bg-canvas)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 7 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", textTransform: "uppercase", letterSpacing: ".05em" }}>Prompt module</span>
            <span className="hint">the instruction block Claude receives when planning this stage</span>
          </div>
          <textarea className="pm" value={s.prompt} onChange={(e) => api.editPrompt(s.uid, e.target.value)} spellCheck={false} />

          <div style={{ marginTop: 16, paddingLeft: 12, borderLeft: "2px solid color-mix(in oklch,var(--accent),transparent 65%)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", textTransform: "uppercase", letterSpacing: ".05em" }}>Pipelines</span>
              <span className="hint">pluggable actions that run on this stage's output</span>
              <div style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => onAdd(s)}>+ Add pipeline</button>
            </div>

            {locked && s.pipelines.length > 0 && (
              <div className="hint" style={{ marginBottom: 8, color: "var(--accent)" }}>stage locked — pipelines won't run until dependencies are met.</div>
            )}

            {s.pipelines.length === 0 ? (
              <div style={{ padding: "20px 16px", borderRadius: "var(--r-md)", border: "1px dashed var(--border)", textAlign: "center", background: "var(--bg-panel)" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-muted)" }}>No pipelines yet</div>
                <div className="hint" style={{ margin: "4px 0 10px" }}>Bind an action that runs when this stage produces its plan.</div>
                <button className="btn primary sm" onClick={() => onAdd(s)}>+ Add pipeline</button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, pointerEvents: locked ? "none" : "auto", opacity: locked ? 0.6 : 1 }}>
                {s.pipelines.map((pl) => <PipelineRow key={pl.uid} pl={pl} secUid={s.uid} locked={locked} api={api} drag={plDrag} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── section list (center stage) ──────────────────────────────────────────────
function SectionList({ bp, api }: { bp: Blueprint; api: BpApi }) {
  const drag = useDragCtl();
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [pickFor, setPickFor] = useState<BlueprintSection | null>(null);
  const status = computeStatus(bp.sections);
  const byKey: Record<string, BlueprintSection> = Object.fromEntries(bp.sections.map((s) => [s.key, s]));

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 9 }}>
      {bp.sections.map((s, i) => (
        <SectionRow key={s.uid} s={s} idx={i} status={status[s.key]} statusAll={status} byKey={byKey} api={api} drag={drag} onAdd={setPickFor} />
      ))}

      {adding ? (
        <div style={{ display: "flex", gap: 8, padding: "10px 12px", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)", background: "var(--bg-panel)" }}>
          <input className="ti" autoFocus placeholder="custom stage name (e.g. Compliance review)" value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && addName.trim()) { api.addSection(addName.trim()); setAddName(""); setAdding(false); } }} />
          <button className="btn primary sm" disabled={!addName.trim()} onClick={() => { api.addSection(addName.trim()); setAddName(""); setAdding(false); }}>add</button>
          <button className="btn ghost sm" onClick={() => { setAdding(false); setAddName(""); }}>cancel</button>
        </div>
      ) : (
        <button className="btn ghost" style={{ alignSelf: "flex-start", color: "var(--fg-muted)" }} onClick={() => setAdding(true)}>+ Add custom stage</button>
      )}

      {pickFor && <AddPipelineModal section={bp.sections.find((x) => x.uid === pickFor.uid) || pickFor} api={api} onClose={() => setPickFor(null)} />}
    </div>
  );
}

// ── import modal ─────────────────────────────────────────────────────────────
// Paste a share code (or exported JSON) → validate the envelope → reconstruct the
// blueprint → add it under a fresh id. The same path a gist install will reuse (#598).
function ImportBlueprintModal({ onImport, onClose, token }: { onImport: (bp: Blueprint) => void; onClose: () => void; token: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const doImport = async () => {
    const raw = text.trim();
    if (!raw) { setError("Paste a share code, gist URL, or exported JSON."); return; }
    setBusy(true);
    setError(null);
    try {
      // Accept raw JSON, a gist URL/id (fetched), or a share code.
      const validated = raw.startsWith("{") ? parseManifest(raw)
        : gistIdFromUrl(raw) ? await installFromGist(raw, token)
        : decodeShareCode(raw);
      if (!validated.ok) { setError(validated.error); return; }
      const bp = manifestToBlueprint(validated.manifest);
      if (!bp.ok) { setError(bp.error); return; }
      onImport(bp.blueprint);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ padding: "18px 20px", width: 480 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>Import blueprint</h3>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="hint" style={{ marginBottom: 8 }}>Paste a blueprint share code, a gist URL, or exported JSON.</div>
        <textarea
          className="input" value={text} onChange={(e) => { setText(e.target.value); setError(null); }}
          placeholder="share code, gist URL, or JSON…" rows={5}
          style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 11, resize: "vertical" }}
        />
        {error && <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11, marginTop: 8 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose}>cancel</button>
          <button className="btn primary" onClick={doImport} disabled={busy}>{busy ? "Importing…" : "Import"}</button>
        </div>
      </div>
    </div>
  );
}

// ── library (secondary) ──────────────────────────────────────────────────────
function Library({ blueprints, selectedId, activeId, onSelect, onNew, onSetActive, onDuplicate, onDelete, onExport, onImport, onPublish, canPublish }: {
  blueprints: Blueprint[]; selectedId: string; activeId: string;
  onSelect: (id: string) => void; onNew: () => void; onSetActive: (id: string) => void;
  onDuplicate: (id: string) => void; onDelete: (id: string) => void;
  onExport: (id: string) => void; onImport: () => void;
  onPublish: (id: string) => void; canPublish: boolean;
}) {
  return (
    <aside style={{ width: 256, flex: "0 0 256px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", textTransform: "uppercase", letterSpacing: ".05em" }}>Library</h3>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={onImport}>Import</button>
        <button className="btn sm" onClick={onNew}>+ New</button>
      </div>
      <div className="hint">The active blueprint seeds every new project.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blueprints.map((b) => {
          const sel = b.id === selectedId;
          const active = b.id === activeId;
          const plCount = b.sections.reduce((n, s) => n + s.pipelines.length, 0);
          const onCount = b.sections.filter((s) => s.enabled).length;
          return (
            <div key={b.id} onClick={() => onSelect(b.id)} style={{
              padding: "11px 12px", borderRadius: "var(--r-lg)", cursor: "pointer",
              background: sel ? "var(--bg-elev)" : "var(--bg-panel)",
              border: "1px solid " + (sel ? "var(--accent-dim)" : "var(--border-soft)"),
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontFamily: "var(--sans)", fontSize: 12.5, fontWeight: 600, color: "var(--fg)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</span>
                {active && <span className="tag" style={{ color: "var(--accent)", borderColor: "color-mix(in oklch,var(--accent),transparent 65%)", background: "color-mix(in oklch,var(--accent),transparent 90%)" }}>★ active</span>}
              </div>
              <div className="hint" style={{ marginTop: 3 }}>{b.desc}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
                <span>{onCount}/{b.sections.length} stages</span><span>·</span><span>{plCount} pipelines</span>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
                {!active && <button className="btn sm" style={{ flex: 1 }} onClick={(e) => { e.stopPropagation(); onSetActive(b.id); }}>set active</button>}
                {active && <button className="btn sm" style={{ flex: 1, cursor: "default", color: "var(--fg-dim)" }} disabled>seeds new projects</button>}
                <button className="icon-btn" title="Copy share code" onClick={(e) => { e.stopPropagation(); onExport(b.id); }}>↗</button>
                <button
                  className="icon-btn"
                  title={canPublish ? "Publish to Gist (copies URL)" : "Connect GitHub to publish to a gist"}
                  disabled={!canPublish}
                  onClick={(e) => { e.stopPropagation(); onPublish(b.id); }}
                >☁</button>
                <button className="icon-btn" title="Duplicate" onClick={(e) => { e.stopPropagation(); onDuplicate(b.id); }}>⧉</button>
                <button
                  className="icon-btn danger"
                  title={blueprints.length <= 1 ? "Can't delete the only blueprint" : "Delete blueprint"}
                  disabled={blueprints.length <= 1}
                  onClick={(e) => { e.stopPropagation(); onDelete(b.id); }}
                >✕</button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export function Blueprints() {
  const {
    blueprints, activeBlueprintId, githubToken,
    setActiveBlueprint, addBlueprint, duplicateBlueprint, setBlueprintSections, removeBlueprint, importBlueprint,
  } = useAppStore();

  const [selectedId, setSelectedId] = useState(activeBlueprintId);
  const [importOpen, setImportOpen] = useState(false);
  const [published, setPublished] = useState<{ url: string } | { error: string } | null>(null);

  // Export = copy the blueprint's share code to the clipboard.
  const copyShareCode = (id: string) => {
    const bp = blueprints.find((b) => b.id === id);
    if (bp) navigator.clipboard?.writeText(encodeShareCode(blueprintToManifest(bp))).catch(() => {});
  };

  // Publish = create a secret gist and copy its URL to the clipboard.
  const publishToGist = async (id: string) => {
    const bp = blueprints.find((b) => b.id === id);
    if (!bp || !githubToken) return;
    setPublished(null);
    try {
      const { htmlUrl } = await publishGist(githubToken, blueprintToManifest(bp));
      navigator.clipboard?.writeText(htmlUrl).catch(() => {});
      setPublished({ url: htmlUrl });
    } catch (e) {
      setPublished({ error: String(e) });
    }
  };
  const selected = blueprints.find((b) => b.id === selectedId) ?? blueprints.find((b) => b.id === activeBlueprintId) ?? blueprints[0];

  // All section/pipeline edits compute a new sections array and persist it.
  const setSecs = (updater: (secs: BlueprintSection[]) => BlueprintSection[]) =>
    selected && setBlueprintSections(selected.id, updater(selected.sections));
  const mapSec = (u: string, fn: (s: BlueprintSection) => BlueprintSection) =>
    setSecs((secs) => secs.map((s) => (s.uid === u ? fn(s) : s)));

  const api: BpApi = {
    toggleSection: (u) => mapSec(u, (s) => ({ ...s, enabled: !s.enabled })),
    toggleExpand: (u) => mapSec(u, (s) => ({ ...s, expanded: !s.expanded })),
    editPrompt: (u, v) => mapSec(u, (s) => ({ ...s, prompt: v })),
    moveSection: (from, to, before) => setSecs((secs) => reorder(secs, from, to, before)),
    removeSection: (u) => setSecs((secs) => secs.filter((s) => s.uid !== u)),
    addSection: (name) => setSecs((secs) => [...secs, {
      uid: uid("sec"), key: "custom-" + uid("k"), name, glyph: "✚", gate: "stage complete", deps: [],
      blurb: "Custom planning stage.", prompt: "Describe what Claude should produce in this stage, and the gate that marks it complete.",
      enabled: true, expanded: true, pipelines: [],
    }]),
    addPipeline: (su, pl) => mapSec(su, (s) => ({ ...s, pipelines: [...s.pipelines, pl] })),
    removePipeline: (su, pu) => mapSec(su, (s) => ({ ...s, pipelines: s.pipelines.filter((p) => p.uid !== pu) })),
    togglePipeline: (su, pu) => mapSec(su, (s) => ({ ...s, pipelines: s.pipelines.map((p) => (p.uid === pu ? { ...p, enabled: !p.enabled } : p)) })),
    setTrigger: (su, pu, v) => mapSec(su, (s) => ({ ...s, pipelines: s.pipelines.map((p) => (p.uid === pu ? { ...p, trigger: v } : p)) })),
    setGate: (su, pu, gate) => mapSec(su, (s) => ({ ...s, pipelines: s.pipelines.map((p) => (p.uid === pu ? { ...p, gate } : p)) })),
    movePipeline: (su, from, to, before) => mapSec(su, (s) => ({ ...s, pipelines: reorder(s.pipelines, from, to, before) })),
  };

  if (!selected) {
    return <div style={{ padding: 24, fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>No blueprints.</div>;
  }

  const onCount = selected.sections.filter((s) => s.enabled).length;
  const plCount = selected.sections.reduce((n, s) => n + s.pipelines.length, 0);

  return (
    <section style={{ flex: 1, overflow: "auto", padding: "20px 26px", minWidth: 0 }}>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 19, fontWeight: 600 }}>Blueprints</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 5, lineHeight: 1.5, maxWidth: 640 }}>
              A blueprint is a reusable planning configuration — an ordered list of stages, each with its prompt module and its pipelines — that seeds every new project's planning session.
            </div>
          </div>
        </div>

        {/* editing context bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", marginBottom: 16, background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }}>
          <span className="hint">editing</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)" }}>{selected.name}</span>
          {selected.id === activeBlueprintId
            ? <span className="tag" style={{ color: "var(--accent)", borderColor: "color-mix(in oklch,var(--accent),transparent 65%)", background: "color-mix(in oklch,var(--accent),transparent 90%)" }}>★ active · seeds new projects</span>
            : <button className="btn sm" onClick={() => setActiveBlueprint(selected.id)}>set as active</button>}
          <div style={{ flex: 1 }} />
          <span className="hint">{onCount}/{selected.sections.length} stages on · {plCount} pipelines</span>
        </div>

        {/* two-column: section list (star) + library (secondary) */}
        <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
          <SectionList bp={selected} api={api} />
          <Library
            blueprints={blueprints} selectedId={selectedId} activeId={activeBlueprintId}
            onSelect={setSelectedId}
            onNew={() => setSelectedId(addBlueprint())}
            onSetActive={setActiveBlueprint}
            onDuplicate={(id) => setSelectedId(duplicateBlueprint(id))}
            onDelete={(id) => { removeBlueprint(id); setSelectedId(activeBlueprintId); }}
            onExport={copyShareCode}
            onImport={() => setImportOpen(true)}
            onPublish={publishToGist}
            canPublish={!!githubToken}
          />
        </div>
      </div>
      {published && (
        <div style={{
          position: "fixed", bottom: 18, right: 18, zIndex: 60, maxWidth: 420,
          padding: "10px 14px", borderRadius: "var(--r-md)",
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--mono)", fontSize: 11,
        }}>
          {"url" in published ? (
            <>
              <span style={{ color: "var(--success)" }}>✓ Published · URL copied</span>
              <a href={published.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{published.url.replace(/^https?:\/\//, "")}</a>
            </>
          ) : (
            <span style={{ color: "var(--danger)" }}>Publish failed: {published.error}</span>
          )}
          <button className="icon-btn" onClick={() => setPublished(null)}>✕</button>
        </div>
      )}
      {importOpen && (
        <ImportBlueprintModal
          onImport={(bp) => setSelectedId(importBlueprint(bp))}
          onClose={() => setImportOpen(false)}
          token={githubToken}
        />
      )}
    </section>
  );
}
