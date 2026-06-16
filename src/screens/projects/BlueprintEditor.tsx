// Blueprint editor view (#609 slice 3) — ported from the design's editor.jsx. A
// draggable stage-flow rail + a per-stage detail editor (prompt / dependencies /
// attached pipelines / output disposition). Pure-ish: it computes new sections via the
// slice-2 helpers (blueprintEdit) and hands them up through `onChange`; the page shell
// persists via setBlueprintSections. The runtime fields (#584 gateRule) ride along
// untouched.

import { useState } from "react";
import "../../styles/blueprints.css";
import { Ic } from "./blueprintIcons";
import {
  stageKind, tint, hue, DISPOSITIONS, DISPOSITION_KEYS, defaultDisposition,
  pipelineMeta, TRIGGER_LABELS, STAGE_KIND_KEYS,
} from "./blueprintCatalog";
import {
  reorderStages, addStage, duplicateStage, deleteStage, toggleDep,
  addPipeline, updatePipeline, removePipeline, setOutput, setStageField, depCandidates,
  addSkill, removeSkill, addMcpServer, removeMcpServer,
} from "./blueprintEdit";
import { resolveBlueprintSkills, type BlueprintSkillItem } from "./blueprintSkills";
import { resolveBlueprintMcp, type McpLibraryItem } from "./blueprintMcp";
import { PIPELINE_LIB, type BlueprintSection, type PipelineTrigger } from "./blueprints";

export interface EditorRibbon { author?: string; label: string; summary: string }

export interface BlueprintEditorProps {
  sections: BlueprintSection[];
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  /** Persist a new sections array (already computed by an edit helper). */
  onChange: (sections: BlueprintSection[]) => void;
  /** The pickable skills/knowledge library (#636); empty ⇒ the Skills block hides its picker. */
  skillLibrary?: BlueprintSkillItem[];
  /** The pickable MCP-server library (#897); empty ⇒ the MCP block hides its picker. */
  mcpLibrary?: McpLibraryItem[];
  ribbon?: EditorRibbon | null;
  onResolveRibbon?: (action: "dismiss" | "review") => void;
}

const gateCount = (s: BlueprintSection) => s.pipelines.filter((p) => p.gate).length;

/* ── stage rail ── */
function StageNode({
  section, idx, selected, all, onSelect, drag, dragging, over,
}: {
  section: BlueprintSection; idx: number; selected: boolean; all: BlueprintSection[];
  onSelect: (uid: string) => void;
  drag: { start: (e: React.DragEvent, i: number) => void; over: (e: React.DragEvent, i: number) => void; drop: (e: React.DragEvent, i: number) => void; end: () => void };
  dragging: boolean; over: boolean;
}) {
  const k = stageKind(section.key);
  const gates = gateCount(section);
  const depNames = section.deps.map((d) => all.find((s) => s.key === d)?.name ?? d);
  const locked = depNames.length > 0;
  return (
    <div
      className={"stage" + (selected ? " is-sel" : "") + (locked ? " locked" : "") + (dragging ? " dragging" : "") + (over ? " dragover" : "")}
      draggable
      onDragStart={(e) => drag.start(e, idx)}
      onDragOver={(e) => drag.over(e, idx)}
      onDrop={(e) => drag.drop(e, idx)}
      onDragEnd={drag.end}
      onClick={() => onSelect(section.uid)}
    >
      <span className="grip" title="Drag to reorder">⠿</span>
      <span className="snum">{String(idx + 1).padStart(2, "0")}</span>
      <span className="sicon" style={{ background: tint(k.h, 0.16), color: hue(k.h) }}><Ic n={k.glyph} size={15} /></span>
      <span className="sbody">
        <span className="sname">{section.name}{locked && <span className="lock" title={"depends on " + depNames.join(", ")}>🔒</span>}</span>
        <span className="smeta">
          {section.pipelines.length > 0 && <span>{section.pipelines.length} pipeline{section.pipelines.length > 1 ? "s" : ""}</span>}
          {gates > 0 && <span className="gate">{gates} gate{gates > 1 ? "s" : ""}</span>}
          {locked && <span>↳ {depNames.join(", ")}</span>}
          {section.pipelines.length === 0 && !locked && <span className="dim">{DISPOSITIONS[section.output ?? defaultDisposition(section.key)]?.title ?? "Plan file"}</span>}
        </span>
      </span>
    </div>
  );
}

function StageRail({ sections, selectedUid, onSelect, onChange }: Pick<BlueprintEditorProps, "sections" | "selectedUid" | "onSelect" | "onChange">) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const drag = {
    start: (e: React.DragEvent, i: number) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; },
    over: (e: React.DragEvent, i: number) => { e.preventDefault(); if (i !== overIdx) setOverIdx(i); },
    drop: (e: React.DragEvent, i: number) => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) onChange(reorderStages(sections, dragIdx, i)); setDragIdx(null); setOverIdx(null); },
    end: () => { setDragIdx(null); setOverIdx(null); },
  };

  const used = new Set(sections.map((s) => s.key));

  return (
    <div className="rail-stages">
      <div className="rail-head">
        <span className="rh-title">Stage flow</span>
        <span className="rh-count tag">{sections.length}</span>
      </div>
      <div className="rail-list">
        {sections.map((s, i) => (
          <div key={s.uid}>
            <StageNode section={s} idx={i} selected={s.uid === selectedUid} all={sections} onSelect={onSelect}
              drag={drag} dragging={dragIdx === i} over={overIdx === i && dragIdx !== null && dragIdx !== i} />
            {i < sections.length - 1 && <div className={"stage-conn" + (sections[i + 1].deps.includes(s.key) ? " dep" : "")} />}
          </div>
        ))}

        <div className="addstage">
          {!adding ? (
            <button className="btn ghost sm" style={{ width: "100%", justifyContent: "center", borderStyle: "dashed", marginTop: 8 }} onClick={() => setAdding(true)}>+ Add stage</button>
          ) : (
            <div className="card" style={{ padding: 11, marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                <span className="rh-title">Add a stage</span>
                <span style={{ flex: 1 }} />
                <button className="iconbtn" onClick={() => setAdding(false)}>✕</button>
              </div>
              <div className="hint" style={{ marginBottom: 6 }}>Pick a kind — it seeds a prompt module you can edit.</div>
              <div className="palette">
                {STAGE_KIND_KEYS.map((kk) => {
                  const k = stageKind(kk);
                  return (
                    <button className="pal-item" key={kk} title={k.blurb}
                      onClick={() => { const next = addStage(sections, kk); onChange(next); onSelect(next[next.length - 1].uid); setAdding(false); }}>
                      <span className="pg" style={{ background: tint(k.h, 0.18), color: hue(k.h) }}><Ic n={k.glyph} size={13} /></span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.title}{used.has(kk) && <span className="dim"> ·</span>}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── stage detail ── */
function DependencyEditor({ sections, section, onChange }: { sections: BlueprintSection[]; section: BlueprintSection; onChange: (s: BlueprintSection[]) => void }) {
  const candidates = depCandidates(sections, section.uid);
  if (candidates.length === 0) return <div className="hint">First stage — nothing can precede it, so it's always unlocked.</div>;
  return (
    <div className="dep-row">
      {candidates.map((c) => {
        const k = stageKind(c.key);
        const on = section.deps.includes(c.key);
        return (
          <button className={"dep-chip" + (on ? " on" : "")} key={c.uid} onClick={() => onChange(toggleDep(sections, section.uid, c.key))}>
            <span className="dg" style={{ background: tint(k.h, 0.2), color: hue(k.h) }}><Ic n={k.glyph} size={11} /></span>
            {c.name}{on && <span style={{ opacity: .7 }}>✓</span>}
          </button>
        );
      })}
    </div>
  );
}

function PipelineRow({ p, onTrigger, onGate, onRemove }: {
  p: BlueprintSection["pipelines"][number];
  onTrigger: (t: PipelineTrigger) => void; onGate: () => void; onRemove: () => void;
}) {
  const meta = pipelineMeta(p.id);
  return (
    <div className="pipe">
      <span className="pi" style={{ background: tint(meta.h, 0.16), color: hue(meta.h) }}><Ic n={meta.glyph} size={15} /></span>
      <div className="pbody">
        <div className="pname">{p.name}{!p.enabled && <span className="tag">paused</span>}</div>
        <div className="pdesc">{p.desc}</div>
      </div>
      <div className="ptrig">
        <div className="seg" title="When this pipeline runs">
          {TRIGGER_LABELS.map((t) => <button key={t.value} className={p.trigger === t.value ? "on" : ""} onClick={() => onTrigger(t.value)}>{t.label}</button>)}
        </div>
        {meta.gateable && (
          <span className="gate-toggle" onClick={onGate} title="Gate: stage can't complete until this passes">
            <span className={"switch" + (p.gate ? " on" : "")} />gate
          </span>
        )}
        <button className="iconbtn danger" title="Remove pipeline" onClick={onRemove}>✕</button>
      </div>
    </div>
  );
}

function StageDetail({ sections, section, onSelect, onChange, skillLibrary = [], mcpLibrary = [] }: { sections: BlueprintSection[]; section: BlueprintSection; onSelect: (uid: string) => void; onChange: (s: BlueprintSection[]) => void; skillLibrary?: BlueprintSkillItem[]; mcpLibrary?: McpLibraryItem[] }) {
  const attached = section.skills ?? [];
  const { found: attachedSkills, missing: missingSkills } = resolveBlueprintSkills(attached, skillLibrary);
  const addableSkills = skillLibrary.filter((i) => !attached.includes(i.id));
  const attachedMcpIds = section.mcp ?? [];
  const { found: attachedMcp, missing: missingMcp } = resolveBlueprintMcp(attachedMcpIds, mcpLibrary);
  const addableMcp = mcpLibrary.filter((i) => !attachedMcpIds.includes(i.id));
  const k = stageKind(section.key);
  const existing = new Set(section.pipelines.map((p) => p.id));
  const suggested = PIPELINE_LIB.filter((p) => p.suits.includes(section.key)).map((p) => p.id);
  const others = PIPELINE_LIB.filter((p) => !suggested.includes(p.id)).map((p) => p.id);
  const addable = [...suggested, ...others].filter((id) => !existing.has(id));
  const output = section.output ?? defaultDisposition(section.key);

  return (
    <div className="detail">
      <div className="detail-inner">
        <div className="d-head">
          <span className="dicon" style={{ background: tint(k.h, 0.16), color: hue(k.h) }}><Ic n={k.glyph} size={19} /></span>
          <input className="d-name" value={section.name} onChange={(e) => onChange(setStageField(sections, section.uid, { name: e.target.value }))} />
          <span style={{ flex: 1 }} />
          <button className="iconbtn" title="Duplicate stage" onClick={() => onChange(duplicateStage(sections, section.uid))}>⧉</button>
          <button className="iconbtn danger" title="Delete stage" onClick={() => {
            const next = deleteStage(sections, section.uid);
            onChange(next);
            if (next[0]) onSelect(next[0].uid);
          }}>🗑</button>
        </div>
        <div className="d-kind">{k.title} stage · {k.blurb}</div>

        <div className="d-block">
          <div className="lbl">Prompt module <span className="ln" /><span className="lhint">what Claude is told in this stage</span></div>
          <textarea className="input" value={section.prompt} style={{ minHeight: 96 }}
            placeholder="Instructions for the planning agent during this stage…"
            onChange={(e) => onChange(setStageField(sections, section.uid, { prompt: e.target.value }))} />
        </div>

        <div className="d-block">
          <div className="lbl">Dependencies <span className="ln" /><span className="lhint">stage stays locked until these complete</span></div>
          <DependencyEditor sections={sections} section={section} onChange={onChange} />
        </div>

        <div className="d-block">
          <div className="lbl">Attached pipelines <span className="ln" /><span className="lhint">actions that run on this stage's output</span></div>
          {section.pipelines.length === 0 && <div className="hint" style={{ marginBottom: 8 }}>No pipelines attached. Add one below — gate pipelines block stage completion until they pass.</div>}
          {section.pipelines.map((p) => (
            <PipelineRow key={p.uid} p={p}
              onTrigger={(t) => onChange(updatePipeline(sections, section.uid, p.uid, { trigger: t }))}
              onGate={() => onChange(updatePipeline(sections, section.uid, p.uid, { gate: !p.gate }))}
              onRemove={() => onChange(removePipeline(sections, section.uid, p.uid))} />
          ))}
          {addable.length > 0 && (
            <div className="pipe-add">
              {addable.map((id) => {
                const def = PIPELINE_LIB.find((p) => p.id === id)!;
                const m = pipelineMeta(id);
                const isSug = suggested.includes(id);
                return (
                  <button className="chip-sug" key={id} title={def.desc}
                    style={isSug ? { borderColor: tint(m.h, 0.5), color: hue(m.h) } : undefined}
                    onClick={() => onChange(addPipeline(sections, section.uid, id))}>
                    + {def.name}{isSug && " ✦"}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="d-block">
          <div className="lbl">Output disposition <span className="ln" /><span className="lhint">what happens to this stage's artifact</span></div>
          <div className="disp-grid">
            {DISPOSITION_KEYS.map((key) => {
              const d = DISPOSITIONS[key];
              return (
                <div className={"disp" + (output === key ? " on" : "")} key={key} onClick={() => onChange(setOutput(sections, section.uid, key))}>
                  <span className="dgl" style={{ background: tint(d.h, 0.16), color: hue(d.h) }}><Ic n={d.glyph} size={14} /></span>
                  <span className="dtxt"><div className="dt">{d.title}</div><div className="dd">{d.desc}</div></span>
                </div>
              );
            })}
          </div>
        </div>

        {/* skills / knowledge attached to this stage (#636) */}
        <div className="d-block">
          <div className="lbl">Skills &amp; knowledge <span className="ln" /><span className="lhint">paired context Claude gets in this stage</span></div>
          {attachedSkills.length === 0 && missingSkills.length === 0 && (
            <div className="hint" style={{ marginBottom: 8 }}>No skills attached. Add reusable knowledge / skills below — they're injected into the agent's context for this stage.</div>
          )}
          {(attachedSkills.length > 0 || missingSkills.length > 0) && (
            <div className="dep-row" style={{ marginBottom: 8 }}>
              {attachedSkills.map((sk) => (
                <span className="dep-chip on" key={sk.id} title={sk.desc}>
                  <span className="dim" style={{ fontSize: 8.5 }}>{sk.kind}</span>{sk.name}
                  <span style={{ cursor: "pointer", opacity: .8 }} onClick={() => onChange(removeSkill(sections, section.uid, sk.id))}> ✕</span>
                </span>
              ))}
              {missingSkills.map((id) => (
                <span className="dep-chip" key={id} title="Not in your library — install it or it won't inject" style={{ color: "var(--danger)", borderColor: "color-mix(in oklch, var(--danger), transparent 60%)" }}>
                  ⚠ {id}
                  <span style={{ cursor: "pointer", opacity: .8 }} onClick={() => onChange(removeSkill(sections, section.uid, id))}> ✕</span>
                </span>
              ))}
            </div>
          )}
          {addableSkills.length > 0 && (
            <div className="pipe-add">
              {addableSkills.map((sk) => (
                <button className="chip-sug" key={sk.id} title={sk.desc} onClick={() => onChange(addSkill(sections, section.uid, sk.id))}>
                  + {sk.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* MCP servers attached to this stage (#897) — tools the planner can call here. */}
        <div className="d-block">
          <div className="lbl">MCP servers <span className="ln" /><span className="lhint">tools Claude can call in this stage</span></div>
          {attachedMcp.length === 0 && missingMcp.length === 0 && (
            <div className="hint" style={{ marginBottom: 8 }}>No MCP servers attached. Add tools below — they're scoped to the project so the planner (and fleet) can call them.</div>
          )}
          {(attachedMcp.length > 0 || missingMcp.length > 0) && (
            <div className="dep-row" style={{ marginBottom: 8 }}>
              {attachedMcp.map((m) => (
                <span className="dep-chip on" key={m.id} title={m.desc}>
                  {m.downloadable && <span className="dim" style={{ fontSize: 8.5 }}>first-party</span>}{m.name}
                  <span style={{ cursor: "pointer", opacity: .8 }} onClick={() => onChange(removeMcpServer(sections, section.uid, m.id))}> ✕</span>
                </span>
              ))}
              {missingMcp.map((id) => (
                <span className="dep-chip" key={id} title="Not in the catalog or installed — add it or it won't connect" style={{ color: "var(--danger)", borderColor: "color-mix(in oklch, var(--danger), transparent 60%)" }}>
                  ⚠ {id}
                  <span style={{ cursor: "pointer", opacity: .8 }} onClick={() => onChange(removeMcpServer(sections, section.uid, id))}> ✕</span>
                </span>
              ))}
            </div>
          )}
          {addableMcp.length > 0 && (
            <div className="pipe-add">
              {addableMcp.map((m) => (
                <button className="chip-sug" key={m.id} title={m.desc} onClick={() => onChange(addMcpServer(sections, section.uid, m.id))}>
                  + {m.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The editor body: an optional upstream ribbon + the stage rail + the stage detail. */
export function BlueprintEditorView({ sections, selectedUid, onSelect, onChange, skillLibrary, mcpLibrary, ribbon, onResolveRibbon }: BlueprintEditorProps) {
  const section = sections.find((s) => s.uid === selectedUid) ?? sections[0];
  return (
    <div className="ed">
      {ribbon && (
        <div className="ribbon">
          <Ic n="upgrade" size={16} style={{ color: "var(--info)" }} />
          <span><b>{ribbon.author ?? "upstream"}</b> shipped <b>{ribbon.label}</b> — {ribbon.summary}</span>
          <span className="sp" />
          <button className="btn sm" onClick={() => onResolveRibbon?.("dismiss")}>Dismiss</button>
          <button className="btn sm primary" onClick={() => onResolveRibbon?.("review")}>Review changes</button>
        </div>
      )}
      <div className="ed-body">
        <StageRail sections={sections} selectedUid={section ? section.uid : null} onSelect={onSelect} onChange={onChange} />
        {section ? (
          <StageDetail sections={sections} section={section} onSelect={onSelect} onChange={onChange} skillLibrary={skillLibrary} mcpLibrary={mcpLibrary} />
        ) : (
          <div className="detail"><div className="d-empty"><div className="ico">▢</div><div>No stages yet. Add one from the flow rail, or ask Claude to design the blueprint.</div></div></div>
        )}
      </div>
    </div>
  );
}
