/* ===== Editor view: stage flow rail + stage detail ===== */
const { useState: useStateEd, useRef: useRefEd } = React;

/* ---------- left rail: ordered, draggable stage flow ---------- */
function StageNode({ stage, idx, total, selected, allStages, onSelect, dragHandlers, isDragging, isOver }) {
  const k = STAGE_KINDS[stage.kind] || { glyph: "category", h: 250, title: stage.kind };
  const gates = stage.pipelines.filter((p) => p.gate).length;
  const deps = stage.dependsOn.map((id) => allStages.find((s) => s.id === id)).filter(Boolean);
  const locked = deps.length > 0;
  return (
    <div
      className={"stage" + (selected ? " sel" : "") + (locked ? " locked" : "") + (isDragging ? " dragging" : "") + (isOver ? " dragover" : "")}
      draggable
      onDragStart={(e) => dragHandlers.start(e, idx)}
      onDragOver={(e) => dragHandlers.over(e, idx)}
      onDrop={(e) => dragHandlers.drop(e, idx)}
      onDragEnd={dragHandlers.end}
      onClick={() => onSelect(stage.id)}
    >
      <span className="grip" title="Drag to reorder">⠿</span>
      <span className="snum">{String(idx + 1).padStart(2, "0")}</span>
      <span className="sicon" style={{ background: tint(k.h, 0.16), color: hue(k.h) }}><Ic n={k.glyph} size={15} /></span>
      <span className="sbody">
        <span className="sname">{stage.title}{locked && <span className="lock" title={"depends on " + deps.map((d) => d.title).join(", ")}>🔒</span>}</span>
        <span className="smeta">
          {stage.pipelines.length > 0 && <span>{stage.pipelines.length} pipeline{stage.pipelines.length > 1 ? "s" : ""}</span>}
          {gates > 0 && <span className="gate">{gates} gate{gates > 1 ? "s" : ""}</span>}
          {locked && <span>↳ {deps.map((d) => d.title).join(", ")}</span>}
          {stage.pipelines.length === 0 && !locked && <span className="dim">{DISPOSITIONS[stage.output] ? DISPOSITIONS[stage.output].title : stage.output}</span>}
        </span>
      </span>
    </div>
  );
}

