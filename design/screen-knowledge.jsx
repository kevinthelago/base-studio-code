/* global React, Titlebar, Rail, StatusBar */

const KB_TAGS = [
  { name:"all",          n:142, on:true },
  { name:"architecture", n:18 },
  { name:"decisions",    n:24 },
  { name:"review-policy", n:7,  on:true },
  { name:"agents",       n:21 },
  { name:"tunnel",       n:9  },
  { name:"repro",        n:14 },
  { name:"glossary",     n:6  },
  { name:"runbooks",     n:11 },
  { name:"prompts",      n:32 },
];

const KB_BLOCKS = [
  { id:"blk_9a2c", title:"Review policy — TS / Rust",
    tags:["review-policy","decisions"], updated:"14:02", lines:42, sel:true, scope:"manual" },
  { id:"blk_71fe", title:"Tunnel framing v2",
    tags:["tunnel","architecture"], updated:"yesterday", lines:88, scope:"project" },
  { id:"blk_4ad8", title:"Agent: @reviewer system prompt",
    tags:["agents","prompts"], updated:"2d", lines:64, scope:"global" },
  { id:"blk_2199", title:"Decision · SQLite over LMDB",
    tags:["decisions","architecture"], updated:"3d", lines:31, scope:"project" },
  { id:"blk_aa17", title:"Glossary — console, tab, pane",
    tags:["glossary"], updated:"5d", lines:22, scope:"global" },
  { id:"blk_cd03", title:"Repro pattern — flaky retry loop",
    tags:["repro","runbooks"], updated:"1w", lines:17, scope:"manual" },
  { id:"blk_55fd", title:"Webhook routing table",
    tags:["architecture","decisions"], updated:"1w", lines:54, scope:"manual" },
];

const SCOPE_BADGE = {
  global:  { l:"G",    bg:"var(--accent)",                                       fg:"#1a120a",       title:"pinned globally" },
  project: { l:"P",    bg:"color-mix(in oklch, var(--info), transparent 50%)",   fg:"#1a120a",       title:"pinned for a project" },
  pane:    { l:"·",    bg:"var(--bg-elev2)",                                     fg:"var(--fg-muted)", title:"pinned in a pane" },
  manual:  { l:"",     bg:"transparent",                                         fg:"var(--fg-dim)", title:"not pinned" },
};

function ScopeBadge({ scope }) {
  const s = SCOPE_BADGE[scope] || SCOPE_BADGE.manual;
  if (!s.l) return <span style={{width:18}}/>;
  return (
    <span title={s.title} style={{
      width:18, height:18, borderRadius:4,
      background:s.bg, color:s.fg,
      fontFamily:"var(--mono)", fontSize:10, fontWeight:700,
      display:"inline-flex", alignItems:"center", justifyContent:"center",
      flex:"0 0 18px",
    }}>{s.l}</span>
  );
}

