/* global React, REPOS, STRUCTURE, structFor, AGENTS, ISSUE_STATE, Avatar, Track, SubList, BranchChip */
// pp-merged.jsx — Repository + GitHub Structure folded into ONE section.
// On the planning page the repo's whole point is the work it will hold,
// so milestones · epics · issues · sub-issues · branches live together.
// Three framings: repo-first tree, switcher + rollup + cards, milestone-first plan.

function MStateDot({ state }) {
  return <span style={{width:6, height:6, borderRadius:"50%", flex:"0 0 6px",
    background: ISSUE_STATE[state]||"var(--fg-dim)"}}/>;
}
function repoRollup(repoId){
  const ms = structFor(repoId);
  const iss = ms.flatMap(m=>m.epics.flatMap(e=>e.issues));
  const pct = ms.length ? ms.reduce((a,m)=>a+m.pct,0)/ms.length : 0;
  return { ms, iss, pct };
}

// =================================================================
// MERGED A — Repo-first: container header w/ rollup → milestone →
//            epic → issue → sub-issue → branch
// =================================================================
function MergedA() {
  const [openRepo,setOpenRepo] = React.useState(REPOS[0].id);
  const [openIss,setOpenIss] = React.useState(418);
  return (
    <div style={{display:"flex", flexDirection:"column", gap:8}}>
      {REPOS.map(r=>{
        const on = openRepo===r.id;
        const { ms, iss, pct } = repoRollup(r.id);
        return (
          <div key={r.id} style={{borderRadius:7, overflow:"hidden",
            border:"1px solid "+(r.primary?"var(--accent-dim)":"var(--border-soft)"),
            background:"var(--bg-canvas)"}}>
            {/* repo container header with structure rollup */}
            <div onClick={()=>setOpenRepo(on?null:r.id)} style={{padding:"9px 11px", cursor:"pointer"}}>
              <div style={{display:"flex", alignItems:"center", gap:7}}>
                <span style={{width:8, fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>{on?"▾":"▸"}</span>
                <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--fg)"}}>{r.id}</span>
                {r.primary && <span className="tag amber" style={{fontSize:8.5}}>primary</span>}
                <span style={{flex:1}}/>
                <div style={{display:"flex"}}>
                  {r.agents.map((id,i)=>(<span key={id} style={{marginLeft:i?-5:0}}><Avatar id={id} sz={14}/></span>))}
                </div>
              </div>
              <div style={{display:"flex", alignItems:"center", gap:8, marginTop:7, paddingLeft:15}}>
                <span style={{flex:1}}><Track pct={pct} green={pct>0.65}/></span>
                <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-muted)"}}>{Math.round(pct*100)}%</span>
              </div>
              <div style={{display:"flex", gap:10, marginTop:6, paddingLeft:15,
                fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>
                <span>⎇ {r.branch}</span>
                <span>{ms.length} milestone{ms.length!==1?"s":""}</span>
                <span>{iss.length} issues</span>
                <span>{r.branches.length} branches</span>
              </div>
            </div>

            {on && (
              <div style={{padding:"2px 10px 10px", borderTop:"1px solid var(--border-soft)",
                background:"var(--bg-panel)"}}>
                {ms.map(m=>(
                  <div key={m.id} style={{marginTop:8}}>
                    <div style={{display:"flex", alignItems:"center", gap:7}}>
                      <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--accent)"}}>{m.id}</span>
                      <span style={{flex:1, fontFamily:"var(--sans)", fontSize:11, color:"var(--fg)"}}>{m.title}</span>
                      <span style={{width:40}}><Track pct={m.pct}/></span>
                      <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)", width:24, textAlign:"right"}}>{Math.round(m.pct*100)}%</span>
                    </div>
                    {m.epics.map(e=>(
                      <div key={e.id} style={{paddingLeft:12, marginTop:4}}>
                        <div style={{display:"flex", alignItems:"center", gap:6, padding:"2px 0"}}>
                          <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--info)"}}>{e.id}</span>
                          <span style={{fontFamily:"var(--sans)", fontSize:10, color:"var(--fg-muted)"}}>{e.title}</span>
                          <span style={{flex:1}}/>
                          <span style={{fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>{Math.round(e.pct*100)}%</span>
                        </div>
                        <div style={{borderLeft:"1px solid var(--border-soft)", marginLeft:5, paddingLeft:9}}>
                          {e.issues.map(is=>{
                            const io = openIss===is.n;
                            return (
                              <div key={is.n} style={{padding:"4px 0"}}>
                                <div onClick={()=>setOpenIss(io?null:is.n)} style={{display:"flex", alignItems:"center", gap:6, cursor:"pointer"}}>
                                  {is.sub && is.sub.length>0
                                    ? <span style={{width:8, fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>{io?"▾":"▸"}</span>
                                    : <span style={{width:8}}/>}
                                  <MStateDot state={is.state}/>
                                  <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>#{is.n}</span>
                                  <span style={{flex:1, fontFamily:"var(--sans)", fontSize:10.5, color:"var(--fg)",
                                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{is.t}</span>
                                  <span title={"@"+is.owner}><Avatar id={is.owner} sz={14}/></span>
                                </div>
                                <div style={{paddingLeft:22, marginTop:3, display:"flex", gap:5}}>
                                  <BranchChip n={is.branch}/>
                                  <span style={{fontFamily:"var(--mono)", fontSize:8, color:"var(--success)"}}>✓ {is.ac} AC</span>
                                  {is.deps.length>0 && <span style={{fontFamily:"var(--mono)", fontSize:8, color:"var(--accent)"}}>⇠ #{is.deps.join(" #")}</span>}
                                </div>
                                {io && <SubList sub={is.sub}/>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div style={{paddingLeft:12, marginTop:5, fontFamily:"var(--mono)", fontSize:9,
                      color:"var(--fg-dim)", display:"flex", gap:10}}>
                      <span style={{cursor:"pointer"}}>+ issue</span>
                      <span style={{cursor:"pointer"}}>+ epic</span>
                    </div>
                  </div>
                ))}
                <div style={{marginTop:9, fontFamily:"var(--mono)", fontSize:9,
                  color:"var(--accent)", cursor:"pointer", paddingLeft:4}}>+ milestone</div>
              </div>
            )}
          </div>
        );
      })}
      <span className="mini" style={{alignSelf:"flex-start"}}>+ add repository</span>
    </div>
  );
}

// =================================================================
// MERGED B — Switcher → milestone rollup strip + issue cards
// =================================================================
function MergedB() {
  const [active,setActive] = React.useState(0);
  const r = REPOS[active];
  const { ms } = repoRollup(r.id);
  const cards = ms.flatMap(m=>m.epics.flatMap(e=>e.issues.map(is=>({...is, m:m.id, e:e.id}))));
  return (
    <div>
      {/* repo switcher */}
      <div style={{display:"flex", gap:4, marginBottom:10}}>
        {REPOS.map((repo,i)=>{
          const on=i===active; const ro=repoRollup(repo.id);
          return (
            <button key={repo.id} onClick={()=>setActive(i)} style={{flex:1, padding:"6px 9px",
              borderRadius:6, cursor:"pointer", textAlign:"left",
              background:on?"var(--bg-canvas)":"transparent",
              border:"1px solid "+(on?"var(--accent-dim)":"var(--border-soft)")}}>
              <div style={{fontFamily:"var(--mono)", fontSize:10, color:on?"var(--fg)":"var(--fg-muted)",
                whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{repo.id.split("/")[1]}</div>
              <div style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)", marginTop:3}}>
                {ro.iss.length} issues · {Math.round(ro.pct*100)}%</div>
            </button>
          );
        })}
      </div>

      {/* milestone rollup strip (the structure overview) */}
      <div className="ulabel" style={{padding:"0 2px 7px"}}>milestones · path to done</div>
      <div style={{display:"flex", flexDirection:"column", gap:5, marginBottom:13}}>
        {ms.map(m=>(
          <div key={m.id} style={{display:"flex", alignItems:"center", gap:8, padding:"6px 9px",
            borderRadius:6, background:"var(--bg-canvas)", border:"1px solid var(--border-soft)"}}>
            <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--accent)"}}>{m.id}</span>
            <span style={{flex:"1 1 0", fontFamily:"var(--sans)", fontSize:10.5, color:"var(--fg)",
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{m.title}</span>
            <span style={{flex:"0 0 56px"}}><Track pct={m.pct} green={m.pct>0.65}/></span>
            <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)", width:48, textAlign:"right"}}>
              {m.epics.flatMap(e=>e.issues).length} iss · {Math.round(m.pct*100)}%</span>
          </div>
        ))}
      </div>

      {/* issues as cards (the detail) */}
      <div className="ulabel" style={{padding:"0 2px 7px"}}>issues · {cards.length}</div>
      <div style={{display:"flex", flexDirection:"column", gap:7}}>
        {cards.map(c=>{
          const done = c.sub.filter(s=>s.done).length;
          return (
            <div key={c.n} style={{padding:"9px 11px", borderRadius:7,
              background:"var(--bg-canvas)", border:"1px solid var(--border-soft)"}}>
              <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:6}}>
                <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--accent)"}}>{c.m}</span>
                <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--info)"}}>{c.e}</span>
                <span style={{flex:1}}/>
                <MStateDot state={c.state}/>
                <span title={"@"+c.owner}><Avatar id={c.owner} sz={14}/></span>
              </div>
              <div style={{display:"flex", alignItems:"baseline", gap:6, marginBottom:6}}>
                <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>#{c.n}</span>
                <span style={{flex:1, fontFamily:"var(--sans)", fontSize:11.5, color:"var(--fg)", lineHeight:1.4}}>{c.t}</span>
              </div>
              <div style={{display:"flex", alignItems:"center", gap:6, marginBottom: c.sub.length?7:0}}>
                <BranchChip n={c.branch}/>
                <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--success)"}}>✓ {c.ac} AC</span>
                {c.deps.length>0 && <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--accent)"}}>⇠ #{c.deps.join(" #")}</span>}
                {c.sub.length>0 && <><span style={{flex:1}}/><span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>{done}/{c.sub.length} sub</span></>}
              </div>
              {c.sub.length>0 && (
                <div style={{paddingTop:7, borderTop:"1px solid var(--border-soft)"}}>
                  <SubList sub={c.sub} pad={0}/>
                </div>
              )}
            </div>
          );
        })}
        <div style={{display:"flex", gap:6}}>
          <span className="mini accent">+ issue</span>
          <span className="mini">+ milestone</span>
        </div>
      </div>
    </div>
  );
}

// =================================================================
// MERGED C — Milestone-first (the project plan); repo is a tag
// =================================================================
function MergedC() {
  const [openIss,setOpenIss] = React.useState(417);
  return (
    <div>
      <div style={{padding:"0 2px 10px", fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>
        the plan · {STRUCTURE.length} milestones across {REPOS.length} repos
      </div>
      <div style={{paddingLeft:6}}>
        {STRUCTURE.map((m,mi)=>(
          <div key={m.id} style={{position:"relative", paddingLeft:18,
            borderLeft:"2px solid var(--border-soft)", paddingBottom: mi<STRUCTURE.length-1?16:0}}>
            <span style={{position:"absolute", left:-7, top:1, width:12, height:12, borderRadius:"50%",
              background:"var(--bg-panel)", border:"2px solid var(--accent)"}}/>
            {/* milestone header with repo tag */}
            <div style={{display:"flex", alignItems:"center", gap:7, marginBottom:4}}>
              <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--accent)"}}>{m.id}</span>
              <span style={{flex:1, fontFamily:"var(--sans)", fontSize:11.5, color:"var(--fg)"}}>{m.title}</span>
              <span style={{fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>{Math.round(m.pct*100)}%</span>
            </div>
            <div style={{display:"flex", alignItems:"center", gap:7, marginBottom:9}}>
              <span style={{fontFamily:"var(--mono)", fontSize:8.5, padding:"0 6px", borderRadius:3,
                background:"var(--bg-elev)", border:"1px solid var(--border-soft)", color:"var(--fg-muted)"}}>⎇ {m.repo.split("/")[1]}</span>
              <span style={{flex:1}}><Track pct={m.pct}/></span>
            </div>
            {m.epics.map(e=>(
              <div key={e.id} style={{marginBottom:9}}>
                <div style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--info)", marginBottom:5}}>{e.id} · {e.title}</div>
                <div style={{display:"flex", flexDirection:"column", gap:5}}>
                  {e.issues.map(is=>{
                    const io = openIss===is.n;
                    return (
                      <div key={is.n} style={{borderRadius:6, background:"var(--bg-canvas)",
                        border:"1px solid var(--border-soft)", overflow:"hidden"}}>
                        <div onClick={()=>setOpenIss(io?null:is.n)} style={{padding:"7px 9px", cursor:"pointer"}}>
                          <div style={{display:"flex", alignItems:"center", gap:6}}>
                            <MStateDot state={is.state}/>
                            <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>#{is.n}</span>
                            <span style={{flex:1, fontFamily:"var(--sans)", fontSize:10.5, color:"var(--fg)",
                              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{is.t}</span>
                            <span title={"@"+is.owner}><Avatar id={is.owner} sz={14}/></span>
                          </div>
                          <div style={{display:"flex", gap:5, marginTop:5, paddingLeft:20, alignItems:"center"}}>
                            <BranchChip n={is.branch}/>
                            <span style={{fontFamily:"var(--mono)", fontSize:8, color:"var(--success)"}}>✓ {is.ac} AC</span>
                            {is.sub.length>0 && <span style={{fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>⌱ {is.sub.length} sub</span>}
                            {is.deps.length>0 && <span style={{fontFamily:"var(--mono)", fontSize:8, color:"var(--accent)"}}>⇠ #{is.deps.join(" #")}</span>}
                          </div>
                        </div>
                        {io && is.sub.length>0 && (
                          <div style={{padding:"0 9px 8px", borderTop:"1px solid var(--border-soft)"}}>
                            <SubList sub={is.sub} pad={4}/>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{marginTop:8, fontFamily:"var(--mono)", fontSize:9, color:"var(--accent)", cursor:"pointer"}}>+ milestone</div>
    </div>
  );
}

Object.assign(window, { MergedA, MergedB, MergedC });
