/* global React */
// pane.jsx — pane shell with icon-only view tabs + hamburger menu,
// and the five view components (console / files / branches / changes / log).

const VIEW_DEFS = {
  console:  { icon:"▸", label:"console",  hint:"claude session",        hotkey:"⌘1" },
  files:    { icon:"⌗", label:"files",    hint:"working tree",          hotkey:"⌘2" },
  branches: { icon:"⎇", label:"branches", hint:"local + remote refs",   hotkey:"⌘3", gitOnly:true },
  changes:  { icon:"±", label:"changes",  hint:"diff vs HEAD",          hotkey:"⌘4", gitOnly:true },
  log:      { icon:"⏱", label:"log",      hint:"recent commits",        hotkey:"⌘5", gitOnly:true },
};

const MODELS = [
  { id:"haiku-4.5",  name:"haiku-4.5",  tone:"fast",      ctx:"200k", price:"$ ·"   },
  { id:"sonnet-4.5", name:"sonnet-4.5", tone:"balanced",  ctx:"200k", price:"$$ ··"  },
  { id:"opus-4.5",   name:"opus-4.5",   tone:"deep",      ctx:"200k", price:"$$$ ···" },
];

// ─────────────────────────────────────────────────────────────
// Icon-only view tab strip
// ─────────────────────────────────────────────────────────────
function ViewTabs({ active, available }) {
  return (
    <div style={{
      height:26, flex:"0 0 26px",
      display:"flex", alignItems:"center", gap:2,
      padding:"0 6px",
      borderBottom:"1px solid var(--border-soft)",
      background:"var(--bg-panel)",
      fontFamily:"var(--mono)",
    }}>
      {available.map(k=>{
        const v = VIEW_DEFS[k];
        const on = k === active;
        return (
          <div key={k} title={`${v.label} · ${v.hotkey}`} style={{
            width:24, height:20,
            display:"flex", alignItems:"center", justifyContent:"center",
            borderRadius:4,
            background: on ? "var(--bg-canvas)"    : "transparent",
            border: on ? "1px solid var(--accent-dim)" : "1px solid transparent",
            color: on ? "var(--accent)" : "var(--fg-muted)",
            fontSize:12,
            cursor:"pointer",
          }}>{v.icon}</div>
        );
      })}
      <div style={{flex:1}}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hamburger popover menu
// ─────────────────────────────────────────────────────────────
function HamburgerMenu({ agent, repo, branch, model="sonnet-4.5", active, available, onClose }) {
  return (
    <div style={{
      position:"absolute", top:38, right:6, zIndex:20,
      width:268,
      background:"var(--bg-panel)",
      border:"1px solid var(--border)",
      borderRadius:8,
      boxShadow:"0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02)",
      overflow:"hidden",
      fontFamily:"var(--mono)", fontSize:11,
    }}>
      {/* Header */}
      <div style={{
        padding:"10px 12px", borderBottom:"1px solid var(--border-soft)",
        background:"var(--bg-elev)",
      }}>
        <div style={{display:"flex", alignItems:"baseline", gap:8}}>
          <span style={{fontSize:12, color:"var(--fg)", fontWeight:600}}>{agent}</span>
          <span style={{flex:1}}/>
          <span style={{color:"var(--fg-dim)", fontSize:10, cursor:"pointer"}}>rename</span>
        </div>
        {repo && (
          <div style={{fontSize:10, color:"var(--fg-muted)", marginTop:3,
            whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
            <span style={{color:"var(--info)"}}>⎇ {branch}</span>
            <span style={{color:"var(--fg-dim)"}}> · </span>
            {repo}
          </div>
        )}
      </div>

      {/* Model selector */}
      <Section label="model">
        {MODELS.map(m=>{
          const on = m.id===model;
          return (
            <Row key={m.id} on={on}>
              <span style={{color: on?"var(--accent)":"var(--fg-dim)", width:10}}>{on?"●":"○"}</span>
              <span style={{color: on?"var(--accent)":"var(--fg)", flex:1}}>{m.name}</span>
              <span style={{color:"var(--fg-dim)", fontSize:9.5, marginRight:6}}>{m.tone}</span>
              <span style={{color:"var(--fg-dim)", fontSize:9.5}}>{m.price}</span>
            </Row>
          );
        })}
      </Section>

      {/* Views */}
      <Section label="view">
        {available.map(k=>{
          const v = VIEW_DEFS[k];
          const on = k===active;
          return (
            <Row key={k} on={on}>
              <span style={{color: on?"var(--accent)":"var(--fg-muted)", width:12, textAlign:"center"}}>{v.icon}</span>
              <span style={{color: on?"var(--accent)":"var(--fg)", flex:1}}>{v.label}</span>
              {on && <span style={{color:"var(--accent)", fontSize:9.5, marginRight:6}}>current</span>}
              <span style={{color:"var(--fg-dim)", fontSize:9.5}}>{v.hotkey}</span>
            </Row>
          );
        })}
      </Section>

      {/* Pane actions */}
      <Section label="context">
        <Row>
          <span style={{color:"var(--accent)", width:12, textAlign:"center"}}>✦</span>
          <span style={{color:"var(--fg)", flex:1}}>3 blocks pinned</span>
          <span style={{color:"var(--fg-dim)", fontSize:9.5}}>2G · 1P</span>
        </Row>
        <ActionRow icon="↗" t="open context inspector…" sub="see what's resolved"/>
      </Section>

      <Section label="pane" last>
        <ActionRow icon="↻" t="rescan repo"            sub="re-detect HEAD"/>
        <ActionRow icon="✦" t="pin knowledge…"         sub="surface a block in context"/>
        <ActionRow icon="⌖" t="set cwd…"               sub="change working dir"/>
        <ActionRow icon="⊘" t="unbind repo"            sub="drop git context" danger/>
        <ActionRow icon="✕" t="close pane"             sub=""                 danger/>
      </Section>
    </div>
  );
}

function Section({ label, children, last }) {
  return (
    <div style={{padding:"6px 6px", borderBottom: last ? "0" : "1px solid var(--border-soft)"}}>
      <div style={{
        padding:"4px 8px 6px", fontSize:9.5, color:"var(--fg-dim)",
        textTransform:"uppercase", letterSpacing:".08em",
      }}>{label}</div>
      <div style={{display:"flex", flexDirection:"column", gap:1}}>{children}</div>
    </div>
  );
}
function Row({ on, children }) {
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:6, padding:"6px 8px",
      borderRadius:5,
      background: on ? "color-mix(in oklch, var(--accent), transparent 90%)" : "transparent",
      cursor:"pointer",
    }}>{children}</div>
  );
}
function ActionRow({ icon, t, sub, danger }) {
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:8, padding:"6px 8px",
      borderRadius:5, cursor:"pointer",
    }}>
      <span style={{width:12, color: danger?"var(--danger)":"var(--fg-muted)"}}>{icon}</span>
      <span style={{color: danger?"var(--danger)":"var(--fg)"}}>{t}</span>
      <span style={{flex:1}}/>
      {sub && <span style={{fontSize:9.5, color:"var(--fg-dim)"}}>{sub}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PaneShell — no model badge; hamburger replaces it
// ─────────────────────────────────────────────────────────────
function PaneShell({
  agent, status="run", meta,
  cwd, repo, branch, dirty, model="sonnet-4.5",
  available=["console","files"],
  active="console",
  banner=null,
  menuOpen=false,
  children,
  height,
}) {
  const statusColor = status==="idle" ? "var(--fg-dim)"
                    : status==="run"  ? "var(--accent)"
                    : "var(--success)";
  return (
    <div className="pane focused" style={{
      height: height || "100%",
      display:"flex", flexDirection:"column",
      position:"relative",
      // pane that owns an open menu floats above siblings
      zIndex: menuOpen ? 5 : 1,
    }}>
      {/* head */}
      <div style={{
        height:32, flex:"0 0 32px", padding:"0 8px 0 10px",
        display:"flex", alignItems:"center", gap:8,
        background:"var(--bg-elev)", borderBottom:"1px solid var(--border-soft)",
      }}>
        <span style={{
          width:7, height:7, borderRadius:"50%", background:statusColor,
          animation: status==="run" ? "pulse 1.4s ease-in-out infinite" : "none",
          flex:"0 0 7px",
        }}/>
        <span style={{fontFamily:"var(--mono)", fontSize:11.5, color:"var(--fg)",
          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", flex:"0 1 auto"}}>{agent}</span>
        <div style={{flex:1, minWidth:0,
          display:"flex", alignItems:"center", justifyContent:"flex-end", gap:6,
          fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)",
          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
          {repo ? (
            <>
              <span style={{color:"var(--info)"}}>⎇ {branch}</span>
              {dirty && <span style={{color:"var(--danger)"}}>●</span>}
              <span style={{color:"var(--fg-dim)", overflow:"hidden", textOverflow:"ellipsis"}}>{repo}</span>
            </>
          ) : (
            <span style={{color:"var(--fg-dim)"}}>cwd: {cwd}</span>
          )}
          {meta && (<><span style={{color:"var(--fg-dim)"}}>·</span><span>{meta}</span></>)}
        </div>
        {/* hamburger */}
        <button title="Pane menu" style={{
          width:22, height:22, borderRadius:4,
          border:"1px solid " + (menuOpen?"var(--accent-dim)":"transparent"),
          background: menuOpen ? "var(--bg-canvas)" : "transparent",
          color: menuOpen ? "var(--accent)" : "var(--fg-muted)",
          display:"flex", alignItems:"center", justifyContent:"center",
          cursor:"pointer", fontSize:12, lineHeight:1, flex:"0 0 22px",
        }}>☰</button>
      </div>

      {banner}

      <ViewTabs active={active} available={available}/>

      <div style={{flex:1, minHeight:0, display:"flex", flexDirection:"column", overflow:"hidden"}}>
        {children}
      </div>

      {menuOpen && (
        <HamburgerMenu agent={agent} repo={repo} branch={branch}
          model={model} active={active} available={available}/>
      )}
    </div>
  );
}

// =============================================================
// View bodies
// =============================================================

// ─── Console (Claude chat)
function ConsoleView({ small=false, withInput=true, turns, draft, streaming }) {
  return (
    <>
      <div style={{
        flex:1, minHeight:0, overflow:"auto",
        padding: small ? "8px 10px" : "12px 16px",
        fontFamily:"var(--mono)", fontSize: small ? 10.5 : 11.5,
        lineHeight:1.55, color:"var(--fg-muted)",
        display:"flex", flexDirection:"column", gap: small ? 10 : 14,
      }}>
        {turns.map((t,i)=>(<Turn key={i} t={t} small={small}/>))}
        {streaming && (
          <div style={{display:"flex", alignItems:"center", gap:6,
            color:"var(--fg-dim)", fontSize: small?9.5:10.5}}>
            <span style={{width:8, height:8, borderRadius:"50%", background:"var(--accent)",
              animation:"pulse 1.4s ease-in-out infinite"}}/>
            claude is writing…
          </div>
        )}
      </div>

      {withInput && (
        <div style={{
          padding:"7px 10px", borderTop:"1px solid var(--border-soft)",
          background:"var(--bg-canvas)",
          display:"flex", flexDirection:"column", gap:5,
        }}>
          <div style={{display:"flex", alignItems:"center", gap:6,
            fontFamily:"var(--mono)", fontSize: small?10:11,
            color: draft ? "var(--fg)" : "var(--fg-dim)"}}>
            <span style={{color:"var(--accent)"}}>▸</span>
            <span style={{flex:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
              {draft || "ask claude… try /scan to load repo context"}
            </span>
            {!small && (
              <>
                <span style={{padding:"0 5px", borderRadius:3, background:"var(--bg-elev)",
                  border:"1px solid var(--border-soft)", color:"var(--fg-muted)", fontSize:10}}>+ attach</span>
                <span style={{padding:"0 5px", borderRadius:3, background:"var(--accent)",
                  color:"#1a120a", fontWeight:600, fontSize:10}}>↵ send</span>
              </>
            )}
          </div>
          {!small && (
            <div style={{display:"flex", gap:6, fontFamily:"var(--mono)", fontSize:9.5,
              color:"var(--fg-dim)"}}>
              <span style={{color:"var(--info)"}}>/scan</span>
              <span style={{color:"var(--info)"}}>/pin</span>
              <span style={{color:"var(--info)"}}>/tools</span>
              <span style={{color:"var(--info)"}}>/reset</span>
              <span style={{color:"var(--info)"}}>/export</span>
              <span style={{flex:1}}/>
              <span>tools: <span style={{color:"var(--fg-muted)"}}>read · write · bash · git · gh · kb</span></span>
              <span>·</span>
              <span>14.2k / 200k</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Turn({ t, small }) {
  if (t.role === "user") {
    return (
      <div style={{display:"flex", justifyContent:"flex-end"}}>
        <div style={{
          maxWidth:"82%",
          padding: small ? "5px 9px" : "7px 11px",
          borderRadius:8,
          background:"color-mix(in oklch, var(--info), transparent 86%)",
          border:"1px solid color-mix(in oklch, var(--info), transparent 70%)",
          color:"var(--fg)",
          fontFamily: small ? "var(--mono)" : "var(--sans)",
          fontSize: small ? 10.5 : 12,
          lineHeight:1.55, whiteSpace:"pre-wrap",
        }}>{t.text}</div>
      </div>
    );
  }
  return (
    <div style={{display:"flex", gap:8}}>
      {!small && (
        <div style={{
          flex:"0 0 22px", width:22, height:22, borderRadius:5,
          background:"linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
          color:"#1a120a", fontFamily:"var(--mono)", fontWeight:700, fontSize:11,
          display:"flex", alignItems:"center", justifyContent:"center",
          marginTop:2,
        }}>C</div>
      )}
      <div style={{flex:1, minWidth:0, display:"flex", flexDirection:"column", gap:6}}>
        {t.blocks.map((b,i)=>(<Block key={i} b={b} small={small}/>))}
      </div>
    </div>
  );
}

function Block({ b, small }) {
  if (b.kind === "thinking") {
    return (
      <div style={{
        padding: small?"4px 8px":"6px 10px",
        borderRadius:6, background:"var(--bg-elev)",
        border:"1px dashed var(--border-soft)",
        fontFamily:"var(--mono)", fontSize: small?9.5:10.5,
        color:"var(--fg-dim)", fontStyle:"italic",
      }}>
        <div style={{display:"flex", alignItems:"center", gap:6,
          marginBottom: b.collapsed?0:4, color:"var(--fg-muted)", fontStyle:"normal"}}>
          <span>{b.collapsed ? "▸" : "▾"}</span>
          <span>thinking</span>
          <span style={{color:"var(--fg-dim)"}}>· {b.dur}</span>
        </div>
        {!b.collapsed && <div>{b.text}</div>}
      </div>
    );
  }
  if (b.kind === "tool") {
    return (
      <div style={{borderRadius:6, background:"var(--bg-elev)",
        border:"1px solid var(--border-soft)", overflow:"hidden"}}>
        <div style={{
          padding: small?"4px 8px":"5px 10px",
          background:"color-mix(in oklch, var(--success), transparent 90%)",
          borderBottom:"1px solid var(--border-soft)",
          display:"flex", alignItems:"center", gap:8,
          fontFamily:"var(--mono)", fontSize: small?9.5:10.5,
        }}>
          <span style={{color:"var(--success)", fontWeight:600}}>{b.tool}</span>
          <span style={{color:"var(--fg-muted)", flex:1,
            whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{b.args}</span>
          <span style={{color: b.ok===false ? "var(--danger)" : "var(--success)"}}>
            {b.ok===false ? "✗" : "✓"} {b.summary}
          </span>
        </div>
        {b.preview && (
          <pre style={{margin:0, padding: small?"5px 10px":"8px 12px",
            fontFamily:"var(--mono)", fontSize: small?9.5:10.5,
            color:"var(--fg-muted)", lineHeight:1.55,
            whiteSpace:"pre-wrap", maxHeight: small?60:120, overflow:"hidden"}}>
            {b.preview}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div style={{fontFamily: small?"var(--mono)":"var(--sans)",
      fontSize: small?10.5:12, color:"var(--fg)", lineHeight:1.6,
      whiteSpace:"pre-wrap"}}>{b.text}</div>
  );
}

// ─── Files
function FilesView({ small=false, cwd, tree, active }) {
  return (
    <div style={{flex:1, minHeight:0, overflow:"auto",
      padding: small?"6px 4px":"8px 6px",
      fontFamily:"var(--mono)", fontSize: small?10:11, color:"var(--fg-muted)"}}>
      <div style={{padding:"2px 8px 6px", color:"var(--fg-dim)", fontSize: small?9.5:10,
        display:"flex", alignItems:"center", gap:6}}>
        <span>{cwd}</span>
        <span style={{flex:1}}/>
        <span style={{color:"var(--accent)"}}>± 4</span>
      </div>
      {tree.map((row,i)=>(
        <div key={i} style={{
          display:"flex", alignItems:"center", gap:4,
          padding:"2px 8px", paddingLeft: 8+(row.depth||0)*12,
          background: row.path===active ? "var(--bg-elev)" : "transparent",
          borderRadius:3,
          color: row.dir ? "var(--fg)" : "var(--fg-muted)",
          cursor:"pointer",
        }}>
          <span style={{width:10, color:"var(--fg-dim)",
            visibility: row.dir ? "visible" : "hidden"}}>{row.open?"▾":"▸"}</span>
          <span style={{color: row.dir ? "var(--accent)" : "var(--fg-muted)",
            opacity: row.dir ? 0.9 : 0.7}}>
            {row.dir ? (row.open?"⌹":"⌷") : "·"}
          </span>
          <span style={{flex:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
            {row.name}
          </span>
          {row.status && (
            <span style={{fontSize: small?9:9.5, padding:"0 4px", borderRadius:3,
              color: row.status==="M" ? "var(--accent)"
                  : row.status==="A" ? "var(--success)"
                  : row.status==="??" ? "var(--fg-dim)" : "var(--fg-muted)",
              background:"var(--bg-elev2)"}}>{row.status}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Branches
function BranchesView({ small=false }) {
  const branches = [
    { n:"main",                cur:true, ahead:0, behind:0, age:"3m"  },
    { n:"feat/tunnel-v2",      ahead:5,  behind:2, age:"24m" },
    { n:"fix/retry-loop",      ahead:0,  behind:0, age:"4h", merged:true },
    { n:"docs/migrate-store",  ahead:2,  behind:0, age:"1h" },
    { n:"chore/bump-sdk",      ahead:1,  behind:8, age:"3d" },
    { n:"wip/audit-log",       ahead:11, behind:14, age:"1w", stale:true },
  ];
  return (
    <div style={{flex:1, minHeight:0, overflow:"auto",
      padding: small?"6px 8px":"10px 12px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:8, marginBottom:6,
        fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
        textTransform:"uppercase", letterSpacing:".06em"}}>
        <span>6 branches</span><span>·</span><span>2 ahead, 1 stale</span>
      </div>
      {branches.map(b=>(
        <div key={b.n} style={{
          display:"grid", gridTemplateColumns:"14px 1fr auto auto", gap:8,
          alignItems:"center", padding:"4px 6px", borderRadius:4,
          background: b.cur ? "color-mix(in oklch, var(--accent), transparent 90%)" : "transparent",
          fontFamily:"var(--mono)", fontSize: small?10:11,
        }}>
          <span style={{color: b.cur?"var(--accent)":"var(--fg-dim)"}}>{b.cur?"●":"○"}</span>
          <span style={{color: b.cur?"var(--accent)":b.merged?"var(--fg-dim)":"var(--fg)",
            textDecoration: b.merged?"line-through":"none",
            whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{b.n}</span>
          <span style={{fontSize: small?9.5:10, color:"var(--fg-muted)", whiteSpace:"nowrap"}}>
            {b.ahead>0 && <span style={{color:"var(--info)"}}>⇡{b.ahead}</span>}
            {b.ahead>0 && b.behind>0 && " "}
            {b.behind>0 && <span style={{color:"var(--accent)"}}>⇣{b.behind}</span>}
            {b.merged && <span style={{color:"var(--success)"}}>merged</span>}
            {b.stale && <span style={{color:"var(--danger)"}}>stale</span>}
          </span>
          <span style={{fontSize: small?9:10, color:"var(--fg-dim)"}}>{b.age}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Changes
function ChangesView({ small=false }) {
  const hunks = [
    { file:"crates/ws-server/src/proto.rs", add:14, del:2, sample:[
      [" "," pub struct Hello {"],
      ["-","     pub v: u8,"],
      ["+","     pub v: u16,"],
      ["+","     pub capabilities: Vec<String>,"],
      [" ","     pub host_name: String,"],
      [" "," }"],
    ]},
    { file:"crates/orch/src/agent.rs", add:4, del:1, sample:[
      [" "," fn dispatch_tool(name: &str) -> Result<()> {"],
      ["-","     trace!(\"tool {}\", name);"],
      ["+","     trace!(target:\"tool\", name);"],
      ["+","     ensure_repo_scope()?;"],
    ]},
  ];
  return (
    <div style={{flex:1, minHeight:0, overflow:"auto",
      padding: small?"6px 8px":"10px 12px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:8, marginBottom:8,
        fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
        textTransform:"uppercase", letterSpacing:".06em"}}>
        <span>4 files changed</span><span>·</span>
        <span style={{color:"var(--success)"}}>+18</span>
        <span style={{color:"var(--danger)"}}>−3</span>
        <div style={{flex:1}}/>
        <span style={{color:"var(--accent)", textTransform:"none", letterSpacing:0}}>stash · commit</span>
      </div>
      {hunks.map((h,i)=>(
        <div key={i} style={{marginBottom:8, borderRadius:5,
          border:"1px solid var(--border-soft)", overflow:"hidden"}}>
          <div style={{padding:"5px 9px", background:"var(--bg-elev)",
            display:"flex", alignItems:"baseline", gap:8,
            fontFamily:"var(--mono)", fontSize: small?10:11}}>
            <span style={{color:"var(--fg)", flex:1,
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{h.file}</span>
            <span style={{color:"var(--success)", fontSize: small?9.5:10}}>+{h.add}</span>
            <span style={{color:"var(--danger)",  fontSize: small?9.5:10}}>−{h.del}</span>
          </div>
          <pre style={{margin:0, padding:"6px 0",
            fontFamily:"var(--mono)", fontSize: small?9.5:10.5,
            lineHeight:1.5, background:"var(--bg-canvas)"}}>
            {h.sample.map(([s,l],j)=>(
              <div key={j} style={{
                padding:"0 9px",
                background: s==="+" ? "color-mix(in oklch, var(--success), transparent 88%)"
                          : s==="-" ? "color-mix(in oklch, var(--danger),  transparent 88%)"
                          : "transparent",
                color: s==="+" ? "var(--success)" : s==="-" ? "var(--danger)" : "var(--fg-muted)",
              }}>
                <span style={{display:"inline-block", width:10, color:"var(--fg-dim)"}}>{s}</span>{l}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ─── Log
function LogView({ small=false }) {
  const cs = [
    { s:"a05", m:"release: v0.5.0 — icon tabs",  who:"lina", t:"3m",  head:true },
    { s:"b05", m:"net: pairing flow",             who:"lina", t:"24m" },
    { s:"d02", m:"docs: store migration",         who:"bot",  t:"1h"  },
    { s:"b04", m:"net: schema.json gen",          who:"alex", t:"3h"  },
    { s:"a04", m:"merge fix/retry-loop",          who:"lina", t:"4h", merge:true },
    { s:"c02", m:"retry: exponential w/ jitter",  who:"alex", t:"6h"  },
    { s:"b03", m:"net: frame v2 encoder",         who:"lina", t:"8h"  },
    { s:"a03", m:"docs: readme overview",         who:"alex", t:"yesterday" },
  ];
  return (
    <div style={{flex:1, minHeight:0, overflow:"auto",
      padding: small?"6px 10px":"10px 14px"}}>
      {cs.map(c=>(
        <div key={c.s} style={{
          display:"grid", gridTemplateColumns:"16px 50px 1fr auto", gap:8,
          padding:"4px 0", alignItems:"baseline",
          fontFamily:"var(--mono)", fontSize: small?10:11,
        }}>
          <span style={{color: c.head?"var(--accent)":c.merge?"var(--info)":"var(--fg-dim)"}}>
            {c.head?"●":c.merge?"◆":"○"}
          </span>
          <span style={{color:"var(--accent)"}}>{c.s}</span>
          <span style={{color:"var(--fg-muted)",
            whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
            {c.m} <span style={{color:"var(--fg-dim)"}}>· @{c.who}</span>
          </span>
          <span style={{color:"var(--fg-dim)", fontSize: small?9:9.5}}>{c.t}</span>
        </div>
      ))}
    </div>
  );
}

// =============================================================
// Sample data
// =============================================================

const REVIEW_TURNS = [
  { role:"user", text:"review the retry loop in crates/ws-server/src/tunnel.rs around line 212" },
  { role:"assistant", blocks:[
    { kind:"thinking", dur:"2s", collapsed:false,
      text:"user wants a focused review. read the file, find the loop, critique with line numbers." },
    { kind:"tool", tool:"Read", args:"crates/ws-server/src/tunnel.rs · L200-260",
      ok:true, summary:"60 lines",
      preview:"L212  loop {\nL213      let delay = base_ms * 2u64.pow(attempts);\nL214      let jitter = rand::random::<f32>();\nL215      tokio::time::sleep(delay).await;\nL216      attempts += 1;\nL217      if let Ok(c) = connect().await { break c; }\nL218  }" },
    { kind:"text", text:"Three things at L212–218:\n\n  1.  base_ms = 100 is too small under a sustained outage. Suggest 500ms or read from config.\n  2.  attempts isn't capped; with current exponent you'd retry past 9 min. Cap at 6.\n  3.  Jitter uses raw rand::random::<f32>(); switch to ±25% of base so it stays bounded.\n\nWant me to draft the patch?" },
  ]},
  { role:"user", text:"yes, please" },
  { role:"assistant", blocks:[
    { kind:"tool", tool:"Write", args:"crates/ws-server/src/tunnel.rs · L212-220",
      ok:true, summary:"+12 −7" },
    { kind:"tool", tool:"Bash", args:"cargo clippy -p ws-server",
      ok:true, summary:"0 warnings" },
    { kind:"text", text:"Patched and clippy is clean. The diff is in the **Changes** tab if you want to eyeball it before I commit." },
  ]},
];

const TREE = [
  { name:"acme/payments", dir:true, open:true, depth:0, path:"_" },
  { name:"crates",         dir:true, open:true, depth:1, path:"crates" },
  { name:"ws-server",      dir:true, open:true, depth:2, path:"crates/ws-server" },
  { name:"src",            dir:true, open:true, depth:3, path:"crates/ws-server/src" },
  { name:"proto.rs",                  depth:4, path:"crates/ws-server/src/proto.rs", status:"M" },
  { name:"frame.rs",                  depth:4, path:"crates/ws-server/src/frame.rs" },
  { name:"tunnel.rs",                 depth:4, path:"crates/ws-server/src/tunnel.rs" },
  { name:"orch",           dir:true,  depth:2, path:"crates/orch" },
  { name:"kb",             dir:true,  depth:2, path:"crates/kb" },
  { name:"gh",             dir:true,  depth:2, path:"crates/gh" },
  { name:"src",            dir:true, open:true, depth:1, path:"src" },
  { name:"App.tsx",                  depth:2, path:"src/App.tsx" },
  { name:"console",        dir:true,  depth:2, path:"src/console" },
  { name:"docs",           dir:true,  depth:1, path:"docs" },
  { name:"automations.md",            depth:2, path:"docs/automations.md", status:"??" },
  { name:"Cargo.toml",                depth:1, path:"Cargo.toml" },
  { name:"README.md",                 depth:1, path:"README.md" },
];

const REPO_CTX_FULL = {
  repo:"acme/payments", branch:"main", dirty:true,
  available:["console","files","branches","changes","log"],
};

// keyframes
if (typeof document !== "undefined" && !document.getElementById("pane-anim")) {
  const s = document.createElement("style");
  s.id = "pane-anim";
  s.textContent = "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}";
  document.head.appendChild(s);
}

Object.assign(window, {
  VIEW_DEFS, MODELS,
  PaneShell, ViewTabs, HamburgerMenu,
  ConsoleView, FilesView, BranchesView, ChangesView, LogView,
  REVIEW_TURNS, TREE, REPO_CTX_FULL,
});
