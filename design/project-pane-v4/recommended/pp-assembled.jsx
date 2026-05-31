/* global React, Sec, AgentsA, MergedC, ContextA, AGENTS */
// pp-assembled.jsx — the recommended full pane composition.
// Picks: Repository × Structure merged = milestone-first plan (C),
// Agents/Permissions = roster rows + drill-in editor (A),
// Context Files = pinned/library (A). Reading order: plan → who → context.

function AssembledPane() {
  return (
    <div className="pp">
      {/* pane header */}
      <div style={{flex:"0 0 auto", padding:"10px 12px",
        borderBottom:"1px solid var(--border-soft)", background:"var(--bg-elev)",
        display:"flex", alignItems:"center", gap:8}}>
        <span style={{width:8, height:8, borderRadius:2,
          background:"linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))"}}/>
        <span style={{fontFamily:"var(--mono)", fontSize:11.5, color:"var(--fg)"}}>Settlement webhooks v2</span>
        <span style={{flex:1}}/>
        <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>prj_2fa</span>
      </div>

      {/* fleet pulse strip — always-visible glance line */}
      <div style={{flex:"0 0 auto", padding:"7px 12px", borderBottom:"1px solid var(--border-soft)",
        display:"flex", alignItems:"center", gap:6, fontFamily:"var(--mono)", fontSize:9,
        color:"var(--fg-muted)", background:"var(--bg-panel)"}}>
        <span style={{display:"flex", gap:-4}}>
          {AGENTS.map((a,i)=>(
            <span key={a.id} style={{marginLeft:i?-4:0, position:"relative"}}>
              <span className="av" style={{width:16, height:16, background:a.color, fontSize:9}}>{a.initial}</span>
            </span>
          ))}
        </span>
        <span style={{color:"var(--accent)"}}>2 running</span>
        <span style={{color:"var(--fg-dim)"}}>· 3 on · 1 idle</span>
        <span style={{flex:1}}/>
        <span style={{color:"var(--success)"}}>● github 4m</span>
      </div>

      <div className="pp-scroll">
        <Sec title="Context Files" count="✦ 4 pinned" open={false}>
          <ContextA/>
        </Sec>
        <Sec title="Repository · Structure" count="2 repos · 2 milestones" open={true}>
          <MergedC/>
        </Sec>
        <Sec title="Agents · Permissions" count="6 · 2 running" open={true}>
          <AgentsA/>
        </Sec>
      </div>
    </div>
  );
}

Object.assign(window, { AssembledPane });
