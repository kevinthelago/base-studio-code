/* global React, REPOS, AGENTS, STRUCTURE, structFor, ISSUE_STATE, Avatar, Track, Dot */
// pp-repo.jsx — Repository panel, PLANNING edition.
// Files don't matter on the planning page; what matters is the work the
// project will create in each repo: milestones → epics → issues → sub-issues,
// and the branches that work lands on. Three takes.

const BR_STATE = {
  active: { c:"var(--accent)",  t:"active" },
  draft:  { c:"var(--fg-dim)",  t:"draft"  },
  review: { c:"var(--success)", t:"review" },
  merged: { c:"var(--info)",    t:"merged" },
};

function StateDot({ state }) {
  return <span style={{width:6, height:6, borderRadius:"50%", flex:"0 0 6px",
    background: ISSUE_STATE[state]||"var(--fg-dim)"}}/>;
}
function BranchChip({ n, mute }) {
  return <span style={{display:"inline-flex", alignItems:"center", gap:3,
    fontFamily:"var(--mono)", fontSize:8.5, padding:"0 5px", borderRadius:3,
    background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
    color: mute?"var(--fg-dim)":"var(--info)", whiteSpace:"nowrap"}}>⎇ {n}</span>;
}
function SubList({ sub, pad=22 }) {
  if (!sub || !sub.length) return null;
  return (
    <div style={{paddingLeft:pad, marginTop:5, display:"flex", flexDirection:"column", gap:3}}>
      {sub.map((s,i)=>(
        <div key={i} style={{display:"flex", alignItems:"center", gap:6,
          fontFamily:"var(--mono)", fontSize:9.5,
          color: s.done?"var(--fg-dim)":"var(--fg-muted)"}}>
          <span style={{width:11, height:11, borderRadius:3, flex:"0 0 11px",
            border:"1px solid "+(s.done?"var(--success)":"var(--border)"),
            background: s.done?"var(--success)":"transparent", color:"#1a120a",
            fontSize:8, lineHeight:"10px", textAlign:"center"}}>{s.done?"✓":""}</span>
          <span style={{textDecoration: s.done?"line-through":"none"}}>{s.t}</span>
        </div>
      ))}
      <div style={{display:"flex", alignItems:"center", gap:6, fontFamily:"var(--mono)",
        fontSize:9, color:"var(--fg-dim)", cursor:"pointer"}}>
        <span style={{width:11, textAlign:"center"}}>+</span> sub-issue
      </div>
    </div>
  );
}

function RepoHead({ r, open, onClick }) {
  return (
    <div onClick={onClick} style={{display:"flex", alignItems:"center", gap:7, cursor: onClick?"pointer":"default"}}>
      {onClick && <span style={{width:8, fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>{open?"▾":"▸"}</span>}
      <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--fg)"}}>{r.id}</span>
      {r.primary && <span className="tag amber" style={{fontSize:8.5}}>primary</span>}
      <span style={{flex:1}}/>
      <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--info)"}}>⎇ {r.branch}</span>
      <div style={{display:"flex"}}>
        {r.agents.map((id,i)=>(<span key={id} style={{marginLeft:i?-5:0}}><Avatar id={id} sz={15}/></span>))}
      </div>
    </div>
  );
}