function StageRail({ bp, selectedId, onSelect, onReorder, onAddStage }) {
  const [dragIdx, setDragIdx] = useStateEd(null);
  const [overIdx, setOverIdx] = useStateEd(null);
  const [adding, setAdding] = useStateEd(false);

  const dragHandlers = {
    start: (e, i) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", String(i)); } catch (_) {} },
    over: (e, i) => { e.preventDefault(); if (i !== overIdx) setOverIdx(i); },
    drop: (e, i) => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i); setDragIdx(null); setOverIdx(null); },
    end: () => { setDragIdx(null); setOverIdx(null); },
  };

  // kinds not already used (still allow dup but show used as dim)
  const usedKinds = new Set(bp.stages.map((s) => s.kind));
  const paletteKeys = Object.keys(STAGE_KINDS);

  return (
    <div className="rail-stages">
      <div className="rail-head">
        <span className="rh-title">Stage flow</span>
        <span className="rh-count tag">{bp.stages.length}</span>
      </div>
      <div className="rail-list">
        {bp.stages.map((s, i) => (
          <React.Fragment key={s.id}>
            <StageNode stage={s} idx={i} total={bp.stages.length} selected={s.id === selectedId}
              allStages={bp.stages} onSelect={onSelect} dragHandlers={dragHandlers}
              isDragging={dragIdx === i} isOver={overIdx === i && dragIdx !== null && dragIdx !== i} />
            {i < bp.stages.length - 1 && <div className={"stage-conn" + (bp.stages[i + 1].dependsOn.includes(s.id) ? " dep" : "")} />}
          </React.Fragment>
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
                {paletteKeys.map((kk) => {
                  const k = STAGE_KINDS[kk];
                  return (
                    <button className="pal-item" key={kk} onClick={() => { onAddStage(kk); setAdding(false); }} title={k.blurb}>
                      <span className="pg" style={{ background: tint(k.h, 0.18), color: hue(k.h) }}><Ic n={k.glyph} size={13} /></span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.title}{usedKinds.has(kk) && <span className="dim"> ·</span>}</span>
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

/* ---------- right: stage detail editor ---------- */
function DependencyEditor({ stage, allStages, onToggle }) {
  // a stage may only depend on stages that precede it (prevents cycles)
  const myIdx = allStages.findIndex((s) => s.id === stage.id);
  const candidates = allStages.slice(0, myIdx);
  if (candidates.length === 0) return <div className="hint">First stage — nothing can precede it, so it's always unlocked.</div>;
  return (
    <div className="dep-row">
      {candidates.map((c) => {
        const k = STAGE_KINDS[c.kind];
        const on = stage.dependsOn.includes(c.id);
        return (
          <button className={"dep-chip" + (on ? " on" : "")} key={c.id} onClick={() => onToggle(c.id)}>
            <span className="dg" style={{ background: tint(k.h, 0.2), color: hue(k.h) }}><Ic n={k.glyph} size={11} /></span>
            {c.title}
            {on && <span style={{ opacity: .7 }}>✓</span>}
          </button>
        );
      })}
    </div>
  );
}

function PipelineRow({ p, onTrigger, onGate, onRemove }) {
  const meta = PIPELINES[p.key] || { name: p.key, h: 250, desc: "", gateable: false };
  return (
    <div className="pipe">
      <span className="pi" style={{ background: tint(meta.h, 0.16), color: hue(meta.h) }}><Ic n={meta.glyph || "conveyor_belt"} size={15} /></span>
      <div className="pbody">
        <div className="pname">{meta.name}{!p.enabled && <span className="tag">paused</span>}</div>
        <div className="pdesc">{meta.desc}</div>
      </div>
      <div className="ptrig">
        <div className="seg" title="When this pipeline runs">
          {TRIGGERS.map((t) => <button key={t} className={p.trigger === t ? "on" : ""} onClick={() => onTrigger(t)}>{t}</button>)}
        </div>
        {meta.gateable && (
          <span className={"gate-toggle"} onClick={onGate} title="Gate: stage can't complete until this passes">
            <span className={"switch" + (p.gate ? " on" : "")} />gate
          </span>
        )}
        <button className="iconbtn danger" title="Remove pipeline" onClick={onRemove}>✕</button>
      </div>
    </div>
  );
}

function StageDetail({ bp, stage, onUpdate, onToggleDep, onAddPipe, onUpdatePipe, onRemovePipe, onDelete, onDuplicate }) {
  const k = STAGE_KINDS[stage.kind] || { glyph: "category", h: 250, title: stage.kind, blurb: "" };
  const existing = new Set(stage.pipelines.map((p) => p.key));
  // suggest relevant pipelines for this kind first, then the rest
  const suggested = Object.keys(PIPELINES).filter((key) => {
    const m = PIPELINES[key]; return m.kinds ? m.kinds.includes(stage.kind) : false;
  });
  const others = Object.keys(PIPELINES).filter((key) => !suggested.includes(key));
  const addable = [...suggested, ...others].filter((key) => !existing.has(key));

  return (
    <div className="detail">
      <div className="detail-inner">
        <div className="d-head">
          <span className="dicon" style={{ background: tint(k.h, 0.16), color: hue(k.h) }}><Ic n={k.glyph} size={19} /></span>
          <input className="d-name" value={stage.title} onChange={(e) => onUpdate({ title: e.target.value })} />
          <span style={{ flex: 1 }} />
          <button className="iconbtn" title="Duplicate stage" onClick={onDuplicate}>⧉</button>
          <button className="iconbtn danger" title="Delete stage" onClick={onDelete}>🗑</button>
        </div>
        <div className="d-kind">{k.title} stage · {k.blurb}</div>

        {/* prompt module */}
        <div className="d-block">
          <div className="lbl">Prompt module <span className="ln" /><span className="lhint">what Claude is told in this stage</span></div>
          <textarea className="input" value={stage.prompt} onChange={(e) => onUpdate({ prompt: e.target.value })}
            style={{ minHeight: 96 }} placeholder="Instructions for the planning agent during this stage…" />
        </div>

        {/* dependencies / gating */}
        <div className="d-block">
          <div className="lbl">Dependencies <span className="ln" /><span className="lhint">stage stays locked until these complete</span></div>
          <DependencyEditor stage={stage} allStages={bp.stages} onToggle={onToggleDep} />
        </div>

        {/* attached pipelines */}
        <div className="d-block">
          <div className="lbl">Attached pipelines <span className="ln" /><span className="lhint">actions that run on this stage's output</span></div>
          {stage.pipelines.length === 0 && <div className="hint" style={{ marginBottom: 8 }}>No pipelines attached. Add one below — gate pipelines block stage completion until they pass.</div>}
          {stage.pipelines.map((p) => (
            <PipelineRow key={p.id} p={p}
              onTrigger={(t) => onUpdatePipe(p.id, { trigger: t })}
              onGate={() => onUpdatePipe(p.id, { gate: !p.gate })}
              onRemove={() => onRemovePipe(p.id)} />
          ))}
          {addable.length > 0 && (
            <div className="pipe-add">
              {addable.map((key) => {
                const m = PIPELINES[key];
                const isSug = suggested.includes(key);
                return (
                  <button className="chip-sug" key={key} onClick={() => onAddPipe(key)}
                    style={isSug ? { borderColor: tint(m.h, 0.5), color: hue(m.h) } : null}
                    title={m.desc}>
                    + {m.name}{isSug && " ✦"}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* output disposition */}
        <div className="d-block">
          <div className="lbl">Output disposition <span className="ln" /><span className="lhint">what happens to this stage's artifact</span></div>
          <div className="disp-grid">
            {Object.keys(DISPOSITIONS).map((key) => {
              const d = DISPOSITIONS[key];
              return (
                <div className={"disp" + (stage.output === key ? " on" : "")} key={key} onClick={() => onUpdate({ output: key })}>
                  <span className="dgl" style={{ background: tint(d.h, 0.16), color: hue(d.h) }}><Ic n={d.glyph} size={14} /></span>
                  <span className="dtxt"><div className="dt">{d.title}</div><div className="dd">{d.desc}</div></span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function EditorView(props) {
  const { bp, selectedId, onSelect, onReorder, onAddStage, ribbon, onResolveRibbon,
    onUpdateStage, onToggleDep, onAddPipe, onUpdatePipe, onRemovePipe, onDeleteStage, onDuplicateStage } = props;
  const stage = bp.stages.find((s) => s.id === selectedId) || bp.stages[0];

  return (
    <div className="ed">
      {ribbon && (
        <div className="ribbon">
          <Ic n="upgrade" size={16} style={{ color: "var(--info)" }} />
          <span><b>{ribbon.author || "upstream"}</b> shipped <b>{ribbon.label}</b> — {ribbon.summary}</span>
          <span className="sp" />
          <button className="btn sm" onClick={() => onResolveRibbon("dismiss")}>Dismiss</button>
          <button className="btn sm primary" onClick={() => onResolveRibbon("review")}>Review changes</button>
        </div>
      )}
      <div className="ed-body">
        <StageRail bp={bp} selectedId={stage ? stage.id : null} onSelect={onSelect} onReorder={onReorder} onAddStage={onAddStage} />
        {stage ? (
          <StageDetail bp={bp} stage={stage}
            onUpdate={(patch) => onUpdateStage(stage.id, patch)}
            onToggleDep={(depId) => onToggleDep(stage.id, depId)}
            onAddPipe={(key) => onAddPipe(stage.id, key)}
            onUpdatePipe={(pid, patch) => onUpdatePipe(stage.id, pid, patch)}
            onRemovePipe={(pid) => onRemovePipe(stage.id, pid)}
            onDelete={() => onDeleteStage(stage.id)}
            onDuplicate={() => onDuplicateStage(stage.id)} />
        ) : (
          <div className="detail"><div className="d-empty"><div className="ico">▢</div><div>No stages yet. Add one from the flow rail, or ask Claude to design the blueprint.</div></div></div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { EditorView, StageRail, StageDetail, StageNode });
