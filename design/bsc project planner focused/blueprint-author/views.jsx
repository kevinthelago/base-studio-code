/* =====================================================================
   views.jsx — the four focused Blueprint Author phase views.
   Each owns the full pane width for its stage of authoring.
   ===================================================================== */
const { useState, useEffect, useRef } = React;

/* ---------- shared primitives ---------- */
function StageGlyph({ k, size = 26, r = 6, fs }) {
  const meta = window.stageKind(k);
  return (
    <span style={{ width: size, height: size, flex: `0 0 ${size}px`, borderRadius: r,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: window.tint(meta.h, 0.16), color: window.hue(meta.h) }}>
      <window.Ic n={meta.glyph} size={fs || size * 0.56} />
    </span>
  );
}
function Sec({ children, hint }) {
  return (
    <div className="d-block" style={{ marginTop: 0 }}>
      <div className="lbl">{children}<span className="ln" />{hint && <span className="lhint">{hint}</span>}</div>
    </div>
  );
}
const gateCount = (s) => s.pipelines.filter((p) => p.gate).length;

/* ===================================================================
   1 · PURPOSE — blueprint identity + live catalog-card preview
   =================================================================== */
const HUE_CHOICES = [195, 25, 70, 145, 230, 295, 350];
function PurposeView({ bp, onChange }) {
  const set = (patch) => onChange({ ...bp, ...patch });
  const toggleTag = (t) => set({ bestFor: bp.bestFor.includes(t) ? bp.bestFor.filter((x) => x !== t) : [...bp.bestFor, t] });
  const TAGS = ["backend", "frontend", "realtime", "api", "data", "ml", "mobile", "infra", "lean"];

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* identity */}
      <div>
        <div className="lbl">Identity<span className="ln" /><span className="lhint">name & accent</span></div>
        <div className="row" style={{ gap: 11, alignItems: "flex-start" }}>
          <div className="col" style={{ gap: 7, alignItems: "center" }}>
            <span className="ed-icon" style={{ width: 44, height: 44, fontSize: 19,
              background: window.tint(bp.h, 0.18), color: window.hue(bp.h),
              border: `1px solid ${window.tint(bp.h, 0.4)}` }}>{bp.icon}</span>
            <div className="row" style={{ gap: 4 }}>
              {HUE_CHOICES.map((h) => (
                <span key={h} onClick={() => set({ h })} title="accent hue"
                  style={{ width: 13, height: 13, borderRadius: 4, cursor: "pointer",
                    background: window.hue(h),
                    outline: bp.h === h ? "2px solid var(--fg)" : "none", outlineOffset: 1 }} />
              ))}
            </div>
          </div>
          <div className="col" style={{ gap: 8, flex: 1 }}>
            <input className="input" value={bp.name} onChange={(e) => set({ name: e.target.value, icon: (e.target.value[0] || "B").toUpperCase() })}
              placeholder="Blueprint name" style={{ fontSize: 13 }} />
            <input className="input" value={bp.pitch} onChange={(e) => set({ pitch: e.target.value })}
              placeholder="One-line pitch — shown in the catalog" />
          </div>
        </div>
      </div>

      {/* description */}
      <div>
        <div className="lbl">Description<span className="ln" /><span className="lhint">what it's for & why</span></div>
        <textarea className="input" value={bp.desc} onChange={(e) => set({ desc: e.target.value })}
          style={{ minHeight: 78 }} placeholder="Describe the kind of project this blueprint plans…" />
      </div>

      {/* audience + tags */}
      <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
        <div className="col" style={{ gap: 8, flex: 1 }}>
          <div className="lbl">Audience<span className="ln" /></div>
          <input className="input" value={bp.audience} onChange={(e) => set({ audience: e.target.value })}
            placeholder="Who plans with this" />
        </div>
      </div>
      <div>
        <div className="lbl">Best for<span className="ln" /><span className="lhint">catalog tags · pick a few</span></div>
        <div className="dep-row">
          {TAGS.map((t) => (
            <button key={t} className={"dep-chip" + (bp.bestFor.includes(t) ? " on" : "")} onClick={() => toggleTag(t)}>
              {t}{bp.bestFor.includes(t) && <span style={{ opacity: .7 }}>✓</span>}
            </button>
          ))}
        </div>
      </div>

      {/* live catalog-card preview */}
      <div>
        <div className="lbl">Catalog preview<span className="ln" /><span className="lhint">how it appears in the library</span></div>
        <div className="bp-card" style={{ cursor: "default" }}>
          <div className="bp-top">
            <span className="bp-icon" style={{ background: window.tint(bp.h, 0.16), color: window.hue(bp.h), borderColor: window.tint(bp.h, 0.4) }}>{bp.icon}</span>
            <div style={{ minWidth: 0 }}>
              <h3>{bp.name || "Untitled blueprint"}</h3>
              <p className="bp-desc">{bp.pitch || "Add a one-line pitch…"}</p>
            </div>
          </div>
          <div className="seq">
            {bp.stages.slice(0, 6).map((s, i) => {
              const k = window.stageKind(s.key);
              return (
                <React.Fragment key={s.uid}>
                  {i > 0 && <span className="arr">→</span>}
                  <span className={"st-g" + (gateCount(s) ? " gated" : "")} title={k.title}><window.Ic n={k.glyph} size={11} /></span>
                </React.Fragment>
              );
            })}
            {bp.stages.length > 6 && <span className="more">+{bp.stages.length - 6}</span>}
          </div>
          <div className="bp-foot">
            <span>{bp.stages.length} stages</span>
            <span className="gsync"><i style={{ background: "var(--accent)" }} />{bp.stages.reduce((n, s) => n + gateCount(s), 0)} gates</span>
            <span className="sp" />
            {bp.bestFor.slice(0, 3).map((t) => <span key={t} className="tag">{t}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================================================================
   2 · STAGES — draggable stage flow + inline detail
   =================================================================== */
function StagesView({ bp, onChange, selectedUid, onSelect }) {
  const stages = bp.stages;
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const [adding, setAdding] = useState(false);
  const setStages = (next) => onChange({ ...bp, stages: next });

  const move = (from, to) => {
    const next = [...stages]; const [x] = next.splice(from, 1); next.splice(to, 0, x); setStages(next);
  };
  const used = new Set(stages.map((s) => s.key));

  const addStage = (key) => {
    const k = window.stageKind(key);
    const ns = window.mkStage(key, k.title, "", stages.length ? [stages[stages.length - 1].key] : [], [], undefined, []);
    setStages([...stages, ns]); onSelect(ns.uid); setAdding(false);
  };
  const del = (uidv) => {
    const next = stages.filter((s) => s.uid !== uidv).map((s) => ({ ...s, deps: s.deps.filter((d) => stages.find((x) => x.uid === uidv)?.key !== d) }));
    setStages(next); if (next[0]) onSelect(next[0].uid);
  };
  const patchStage = (uidv, patch) => setStages(stages.map((s) => s.uid === uidv ? { ...s, ...patch } : s));
  const toggleDep = (s, depKey) => patchStage(s.uid, { deps: s.deps.includes(depKey) ? s.deps.filter((d) => d !== depKey) : [...s.deps, depKey] });

  return (
    <div className="col" style={{ gap: 0 }}>
      <div className="rail-list" style={{ padding: 0, overflow: "visible" }}>
        {stages.map((s, i) => {
          const k = window.stageKind(s.key);
          const depNames = s.deps.map((d) => stages.find((x) => x.key === d)?.name || d);
          const locked = depNames.length > 0;
          const sel = s.uid === selectedUid;
          const gates = gateCount(s);
          return (
            <div key={s.uid}>
              <div className={"stage" + (sel ? " is-sel" : "") + (locked ? " locked" : "") + (dragIdx === i ? " dragging" : "") + (overIdx === i && dragIdx !== null && dragIdx !== i ? " dragover" : "")}
                draggable
                onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); if (i !== overIdx) setOverIdx(i); }}
                onDrop={(e) => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) move(dragIdx, i); setDragIdx(null); setOverIdx(null); }}
                onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                onClick={() => onSelect(sel ? null : s.uid)}>
                <span className="grip" title="Drag to reorder">⠿</span>
                <span className="snum">{String(i + 1).padStart(2, "0")}</span>
                <StageGlyph k={s.key} />
                <span className="sbody">
                  <span className="sname">{s.name}{locked && <span className="lock" title={"depends on " + depNames.join(", ")}>🔒</span>}</span>
                  <span className="smeta">
                    {s.pipelines.length > 0 && <span>{s.pipelines.length} pipeline{s.pipelines.length > 1 ? "s" : ""}</span>}
                    {gates > 0 && <span className="gate">{gates} gate{gates > 1 ? "s" : ""}</span>}
                    {locked && <span>↳ {depNames.join(", ")}</span>}
                    {s.pipelines.length === 0 && !locked && <span className="dim">{window.DISPOSITIONS[s.output]?.title}</span>}
                  </span>
                </span>
              </div>

              {/* inline detail */}
              {sel && (
                <div className="card" style={{ margin: "2px 4px 8px 30px", padding: 13 }}>
                  <div className="row" style={{ gap: 8, marginBottom: 11 }}>
                    <input className="d-name" style={{ fontSize: 13, minWidth: 0, flex: 1, marginLeft: 0 }}
                      value={s.name} onChange={(e) => patchStage(s.uid, { name: e.target.value })} />
                    <button className="iconbtn danger" title="Delete stage" onClick={() => del(s.uid)}>🗑</button>
                  </div>
                  <div className="d-kind" style={{ paddingLeft: 0, marginBottom: 11 }}>{k.title} · {k.blurb}</div>

                  <Sec hint="what Claude is told in this stage">Prompt module</Sec>
                  <textarea className="input" value={s.prompt} style={{ minHeight: 70, marginBottom: 13 }}
                    placeholder="Instructions for the planning agent during this stage…"
                    onChange={(e) => patchStage(s.uid, { prompt: e.target.value })} />

                  <Sec hint="stays locked until these complete">Dependencies</Sec>
                  {stages.filter((c) => c.uid !== s.uid && stages.indexOf(c) < i).length === 0 ? (
                    <div className="hint">First stage — nothing precedes it.</div>
                  ) : (
                    <div className="dep-row">
                      {stages.filter((c) => c.uid !== s.uid && stages.indexOf(c) < i).map((c) => {
                        const ck = window.stageKind(c.key); const on = s.deps.includes(c.key);
                        return (
                          <button key={c.uid} className={"dep-chip" + (on ? " on" : "")} onClick={() => toggleDep(s, c.key)}>
                            <span className="dg" style={{ background: window.tint(ck.h, 0.2), color: window.hue(ck.h) }}><window.Ic n={ck.glyph} size={10} /></span>
                            {c.name}{on && <span style={{ opacity: .7 }}>✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {i < stages.length - 1 && <div className={"stage-conn" + (stages[i + 1].deps.includes(s.key) ? " dep" : "")} />}
            </div>
          );
        })}

        {/* add stage */}
        <div className="addstage">
          {!adding ? (
            <button className="btn ghost sm" style={{ width: "100%", justifyContent: "center", borderStyle: "dashed", marginTop: 8 }} onClick={() => setAdding(true)}>+ Add stage</button>
          ) : (
            <div className="card" style={{ padding: 11, marginTop: 8 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="rh-title" style={{ fontFamily: "var(--mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--fg-muted)" }}>Add a stage</span>
                <span style={{ flex: 1 }} />
                <button className="iconbtn" onClick={() => setAdding(false)}>✕</button>
              </div>
              <div className="palette">
                {window.STAGE_KIND_KEYS.map((kk) => {
                  const k = window.stageKind(kk);
                  return (
                    <button className="pal-item" key={kk} title={k.blurb} onClick={() => addStage(kk)}>
                      <span className="pg" style={{ background: window.tint(k.h, 0.18), color: window.hue(k.h) }}><window.Ic n={k.glyph} size={12} /></span>
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

/* ===================================================================
   3 · CAPABILITIES — pipelines, gates, dispositions, skills per stage
   =================================================================== */
function CapabilitiesView({ bp, onChange }) {
  const stages = bp.stages;
  const [open, setOpen] = useState(() => new Set([stages.find((s) => gateCount(s))?.uid || stages[0]?.uid].filter(Boolean)));
  const toggle = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setStages = (next) => onChange({ ...bp, stages: next });
  const patch = (uidv, fn) => setStages(stages.map((s) => s.uid === uidv ? fn(s) : s));

  const addPipe = (s, id) => { const def = window.pipelineMeta(id); patch(s.uid, (x) => ({ ...x, pipelines: [...x.pipelines, { uid: "p" + Date.now() + Math.random(), id, name: def.name, trigger: def.defaultTrigger || "complete", gate: false, enabled: true }] })); };
  const updPipe = (s, puid, p) => patch(s.uid, (x) => ({ ...x, pipelines: x.pipelines.map((pp) => pp.uid === puid ? { ...pp, ...p } : pp) }));
  const rmPipe  = (s, puid) => patch(s.uid, (x) => ({ ...x, pipelines: x.pipelines.filter((pp) => pp.uid !== puid) }));
  const setOut  = (s, key) => patch(s.uid, (x) => ({ ...x, output: key }));
  const addSkill = (s, id) => patch(s.uid, (x) => ({ ...x, skills: [...x.skills, id] }));
  const rmSkill  = (s, id) => patch(s.uid, (x) => ({ ...x, skills: x.skills.filter((k) => k !== id) }));

  const totalPipes = stages.reduce((n, s) => n + s.pipelines.length, 0);
  const totalGates = stages.reduce((n, s) => n + gateCount(s), 0);
  const totalSkills = new Set(stages.flatMap((s) => s.skills)).size;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 4 }}>
        <div className="stat"><div className="sk">pipelines</div><div className="sv">{totalPipes}</div></div>
        <div className="stat"><div className="sk">gates</div><div className="sv am">{totalGates}</div></div>
        <div className="stat"><div className="sk">skills wired</div><div className="sv">{totalSkills}</div></div>
      </div>

      {stages.map((s) => {
        const k = window.stageKind(s.key);
        const isOpen = open.has(s.uid);
        const existing = new Set(s.pipelines.map((p) => p.id));
        const suggested = window.PIPELINE_LIB.filter((p) => p.suits.includes(s.key) && !existing.has(p.id));
        const others = window.PIPELINE_LIB.filter((p) => !p.suits.includes(s.key) && !existing.has(p.id));
        const addableSkills = window.SKILL_LIB.filter((sk) => !s.skills.includes(sk.id));
        return (
          <div key={s.uid} className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="row" style={{ gap: 10, padding: "11px 13px", cursor: "pointer" }} onClick={() => toggle(s.uid)}>
              <StageGlyph k={s.key} />
              <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{s.name}</span>
                <span className="smeta" style={{ fontSize: 10, color: "var(--fg-dim)", display: "flex", gap: 8 }}>
                  <span>{s.pipelines.length} pipeline{s.pipelines.length !== 1 ? "s" : ""}</span>
                  {gateCount(s) > 0 && <span style={{ color: "var(--accent)" }}>{gateCount(s)} gate{gateCount(s) > 1 ? "s" : ""}</span>}
                  <span>→ {window.DISPOSITIONS[s.output]?.title}</span>
                </span>
              </div>
              <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{isOpen ? "▼" : "▶"}</span>
            </div>

            {isOpen && (
              <div style={{ padding: "0 13px 14px", borderTop: "1px solid var(--border-soft)" }}>
                {/* pipelines */}
                <div className="lbl" style={{ marginTop: 13 }}>Pipelines<span className="ln" /><span className="lhint">run on this stage's output</span></div>
                {s.pipelines.length === 0 && <div className="hint" style={{ marginBottom: 8 }}>No pipelines. Add one — gate pipelines block completion until they pass.</div>}
                {s.pipelines.map((p) => {
                  const m = window.pipelineMeta(p.id);
                  return (
                    <div className="pipe" key={p.uid}>
                      <span className="pi" style={{ background: window.tint(m.h, 0.16), color: window.hue(m.h) }}><window.Ic n={m.glyph} size={14} /></span>
                      <div className="pbody">
                        <div className="pname">{p.name}</div>
                        <div className="pdesc">{m.desc}</div>
                      </div>
                      <div className="ptrig">
                        <div className="seg" title="When this pipeline runs">
                          {window.TRIGGERS.map((t) => <button key={t.value} className={p.trigger === t.value ? "on" : ""} onClick={() => updPipe(s, p.uid, { trigger: t.value })}>{t.label}</button>)}
                        </div>
                        {m.gateable && (
                          <span className="gate-toggle" onClick={() => updPipe(s, p.uid, { gate: !p.gate })} title="Gate: stage can't complete until this passes">
                            <span className={"switch" + (p.gate ? " on" : "")} />gate
                          </span>
                        )}
                        <button className="iconbtn danger" title="Remove" onClick={() => rmPipe(s, p.uid)}>✕</button>
                      </div>
                    </div>
                  );
                })}
                {(suggested.length > 0 || others.length > 0) && (
                  <div className="pipe-add">
                    {suggested.map((p) => { const m = window.pipelineMeta(p.id); return (
                      <button className="chip-sug" key={p.id} title={p.desc} style={{ borderColor: window.tint(m.h, 0.5), color: window.hue(m.h) }} onClick={() => addPipe(s, p.id)}>+ {p.name} ✦</button>
                    ); })}
                    {others.slice(0, 4).map((p) => <button className="chip-sug" key={p.id} title={p.desc} onClick={() => addPipe(s, p.id)}>+ {p.name}</button>)}
                  </div>
                )}

                {/* disposition */}
                <div className="lbl" style={{ marginTop: 18 }}>Output disposition<span className="ln" /><span className="lhint">what happens to the artifact</span></div>
                <div className="disp-grid">
                  {window.DISPOSITION_KEYS.map((key) => {
                    const d = window.DISPOSITIONS[key];
                    return (
                      <div className={"disp" + (s.output === key ? " on" : "")} key={key} onClick={() => setOut(s, key)}>
                        <span className="dgl" style={{ background: window.tint(d.h, 0.16), color: window.hue(d.h) }}><window.Ic n={d.glyph} size={13} /></span>
                        <span className="dtxt"><div className="dt">{d.title}</div><div className="dd">{d.desc}</div></span>
                      </div>
                    );
                  })}
                </div>

                {/* skills */}
                <div className="lbl" style={{ marginTop: 18 }}>Skills & knowledge<span className="ln" /><span className="lhint">injected context for this stage</span></div>
                {s.skills.length === 0 && addableSkills.length === window.SKILL_LIB.length && <div className="hint" style={{ marginBottom: 8 }}>No skills attached.</div>}
                {s.skills.length > 0 && (
                  <div className="dep-row" style={{ marginBottom: 8 }}>
                    {s.skills.map((id) => { const sk = window.SKILL_LIB.find((x) => x.id === id); if (!sk) return null; return (
                      <span className="dep-chip on" key={id} title={sk.desc}>
                        <span className="dim" style={{ fontSize: 8.5 }}>{sk.kind}</span>{sk.name}
                        <span style={{ cursor: "pointer", opacity: .8 }} onClick={() => rmSkill(s, id)}> ✕</span>
                      </span>
                    ); })}
                  </div>
                )}
                {addableSkills.length > 0 && (
                  <div className="pipe-add">
                    {addableSkills.map((sk) => <button className="chip-sug" key={sk.id} title={sk.desc} onClick={() => addSkill(s, sk.id)}>+ {sk.name}</button>)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ===================================================================
   4 · REVIEW & PUBLISH — validation, flow preview, visibility
   =================================================================== */
function PublishView({ bp, checks, onVisibility, published, onPublish }) {
  const VIS = [
    { key: "local", glyph: "folder", title: "Local only", desc: "Stays on this machine." },
    { key: "private-gist", glyph: "lock_person", title: "Private gist", desc: "Shareable by link." },
    { key: "catalog", glyph: "globe", title: "Public catalog", desc: "Discoverable by everyone." },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const allPass = passed === checks.length;

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* summary */}
      <div className="hero" style={{ marginBottom: 0 }}>
        <span className="hicon" style={{ background: window.tint(bp.h, 0.16), color: window.hue(bp.h) }}>{bp.icon}</span>
        <div className="htxt">
          <div className="heyebrow">blueprint</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg)", marginBottom: 3 }}>{bp.name}</div>
          <div className="hbody">{bp.pitch}</div>
        </div>
      </div>

      <div className="stats" style={{ gridTemplateColumns: "repeat(4,1fr)", margin: 0 }}>
        <div className="stat"><div className="sk">stages</div><div className="sv">{bp.stages.length}</div></div>
        <div className="stat"><div className="sk">pipelines</div><div className="sv">{bp.stages.reduce((n, s) => n + s.pipelines.length, 0)}</div></div>
        <div className="stat"><div className="sk">gates</div><div className="sv am">{bp.stages.reduce((n, s) => n + gateCount(s), 0)}</div></div>
        <div className="stat"><div className="sk">checks</div><div className={"sv" + (allPass ? " ok" : "")}>{passed}/{checks.length}</div></div>
      </div>

      {/* full flow preview */}
      <div>
        <div className="lbl">Flow<span className="ln" /></div>
        <div className="seq" style={{ gap: 5 }}>
          {bp.stages.map((s, i) => {
            const k = window.stageKind(s.key);
            return (
              <React.Fragment key={s.uid}>
                {i > 0 && <span className="arr">→</span>}
                <span className={"st-g" + (gateCount(s) ? " gated" : "")} title={s.name + (gateCount(s) ? " · gated" : "")}
                  style={{ width: 24, height: 24 }}><window.Ic n={k.glyph} size={13} /></span>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* validation checklist */}
      <div>
        <div className="lbl">Validation<span className="ln" /><span className="lhint">lint · must pass to publish</span></div>
        <div className="col" style={{ gap: 5 }}>
          {checks.map((c) => (
            <div key={c.id} className={"diff-line " + (c.ok ? "add" : "del")} style={{ marginBottom: 0 }}>
              <span className="dmark">{c.ok ? "✓" : "✕"}</span>
              <span className="dtitle">{c.label}</span>
              <span style={{ flex: 1 }} />
              <span className="dim" style={{ fontSize: 10 }}>{c.detail}</span>
            </div>
          ))}
        </div>
      </div>

      {/* visibility */}
      <div>
        <div className="lbl">Visibility<span className="ln" /></div>
        <div className="disp-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
          {VIS.map((v) => (
            <div key={v.key} className={"disp" + (bp.visibility === v.key ? " on" : "")} style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }} onClick={() => onVisibility(v.key)}>
              <span className="dgl" style={{ background: bp.visibility === v.key ? window.tint(bp.h, 0.18) : "var(--bg-elev)", color: bp.visibility === v.key ? window.hue(bp.h) : "var(--fg-muted)" }}><window.Ic n={v.glyph} size={13} /></span>
              <span className="dtxt"><div className="dt">{v.title}</div><div className="dd">{v.desc}</div></span>
            </div>
          ))}
        </div>
      </div>

      {/* publish */}
      <button className="btn primary" disabled={!allPass || published} onClick={onPublish}
        style={{ height: 38, justifyContent: "center", fontSize: 12 }}>
        {published ? "✓ Published to " + (bp.visibility === "catalog" ? "public catalog" : bp.visibility === "local" ? "local library" : "private gist")
          : allPass ? <span className="row" style={{ gap: 7 }}><window.Ic n="upload" size={14} /> Publish blueprint</span>
          : `Resolve ${checks.length - passed} check${checks.length - passed > 1 ? "s" : ""} to publish`}
      </button>
    </div>
  );
}

Object.assign(window, { PurposeView, StagesView, CapabilitiesView, PublishView, BA_StageGlyph: StageGlyph, gateCount });
