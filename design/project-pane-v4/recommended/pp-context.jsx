/* global React, CONTEXT, CTX_KIND */
// pp-context.jsx — Context Files. pinned-to-context vs library, three takes.

function KindDot({ kind }) {
  return <span style={{width:6, height:6, borderRadius:2, flex:"0 0 6px",
    background: CTX_KIND[kind]||"var(--fg-dim)"}}/>;
}

function CtxRow({ f, onToggle }) {
  return (
    <div style={{display:"flex", alignItems:"center", gap:7, padding:"5px 7px",
      borderRadius:5, background: f.pinned?"var(--bg-canvas)":"transparent",
      border:"1px solid "+(f.pinned?"var(--border-soft)":"transparent")}}>
      <KindDot kind={f.kind}/>
      <span style={{flex:1, fontFamily:"var(--mono)", fontSize:10, color: f.pinned?"var(--fg)":"var(--fg-muted)",
        whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{f.name}</span>
      <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>{f.tok}</span>
      <span onClick={onToggle} style={{cursor:"pointer", fontFamily:"var(--mono)", fontSize:11,
        color: f.pinned?"var(--accent)":"var(--fg-dim)", width:14, textAlign:"center"}}>
        {f.pinned?"✦":"+"}
      </span>
    </div>
  );
}

// =================================================================
// VARIANT A — Pinned vs Library, two sections
// =================================================================
function ContextA() {
  const [items,setItems] = React.useState(CONTEXT);
  const toggle = name => setItems(items.map(f=>f.name===name?{...f,pinned:!f.pinned}:f));
  const pinned = items.filter(f=>f.pinned);
  const lib = items.filter(f=>!f.pinned);
  return (
    <div>
      <div style={{display:"flex", alignItems:"center", gap:6, padding:"2px 2px 7px"}}>
        <span className="ulabel">pinned to context</span>
        <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--accent)"}}>✦ {pinned.length}</span>
        <span style={{flex:1}}/>
        <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>~6.7k tok</span>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:4, marginBottom:12}}>
        {pinned.map(f=><CtxRow key={f.name} f={f} onToggle={()=>toggle(f.name)}/>)}
      </div>

      <div style={{display:"flex", alignItems:"center", gap:6, padding:"2px 2px 7px"}}>
        <span className="ulabel">library</span>
        <span style={{flex:1}}/>
        <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>{lib.length} available</span>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:3}}>
        {lib.map(f=><CtxRow key={f.name} f={f} onToggle={()=>toggle(f.name)}/>)}
      </div>
    </div>
  );
}

// =================================================================
// VARIANT B — Token-budget view, grouped by kind w/ meter
// =================================================================
function ContextB() {
  const pinned = CONTEXT.filter(f=>f.pinned);
  const used = 14.2, cap = 200;
  const groups = {};
  pinned.forEach(f=>{ (groups[f.kind]=groups[f.kind]||[]).push(f); });
  const KIND_LABEL = { spec:"specs", claude:"CLAUDE", kb:"knowledge", doc:"docs" };
  return (
    <div>
      {/* budget meter */}
      <div style={{padding:"10px 11px", borderRadius:7, background:"var(--bg-canvas)",
        border:"1px solid var(--border-soft)", marginBottom:11}}>
        <div style={{display:"flex", alignItems:"baseline", gap:6, marginBottom:7}}>
          <span className="ulabel">context budget</span>
          <span style={{flex:1}}/>
          <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg)"}}>{used}k</span>
          <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)"}}>/ {cap}k</span>
        </div>
        <div style={{height:7, borderRadius:4, background:"var(--bg-elev2)", overflow:"hidden", display:"flex"}}>
          {pinned.map((f,i)=>(
            <span key={i} title={f.name} style={{
              width:`${parseFloat(f.tok)/cap*100}%`,
              background: CTX_KIND[f.kind], borderRight:"1px solid var(--bg-panel)"}}/>
          ))}
        </div>
        <div style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)", marginTop:6}}>
          {pinned.length} files pinned · 7% of window · plenty of headroom
        </div>
      </div>

      {/* grouped */}
      <div style={{display:"flex", flexDirection:"column", gap:11}}>
        {Object.keys(groups).map(k=>(
          <div key={k}>
            <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:6}}>
              <KindDot kind={k}/>
              <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg)"}}>{KIND_LABEL[k]||k}</span>
              <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>{groups[k].length}</span>
              <span style={{flex:1, height:1, background:"var(--border-soft)"}}/>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:3}}>
              {groups[k].map(f=>(
                <div key={f.name} style={{display:"flex", alignItems:"center", gap:7, padding:"3px 6px"}}>
                  <span style={{flex:1, fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)",
                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{f.name}</span>
                  <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>{f.tok}</span>
                  <span style={{color:"var(--accent)", fontFamily:"var(--mono)", fontSize:10}}>✦</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <span className="mini" style={{marginTop:11, display:"inline-block"}}>+ pin from library…</span>
    </div>
  );
}

// =================================================================
// VARIANT C — By scope: Global → Project → Repo resolution
// =================================================================
function ContextC() {
  const scopes = [
    { k:"global",  label:"Global",  note:"every agent, every project", color:"var(--fg-dim)" },
    { k:"project", label:"Project", note:"settlement webhooks v2",     color:"var(--accent)" },
    { k:"repo",    label:"Repo",    note:"acme/payments",              color:"var(--info)" },
  ];
  return (
    <div>
      <div style={{padding:"0 2px 9px", fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-dim)", lineHeight:1.6}}>
        resolved top-down · each scope adds to the parent, never subtracts
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:8}}>
        {scopes.map(sc=>{
          const files = CONTEXT.filter(f=>f.scope===sc.k);
          return (
            <div key={sc.k} style={{borderRadius:7, overflow:"hidden",
              border:"1px solid var(--border-soft)", background:"var(--bg-canvas)"}}>
              <div style={{display:"flex", alignItems:"center", gap:7, padding:"7px 10px",
                background:"var(--bg-elev)", borderLeft:`3px solid ${sc.color}`}}>
                <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg)"}}>{sc.label}</span>
                <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>{sc.note}</span>
                <span style={{flex:1}}/>
                <span style={{fontFamily:"var(--mono)", fontSize:9, color: files.some(f=>f.pinned)?"var(--accent)":"var(--fg-dim)"}}>
                  ✦ {files.filter(f=>f.pinned).length}/{files.length}
                </span>
              </div>
              <div style={{padding:"5px 10px 8px", display:"flex", flexDirection:"column", gap:3}}>
                {files.map(f=>(
                  <div key={f.name} style={{display:"flex", alignItems:"center", gap:7}}>
                    <span style={{color: f.pinned?"var(--accent)":"var(--fg-dim)", fontFamily:"var(--mono)", fontSize:10, width:12}}>
                      {f.pinned?"✦":"○"}</span>
                    <span style={{flex:1, fontFamily:"var(--mono)", fontSize:10,
                      color: f.pinned?"var(--fg)":"var(--fg-dim)",
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{f.name}</span>
                    <span style={{fontFamily:"var(--mono)", fontSize:8.5, color:"var(--fg-dim)"}}>{f.tok}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

Object.assign(window, { ContextA, ContextB, ContextC });
