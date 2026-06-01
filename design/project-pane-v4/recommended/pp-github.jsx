/* global React, STRUCTURE, ISSUE_STATE, Avatar, Track, RoleChip, AGENTS */
// pp-github.jsx — GitHub Structure. milestone → epic → issue, three takes.

function StateDot({ state }) {
  return <span style={{width:6, height:6, borderRadius:"50%", flex:"0 0 6px",
    background: ISSUE_STATE[state]||"var(--fg-dim)"}}/>;
}

function IssueLine({ iss, showContract }) {
  return (
    <div style={{padding:"5px 7px", borderRadius:5, cursor:"pointer"}}
      className="trow-wrap">
      <div style={{display:"flex", alignItems:"center", gap:7}}>
        <StateDot state={iss.state}/>
        <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>#{iss.n}</span>
        <span style={{flex:1, fontFamily:"var(--sans)", fontSize:11, color:"var(--fg)",
          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{iss.t}</span>
        <span title={"owned by @"+iss.owner}><Avatar id={iss.owner} sz={15}/></span>
      </div>
      {showContract && (
        <div style={{display:"flex", flexWrap:"wrap", gap:5, marginTop:5, paddingLeft:20,
          fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>
          <span style={{color:"var(--success)"}}>✓ {iss.ac} AC</span>
          {iss.branch && <span className="glob" style={{fontSize:8.5, padding:"0 5px", color:"var(--info)"}}>⎇ {iss.branch}</span>}
          {iss.sub && iss.sub.length>0 && <span style={{color:"var(--fg-dim)"}}>⌁ {iss.sub.length} sub</span>}
          {iss.deps.length>0 && <span style={{color:"var(--accent)"}}>⇠ #{iss.deps.join(" #")}</span>}
        </div>
      )}
    </div>
  );
}

// =================================================================
// VARIANT A — Nested collapsible tree (milestone>epic>issue)
// =================================================================
function GithubA() {
  const [open,setOpen] = React.useState({M1:true, E1:true});
  const tog = k => setOpen(o=>({...o,[k]:!o[k]}));
  return (
    <div>
      <div style={{padding:"0 2px 8px", fontFamily:"var(--mono)", fontSize:9.5,
        color:"var(--fg-dim)", display:"flex", gap:6}}>
        <span>2 milestones · 3 epics · 6 issues</span>
        <span style={{flex:1}}/>
        <span style={{color:"var(--info)"}}>gh/projects/14</span>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:4}}>
        {STRUCTURE.map(m=>(
          <div key={m.id}>
            <div onClick={()=>tog(m.id)} style={{display:"flex", alignItems:"center", gap:7,
              padding:"6px 7px", borderRadius:5, cursor:"pointer", background:"var(--bg-elev)"}}>
              <span style={{width:8, fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>{open[m.id]?"▾":"▸"}</span>
              <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)"}}>{m.id}</span>
              <span style={{flex:1, fontFamily:"var(--sans)", fontSize:11, color:"var(--fg)"}}>{m.title}</span>
              <span style={{width:46}}><Track pct={m.pct}/></span>
              <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-muted)", width:26, textAlign:"right"}}>{Math.round(m.pct*100)}%</span>
            </div>
            {open[m.id] && m.epics.map(e=>(
              <div key={e.id} style={{paddingLeft:14}}>
                <div onClick={()=>tog(e.id)} style={{display:"flex", alignItems:"center", gap:7,
                  padding:"5px 7px", borderRadius:5, cursor:"pointer"}}>
                  <span style={{width:8, fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>{open[e.id]?"▾":"▸"}</span>
                  <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--info)"}}>{e.id}</span>
                  <span style={{flex:1, fontFamily:"var(--sans)", fontSize:10.5, color:"var(--fg-muted)"}}>{e.title}</span>
                  <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>{e.issues.length} iss</span>
                </div>
                {open[e.id] && (
                  <div style={{paddingLeft:14, borderLeft:"1px solid var(--border-soft)", marginLeft:11}}>
                    {e.issues.map(iss=><IssueLine key={iss.n} iss={iss}/>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// =================================================================
// VARIANT B — Milestone cards with epic chips → issues
// =================================================================
function GithubB() {
  const [open,setOpen] = React.useState("M1");
  return (
    <div style={{display:"flex", flexDirection:"column", gap:9}}>
      {STRUCTURE.map(m=>{
        const on = open===m.id;
        const issues = m.epics.flatMap(e=>e.issues);
        return (
          <div key={m.id} style={{borderRadius:8, overflow:"hidden",
            border:"1px solid "+(on?"var(--accent-dim)":"var(--border-soft)"),
            background:"var(--bg-canvas)"}}>
            <div onClick={()=>setOpen(on?null:m.id)} style={{padding:"10px 12px", cursor:"pointer"}}>
              <div style={{display:"flex", alignItems:"baseline", gap:7, marginBottom:8}}>
                <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)"}}>{m.id}</span>
                <span style={{flex:1, fontFamily:"var(--sans)", fontSize:12.5, color:"var(--fg)"}}>{m.title}</span>
                <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-muted)"}}>{Math.round(m.pct*100)}%</span>
              </div>
              <Track pct={m.pct} green={m.pct>0.65}/>
              <div style={{display:"flex", gap:5, flexWrap:"wrap", marginTop:9}}>
                {m.epics.map(e=>(
                  <span key={e.id} style={{display:"inline-flex", alignItems:"center", gap:5,
                    padding:"2px 8px", borderRadius:99, fontFamily:"var(--mono)", fontSize:9,
                    background:"var(--bg-elev)", border:"1px solid var(--border-soft)", color:"var(--fg-muted)"}}>
                    <span style={{color:"var(--info)"}}>{e.id}</span>{e.title}
                    <span style={{color:"var(--fg-dim)"}}>{Math.round(e.pct*100)}%</span>
                  </span>
                ))}
              </div>
            </div>
            {on && (
              <div style={{padding:"4px 10px 10px", borderTop:"1px solid var(--border-soft)",
                background:"var(--bg-panel)"}}>
                {issues.map(iss=><IssueLine key={iss.n} iss={iss} showContract/>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// =================================================================
// VARIANT C — Path-to-done spine with per-issue contract
// =================================================================
function GithubC() {
  return (
    <div>
      <div style={{padding:"0 2px 10px", fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>
        path to done · M1 → M2
      </div>
      <div style={{paddingLeft:6}}>
        {STRUCTURE.map((m,mi)=>(
          <div key={m.id} style={{position:"relative", paddingLeft:18,
            borderLeft:"2px solid var(--border-soft)", paddingBottom: mi<STRUCTURE.length-1?14:0}}>
            {/* node */}
            <span style={{position:"absolute", left:-7, top:1, width:12, height:12, borderRadius:"50%",
              background:"var(--bg-panel)", border:"2px solid var(--accent)"}}/>
            <div style={{display:"flex", alignItems:"baseline", gap:7, marginBottom:6}}>
              <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)"}}>{m.id}</span>
              <span style={{flex:1, fontFamily:"var(--sans)", fontSize:12, color:"var(--fg)"}}>{m.title}</span>
              <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-muted)"}}>{Math.round(m.pct*100)}% done</span>
            </div>
            <div style={{marginBottom:9}}><Track pct={m.pct}/></div>
            {m.epics.map(e=>(
              <div key={e.id} style={{marginBottom:9}}>
                <div style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--info)", marginBottom:5}}>
                  {e.id} · {e.title}
                </div>
                <div style={{display:"flex", flexDirection:"column", gap:5}}>
                  {e.issues.map(iss=>(
                    <div key={iss.n} style={{padding:"7px 8px", borderRadius:6,
                      background:"var(--bg-canvas)", border:"1px solid var(--border-soft)"}}>
                      <div style={{display:"flex", alignItems:"center", gap:7}}>
                        <StateDot state={iss.state}/>
                        <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>#{iss.n}</span>
                        <span style={{flex:1, fontFamily:"var(--sans)", fontSize:10.5, color:"var(--fg)",
                          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{iss.t}</span>
                        <span title={"@"+iss.owner} style={{display:"flex", alignItems:"center", gap:3}}>
                          <Avatar id={iss.owner} sz={14}/>
                        </span>
                      </div>
                      <div style={{display:"flex", flexWrap:"wrap", gap:5, marginTop:5, paddingLeft:20,
                        fontFamily:"var(--mono)", fontSize:8.5}}>
                        <span style={{color:"var(--success)"}}>✓ {iss.ac} acceptance</span>
                        {iss.branch && <span className="glob" style={{fontSize:8.5, padding:"0 5px", color:"var(--info)"}}>⎇ {iss.branch}</span>}
                        {iss.deps.length>0 && <span style={{color:"var(--accent)"}}>blocked by #{iss.deps.join(" #")}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { GithubA, GithubB, GithubC, IssueLine, StateDot });