// =================================================================
// VARIANT A — Repo → work tree (milestone → epic → issue → sub-issue)
// =================================================================
function RepoA() {
  const [openRepo,setOpenRepo] = React.useState(REPOS[0].id);
  const [openIss,setOpenIss] = React.useState(418);
  return (
    <div style={{display:"flex", flexDirection:"column", gap:8}}>
      {REPOS.map(r=>{
        const on = openRepo===r.id;
        const ms = structFor(r.id);
        const issN = ms.flatMap(m=>m.epics.flatMap(e=>e.issues)).length;
        return (
          <div key={r.id} style={{borderRadius:7, overflow:"hidden",
            border:"1px solid "+(r.primary?"var(--accent-dim)":"var(--border-soft)"),
            background:"var(--bg-canvas)"}}>
            <div style={{padding:"9px 11px"}}>
              <RepoHead r={r} open={on} onClick={()=>setOpenRepo(on?null:r.id)}/>
              <div style={{display:"flex", gap:10, marginTop:6, paddingLeft:15,
                fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>
                <span>{ms.length} milestone{ms.length!==1?"s":""}</span>
                <span>{issN} issues</span>
                <span>{r.branches.length} branches</span>
              </div>
            </div>
            {on && (
              <div style={{padding:"4px 10px 10px", borderTop:"1px solid var(--border-soft)",
                background:"var(--bg-panel)"}}>
                {ms.map(m=>(
                  <div key={m.id} style={{marginTop:6}}>
                    <div style={{display:"flex", alignItems:"center", gap:7, padding:"4px 4px"}}>
                      <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--accent)"}}>{m.id}</span>
                      <span style={{flex:1, fontFamily:"var(--sans)", fontSize:11, color:"var(--fg)"}}>{m.title}</span>
                      <span style={{width:40}}><Track pct={m.pct}/></span>
                    </div>
                    {m.epics.map(e=>(
                      <div key={e.id} style={{paddingLeft:12}}>
                        <div style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--info)", padding:"4px 4px 2px"}}>
                          {e.id} · {e.title}
                        </div>
                        <div style={{borderLeft:"1px solid var(--border-soft)", marginLeft:6, paddingLeft:8}}>
                          {e.issues.map(iss=>{
                            const io = openIss===iss.n;
                            return (
                              <div key={iss.n} style={{padding:"4px 0"}}>
                                <div onClick={()=>setOpenIss(io?null:iss.n)} style={{display:"flex",
                                  alignItems:"center", gap:6, cursor:"pointer"}}>
                                  {iss.sub && iss.sub.length>0
                                    ? <span style={{width:8, fontFamily:"var(--mono)", fontSize:8, color:"var(--fg-dim)"}}>{io?"▾":"▸"}</span>
                                    : <span style={{width:8}}/>}
                                  <StateDot state={iss.state}/>
                                  <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>#{iss.n}</span>
                                  <span style={{flex:1, fontFamily:"var(--sans)", fontSize:10.5, color:"var(--fg)",
                                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{iss.t}</span>
                                  {iss.sub && iss.sub.length>0 && <span style={{fontFamily:"var(--mono)",
                                    fontSize:8.5, color:"var(--fg-dim)"}}>⌱{iss.sub.length}</span>}
                                  <span title={"@"+iss.owner}><Avatar id={iss.owner} sz={14}/></span>
                                </div>
                                <div style={{paddingLeft:22, marginTop:3}}><BranchChip n={iss.branch}/></div>
                                {io && <SubList sub={iss.sub}/>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div style={{display:"flex", gap:8, paddingLeft:12, marginTop:4,
                      fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>
                      <span style={{cursor:"pointer"}}>+ issue</span>
                      <span style={{cursor:"pointer"}}>+ epic</span>
                    </div>
                  </div>
                ))}
                <div style={{marginTop:8, fontFamily:"var(--mono)", fontSize:9,
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
// VARIANT B — Repo → branch lanes (branch = unit of delivery)
// =================================================================
function RepoB() {
  // map issue # → issue object for branch lanes
  const issueOf = n => STRUCTURE.flatMap(m=>m.epics.flatMap(e=>e.issues)).find(i=>i.n===n);
  return (
    <div style={{display:"flex", flexDirection:"column", gap:10}}>
      {REPOS.map(r=>(
        <div key={r.id}>
          <div style={{marginBottom:7}}><RepoHead r={r}/></div>
          {/* default branch */}
          <div style={{display:"flex", alignItems:"center", gap:7, padding:"5px 9px",
            borderRadius:5, background:"var(--bg-elev)", marginBottom:5,
            fontFamily:"var(--mono)", fontSize:9.5}}>
            <span style={{color:"var(--info)"}}>⎇ {r.branch}</span>
            <span style={{color:"var(--fg-dim)"}}>default · target</span>
            <span style={{flex:1}}/>
            <span style={{color:"var(--fg-dim)"}}>⇡{r.ahead}</span>
          </div>
          {/* feature branch lanes */}
          <div style={{display:"flex", flexDirection:"column", gap:5}}>
            {r.branches.map(br=>{
              const iss = issueOf(br.issue);
              const S = BR_STATE[br.state];
              return (
                <div key={br.n} style={{borderRadius:6, overflow:"hidden",
                  border:"1px solid var(--border-soft)", background:"var(--bg-canvas)"}}>
                  <div style={{display:"flex", alignItems:"center", gap:7, padding:"6px 9px",
                    borderLeft:`3px solid ${S.c}`}}>
                    <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg)"}}>⎇ {br.n}</span>
                    <span style={{flex:1}}/>
                    <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:S.c}}>{S.t}</span>
                    {(br.ahead>0||br.behind>0) && <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>
                      {br.ahead>0?`⇡${br.ahead}`:""}{br.behind>0?` ⇣${br.behind}`:""}</span>}
                  </div>
                  {iss && (
                    <div style={{padding:"6px 9px 8px", borderTop:"1px solid var(--border-soft)"}}>
                      <div style={{display:"flex", alignItems:"center", gap:6}}>
                        <StateDot state={iss.state}/>
                        <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>#{iss.n}</span>
                        <span style={{flex:1, fontFamily:"var(--sans)", fontSize:10.5, color:"var(--fg)",
                          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{iss.t}</span>
                        <span title={"@"+iss.owner}><Avatar id={iss.owner} sz={14}/></span>
                      </div>
                      <SubList sub={iss.sub} pad={20}/>
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)",
              cursor:"pointer", paddingLeft:4, marginTop:1}}>+ branch from {r.branch}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// =================================================================
// VARIANT C — Issue cards with sub-issue checklists (define the work)
// =================================================================
function RepoC() {
  const [active,setActive] = React.useState(0);
  const r = REPOS[active];
  const ms = structFor(r.id);
  const cards = ms.flatMap(m=>m.epics.flatMap(e=>e.issues.map(iss=>({...iss, m:m.id, e:e.id, et:e.title}))));
  return (
    <div>
      {/* repo switcher */}
      <div style={{display:"flex", gap:4, marginBottom:9}}>
        {REPOS.map((repo,i)=>{
          const on=i===active;
          return (
            <button key={repo.id} onClick={()=>setActive(i)} style={{flex:1, padding:"6px 8px",
              borderRadius:6, cursor:"pointer", textAlign:"left",
              background:on?"var(--bg-canvas)":"transparent",
              border:"1px solid "+(on?"var(--accent-dim)":"var(--border-soft)")}}>
              <div style={{fontFamily:"var(--mono)", fontSize:10, color:on?"var(--fg)":"var(--fg-muted)",
                whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{repo.id.split("/")[1]}</div>
              <div style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)", marginTop:3}}>
                {structFor(repo.id).flatMap(m=>m.epics.flatMap(e=>e.issues)).length} issues</div>
            </button>
          );
        })}
      </div>

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
                <StateDot state={c.state}/>
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
                {c.sub.length>0 && <><span style={{flex:1}}/><span style={{fontFamily:"var(--mono)", fontSize:8.5,
                  color:"var(--fg-dim)"}}>{done}/{c.sub.length} sub</span></>}
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

Object.assign(window, { RepoA, RepoB, RepoC, SubList, BranchChip });