function ScreenKnowledgeStore() {
  return (
    <div className="app">
      <Titlebar workspace="knowledge store"/>
      <div className="shell">
        <Rail active="knowledge"/>
        <div className="main">
          <div style={{flex:1, display:"flex", minHeight:0}}>
            {/* Tag rail */}
            <aside style={{
              width:200, flex:"0 0 200px", background:"var(--bg-panel)",
              borderRight:"1px solid var(--border-soft)", padding:"14px 8px",
              display:"flex", flexDirection:"column", gap:1, overflow:"auto",
            }}>
              <div style={{
                fontFamily:"var(--mono)", fontSize:10, letterSpacing:".08em",
                color:"var(--fg-dim)", padding:"2px 12px 8px",
                display:"flex", justifyContent:"space-between",
              }}>
                <span>TAGS</span>
                <span style={{cursor:"pointer", color:"var(--fg-muted)"}}>+</span>
              </div>
              {KB_TAGS.map(t=>(
                <div key={t.name} style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                  padding:"6px 10px 6px 12px",
                  borderRadius:5, fontSize:11.5,
                  background: t.on ? "var(--bg-elev)" : "transparent",
                  color: t.on ? "var(--fg)" : "var(--fg-muted)",
                  borderLeft: t.on ? "2px solid var(--accent)" : "2px solid transparent",
                  paddingLeft: t.on ? 10 : 12,
                  cursor:"pointer", fontFamily:"var(--mono)",
                }}>
                  <span>#{t.name}</span>
                  <span style={{color:"var(--fg-dim)", fontSize:10.5}}>{t.n}</span>
                </div>
              ))}
              <div style={{height:14}}/>
              <div style={{
                fontFamily:"var(--mono)", fontSize:10, letterSpacing:".08em",
                color:"var(--fg-dim)", padding:"2px 12px 8px",
              }}>SOURCES</div>
              {["manual","agent-authored","github · imported"].map(s=>(
                <div key={s} style={{padding:"6px 12px", fontSize:11.5, fontFamily:"var(--mono)",
                  color:"var(--fg-muted)", cursor:"pointer"}}>{s}</div>
              ))}
            </aside>

            {/* Block list */}
            <aside style={{
              width:280, flex:"0 0 280px", background:"var(--bg-canvas)",
              borderRight:"1px solid var(--border-soft)", display:"flex", flexDirection:"column",
            }}>
              <div style={{padding:"12px 12px 8px", borderBottom:"1px solid var(--border-soft)",
                display:"flex", flexDirection:"column", gap:8}}>
                <input className="input" placeholder="⌕ search blocks…"/>
                <div style={{display:"flex", gap:6, alignItems:"center", justifyContent:"space-between"}}>
                  <span className="hint">7 blocks · #review-policy</span>
                  <select className="input" style={{height:22, width:90, fontSize:10.5}}>
                    <option>updated</option><option>title</option><option>size</option>
                  </select>
                </div>
              </div>
              <div style={{flex:1, overflow:"auto"}}>
                {KB_BLOCKS.map(b=>(
                  <div key={b.id} style={{
                    padding:"11px 12px", borderBottom:"1px solid var(--border-soft)",
                    background: b.sel ? "var(--bg-elev)" : "transparent",
                    borderLeft: b.sel ? "2px solid var(--accent)" : "2px solid transparent",
                    paddingLeft: b.sel ? 10 : 12,
                    cursor:"pointer",
                  }}>
                    <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:4}}>
                      <ScopeBadge scope={b.scope}/>
                      <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{b.id}</span>
                      <span style={{flex:1}}/>
                      <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{b.updated}</span>
                    </div>
                    <div style={{fontSize:12, color: b.sel ? "var(--fg)" : "var(--fg-muted)",
                      marginBottom:5, fontWeight:500}}>{b.title}</div>
                    <div style={{display:"flex", gap:4, flexWrap:"wrap"}}>
                      {b.tags.map(t=>(
                        <span key={t} className={"tag " + (t==="review-policy"?"amber":"")}>#{t}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{padding:10, borderTop:"1px solid var(--border-soft)"}}>
                <button className="btn primary" style={{width:"100%", justifyContent:"center"}}>+ New block</button>
              </div>
            </aside>

            {/* Editor */}
            <section style={{flex:1, display:"flex", flexDirection:"column", minWidth:0}}>
              <header style={{
                padding:"12px 18px", borderBottom:"1px solid var(--border-soft)",
                display:"flex", alignItems:"center", gap:10, background:"var(--bg-panel)",
              }}>
                <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>blk_9a2c</span>
                <input className="input" defaultValue="Review policy — TS / Rust"
                  style={{flex:1, height:30, fontSize:14, fontFamily:"var(--sans)",
                    background:"transparent", border:"1px solid transparent"}}/>
                <span className="tag amber">#review-policy</span>
                <span className="tag">#decisions</span>
                <button className="btn ghost" style={{height:24, fontSize:10.5}}>+ tag</button>
                <div style={{width:1, height:18, background:"var(--border-soft)"}}/>
                <button className="btn ghost" style={{height:24}}>↗ link</button>
                <button className="btn ghost" style={{height:24}}>⎘ embed</button>
                <button className="btn">save</button>
              </header>

              {/* Scope strip */}
              <div style={{
                padding:"10px 18px",
                background:"var(--bg-panel)",
                borderBottom:"1px solid var(--border-soft)",
                display:"flex", alignItems:"center", gap:12, flexWrap:"wrap",
              }}>
                <div style={{display:"flex", alignItems:"center", gap:6,
                  fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-dim)",
                  textTransform:"uppercase", letterSpacing:".06em"}}>
                  <span>scope</span>
                </div>
                {/* Segmented */}
                <div style={{display:"flex", gap:4, padding:3, background:"var(--bg-elev)",
                  borderRadius:6, border:"1px solid var(--border-soft)"}}>
                  {[
                    { k:"manual",  l:"Manual",            on:true,  hint:"only when /pin'd ad-hoc" },
                    { k:"global",  l:"Global",            hint:"auto-pinned to every session" },
                    { k:"project", l:"Project",           hint:"per-project pin" },
                    { k:"pane",    l:"Pane",              hint:"this pane only" },
                  ].map(s=>(
                    <span key={s.k} title={s.hint} style={{
                      padding:"4px 10px", borderRadius:4,
                      background: s.on ? "var(--bg-canvas)" : "transparent",
                      border:"1px solid " + (s.on?"var(--accent-dim)":"transparent"),
                      color: s.on ? "var(--accent)" : "var(--fg-muted)",
                      fontFamily:"var(--mono)", fontSize:10.5, cursor:"pointer",
                    }}>{s.l}</span>
                  ))}
                </div>
                <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)"}}>
                  currently · <b style={{color:"var(--fg)"}}>not pinned</b> — surfaces only when an agent runs <code>/pin blk_9a2c</code>.
                </div>
                <div style={{flex:1}}/>
                <button className="btn ghost" style={{height:24, fontSize:10.5}}>
                  ✦ pin globally
                </button>
                <button className="btn ghost" style={{height:24, fontSize:10.5}}>
                  pin to project…
                </button>
              </div>

              <div style={{flex:1, display:"flex", minHeight:0}}>
                <div style={{flex:1, padding:"18px 22px", overflow:"auto",
                  borderRight:"1px solid var(--border-soft)"}}>
                  <pre style={{margin:0, fontFamily:"var(--mono)", fontSize:12, lineHeight:1.7,
                    color:"var(--fg)", whiteSpace:"pre-wrap"}}>
{`# Review policy — TS / Rust

Applies to: `}<span style={{color:"var(--accent)"}}>{`acme/payments`}</span>{`, `}<span style={{color:"var(--accent)"}}>{`acme/ledger-core`}</span>{`

## Required signals
- `}<span style={{color:"var(--info)"}}>{`cargo clippy --workspace`}</span>{` must pass
- `}<span style={{color:"var(--info)"}}>{`cargo fmt --check`}</span>{` must pass
- New public surface needs a doc-comment
- Migrations require an explicit \`rollback.sql\`

## Tone
- Friendly, terse, no preamble.
- Quote line numbers, never paraphrase code.

## Out of scope
- Style nits beyond rustfmt
- Bumping deps unless asked

> Linked from agent prompt `}<span style={{color:"var(--success)"}}>{`@reviewer`}</span>
}
                  </pre>
                </div>

                <div style={{flex:1, padding:"18px 24px", overflow:"auto", background:"var(--bg-panel)"}}>
                  <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                    textTransform:"uppercase", letterSpacing:".08em", marginBottom:10}}>preview</div>
                  <h1 style={{fontSize:22, margin:"0 0 14px", fontWeight:600,
                    fontFamily:"var(--sans)"}}>Review policy — TS / Rust</h1>
                  <p style={{margin:"0 0 18px", color:"var(--fg-muted)"}}>
                    Applies to: <code style={{fontFamily:"var(--mono)", color:"var(--accent)"}}>acme/payments</code>,{" "}
                    <code style={{fontFamily:"var(--mono)", color:"var(--accent)"}}>acme/ledger-core</code>.
                  </p>
                  <h3 style={{fontSize:14, margin:"0 0 8px"}}>Required signals</h3>
                  <ul style={{margin:"0 0 16px 20px", color:"var(--fg-muted)", fontSize:12, lineHeight:1.7}}>
                    <li><code style={{fontFamily:"var(--mono)"}}>cargo clippy --workspace</code> must pass</li>
                    <li><code style={{fontFamily:"var(--mono)"}}>cargo fmt --check</code> must pass</li>
                    <li>New public surface needs a doc-comment</li>
                    <li>Migrations require an explicit <code>rollback.sql</code></li>
                  </ul>
                  <h3 style={{fontSize:14, margin:"0 0 8px"}}>Tone</h3>
                  <ul style={{margin:"0 0 16px 20px", color:"var(--fg-muted)", fontSize:12, lineHeight:1.7}}>
                    <li>Friendly, terse, no preamble.</li>
                    <li>Quote line numbers, never paraphrase code.</li>
                  </ul>
                  <div style={{marginTop:18, padding:"10px 14px",
                    borderLeft:"2px solid var(--accent-dim)",
                    background:"var(--bg-elev)",
                    fontSize:11, color:"var(--fg-muted)"}}>
                    <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                      marginBottom:4, textTransform:"uppercase", letterSpacing:".06em"}}>backlinks</div>
                    Used by agent <code style={{color:"var(--success)"}}>@reviewer</code>{" "}
                    · 3 other blocks link here.
                  </div>
                </div>
              </div>
            </section>
          </div>
          <StatusBar/>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenKnowledgeStore });
