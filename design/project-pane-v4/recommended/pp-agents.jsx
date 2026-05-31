/* global React, AGENTS, CAPS, PRESETS, ROLES, RoleChip, Avatar, Posture, Tri, FlowBadges, Dot */
// pp-agents.jsx — Agents / Permissions panel. Three explorations + shared editor.

// small segmented control
function Seg({ options, value, onChange, tiny }) {
  return (
    <span style={{display:"inline-flex", border:"1px solid var(--border-soft)",
      borderRadius:5, overflow:"hidden", fontFamily:"var(--mono)",
      fontSize: tiny?9:9.5}}>
      {options.map((o,i)=>{
        const on = o===value;
        return (
          <button key={o} onClick={()=>onChange && onChange(o)} style={{
            border:0, borderRight: i<options.length-1?"1px solid var(--border-soft)":0,
            background: on?"color-mix(in oklch, var(--accent), transparent 84%)":"transparent",
            color: on?"var(--accent)":"var(--fg-dim)",
            padding:"2px 7px", cursor:"pointer", whiteSpace:"nowrap",
          }}>{o}</button>
        );
      })}
    </span>
  );
}

// ── the shared per-agent editor (drill-in) ─────────────────────
function AgentEditor({ a, dense }) {
  const [perm,setPerm] = React.useState(a.perm);
  const [preset,setPreset] = React.useState(a.preset);
  const [flow,setFlow] = React.useState(a.flow);
  const set = (k,v)=>{ setPerm({...perm,[k]:v}); setPreset("custom"); };
  const applyPreset = p => { setPreset(p); setPerm({...PRESETS[p]}); };
  return (
    <div className="editor">
      {/* header */}
      <div style={{padding:"10px 12px", background:"var(--bg-elev)",
        borderBottom:"1px solid var(--border-soft)"}}>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          <Avatar id={a.id} sz={20}/>
          <span style={{fontFamily:"var(--mono)", fontSize:12, color:"var(--fg)"}}>{a.name}</span>
          <RoleChip role={a.role}/>
          <span style={{flex:1}}/>
          <Dot s={a.status}/>
        </div>
        <div style={{display:"flex", alignItems:"center", gap:6, marginTop:7,
          fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-muted)", flexWrap:"wrap"}}>
          <span style={{color:"var(--info)"}}>⎇ {a.repo}</span>
          <span style={{color:"var(--fg-dim)"}}>·</span>
          <span>owns</span>
          {a.owns.map(o=><span key={o} className="glob">{o}</span>)}
          {a.issues.map(i=><span key={i} style={{color:"var(--accent)"}}>{i}</span>)}
        </div>
      </div>

      {/* presets */}
      <div style={{padding:"9px 12px", borderBottom:"1px solid var(--border-soft)"}}>
        <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:7}}>
          <span className="ulabel">preset</span>
          <span style={{flex:1}}/>
          {preset==="custom" && <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--accent)"}}>● customized</span>}
        </div>
        <div style={{display:"flex", gap:5, flexWrap:"wrap"}}>
          {Object.keys(PRESETS).map(p=>(
            <span key={p} className={"preset"+(preset===p?" on":"")}
              onClick={()=>applyPreset(p)}>{p}</span>
          ))}
        </div>
      </div>

      {/* capabilities */}
      <div style={{padding:"6px 12px 10px"}}>
        <div className="ulabel" style={{padding:"5px 0 7px"}}>capabilities</div>
        <div style={{display:"flex", flexDirection:"column", gap:6}}>
          {CAPS.map(c=>(
            <div key={c.k} style={{display:"flex", alignItems:"center", gap:8}}>
              <span style={{width:16, textAlign:"center", fontFamily:"var(--mono)",
                fontSize:11, color:"var(--fg-dim)"}}>{c.g}</span>
              <span style={{flex:1, fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg)"}}>{c.label}</span>
              <Tri value={perm[c.k]} onChange={v=>set(c.k,v)}/>
            </div>
          ))}
        </div>
      </div>

      {/* flow */}
      <div style={{padding:"10px 12px", borderTop:"1px solid var(--border-soft)",
        background:"var(--bg-panel)"}}>
        <div className="ulabel" style={{marginBottom:8}}>flow</div>
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          <div style={{display:"flex", alignItems:"center", gap:8}}>
            <span style={{flex:"0 0 64px", fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)"}}>autonomy</span>
            <Seg options={["continuous","checkpoint","confirm"]} value={flow.autonomy}
              onChange={v=>setFlow({...flow,autonomy:v})}/>
          </div>
          <div style={{display:"flex", alignItems:"center", gap:8}}>
            <span style={{flex:"0 0 64px", fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)"}}>push</span>
            <Seg options={["auto-PR","push-confirm","commit-only","none"]} value={flow.push}
              onChange={v=>setFlow({...flow,push:v})}/>
          </div>
          <div style={{display:"flex", alignItems:"center", gap:8}}>
            <span style={{flex:"0 0 64px", fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)"}}>gate</span>
            <Seg options={["soft","hard"]} value={flow.gate}
              onChange={v=>setFlow({...flow,gate:v})}/>
            <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>
              {flow.gate==="hard" ? "blocks on violation" : "warns, continues"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// =================================================================
// VARIANT A — Roster rows w/ inline expand
// =================================================================
function AgentsA() {
  const [open,setOpen] = React.useState("framer");
  return (
    <div style={{padding:"4px 0"}}>
      <div style={{display:"flex", alignItems:"center", gap:8, padding:"0 2px 8px",
        fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>
        <span>6 agents · 2 running</span>
        <span style={{flex:1}}/>
        <span className="mini">+ agent</span>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:4}}>
        {AGENTS.map(a=>{
          const on = open===a.id;
          return (
            <div key={a.id}>
              <div onClick={()=>setOpen(on?null:a.id)} style={{
                display:"grid", gridTemplateColumns:"auto 1fr auto", gap:8,
                alignItems:"center", padding:"7px 8px", borderRadius:6, cursor:"pointer",
                background: on?"color-mix(in oklch, var(--accent), transparent 92%)":"var(--bg-canvas)",
                border:"1px solid "+(on?"var(--accent-dim)":"var(--border-soft)"),
              }}>
                <div style={{display:"flex", alignItems:"center", gap:7}}>
                  <Dot s={a.status}/>
                  <Avatar id={a.id} sz={18}/>
                </div>
                <div style={{minWidth:0}}>
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--fg)"}}>{a.name}</span>
                    <RoleChip role={a.role} mute/>
                  </div>
                  <div style={{display:"flex", alignItems:"center", gap:6, marginTop:4}}>
                    <Posture perm={a.perm}/>
                    <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)",
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                      {a.owns[0]}{a.owns.length>1?` +${a.owns.length-1}`:""}
                    </span>
                  </div>
                </div>
                <div style={{display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4}}>
                  <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-muted)"}}>{a.preset}</span>
                  <span className={"fbadge"+(a.flow.gate==="hard"?" hard":"")}>{a.flow.gate}</span>
                </div>
              </div>
              {on && <div style={{marginTop:5, marginBottom:2}}><AgentEditor a={a}/></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =================================================================
// VARIANT B — Posture matrix (agents × capabilities) + bulk
// =================================================================
function AgentsB() {
  const [sel,setSel] = React.useState("auth");
  const a = AGENTS.find(x=>x.id===sel);
  return (
    <div style={{padding:"2px 0"}}>
      <div style={{display:"flex", alignItems:"center", gap:8, padding:"0 2px 8px",
        fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>
        <span>posture · 6 agents × 7 caps</span>
        <span style={{flex:1}}/>
        <span className="mini accent">bulk apply…</span>
      </div>

      {/* matrix */}
      <div style={{border:"1px solid var(--border-soft)", borderRadius:7, overflow:"hidden",
        background:"var(--bg-canvas)"}}>
        {/* header */}
        <div style={{display:"grid", gridTemplateColumns:"94px repeat(7, 1fr)",
          gap:3, padding:"7px 8px", borderBottom:"1px solid var(--border-soft)",
          background:"var(--bg-elev)"}}>
          <span className="ulabel">agent</span>
          {CAPS.map(c=>(
            <span key={c.k} title={c.label} style={{textAlign:"center", fontFamily:"var(--mono)",
              fontSize:10, color:"var(--fg-muted)"}}>{c.g}</span>
          ))}
        </div>
        {/* rows */}
        {AGENTS.map(ag=>{
          const on = sel===ag.id;
          return (
            <div key={ag.id} onClick={()=>setSel(ag.id)} style={{
              display:"grid", gridTemplateColumns:"94px repeat(7, 1fr)", gap:3,
              padding:"5px 8px", alignItems:"center", cursor:"pointer",
              background: on?"color-mix(in oklch, var(--accent), transparent 93%)":"transparent",
              borderBottom:"1px solid var(--border-soft)",
            }}>
              <span style={{display:"flex", alignItems:"center", gap:5, minWidth:0}}>
                <Avatar id={ag.id} sz={15}/>
                <span style={{fontFamily:"var(--mono)", fontSize:9.5, color: on?"var(--accent)":"var(--fg)",
                  whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{ag.name.replace("@","")}</span>
              </span>
              {CAPS.map(c=>{
                const v = ag.perm[c.k];
                return <span key={c.k} className={"mcell "+v}
                  title={`${ag.name} · ${c.label}: ${v}`}>
                  {v==="allow"?"●":v==="ask"?"?":"–"}
                </span>;
              })}
            </div>
          );
        })}
      </div>

      {/* legend */}
      <div style={{display:"flex", gap:10, padding:"7px 2px", fontFamily:"var(--mono)",
        fontSize:9, color:"var(--fg-dim)"}}>
        <span><span className="mcell allow" style={{display:"inline-flex", width:14, height:12, verticalAlign:"middle"}}>●</span> allow</span>
        <span><span className="mcell ask" style={{display:"inline-flex", width:14, height:12, verticalAlign:"middle"}}>?</span> ask</span>
        <span><span className="mcell deny" style={{display:"inline-flex", width:14, height:12, verticalAlign:"middle"}}>–</span> deny</span>
      </div>

      {/* selected detail strip → full editor */}
      <div style={{marginTop:6}}>
        <div className="ulabel" style={{padding:"2px 2px 6px"}}>editing · {a.name}</div>
        <AgentEditor a={a}/>
      </div>
    </div>
  );
}

// =================================================================
// VARIANT C — Cards grouped by role → drill-in
// =================================================================
function AgentsC() {
  const [open,setOpen] = React.useState("auth");
  const groups = {};
  AGENTS.forEach(a=>{ (groups[a.role] = groups[a.role]||[]).push(a); });
  const order = ["worker","planner","tester","triage","reviewer","director"].filter(r=>groups[r]);
  const a = AGENTS.find(x=>x.id===open);
  return (
    <div style={{padding:"2px 0"}}>
      <div style={{display:"flex", alignItems:"center", gap:8, padding:"0 2px 8px",
        fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>
        <span>6 agents · grouped by role</span>
        <span style={{flex:1}}/>
        <span className="mini">+ agent</span>
      </div>

      <div style={{display:"flex", flexDirection:"column", gap:12}}>
        {order.map(role=>(
          <div key={role}>
            <div style={{display:"flex", alignItems:"center", gap:7, marginBottom:6}}>
              <RoleChip role={role}/>
              <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>{groups[role].length}</span>
              <span style={{flex:1, height:1, background:"var(--border-soft)"}}/>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:5}}>
              {groups[role].map(ag=>{
                const R = ROLES[ag.role];
                const on = open===ag.id;
                return (
                  <div key={ag.id}>
                    <div onClick={()=>setOpen(on?null:ag.id)} style={{
                      display:"flex", alignItems:"center", gap:8, padding:"8px 10px",
                      borderRadius:6, cursor:"pointer", position:"relative",
                      background: on?"color-mix(in oklch, var(--accent), transparent 92%)":"var(--bg-canvas)",
                      border:"1px solid "+(on?"var(--accent-dim)":"var(--border-soft)"),
                    }}>
                      <span style={{position:"absolute", left:0, top:6, bottom:6, width:3,
                        borderRadius:3, background:R.c}}/>
                      <Dot s={ag.status}/>
                      <Avatar id={ag.id} sz={18}/>
                      <div style={{flex:1, minWidth:0}}>
                        <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--fg)"}}>{ag.name}</div>
                        <div style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)",
                          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", marginTop:2}}>
                          {ag.repo==="both"?"both repos":ag.repo} · {ag.issues.join(" ")}
                        </div>
                      </div>
                      <div style={{display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4}}>
                        <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--accent)"}}>{ag.preset}</span>
                        <Posture perm={ag.perm}/>
                      </div>
                    </div>
                    {on && <div style={{marginTop:5}}><AgentEditor a={ag}/></div>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { Seg, AgentEditor, AgentsA, AgentsB, AgentsC });
