/* global React, Titlebar, Rail, StatusBar */

// ============================================================
// Empty state — not connected to GitHub
// ============================================================

function ScreenGitHubEmpty() {
  return (
    <div className="app">
      <Titlebar workspace="github"/>
      <div className="shell">
        <Rail active="github"/>
        <div className="main">
          <div className="page" style={{
            flex:1, display:"flex", alignItems:"center", justifyContent:"center",
            background:"var(--bg-canvas)",
          }}>
            <div style={{
              width:480, padding:"36px 36px 32px",
              background:"var(--bg-panel)",
              border:"1px solid var(--border-soft)",
              borderRadius:12,
              textAlign:"center",
            }}>
              <div style={{
                width:54, height:54, margin:"0 auto 18px",
                borderRadius:14,
                background:"var(--bg-elev)",
                border:"1px solid var(--border)",
                display:"flex", alignItems:"center", justifyContent:"center",
                fontFamily:"var(--mono)", fontSize:24, color:"var(--fg)",
              }}>⎇</div>

              <h2 style={{margin:"0 0 8px", fontFamily:"var(--mono)", fontSize:18, fontWeight:600}}>
                Connect your GitHub account
              </h2>
              <p style={{margin:"0 0 24px", color:"var(--fg-muted)", fontSize:13, lineHeight:1.6}}>
                Browse repositories, branches, pull requests, and recent activity right inside
                base-studio. We'll only read what you grant access to.
              </p>

              <button className="btn primary" style={{
                height:38, padding:"0 22px", fontSize:13, fontWeight:600,
                width:"100%", justifyContent:"center", gap:10,
              }}>
                <span style={{fontFamily:"var(--mono)", fontSize:15}}>⎇</span>
                Connect with GitHub
              </button>

              <div style={{margin:"18px 0", display:"flex", alignItems:"center", gap:10,
                fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>
                <span style={{flex:1, height:1, background:"var(--border-soft)"}}/>
                <span>or</span>
                <span style={{flex:1, height:1, background:"var(--border-soft)"}}/>
              </div>

              <button className="btn" style={{
                width:"100%", justifyContent:"center", height:34,
              }}>Paste a personal access token</button>

              <div style={{
                marginTop:22, padding:"12px 14px",
                borderRadius:6, background:"var(--bg-elev)",
                border:"1px solid var(--border-soft)",
                textAlign:"left",
              }}>
                <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                  textTransform:"uppercase", letterSpacing:".06em", marginBottom:6}}>
                  Scopes requested
                </div>
                <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
                  <span className="tag">repo</span>
                  <span className="tag">read:org</span>
                  <span className="tag">read:user</span>
                </div>
                <div style={{marginTop:8, fontSize:11, color:"var(--fg-muted)", lineHeight:1.5}}>
                  Token stored in your OS keyring. Revoke anytime from Settings.
                </div>
              </div>
            </div>
          </div>
          <StatusBar extra={<span className="s" style={{color:"var(--fg-dim)"}}>
            <i className="off"/> github · not connected
          </span>}/>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Branch graph (local copy)
// ============================================================

function BranchGraph() {
  const lanes = [
    { name:"main",                color:"var(--accent)",  y: 36 },
    { name:"feat/tunnel-v2",      color:"var(--info)",    y: 76 },
    { name:"fix/retry-loop",      color:"var(--success)", y:116 },
    { name:"docs/migrate-store",  color:"var(--fg-muted)",y:156 },
  ];
  const C = [
    { lane:0, x:80,  sha:"a01" },
    { lane:0, x:140, sha:"a02" },
    { lane:1, x:200, sha:"b01", from:0 },
    { lane:0, x:230, sha:"a03" },
    { lane:1, x:260, sha:"b02" },
    { lane:2, x:300, sha:"c01", from:0 },
    { lane:1, x:330, sha:"b03" },
    { lane:2, x:360, sha:"c02" },
    { lane:0, x:400, sha:"a04", merge:2 },
    { lane:1, x:430, sha:"b04" },
    { lane:3, x:470, sha:"d01", from:0 },
    { lane:1, x:500, sha:"b05", current:true },
    { lane:3, x:540, sha:"d02" },
    { lane:0, x:600, sha:"a05", head:true },
  ];
  return (
    <div className="card" style={{padding:"14px 16px 12px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:6}}>
        <h3 style={{margin:0}}>Branch graph</h3>
        <span className="hint">last 14 days · main + 3 active branches</span>
        <div style={{flex:1}}/>
        <select className="input" style={{height:24, width:130, fontSize:10.5}}>
          <option>all branches</option><option>open PRs only</option><option>mine</option>
        </select>
      </div>
      <div style={{overflow:"auto"}}>
        <svg width="680" height="200" style={{display:"block"}}>
          {lanes.map((l,i)=>(
            <g key={l.name}>
              <line x1={56} y1={l.y} x2={650} y2={l.y}
                stroke="var(--border-soft)" strokeWidth="1" strokeDasharray="2 4"/>
              <text x={50} y={l.y+4} textAnchor="end"
                fontFamily="var(--mono)" fontSize="10" fill="var(--fg-muted)">{l.name}</text>
              <circle cx={648} cy={l.y} r="3" fill={l.color}/>
            </g>
          ))}
          {C.filter(c=>c.from!==undefined).map(c=>(
            <path key={"f"+c.sha}
              d={`M ${c.x-30} ${lanes[c.from].y} Q ${c.x-10} ${lanes[c.from].y} ${c.x} ${lanes[c.lane].y}`}
              fill="none" stroke={lanes[c.lane].color} strokeWidth="1.5" opacity=".7"/>
          ))}
          {C.filter(c=>c.merge!==undefined).map(c=>(
            <path key={"m"+c.sha}
              d={`M ${c.x-30} ${lanes[c.merge].y} Q ${c.x-10} ${lanes[c.lane].y} ${c.x} ${lanes[c.lane].y}`}
              fill="none" stroke={lanes[c.merge].color} strokeWidth="1.5" opacity=".7"/>
          ))}
          {lanes.map((l,i)=>{
            const xs = C.filter(c=>c.lane===i).map(c=>c.x).sort((a,b)=>a-b);
            return xs.slice(0,-1).map((x,j)=>(
              <line key={`l${i}-${j}`} x1={x} y1={l.y} x2={xs[j+1]} y2={l.y}
                stroke={l.color} strokeWidth="1.5"/>
            ));
          })}
          {C.map(c=>{
            const y = lanes[c.lane].y;
            return (
              <g key={c.sha}>
                <circle cx={c.x} cy={y} r={c.head?6:c.current?5:4}
                  fill={c.head ? "var(--accent)"
                       : c.current ? "var(--bg-canvas)"
                       : lanes[c.lane].color}
                  stroke={c.current ? "var(--accent)" : "transparent"}
                  strokeWidth={c.current?2:0}/>
                {c.head && (
                  <rect x={c.x-12} y={y-22} width="28" height="14" rx="2"
                    fill="var(--accent)" opacity=".9"/>
                )}
                {c.head && (
                  <text x={c.x+2} y={y-12} textAnchor="middle"
                    fontFamily="var(--mono)" fontSize="9" fill="#1a120a" fontWeight="700">HEAD</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{display:"flex", gap:14, marginTop:8, flexWrap:"wrap"}}>
        {lanes.map(l=>(
          <span key={l.name} style={{display:"inline-flex", gap:6, alignItems:"center",
            fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)"}}>
            <span style={{width:10, height:2, background:l.color, borderRadius:1}}/>
            {l.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// File heatmap (local copy)
// ============================================================

function FileHeatmap() {
  const files = [
    { p:"crates/ws-server/src/proto.rs",  w:42 },
    { p:"crates/ws-server/src/frame.rs",  w:28 },
    { p:"crates/orch/src/agent.rs",       w:34 },
    { p:"crates/orch/src/tools/mod.rs",   w:18 },
    { p:"crates/orch/src/stream.rs",      w:12 },
    { p:"crates/kb/src/store.rs",         w:22 },
    { p:"crates/kb/src/fts.rs",           w:9  },
    { p:"crates/kb/src/embed.rs",         w:14 },
    { p:"crates/ui-bridge/src/main.rs",   w:6  },
    { p:"crates/gh/src/webhook.rs",       w:25 },
    { p:"crates/gh/src/oauth.rs",         w:4  },
    { p:"src/App.tsx",                    w:31 },
    { p:"src/console/Grid.tsx",           w:24 },
    { p:"src/console/Pane.tsx",           w:19 },
    { p:"src/settings/GitHub.tsx",        w:8  },
    { p:"docs/protocol.md",               w:7  },
    { p:"schema.json",                    w:13 },
  ];
  const maxW = Math.max(...files.map(f=>f.w));
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Churn heatmap</h3>
        <span className="hint">lines changed in last 14 days · darker = hotter</span>
        <div style={{flex:1}}/>
        <select className="input" style={{height:24, width:120, fontSize:10.5}}>
          <option>14 days</option><option>7 days</option><option>30 days</option>
        </select>
      </div>
      <div style={{display:"grid", gridTemplateColumns:"repeat(6, 1fr)", gap:4}}>
        {files.map(f=>{
          const t = f.w / maxW;
          const a = 0.18 + 0.72 * t;
          return (
            <div key={f.p} title={`${f.p} · ±${f.w} lines`} style={{
              padding:"8px 9px", borderRadius:4, minHeight:54,
              background:`color-mix(in oklch, var(--accent) ${Math.round(a*100)}%, var(--bg-elev))`,
              border:"1px solid var(--border-soft)",
              color: t>0.55 ? "#1a120a" : "var(--fg-muted)",
              fontFamily:"var(--mono)", fontSize:10, lineHeight:1.35,
              display:"flex", flexDirection:"column", justifyContent:"space-between",
              overflow:"hidden",
            }}>
              <span style={{display:"block",
                whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
                color: t>0.55 ? "#1a120a" : "var(--fg)"}}>{f.p.split("/").pop()}</span>
              <span style={{fontSize:9, opacity:.75}}>{f.p.replace(/\/[^/]+$/,"")}</span>
              <span style={{fontSize:9.5, fontWeight:600}}>±{f.w}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Connected — shared shell with page-level tabs
// ============================================================

function PageTabs({ active }) {
  const tabs = [
    { k:"overview", label:"Overview", hint:"branches · commits · PRs" },
    { k:"actions",  label:"Actions",  hint:"workflow files & recent runs" },
    { k:"hooks",    label:"Hooks",    hint:"pre-commit · pre-push · etc." },
  ];
  return (
    <div style={{
      height:36, flex:"0 0 36px",
      borderBottom:"1px solid var(--border-soft)",
      background:"var(--bg-panel)",
      padding:"0 22px",
      display:"flex", alignItems:"end", gap:2,
    }}>
      {tabs.map(t=>{
        const on = t.k===active;
        return (
          <div key={t.k} style={{
            padding:"0 14px", height:30,
            display:"flex", alignItems:"center", gap:8,
            borderTopLeftRadius:6, borderTopRightRadius:6,
            background: on ? "var(--bg-canvas)" : "transparent",
            border:"1px solid " + (on?"var(--border-soft)":"transparent"),
            borderBottom: "0",
            color: on ? "var(--fg)" : "var(--fg-muted)",
            fontFamily:"var(--mono)", fontSize:11.5,
            cursor:"pointer",
          }}>
            {t.label}
            {on && <span style={{color:"var(--fg-dim)", fontSize:10}}>· {t.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}

function GitHubShell({ tab, children }) {
  const repos = [
    { n:"acme/payments",     lang:"rust", on:true, pr:5 },
    { n:"acme/ledger-core",  lang:"rust", pr:2 },
    { n:"acme/web",          lang:"ts",   pr:8 },
    { n:"acme/docs",         lang:"md",   pr:1 },
  ];
  return (
    <div className="app">
      <Titlebar workspace="github · acme/payments"/>
      <div className="shell">
        <Rail active="github"/>
        <div className="main">
          <div style={{flex:1, display:"flex", minHeight:0}}>
            {/* Repo sidebar */}
            <aside style={{
              width:220, flex:"0 0 220px", background:"var(--bg-panel)",
              borderRight:"1px solid var(--border-soft)", padding:"14px 8px",
              display:"flex", flexDirection:"column", gap:2, overflow:"auto",
            }}>
              <div style={{
                fontFamily:"var(--mono)", fontSize:10, letterSpacing:".08em",
                color:"var(--fg-dim)", padding:"2px 12px 8px",
                display:"flex", justifyContent:"space-between",
              }}>
                <span>REPOS</span>
                <span style={{color:"var(--fg-muted)", cursor:"pointer"}}>+ add</span>
              </div>
              {repos.map(r=>(
                <div key={r.n} style={{
                  padding:"8px 10px 8px 12px", borderRadius:5,
                  background: r.on ? "var(--bg-elev)" : "transparent",
                  borderLeft: r.on ? "2px solid var(--accent)" : "2px solid transparent",
                  paddingLeft: r.on ? 10 : 12, cursor:"pointer",
                }}>
                  <div style={{display:"flex", alignItems:"baseline", gap:6}}>
                    <span style={{fontFamily:"var(--mono)", fontSize:11.5,
                      color: r.on ? "var(--fg)" : "var(--fg-muted)"}}>{r.n}</span>
                    <span style={{flex:1}}/>
                    <span className="tag" style={{fontSize:9.5}}>{r.lang}</span>
                  </div>
                  <div style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)", marginTop:4}}>
                    ⊕ {r.pr} PR
                  </div>
                </div>
              ))}
            </aside>

            <div style={{flex:1, display:"flex", flexDirection:"column", minWidth:0}}>
              {/* Repo header */}
              <div style={{
                padding:"14px 22px 0",
                display:"flex", alignItems:"flex-start", gap:14,
              }}>
                <div style={{flex:1}}>
                  <div style={{display:"flex", alignItems:"baseline", gap:10}}>
                    <h2 style={{margin:0, fontFamily:"var(--mono)", fontSize:18, fontWeight:600}}>
                      acme/payments
                    </h2>
                    <span className="tag amber">● synced 12s ago</span>
                    <span className="tag">private</span>
                    <span className="tag">rust</span>
                  </div>
                  <div style={{color:"var(--fg-muted)", fontSize:12, marginTop:4}}>
                    Stripe + Tipalti adapters, ledger glue, settlement workers.
                  </div>
                </div>
                <div style={{display:"flex", alignItems:"center", gap:8}}>
                  <select className="input" defaultValue="main" style={{width:160}}>
                    <option>main</option><option>feat/tunnel-v2</option>
                    <option>fix/retry-loop</option><option>docs/migrate-store</option>
                  </select>
                  <button className="btn">↻ fetch</button>
                  <button className="btn ghost">open on github →</button>
                </div>
              </div>

              <div style={{height:14}}/>
              <PageTabs active={tab}/>
              <section style={{flex:1, overflow:"auto", padding:"18px 22px", minWidth:0}}>
                {children}
              </section>
            </div>
          </div>
          <StatusBar/>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Overview body
// ============================================================
function OverviewBody() {
  const prs = [
    { n:"#418", t:"net: framing v2 + schema regen", who:"lina", st:"review",   age:"2h",  ci:"ok"  },
    { n:"#416", t:"orch: tool dispatch refactor",   who:"alex", st:"changes",  age:"yesterday", ci:"fail" },
    { n:"#414", t:"kb: backlinks + FTS5",           who:"lina", st:"approved", age:"2d",  ci:"ok"  },
    { n:"#411", t:"docs: store migration",          who:"bot",  st:"draft",    age:"3d",  ci:"ok"  },
    { n:"#406", t:"chore: bump anthropic-sdk 0.9",  who:"alex", st:"review",   age:"1w",  ci:"ok"  },
  ];
  const commits = [
    { s:"a05", m:"release: v0.5.0",         who:"lina", t:"3m"  },
    { s:"b05", m:"net: pairing flow",       who:"lina", t:"24m" },
    { s:"d02", m:"docs: store migration",   who:"bot",  t:"1h"  },
    { s:"b04", m:"net: schema.json gen",    who:"alex", t:"3h"  },
    { s:"a04", m:"merge fix/retry-loop",    who:"lina", t:"4h"  },
    { s:"c02", m:"retry: exponential w/jitter",who:"alex",t:"6h"},
  ];

  return (
    <>
      <div style={{display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:8, marginBottom:14}}>
        {[
          ["open PRs",      "5",       "2 awaiting review", "accent"],
          ["branches",      "11",      "3 active this week","info"],
          ["contributors",  "7",       "+ 2 bots",          "muted"],
          ["ahead / behind","12 / 0",  "vs origin/main",    "success"],
        ].map(([k,v,sub,tone])=>(
          <div key={k} className="card" style={{padding:"10px 14px"}}>
            <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
              textTransform:"uppercase", letterSpacing:".06em"}}>{k}</div>
            <div style={{fontFamily:"var(--mono)", fontSize:18, fontWeight:600,
              color: tone==="accent"?"var(--accent)":"var(--fg)", marginTop:2}}>{v}</div>
            <div style={{fontSize:10.5, color:"var(--fg-muted)", marginTop:1}}>{sub}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid", gridTemplateColumns:"1.7fr 1fr", gap:14}}>
        <div style={{display:"flex", flexDirection:"column", gap:14}}>
          <BranchGraph/>
          <FileHeatmap/>
        </div>

        <div style={{display:"flex", flexDirection:"column", gap:14}}>
          <div className="card" style={{padding:"14px 16px"}}>
            <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
              <h3 style={{margin:0}}>Open PRs</h3>
              <span className="hint">5 open</span>
              <div style={{flex:1}}/>
              <button className="btn ghost" style={{height:24, fontSize:10.5}}>view all</button>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:1,
              borderRadius:6, border:"1px solid var(--border-soft)", overflow:"hidden"}}>
              {prs.map((p,i)=>(
                <div key={p.n} style={{
                  padding:"10px 12px",
                  background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
                  display:"grid", gridTemplateColumns:"40px 1fr 60px",
                  gap:8, alignItems:"baseline", fontSize:11,
                }}>
                  <span style={{fontFamily:"var(--mono)", color:"var(--fg-dim)"}}>{p.n}</span>
                  <div>
                    <div style={{color:"var(--fg)"}}>{p.t}</div>
                    <div style={{marginTop:3, display:"flex", gap:6, fontFamily:"var(--mono)",
                      fontSize:10, color:"var(--fg-dim)"}}>
                      <span>@{p.who}</span>
                      <span className={"tag " + (p.st==="approved"?"green":p.st==="changes"?"":"amber")}
                        style={{fontSize:9.5}}>{p.st}</span>
                      <span className={"tag " + (p.ci==="ok"?"green":"")}
                        style={{fontSize:9.5,
                          color:p.ci==="ok"?"var(--success)":"var(--danger)"}}>ci {p.ci}</span>
                    </div>
                  </div>
                  <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                    textAlign:"right"}}>{p.age}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{padding:"14px 16px"}}>
            <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
              <h3 style={{margin:0}}>Recent commits</h3>
              <span className="hint">main · last 24h</span>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:8}}>
              {commits.map(c=>(
                <div key={c.s} style={{display:"grid",
                  gridTemplateColumns:"40px 1fr 60px", gap:8,
                  alignItems:"baseline", fontSize:11}}>
                  <span style={{fontFamily:"var(--mono)", color:"var(--accent)"}}>{c.s}</span>
                  <span style={{color:"var(--fg-muted)"}}>{c.m}
                    <span style={{color:"var(--fg-dim)"}}> · @{c.who}</span>
                  </span>
                  <span style={{fontFamily:"var(--mono)", fontSize:10,
                    color:"var(--fg-dim)", textAlign:"right"}}>{c.t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// Actions body — GitHub Actions workflows editor
// ============================================================

function ActionsBody() {
  const workflows = [
    { f:"ci.yml",         on:true,  st:"passing", lastRun:"a05 · 4m",
      triggers:["push","PR"], sel:true },
    { f:"clippy.yml",     on:true,  st:"failing", lastRun:"b04 · 2h",
      triggers:["push"] },
    { f:"release.yml",    on:true,  st:"passing", lastRun:"a02 · 2d",
      triggers:["tag v*"] },
    { f:"docs.yml",       on:true,  st:"queued",  lastRun:"d02 · 1m",
      triggers:["push docs/**"] },
    { f:"nightly.yml",    on:false, st:"disabled",lastRun:"—",
      triggers:["cron 0 2 * * *"] },
  ];
  const runs = [
    { id:"#9128", sha:"a05", st:"passing", who:"lina", t:"4m",  dur:"2m 14s",
      job:"test+clippy+build" },
    { id:"#9127", sha:"b05", st:"passing", who:"lina", t:"24m", dur:"2m 22s", job:"test+clippy" },
    { id:"#9126", sha:"d02", st:"queued",  who:"bot",  t:"1m",  dur:"—",       job:"queued" },
    { id:"#9125", sha:"b04", st:"failing", who:"alex", t:"2h",  dur:"1m 02s",  job:"clippy", err:"unused_import" },
    { id:"#9124", sha:"a04", st:"passing", who:"lina", t:"4h",  dur:"2m 09s",  job:"test+clippy+build" },
  ];
  return (
    <>
      <div style={{display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:8, marginBottom:14}}>
        {[
          ["workflows",   "5",       "4 enabled",          "fg"],
          ["last run",    "4m ago",  "passing",            "success"],
          ["this week",   "47",      "42 ✓ · 4 ✗ · 1 ◑",  "accent"],
          ["queued",      "1",       "docs.yml",           "info"],
        ].map(([k,v,sub,tone])=>(
          <div key={k} className="card" style={{padding:"10px 14px"}}>
            <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
              textTransform:"uppercase", letterSpacing:".06em"}}>{k}</div>
            <div style={{fontFamily:"var(--mono)", fontSize:18, fontWeight:600,
              color: tone==="success"?"var(--success)":tone==="accent"?"var(--accent)":tone==="info"?"var(--info)":"var(--fg)",
              marginTop:2}}>{v}</div>
            <div style={{fontSize:10.5, color:"var(--fg-muted)", marginTop:1}}>{sub}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid", gridTemplateColumns:"260px 1fr", gap:14}}>
        {/* Workflow list */}
        <div className="card" style={{padding:0, display:"flex", flexDirection:"column"}}>
          <div style={{padding:"12px 14px 8px", borderBottom:"1px solid var(--border-soft)"}}>
            <div style={{display:"flex", alignItems:"baseline", gap:8}}>
              <h3 style={{margin:0}}>Workflows</h3>
              <span className="hint">.github/workflows/</span>
            </div>
            <input className="input" placeholder="filter…" style={{marginTop:8, height:24, fontSize:10.5}}/>
          </div>
          <div style={{flex:1}}>
            {workflows.map(w=>(
              <div key={w.f} style={{
                padding:"10px 14px",
                borderBottom:"1px solid var(--border-soft)",
                background: w.sel ? "var(--bg-elev)" : "transparent",
                borderLeft: w.sel ? "2px solid var(--accent)" : "2px solid transparent",
                paddingLeft: w.sel ? 12 : 14,
                cursor:"pointer",
              }}>
                <div style={{display:"flex", alignItems:"center", gap:8}}>
                  <span style={{
                    width:7, height:7, borderRadius:"50%",
                    background: w.st==="passing" ? "var(--success)"
                      : w.st==="failing" ? "var(--danger)"
                      : w.st==="queued" ? "var(--accent)"
                      : "var(--fg-dim)",
                  }}/>
                  <span style={{fontFamily:"var(--mono)", fontSize:11.5,
                    color: w.sel?"var(--fg)":"var(--fg-muted)"}}>{w.f}</span>
                  <span style={{flex:1}}/>
                  {!w.on && <span className="tag" style={{fontSize:9.5}}>off</span>}
                </div>
                <div style={{display:"flex", gap:5, marginTop:5, flexWrap:"wrap"}}>
                  {w.triggers.map(t=>(<span key={t} className="tag" style={{fontSize:9.5}}>{t}</span>))}
                  <span style={{flex:1}}/>
                  <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>{w.lastRun}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{padding:10, borderTop:"1px solid var(--border-soft)"}}>
            <button className="btn primary" style={{width:"100%", justifyContent:"center"}}>+ New workflow</button>
          </div>
        </div>

        {/* Editor + runs */}
        <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>
          {/* Editor */}
          <div className="card" style={{padding:0, display:"flex", flexDirection:"column"}}>
            <div style={{padding:"12px 16px", borderBottom:"1px solid var(--border-soft)",
              display:"flex", alignItems:"center", gap:10}}>
              <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>
                .github/workflows/
              </span>
              <span style={{fontFamily:"var(--mono)", fontSize:13, color:"var(--fg)"}}>ci.yml</span>
              <span className="tag green">● passing</span>
              <span className="hint">edited by you · 4m ago</span>
              <div style={{flex:1}}/>
              <div style={{display:"flex", gap:4, padding:2, background:"var(--bg-elev)",
                borderRadius:5, border:"1px solid var(--border-soft)"}}>
                <button className="btn" style={{height:22, padding:"0 10px", fontSize:10.5,
                  background:"var(--bg-elev2)", borderColor:"var(--accent-dim)", color:"var(--accent)"}}>structured</button>
                <button className="btn ghost" style={{height:22, padding:"0 10px", fontSize:10.5}}>raw yaml</button>
              </div>
              <button className="btn ghost" style={{height:24}}>↺ rerun</button>
              <button className="btn">commit & push</button>
            </div>

            {/* Structured editor */}
            <div style={{padding:"14px 16px", display:"flex", flexDirection:"column", gap:14}}>
              {/* on: triggers */}
              <Section2 label="on">
                <RowEditable on icon="↑" t="push"          v="branches: main, feat/**"/>
                <RowEditable on icon="⇄" t="pull_request"  v="any branch · paths-ignore: docs/**"/>
                <RowEditable    icon="⏱" t="schedule"      v="not set" placeholder/>
                <RowEditable    icon="·" t="workflow_dispatch" v="not set" placeholder/>
              </Section2>

              {/* env */}
              <Section2 label="env">
                <KV k="RUST_VERSION"      v="1.78"/>
                <KV k="CARGO_TERM_COLOR"  v="always"/>
                <KV k="RUSTFLAGS"         v="-D warnings"/>
              </Section2>

              {/* jobs */}
              <Section2 label="jobs · 3">
                <JobRow name="test"   runs="ubuntu-latest" steps="checkout · setup-rust · cargo test · upload-artifact" dur="2m 14s" st="passing"/>
                <JobRow name="clippy" runs="ubuntu-latest" steps="checkout · setup-rust · cargo clippy --workspace"     dur="1m 02s" st="failing"/>
                <JobRow name="build"  runs="ubuntu-latest" steps="checkout · setup-rust · cargo build --release"        dur="4m 33s" st="passing"/>
              </Section2>
            </div>
          </div>

          {/* Recent runs */}
          <div className="card" style={{padding:"14px 16px"}}>
            <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
              <h3 style={{margin:0}}>Recent runs · ci.yml</h3>
              <span className="hint">last 5</span>
              <div style={{flex:1}}/>
              <button className="btn ghost" style={{height:24, fontSize:10.5}}>view all on github →</button>
            </div>
            <div style={{borderRadius:6, border:"1px solid var(--border-soft)", overflow:"hidden"}}>
              {runs.map((r,i)=>(
                <div key={r.id} style={{
                  display:"grid", gridTemplateColumns:"70px 60px 80px 1fr 90px 60px",
                  gap:12, padding:"9px 14px",
                  alignItems:"baseline", fontSize:11,
                  background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
                  borderTop: i===0?"0":"1px solid var(--border-soft)",
                }}>
                  <span style={{fontFamily:"var(--mono)", color:"var(--fg-dim)"}}>{r.id}</span>
                  <span style={{fontFamily:"var(--mono)", color:"var(--accent)"}}>{r.sha}</span>
                  <span style={{fontFamily:"var(--mono)", fontSize:10.5,
                    color: r.st==="passing" ? "var(--success)"
                         : r.st==="failing" ? "var(--danger)"
                         : "var(--accent)"}}>
                    {r.st==="passing"?"✓":r.st==="failing"?"✗":"◑"} {r.st}
                  </span>
                  <span style={{color:"var(--fg-muted)", fontFamily:"var(--mono)", fontSize:10.5,
                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                    {r.job}{r.err && <span style={{color:"var(--danger)"}}> · {r.err}</span>}
                  </span>
                  <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-dim)"}}>
                    @{r.who} · {r.t}
                  </span>
                  <span style={{fontFamily:"var(--mono)", fontSize:10.5,
                    color:"var(--fg-muted)", textAlign:"right"}}>{r.dur}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// Section header + body wrapper for the structured editor
function Section2({ label, children }) {
  return (
    <div>
      <div style={{
        display:"flex", alignItems:"baseline", gap:8, marginBottom:6,
        fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)",
        textTransform:"uppercase", letterSpacing:".08em",
      }}>
        <span>{label}</span>
        <span style={{flex:1, height:1, background:"var(--border-soft)"}}/>
        <span style={{color:"var(--fg-dim)", cursor:"pointer", textTransform:"none", letterSpacing:0}}>+ add</span>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:6}}>{children}</div>
    </div>
  );
}
function RowEditable({ icon, t, v, on, placeholder }) {
  return (
    <div style={{
      display:"grid", gridTemplateColumns:"22px 130px 1fr 22px",
      gap:10, alignItems:"center",
      padding:"6px 10px", borderRadius:5,
      background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
      fontFamily:"var(--mono)", fontSize:11,
    }}>
      <span style={{color: on?"var(--accent)":"var(--fg-dim)"}}>{icon}</span>
      <span style={{color: on?"var(--fg)":"var(--fg-muted)"}}>{t}</span>
      <span style={{color: placeholder?"var(--fg-dim)":"var(--fg-muted)",
        whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
        fontStyle: placeholder?"italic":"normal"}}>{v}</span>
      <span style={{color:"var(--fg-dim)", textAlign:"right", cursor:"pointer"}}>⋯</span>
    </div>
  );
}
function KV({ k, v }) {
  return (
    <div style={{
      display:"grid", gridTemplateColumns:"180px 1fr",
      gap:10, alignItems:"center",
      padding:"5px 10px", borderRadius:5,
      background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
      fontFamily:"var(--mono)", fontSize:11,
    }}>
      <span style={{color:"var(--info)"}}>{k}</span>
      <span style={{color:"var(--fg)"}}>{v}</span>
    </div>
  );
}
function JobRow({ name, runs, steps, dur, st }) {
  return (
    <div style={{
      padding:"8px 12px", borderRadius:6,
      background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
      display:"flex", flexDirection:"column", gap:5,
    }}>
      <div style={{display:"flex", alignItems:"center", gap:8}}>
        <span style={{
          width:7, height:7, borderRadius:"50%",
          background: st==="passing"?"var(--success)":st==="failing"?"var(--danger)":"var(--accent)",
        }}/>
        <span style={{fontFamily:"var(--mono)", fontSize:12, color:"var(--accent)"}}>{name}</span>
        <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>runs-on: {runs}</span>
        <span style={{flex:1}}/>
        <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)"}}>{dur}</span>
      </div>
      <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)", paddingLeft:15}}>
        {steps}
      </div>
    </div>
  );
}

// ============================================================
// Hooks body — git hooks (.githooks/ shared + .git/hooks/ local)
// ============================================================

function HooksBody() {
  const hooks = [
    { n:"pre-commit",  on:true,  scope:"shared",
      desc:"Runs before each commit; non-zero exit blocks it.",
      cmds:["cargo fmt --check", "cargo clippy --quiet", "tools/check-blocked-paths.sh"] },
    { n:"pre-push",    on:true,  scope:"shared",
      desc:"Runs before push to remote.",
      cmds:["cargo test --workspace --quiet"] },
    { n:"commit-msg",  on:true,  scope:"shared",
      desc:"Lints the message; enforces Conventional Commits.",
      cmds:["tools/commit-lint.sh \"$1\""] },
    { n:"post-merge",  on:false, scope:"shared",
      desc:"Runs after a successful merge.",
      cmds:[] },
    { n:"post-checkout", on:true, scope:"local",
      desc:"Runs after checkout / branch switch. Local-only.",
      cmds:["base-studio rescan-repo --pane=@reviewer"] },
    { n:"prepare-commit-msg", on:false, scope:"shared",
      desc:"Pre-fills the commit message template.",
      cmds:[] },
  ];

  return (
    <>
      {/* Top — where hooks live */}
      <div className="card" style={{padding:"14px 18px", marginBottom:14}}>
        <div style={{display:"flex", alignItems:"baseline", gap:14}}>
          <h3 style={{margin:0}}>Git hooks</h3>
          <span className="hint">
            Tracked in <code style={{fontFamily:"var(--mono)", color:"var(--fg)"}}>.githooks/</code> and
            installed via <code style={{fontFamily:"var(--mono)", color:"var(--fg)"}}>core.hooksPath</code> — your team gets them automatically.
          </span>
          <div style={{flex:1}}/>
          <label style={{display:"flex", alignItems:"center", gap:8, fontFamily:"var(--mono)", fontSize:11}}>
            <span style={{
              width:30, height:18, borderRadius:99, background:"var(--accent)", position:"relative",
            }}>
              <span style={{position:"absolute", top:2, right:2, width:14, height:14,
                background:"#1a120a", borderRadius:"50%"}}/>
            </span>
            installed
          </label>
        </div>
        <div style={{display:"flex", gap:14, marginTop:10, fontFamily:"var(--mono)", fontSize:10.5,
          color:"var(--fg-muted)"}}>
          <span>core.hooksPath = <span style={{color:"var(--accent)"}}>.githooks/</span></span>
          <span>·</span>
          <span>6 hooks · 4 active</span>
          <span>·</span>
          <span>shared with all collaborators on commit</span>
        </div>
      </div>

      {/* Hook cards */}
      <div style={{display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:12}}>
        {hooks.map(h=>(
          <div key={h.n} className="card" style={{padding:"14px 16px"}}>
            <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:6}}>
              <span style={{
                width:7, height:7, borderRadius:"50%",
                background: h.on ? "var(--success)" : "var(--fg-dim)",
              }}/>
              <h3 style={{margin:0, fontFamily:"var(--mono)", fontSize:13}}>{h.n}</h3>
              <span className={"tag " + (h.scope==="shared" ? "amber" : "")} style={{fontSize:9.5}}>
                {h.scope}
              </span>
              <div style={{flex:1}}/>
              <button className="btn ghost" style={{height:22, padding:"0 8px", fontSize:10}}>edit</button>
              <label style={{display:"flex", alignItems:"center"}}>
                <span style={{
                  width:24, height:14, borderRadius:99,
                  background: h.on ? "var(--accent)" : "var(--bg-elev2)",
                  border:"1px solid " + (h.on?"transparent":"var(--border)"),
                  position:"relative",
                }}>
                  <span style={{position:"absolute", top:1, [h.on?"right":"left"]:1,
                    width:10, height:10, borderRadius:"50%",
                    background: h.on ? "#1a120a" : "var(--fg-dim)"}}/>
                </span>
              </label>
            </div>
            <div style={{fontSize:11, color:"var(--fg-muted)", marginBottom:10, lineHeight:1.5}}>{h.desc}</div>
            {h.cmds.length > 0 ? (
              <pre style={{
                margin:0, padding:"8px 10px",
                background:"var(--bg-canvas)",
                border:"1px solid var(--border-soft)", borderRadius:5,
                fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)",
                lineHeight:1.55, whiteSpace:"pre-wrap",
              }}>{h.cmds.map((c,i)=>(
                <span key={i}><span style={{color:"var(--accent)"}}>$</span> {c}{i<h.cmds.length-1?"\n":""}</span>
              ))}</pre>
            ) : (
              <div style={{
                padding:"8px 10px",
                border:"1px dashed var(--border)", borderRadius:5,
                fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-dim)",
                textAlign:"center",
              }}>(no script) — + add command</div>
            )}
          </div>
        ))}
      </div>

      <div style={{
        marginTop:14, padding:"12px 16px",
        border:"1px dashed var(--border)", borderRadius:8,
        display:"flex", gap:14, alignItems:"center",
        fontFamily:"var(--mono)", fontSize:11, color:"var(--fg-muted)",
      }}>
        <span style={{color:"var(--accent)"}}>tip</span>
        <span>
          Edits to shared hooks land in <code style={{color:"var(--fg)"}}>.githooks/</code> and ship in your next commit.
          Local hooks live in <code style={{color:"var(--fg)"}}>.git/hooks/</code> and stay on your machine only.
        </span>
        <div style={{flex:1}}/>
        <button className="btn">+ new hook</button>
      </div>
    </>
  );
}

// ============================================================
// Screen wrappers
// ============================================================

function ScreenGitHubOverview() { return <GitHubShell tab="overview"><OverviewBody/></GitHubShell>; }
function ScreenGitHubActions()  { return <GitHubShell tab="actions"><ActionsBody/></GitHubShell>;   }
function ScreenGitHubHooks()    { return <GitHubShell tab="hooks"><HooksBody/></GitHubShell>;       }

Object.assign(window, {
  ScreenGitHubEmpty,
  ScreenGitHubOverview, ScreenGitHubActions, ScreenGitHubHooks,
  GitHubShell,
});

