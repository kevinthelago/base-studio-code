/* global React, Titlebar, Rail, StatusBar, Tabstrip,
   PaneShell, ConsoleView, FilesView, BranchesView, ChangesView, LogView,
   REVIEW_TURNS, TREE,
   ProjectsHeader, CURRENT_PROJECT */

// ============================================================
// Shared scope-hierarchy strip — used in many places
// ============================================================

function ScopeHierarchy({ active, badges={} }) {
  const levels = [
    { k:"global",  l:"Global",   icon:"⟁", from:"Settings · Claude" },
    { k:"project", l:"Project",  icon:"P", from:"Settlement webhooks v2" },
    { k:"console", l:"Console",  icon:"⌘", from:"orchestrator" },
    { k:"pane",    l:"Pane",     icon:"▸", from:"@reviewer" },
  ];
  return (
    <div style={{
      display:"flex", alignItems:"stretch",
      background:"var(--bg-canvas)",
      border:"1px solid var(--border-soft)",
      borderRadius:6, overflow:"hidden",
    }}>
      {levels.map((lv,i)=>{
        const on = lv.k===active;
        return (
          <React.Fragment key={lv.k}>
            <div style={{
              flex:1, padding:"8px 10px",
              background: on ? "color-mix(in oklch, var(--accent), transparent 90%)" : "transparent",
              borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent",
              display:"flex", flexDirection:"column", gap:2,
            }}>
              <div style={{display:"flex", alignItems:"center", gap:6}}>
                <span style={{
                  width:16, height:16, borderRadius:4,
                  background: on?"var(--accent)":"var(--bg-elev2)",
                  color: on?"#1a120a":"var(--fg-muted)",
                  fontFamily:"var(--mono)", fontSize:9.5, fontWeight:700,
                  display:"flex", alignItems:"center", justifyContent:"center",
                }}>{lv.icon}</span>
                <span style={{fontFamily:"var(--mono)", fontSize:10.5,
                  color: on?"var(--accent)":"var(--fg-muted)"}}>{lv.l}</span>
                {badges[lv.k]!=null && (
                  <span style={{
                    padding:"0 5px", borderRadius:3,
                    fontFamily:"var(--mono)", fontSize:9, color:"var(--fg-muted)",
                    background:"var(--bg-elev2)",
                  }}>{badges[lv.k]}</span>
                )}
              </div>
              <div style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)",
                whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{lv.from}</div>
            </div>
            {i<levels.length-1 && (
              <div style={{display:"flex", alignItems:"center", padding:"0 6px",
                color:"var(--fg-dim)"}}>▸</div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ============================================================
// Settings shell w/ Claude entry added
// ============================================================

function ClaudeSettingsShell({ section, children }) {
  const items = [
    {k:"general",      label:"General"},
    {k:"github",       label:"GitHub"},
    {k:"claude",       label:"Claude",       badge:"new"},
    {k:"integrations", label:"Integrations"},
    {k:"agents",       label:"Agents"},
    {k:"appearance",   label:"Appearance"},
    {k:"keyboard",     label:"Keyboard"},
    {k:"advanced",     label:"Advanced"},
  ];
  return (
    <div className="app">
      <Titlebar workspace={`settings · ${section}`}/>
      <div className="shell">
        <Rail active="settings"/>
        <div className="main">
          <div style={{flex:1, display:"flex", minHeight:0}}>
            <aside style={{
              width:200, flex:"0 0 200px", background:"var(--bg-panel)",
              borderRight:"1px solid var(--border-soft)", padding:"16px 8px",
              display:"flex", flexDirection:"column", gap:2,
            }}>
              <div style={{
                fontFamily:"var(--mono)", fontSize:10, letterSpacing:".08em",
                color:"var(--fg-dim)", padding:"4px 12px 10px",
              }}>SETTINGS</div>
              {items.map(it => {
                const on = it.k===section;
                return (
                  <div key={it.k} style={{
                    padding:"7px 12px", borderRadius:6,
                    fontFamily:"var(--mono)", fontSize:11.5,
                    background: on ? "var(--bg-elev)" : "transparent",
                    color: on ? "var(--fg)" : "var(--fg-muted)",
                    cursor:"pointer",
                    borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
                    paddingLeft: on ? 10 : 12,
                    display:"flex", alignItems:"center", gap:8,
                  }}>
                    <span style={{flex:1}}>{it.label}</span>
                    {it.badge && <span style={{
                      padding:"0 5px", borderRadius:3,
                      fontFamily:"var(--mono)", fontSize:9, color:"var(--accent)",
                      background:"color-mix(in oklch, var(--accent), transparent 80%)",
                    }}>{it.badge}</span>}
                  </div>
                );
              })}
            </aside>
            <section style={{flex:1, padding:24, overflow:"auto", minWidth:0}}>
              {children}
            </section>
          </div>
          <StatusBar/>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Screen · Settings → Claude (dedicated)
// ============================================================

function ScreenSettingsClaude() {
  return (
    <ClaudeSettingsShell section="claude">
      <div style={{maxWidth:880}}>
        <div style={{display:"flex", alignItems:"baseline", gap:12, marginBottom:6}}>
          <h2 style={{fontFamily:"var(--mono)", fontSize:18, margin:0, fontWeight:600}}>Claude</h2>
          <span className="tag green">● connected</span>
        </div>
        <p style={{color:"var(--fg-muted)", margin:"0 0 18px", fontSize:12}}>
          Defaults for every Claude session. Projects, consoles, and panes can layer overrides on top.
        </p>

        <ScopeHierarchy active="global"
          badges={{ global:"3 pinned · 1 prompt", project:"+ 2", console:"+ 0", pane:"+ 1" }}/>

        <div style={{height:18}}/>

        {/* Account + spend */}
        <div className="card">
          <div style={{display:"flex", alignItems:"baseline", marginBottom:12, gap:10}}>
            <h3 style={{margin:0}}>Account</h3>
            <span className="hint">last call 12s ago · this month $42.18 of $150 cap</span>
            <div style={{flex:1}}/>
            <a style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)"}}>view usage →</a>
          </div>
          <div style={{display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:14}}>
            <div className="field">
              <label>API key</label>
              <div style={{display:"flex", gap:8}}>
                <input className="input" type="password" defaultValue="sk-ant-abcdef0123456789xxxxxxxxxxxxxxxxxxxxxxxxxxxx"/>
                <button className="btn">show</button>
                <button className="btn">test</button>
              </div>
              <div className="hint">Stored in OS keyring · never written to disk in plaintext.</div>
            </div>
            <div className="field">
              <label>Monthly spend cap</label>
              <input className="input" defaultValue="$150"/>
              <div className="hint">Warn at 75% · hard-stop at 100%.</div>
            </div>
          </div>

          {/* Usage meter */}
          <div style={{marginTop:16}}>
            <div style={{display:"flex", justifyContent:"space-between", fontFamily:"var(--mono)",
              fontSize:10.5, color:"var(--fg-muted)", marginBottom:5}}>
              <span>this month · $42.18</span>
              <span>$150 cap</span>
            </div>
            <div style={{height:6, borderRadius:3,
              background:"var(--bg-elev2)", overflow:"hidden", display:"flex"}}>
              <div style={{width:"22%", background:"var(--success)"}}/>
              <div style={{width:"6%", background:"var(--accent)"}}/>
            </div>
            <div style={{display:"flex", gap:14, marginTop:6,
              fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-muted)"}}>
              <span><span style={{color:"var(--success)"}}>■</span> sonnet $33</span>
              <span><span style={{color:"var(--accent)"}}>■</span> opus $9</span>
              <span><span style={{color:"var(--fg-dim)"}}>■</span> haiku $0.18</span>
            </div>
          </div>
        </div>

        <div style={{height:14}}/>

        {/* Defaults */}
        <div className="card">
          <div style={{display:"flex", alignItems:"baseline", marginBottom:12, gap:10}}>
            <h3 style={{margin:0}}>Defaults</h3>
            <span className="hint">applied to a session unless an override is set.</span>
          </div>

          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14}}>
            <div className="field">
              <label>Default model</label>
              <select className="input" defaultValue="sonnet-4.5">
                <option>opus-4.5</option>
                <option value="sonnet-4.5">sonnet-4.5</option>
                <option>haiku-4.5</option>
              </select>
            </div>
            <div className="field">
              <label>Per-pane context cap</label>
              <input className="input" defaultValue="64000"/>
              <div className="hint">Trim oldest turns first when the cap is hit.</div>
            </div>
          </div>

          <div className="field" style={{marginBottom:14}}>
            <label>Extended thinking</label>
            <div style={{display:"flex", gap:6}}>
              {["off","auto","always"].map((v,i)=>(
                <button key={v} className="btn" style={{
                  flex:1, justifyContent:"center",
                  background: i===1 ? "var(--bg-elev2)" : "var(--bg-elev)",
                  borderColor: i===1 ? "var(--accent-dim)" : "var(--border-soft)",
                  color: i===1 ? "var(--accent)" : "var(--fg)",
                }}>{v}</button>
              ))}
            </div>
            <div className="hint">Off for haiku regardless of this setting.</div>
          </div>

          {/* Model routing — advanced */}
          <div style={{
            padding:"12px 14px", borderRadius:6,
            background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
          }}>
            <div style={{display:"flex", alignItems:"baseline", gap:8, marginBottom:8}}>
              <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--accent)",
                textTransform:"uppercase", letterSpacing:".06em"}}>model routing</span>
              <span className="hint">"deep" / "balanced" / "cheap" tiers — referenced from agents & slash commands.</span>
            </div>
            <div style={{display:"grid", gridTemplateColumns:"60px 1fr 1fr", gap:8, fontSize:11}}>
              <div style={{fontFamily:"var(--mono)", color:"var(--fg-dim)", textAlign:"right",
                alignSelf:"center"}}>deep</div>
              <select className="input" defaultValue="opus-4.5"><option>opus-4.5</option><option>sonnet-4.5</option></select>
              <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)", alignSelf:"center"}}>used by /plan, @architect</span>

              <div style={{fontFamily:"var(--mono)", color:"var(--fg-dim)", textAlign:"right", alignSelf:"center"}}>balanced</div>
              <select className="input" defaultValue="sonnet-4.5"><option>sonnet-4.5</option><option>opus-4.5</option><option>haiku-4.5</option></select>
              <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)", alignSelf:"center"}}>default for most panes</span>

              <div style={{fontFamily:"var(--mono)", color:"var(--fg-dim)", textAlign:"right", alignSelf:"center"}}>cheap</div>
              <select className="input" defaultValue="haiku-4.5"><option>haiku-4.5</option><option>sonnet-4.5</option></select>
              <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)", alignSelf:"center"}}>tail jobs, @logs, automations</span>
            </div>
          </div>
        </div>

        <div style={{height:14}}/>

        {/* Global system prompt */}
        <div className="card">
          <div style={{display:"flex", alignItems:"baseline", marginBottom:8, gap:10}}>
            <h3 style={{margin:0}}>Global system prompt</h3>
            <span className="hint">prepended to every session · projects can append.</span>
            <div style={{flex:1}}/>
            <button className="btn ghost" style={{height:24, fontSize:10.5}}>history</button>
          </div>
          <div style={{
            background:"var(--bg-canvas)", border:"1px solid var(--border-soft)",
            borderRadius:6, overflow:"hidden",
          }}>
            <div style={{padding:"6px 10px", background:"var(--bg-elev)",
              borderBottom:"1px solid var(--border-soft)",
              fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
              display:"flex", alignItems:"center", gap:8}}>
              <span>prompt.global.md</span>
              <span>·</span>
              <span>286 tokens · cached on every call</span>
              <div style={{flex:1}}/>
              <span style={{color:"var(--accent)"}}>edit ↗</span>
            </div>
            <pre style={{margin:0, padding:"12px 14px",
              fontFamily:"var(--mono)", fontSize:11, color:"var(--fg)",
              lineHeight:1.65, whiteSpace:"pre-wrap"}}>
{`You are a senior engineer at a small team building base-studio-code.
Be terse, accurate, and friendly. No preamble.

Quote line numbers when reviewing code. Do not paraphrase code.
Prefer existing patterns from the knowledge store over inventing new ones.
When unsure, ask one focused question before doing work.`}
            </pre>
          </div>
        </div>

        <div style={{height:14}}/>

        {/* Global pinned knowledge */}
        <div className="card">
          <div style={{display:"flex", alignItems:"baseline", marginBottom:12, gap:10}}>
            <h3 style={{margin:0}}>Pinned knowledge · global</h3>
            <span className="hint">auto-attached to every Claude session, regardless of project.</span>
            <div style={{flex:1}}/>
            <button className="btn">+ pin block</button>
          </div>
          <div style={{borderRadius:6, border:"1px solid var(--border-soft)", overflow:"hidden"}}>
            {[
              { id:"blk_4ad8", title:"@reviewer system prompt",  tags:["agents","prompts"], lines:64 },
              { id:"blk_aa17", title:"Glossary — console, tab, pane", tags:["glossary"], lines:22 },
              { id:"blk_b2c3", title:"House style — Rust naming & errors", tags:["style"], lines:18 },
            ].map((b,i)=>(
              <div key={b.id} style={{
                padding:"11px 14px",
                background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
                display:"grid", gridTemplateColumns:"22px 1fr auto auto auto",
                gap:12, alignItems:"center", fontSize:11,
                borderTop: i===0?"0":"1px solid var(--border-soft)",
              }}>
                <span title="globally pinned" style={{
                  width:18, height:18, borderRadius:4,
                  background:"var(--accent)", color:"#1a120a",
                  fontFamily:"var(--mono)", fontSize:10, fontWeight:700,
                  display:"flex", alignItems:"center", justifyContent:"center",
                }}>G</span>
                <div>
                  <div style={{fontFamily:"var(--mono)", fontSize:11.5, color:"var(--fg)"}}>{b.title}</div>
                  <div style={{display:"flex", gap:6, marginTop:3}}>
                    <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>{b.id}</span>
                    {b.tags.map(t=>(<span key={t} className="tag" style={{fontSize:9}}>#{t}</span>))}
                  </div>
                </div>
                <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{b.lines} lines</span>
                <button className="btn ghost" style={{height:22, fontSize:10}}>open</button>
                <button className="btn ghost danger" style={{height:22, fontSize:10}}>unpin</button>
              </div>
            ))}
          </div>
          <div className="hint" style={{marginTop:10}}>
            Pinning ~3–5 small blocks is ideal. The global prompt + pins are cached on every call.
          </div>
        </div>

        <div style={{height:14}}/>

        {/* Tools */}
        <div className="card">
          <div style={{display:"flex", alignItems:"baseline", marginBottom:12, gap:10}}>
            <h3 style={{margin:0}}>Default tool registry</h3>
            <span className="hint">tools exposed to every agent by default. Projects can narrow.</span>
          </div>
          <div style={{display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:8}}>
            {[
              ["read","Read files inside cwd",true],
              ["write","Write & patch files",true],
              ["bash","Run shell commands (sandboxed)",true],
              ["git","Local git operations",true],
              ["gh","Authenticated GitHub API calls",true],
              ["kb","Read/write Knowledge blocks",true],
              ["http","Outbound HTTP (allowlisted hosts)",false],
              ["browser","Headless browsing for docs",false],
              ["mcp:fs","MCP · filesystem",true],
            ].map(([n,d,on])=>(
              <div key={n} style={{
                padding:"10px 12px", borderRadius:6,
                background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
                display:"flex", flexDirection:"column", gap:4,
              }}>
                <div style={{display:"flex", alignItems:"center", gap:6}}>
                  <span style={{fontFamily:"var(--mono)", fontSize:11.5,
                    color: on?"var(--accent)":"var(--fg-muted)"}}>{n}</span>
                  <span style={{flex:1}}/>
                  <span style={{
                    width:24, height:14, borderRadius:99,
                    background: on?"var(--accent)":"var(--bg-elev2)",
                    border:"1px solid " + (on?"transparent":"var(--border)"),
                    position:"relative",
                  }}>
                    <span style={{position:"absolute", top:1, [on?"right":"left"]:1,
                      width:10, height:10, borderRadius:"50%",
                      background: on ? "#1a120a" : "var(--fg-dim)"}}/>
                  </span>
                </div>
                <div className="hint">{d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ClaudeSettingsShell>
  );
}

// ============================================================
// Project Claude tab
// Uses the same ProjectsShell as the rest of the project pages
// ============================================================

function ProjectsHeaderClaude({ project }) {
  const tabs = [
    { k:"board",    label:"Board" },
    { k:"roadmap",  label:"Roadmap" },
    { k:"issues",   label:"Issues" },
    { k:"insights", label:"Insights" },
    { k:"claude",   label:"Claude", hint:"per-project overrides", isNew:true },
  ];
  return (
    <>
      <div style={{padding:"14px 24px 0", display:"flex", alignItems:"flex-start", gap:14}}>
        <div style={{flex:1}}>
          <div style={{display:"flex", alignItems:"baseline", gap:10}}>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{project.id}</span>
            <h2 style={{margin:0, fontFamily:"var(--mono)", fontSize:18, fontWeight:600}}>{project.name}</h2>
            <span className="tag amber">● {project.iteration}</span>
            <span className="tag">{project.repo}</span>
          </div>
          <div style={{color:"var(--fg-muted)", fontSize:12, marginTop:4}}>{project.pitch}</div>
        </div>
      </div>
      <div style={{
        height:36, marginTop:12,
        borderBottom:"1px solid var(--border-soft)",
        padding:"0 24px",
        display:"flex", alignItems:"end", gap:2,
      }}>
        {tabs.map(t=>{
          const on = t.k==="claude";
          return (
            <div key={t.k} style={{
              padding:"0 14px", height:30,
              display:"flex", alignItems:"center", gap:8,
              borderTopLeftRadius:6, borderTopRightRadius:6,
              background: on ? "var(--bg-canvas)" : "transparent",
              border:"1px solid " + (on?"var(--border-soft)":"transparent"),
              borderBottom:"0",
              color: on ? "var(--fg)" : "var(--fg-muted)",
              fontFamily:"var(--mono)", fontSize:11.5,
              cursor:"pointer",
            }}>
              {t.label}
              {t.isNew && <span style={{
                padding:"0 5px", borderRadius:3,
                fontFamily:"var(--mono)", fontSize:9, color:"var(--accent)",
                background:"color-mix(in oklch, var(--accent), transparent 80%)",
              }}>new</span>}
              {on && t.hint && <span style={{color:"var(--fg-dim)", fontSize:10}}>· {t.hint}</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

function ScreenProjectClaude() {
  const project = (window.CURRENT_PROJECT) || {
    id:"prj_31a", name:"Settlement webhooks v2", repo:"acme/payments",
    iteration:"Iter 24 · ends Fri", gh:14,
    pitch:"Sub-second merchant dashboard notifications via webhook fanout.",
  };
  return (
    <div className="app">
      <Titlebar workspace={`projects · ${project.name} · claude`}/>
      <div className="shell">
        <Rail active="projects"/>
        <div className="main">
          <ProjectsHeaderClaude project={project}/>

          <section style={{flex:1, overflow:"auto", padding:"18px 24px", minWidth:0,
            background:"var(--bg-canvas)"}}>
            <div style={{maxWidth:1040, margin:"0 auto"}}>
              {/* Inheritance strip */}
              <ScopeHierarchy active="project"
                badges={{ global:"3G · 1 prompt", project:"+ 2P · + 1 prompt", console:"0", pane:"0" }}/>

              <div style={{height:18}}/>

              {/* Override panel */}
              <div className="card">
                <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:14}}>
                  <h3 style={{margin:0}}>Overrides</h3>
                  <span className="hint">2 of 4 enabled · the rest inherit from global.</span>
                  <div style={{flex:1}}/>
                  <button className="btn ghost" style={{height:24, fontSize:10.5}}>reset to global</button>
                </div>

                <div style={{display:"flex", flexDirection:"column", gap:10}}>
                  <OverrideRow
                    on={false} title="Default model" inherits="sonnet-4.5"
                    body="Override the model for all panes scoped to this project."/>
                  <OverrideRow
                    on title="System prompt addendum" inherits="(none from project)"
                    body={
                      <pre style={{margin:"6px 0 0", padding:"8px 10px",
                        background:"var(--bg-canvas)", border:"1px solid var(--border-soft)",
                        borderRadius:5, fontFamily:"var(--mono)", fontSize:10.5,
                        color:"var(--fg)", whiteSpace:"pre-wrap", lineHeight:1.6,
                      }}>{`When the user mentions "the dashboard", they mean the merchant-facing surface served
from acme/payments at /m/. Sub-second latency is the explicit goal.

Prefer additive changes over polling-pipeline refactors — see Non-goals in the project plan.`}</pre>
                    }/>
                  <OverrideRow
                    on title="Tool allowlist" inherits="all 9 tools"
                    body={
                      <div style={{display:"flex", flexWrap:"wrap", gap:6, marginTop:6}}>
                        {["read","write","bash","git","gh","kb"].map(t=>(
                          <span key={t} style={{
                            padding:"2px 8px", borderRadius:99,
                            fontFamily:"var(--mono)", fontSize:10,
                            background:"color-mix(in oklch, var(--accent), transparent 86%)",
                            border:"1px solid color-mix(in oklch, var(--accent), transparent 70%)",
                            color:"var(--accent)",
                          }}>{t}</span>
                        ))}
                        <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                          alignSelf:"center"}}>http/browser disabled for this project</span>
                      </div>
                    }/>
                  <OverrideRow
                    on={false} title="Context cap" inherits="64,000 tokens"
                    body="Lower for cheaper sessions, higher for code-heavy work."/>
                </div>
              </div>

              <div style={{height:14}}/>

              {/* Pinned knowledge */}
              <div className="card">
                <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:14}}>
                  <h3 style={{margin:0}}>Pinned knowledge · project</h3>
                  <span className="hint">added on top of the 3 globally-pinned blocks.</span>
                  <div style={{flex:1}}/>
                  <button className="btn">+ pin block</button>
                </div>
                <div style={{borderRadius:6, border:"1px solid var(--border-soft)", overflow:"hidden"}}>
                  {[
                    { id:"blk_71fe", title:"Tunnel framing v2", tags:["tunnel","architecture"], lines:88, scope:"P" },
                    { id:"blk_2199", title:"Decision · SQLite over LMDB", tags:["decisions"], lines:31, scope:"P" },
                  ].map((b,i)=>(
                    <div key={b.id} style={{
                      padding:"11px 14px",
                      background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
                      display:"grid", gridTemplateColumns:"22px 1fr auto auto auto",
                      gap:12, alignItems:"center", fontSize:11,
                      borderTop: i===0?"0":"1px solid var(--border-soft)",
                    }}>
                      <span title="project-pinned" style={{
                        width:18, height:18, borderRadius:4,
                        background:"color-mix(in oklch, var(--info), transparent 60%)",
                        color:"#1a120a",
                        fontFamily:"var(--mono)", fontSize:10, fontWeight:700,
                        display:"flex", alignItems:"center", justifyContent:"center",
                      }}>P</span>
                      <div>
                        <div style={{fontFamily:"var(--mono)", fontSize:11.5, color:"var(--fg)"}}>{b.title}</div>
                        <div style={{display:"flex", gap:6, marginTop:3}}>
                          <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>{b.id}</span>
                          {b.tags.map(t=>(<span key={t} className="tag" style={{fontSize:9}}>#{t}</span>))}
                        </div>
                      </div>
                      <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{b.lines} lines</span>
                      <button className="btn ghost" style={{height:22, fontSize:10}}>open</button>
                      <button className="btn ghost danger" style={{height:22, fontSize:10}}>unpin</button>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{height:14}}/>

              {/* Project slash commands */}
              <div className="card">
                <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:12}}>
                  <h3 style={{margin:0}}>Project slash commands</h3>
                  <span className="hint">available in any pane scoped to this project.</span>
                  <div style={{flex:1}}/>
                  <button className="btn ghost" style={{height:24, fontSize:10.5}}>+ command</button>
                </div>
                <div style={{display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:8}}>
                  {[
                    ["/dashboard",   "load the merchant dashboard repro context"],
                    ["/webhook-test","fire a synthetic settlement event"],
                    ["/sla-check",   "run the p95 latency probe"],
                  ].map(([s,d])=>(
                    <div key={s} style={{
                      padding:"8px 10px", borderRadius:5,
                      background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
                      display:"flex", flexDirection:"column", gap:3,
                    }}>
                      <div style={{fontFamily:"var(--mono)", fontSize:11.5, color:"var(--info)"}}>{s}</div>
                      <div style={{fontSize:11, color:"var(--fg-muted)"}}>{d}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{height:14}}/>

              {/* Sessions using this scope */}
              <div className="card" style={{padding:"14px 18px"}}>
                <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:8}}>
                  <h3 style={{margin:0}}>In use</h3>
                  <span className="hint">consoles & panes currently using these overrides.</span>
                </div>
                <div style={{display:"flex", flexDirection:"column", gap:5,
                  fontFamily:"var(--mono)", fontSize:11, color:"var(--fg-muted)"}}>
                  <div>⌘ orchestrator <span style={{color:"var(--fg-dim)"}}>· 9 panes · scope set 4m ago</span></div>
                  <div>⌘ feat/tunnel  <span style={{color:"var(--fg-dim)"}}>· 4 panes · scope set yesterday</span></div>
                </div>
              </div>
            </div>
          </section>
          <StatusBar extra={<span className="s">project claude · 2 overrides · 2 pinned blocks</span>}/>
        </div>
      </div>
    </div>
  );
}

function OverrideRow({ on, title, body, inherits }) {
  return (
    <div style={{
      padding:"12px 14px", borderRadius:6,
      background:"var(--bg-elev)", border:"1px solid " + (on?"var(--accent-dim)":"var(--border-soft)"),
    }}>
      <div style={{display:"flex", alignItems:"center", gap:10}}>
        <span style={{
          width:30, height:18, borderRadius:99,
          background: on ? "var(--accent)" : "var(--bg-elev2)",
          border:"1px solid " + (on?"transparent":"var(--border)"),
          position:"relative", flex:"0 0 30px",
        }}>
          <span style={{position:"absolute", top:2, [on?"right":"left"]:2,
            width:14, height:14, background: on?"#1a120a":"var(--fg-dim)",
            borderRadius:"50%"}}/>
        </span>
        <div style={{flex:1}}>
          <div style={{fontFamily:"var(--mono)", fontSize:12, color:"var(--fg)"}}>{title}</div>
          {!on && (
            <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)", marginTop:2}}>
              inherits · <span style={{color:"var(--fg-muted)"}}>{inherits}</span>
            </div>
          )}
        </div>
        {on && (
          <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--accent)"}}>overriding</span>
        )}
      </div>
      {on && body && (
        <div style={{marginTop:8, paddingLeft:40,
          fontSize:11.5, color:"var(--fg-muted)", lineHeight:1.55}}>{body}</div>
      )}
    </div>
  );
}

// ============================================================
// Console with project chip + context popover
// ============================================================

function ScreenConsoleClaudeContext() {
  // Mirror screen-console.jsx setup, but: project chip in scope strip,
  // and the top-left pane has a richer hamburger context popover.

  const cells = [
    { agent:"@reviewer",   status:"run",  active:"console",
      view:<ConsoleView small turns={REVIEW_TURNS.slice(0,2)}/>, meta:"PR #418",
      menu:true },
    { agent:"@docs",       status:"on",   active:"files",
      view:<FilesView small tree={TREE.slice(0,10)}
                      active="crates/ws-server/src/tunnel.rs"
                      cwd="~/Code/acme/payments"/>, meta:"watch" },
    { agent:"@triager",    status:"run",  active:"changes",
      view:<ChangesView small/>, meta:"WIP" },
    { agent:"@scratch",    status:"on",   active:"branches",
      view:<BranchesView small/>, meta:"" },
    { agent:"@dispatcher", status:"on",   active:"console",
      view:<ConsoleView small withInput={false} turns={[
        { role:"assistant", blocks:[
          { kind:"text", text:"awaiting webhook routing. 2 in queue." },
          { kind:"tool", tool:"gh", args:"webhooks recent", ok:true, summary:"12 in 1h" },
        ]},
      ]}/>, meta:"q:2" },
    { agent:"@db-shell",   status:"idle", active:"console",
      view:<ConsoleView small withInput={false} turns={[
        { role:"assistant", blocks:[{kind:"text", text:"sqlite session idle. /scan to start."}]},
      ]}/>, meta:"sqlite" },
    { agent:"@github",     status:"on",   active:"log",
      view:<LogView small/>, meta:"main" },
    { agent:"@tunnel-mon", status:"on",   active:"console",
      view:<ConsoleView small withInput={false} turns={[
        { role:"assistant", blocks:[
          { kind:"tool", tool:"ws", args:"ping iPhone-Lina", ok:true, summary:"24ms" },
          { kind:"text", text:"forwarded 12 frames · 0 dropped" },
        ]},
      ]}/>, meta:"42 e/s" },
    { agent:"@logs",       status:"on",   active:"console",
      view:<ConsoleView small withInput={false} turns={[
        { role:"assistant", blocks:[{kind:"text", text:"[14:22:08] auto  fired rule=R-02\n[14:22:10] kb    upsert id=blk_9a2c"}]},
      ]}/>, meta:"tail" },
  ];

  return (
    <div className="app">
      <Titlebar workspace="orchestrator · acme/payments · settlement webhooks v2"/>
      <div className="shell">
        <Rail active="console"/>
        <div className="main">
          <Tabstrip
            tabs={[
              { name:"orchestrator", layout:"3×3", state:"run" },
              { name:"feat/tunnel",  layout:"2×2", state:"on" },
              { name:"scratch",      layout:"1×1", state:"idle" },
            ]}
            activeIdx={0}
          />
          {/* Project scope strip */}
          <ProjectScopeStrip/>

          <div className="page" style={{flexDirection:"column", position:"relative"}}>
            <div className="console-grid" style={{
              gridTemplateColumns:"repeat(3, 1fr)",
              gridTemplateRows:"repeat(3, 1fr)",
            }}>
              {cells.map((c,i)=>(
                <CustomPane key={i} cell={c} contextOpen={c.menu}/>
              ))}
            </div>
          </div>
          <StatusBar extra={<span className="s">claude · project scoped · 6 blocks resolved (3G + 2P + 1 pane)</span>}/>
        </div>
      </div>
    </div>
  );
}

function ProjectScopeStrip() {
  return (
    <div style={{
      padding:"7px 14px",
      background:"linear-gradient(90deg, color-mix(in oklch, var(--info), transparent 88%), transparent 70%)",
      borderBottom:"1px solid var(--border-soft)",
      display:"flex", alignItems:"center", gap:10,
      fontFamily:"var(--mono)", fontSize:10.5,
    }}>
      <span style={{
        width:18, height:18, borderRadius:4,
        background:"color-mix(in oklch, var(--info), transparent 60%)",
        color:"#1a120a", fontWeight:700, fontSize:10,
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>P</span>
      <span style={{color:"var(--fg-muted)"}}>scoped to project</span>
      <span style={{color:"var(--accent)", fontWeight:600}}>Settlement webhooks v2</span>
      <span style={{color:"var(--fg-dim)"}}>·</span>
      <span style={{color:"var(--fg-muted)"}}>acme/payments</span>
      <span style={{color:"var(--fg-dim)"}}>·</span>
      <span style={{color:"var(--fg-muted)"}}>inheriting <b style={{color:"var(--fg)"}}>global</b> claude config</span>
      <span style={{color:"var(--fg-dim)"}}>·</span>
      <span style={{color:"var(--fg-muted)"}}>
        <b style={{color:"var(--accent)"}}>3G</b> + <b style={{color:"var(--info)"}}>2P</b> pinned
      </span>
      <div style={{flex:1}}/>
      <span style={{color:"var(--accent)", cursor:"pointer"}}>open project claude →</span>
      <span style={{color:"var(--fg-dim)"}}>·</span>
      <span style={{color:"var(--fg-muted)", cursor:"pointer"}}>change project</span>
    </div>
  );
}

// Custom pane shell that renders a richer context popover when contextOpen=true
function CustomPane({ cell, contextOpen }) {
  return (
    <div className="pane focused" style={{display:"flex", flexDirection:"column",
      position:"relative", zIndex: contextOpen?5:1, minHeight:0}}>
      {/* head */}
      <div style={{
        height:32, padding:"0 8px 0 10px",
        display:"flex", alignItems:"center", gap:8,
        background:"var(--bg-elev)", borderBottom:"1px solid var(--border-soft)",
      }}>
        <span style={{
          width:7, height:7, borderRadius:"50%",
          background: cell.status==="idle"?"var(--fg-dim)":cell.status==="run"?"var(--accent)":"var(--success)",
          animation: cell.status==="run" ? "pulse 1.4s ease-in-out infinite" : "none",
        }}/>
        <span style={{fontFamily:"var(--mono)", fontSize:11.5, color:"var(--fg)"}}>{cell.agent}</span>
        <div style={{flex:1, display:"flex", justifyContent:"flex-end", gap:6,
          fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)",
          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
          <span style={{color:"var(--info)"}}>⎇ main</span>
          <span style={{color:"var(--danger)"}}>●</span>
          <span style={{color:"var(--fg-dim)"}}>acme/payments</span>
          {cell.meta && <><span style={{color:"var(--fg-dim)"}}>·</span><span>{cell.meta}</span></>}
        </div>
        <button title="Pane menu" style={{
          width:22, height:22, borderRadius:4,
          border:"1px solid " + (contextOpen?"var(--accent-dim)":"transparent"),
          background: contextOpen ? "var(--bg-canvas)" : "transparent",
          color: contextOpen ? "var(--accent)" : "var(--fg-muted)",
          display:"flex", alignItems:"center", justifyContent:"center",
          cursor:"pointer", fontSize:12, lineHeight:1, flex:"0 0 22px",
        }}>☰</button>
      </div>

      {/* icon tabs */}
      <div style={{
        height:26, display:"flex", alignItems:"center", gap:2,
        padding:"0 6px", borderBottom:"1px solid var(--border-soft)",
        background:"var(--bg-panel)",
      }}>
        {["▸","⌗","⎇","±","⏱"].map((i,idx)=>(
          <div key={i} style={{
            width:24, height:20, display:"flex", alignItems:"center", justifyContent:"center",
            borderRadius:4,
            background: idx===0 ? "var(--bg-canvas)" : "transparent",
            border: idx===0 ? "1px solid var(--accent-dim)" : "1px solid transparent",
            color: idx===0 ? "var(--accent)" : "var(--fg-muted)",
            fontSize:12, fontFamily:"var(--mono)", cursor:"pointer",
          }}>{i}</div>
        ))}
      </div>

      {/* body */}
      <div style={{flex:1, minHeight:0, overflow:"hidden", display:"flex", flexDirection:"column"}}>
        {cell.view}
      </div>

      {contextOpen && <PaneContextPopover/>}
    </div>
  );
}

function PaneContextPopover() {
  return (
    <div style={{
      position:"absolute", top:38, right:6, zIndex:20,
      width:340,
      background:"var(--bg-panel)",
      border:"1px solid var(--border)",
      borderRadius:8,
      boxShadow:"0 18px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02)",
      overflow:"hidden",
      fontFamily:"var(--mono)", fontSize:11,
    }}>
      <div style={{padding:"10px 12px", borderBottom:"1px solid var(--border-soft)",
        background:"var(--bg-elev)"}}>
        <div style={{display:"flex", alignItems:"baseline", gap:8}}>
          <span style={{fontSize:12, color:"var(--fg)", fontWeight:600}}>@reviewer</span>
          <span style={{fontSize:10, color:"var(--fg-dim)"}}>sonnet-4.5</span>
          <span style={{flex:1}}/>
          <span style={{color:"var(--fg-dim)", fontSize:10, cursor:"pointer"}}>✕</span>
        </div>
        <div style={{fontSize:10, color:"var(--fg-muted)", marginTop:3}}>
          <span style={{color:"var(--info)"}}>⎇ main</span>
          <span style={{color:"var(--fg-dim)"}}> · acme/payments</span>
        </div>
      </div>

      {/* Context (NEW) */}
      <div style={{padding:"8px 6px", borderBottom:"1px solid var(--border-soft)"}}>
        <div style={{padding:"4px 8px 6px",
          display:"flex", alignItems:"center", justifyContent:"space-between",
          fontSize:9.5, color:"var(--fg-dim)",
          textTransform:"uppercase", letterSpacing:".08em"}}>
          <span>context · 6 resolved</span>
          <span style={{color:"var(--accent)", cursor:"pointer", textTransform:"none", letterSpacing:0, fontSize:10}}>open inspector</span>
        </div>

        {/* Active project */}
        <div style={{padding:"6px 8px",
          display:"flex", alignItems:"center", gap:6,
          background:"color-mix(in oklch, var(--info), transparent 92%)",
          borderRadius:5, marginBottom:6,
        }}>
          <span style={{
            width:16, height:16, borderRadius:4,
            background:"color-mix(in oklch, var(--info), transparent 50%)", color:"#1a120a",
            fontWeight:700, fontSize:10,
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>P</span>
          <span style={{color:"var(--fg)", flex:1}}>Settlement webhooks v2</span>
          <span style={{color:"var(--fg-dim)", fontSize:9.5}}>change</span>
        </div>

        {/* Resolved blocks */}
        <div style={{display:"flex", flexDirection:"column", gap:1}}>
          <ContextBlock scope="G" id="blk_4ad8" t="@reviewer system prompt"/>
          <ContextBlock scope="G" id="blk_aa17" t="Glossary — console, tab, pane"/>
          <ContextBlock scope="G" id="blk_b2c3" t="House style — Rust naming & errors"/>
          <ContextBlock scope="P" id="blk_71fe" t="Tunnel framing v2"/>
          <ContextBlock scope="P" id="blk_2199" t="Decision · SQLite over LMDB"/>
          <ContextBlock scope="Pane" id="blk_9a2c" t="Review policy — TS / Rust" pane/>
        </div>

        {/* Add */}
        <div style={{display:"flex", alignItems:"center", gap:6, marginTop:6,
          padding:"6px 8px", borderRadius:5, border:"1px dashed var(--border)",
          color:"var(--fg-dim)", cursor:"pointer"}}>
          <span style={{color:"var(--accent)"}}>+</span>
          <span>pin a knowledge block to this pane only…</span>
        </div>

        {/* Context budget */}
        <div style={{marginTop:8, padding:"6px 8px",
          background:"var(--bg-canvas)", borderRadius:5,
          border:"1px solid var(--border-soft)",
          fontSize:10, color:"var(--fg-muted)"}}>
          <div style={{display:"flex", justifyContent:"space-between", marginBottom:4}}>
            <span>context · 14.2k / 64k cap</span>
            <span style={{color:"var(--fg-dim)"}}>22%</span>
          </div>
          <div style={{height:4, borderRadius:2, background:"var(--bg-elev2)", overflow:"hidden"}}>
            <div style={{width:"22%", height:"100%", background:"var(--accent)"}}/>
          </div>
        </div>
      </div>

      {/* Model */}
      <div style={{padding:"6px 6px", borderBottom:"1px solid var(--border-soft)"}}>
        <div style={{padding:"4px 8px 6px", fontSize:9.5, color:"var(--fg-dim)",
          textTransform:"uppercase", letterSpacing:".08em"}}>model</div>
        {[
          ["haiku-4.5","fast","$ ·"],
          ["sonnet-4.5","balanced","$$ ··",true],
          ["opus-4.5","deep","$$$ ···"],
        ].map(([n,t,p,on])=>(
          <div key={n} style={{
            display:"flex", alignItems:"center", gap:6, padding:"5px 8px",
            borderRadius:5,
            background: on ? "color-mix(in oklch, var(--accent), transparent 90%)" : "transparent",
          }}>
            <span style={{color:on?"var(--accent)":"var(--fg-dim)", width:10}}>{on?"●":"○"}</span>
            <span style={{color:on?"var(--accent)":"var(--fg)", flex:1}}>{n}</span>
            <span style={{color:"var(--fg-dim)", fontSize:9.5, marginRight:6}}>{t}</span>
            <span style={{color:"var(--fg-dim)", fontSize:9.5}}>{p}</span>
          </div>
        ))}
      </div>

      {/* Pane actions truncated */}
      <div style={{padding:"6px 6px"}}>
        <div style={{padding:"4px 8px 6px", fontSize:9.5, color:"var(--fg-dim)",
          textTransform:"uppercase", letterSpacing:".08em"}}>pane</div>
        <ActionLine icon="↻" t="rescan repo"/>
        <ActionLine icon="⌖" t="set cwd…"/>
        <ActionLine icon="✕" t="close pane" danger/>
      </div>
    </div>
  );
}

function ContextBlock({ scope, id, t, pane }) {
  const colors = {
    G:    { bg:"var(--accent)",                                              fg:"#1a120a" },
    P:    { bg:"color-mix(in oklch, var(--info), transparent 50%)",          fg:"#1a120a" },
    Pane: { bg:"var(--bg-elev2)",                                            fg:"var(--fg-muted)" },
  }[scope];
  return (
    <div style={{
      padding:"6px 8px", borderRadius:5,
      display:"flex", alignItems:"center", gap:6,
    }}>
      <span style={{
        width:18, height:16, borderRadius:3,
        background:colors.bg, color:colors.fg,
        fontFamily:"var(--mono)", fontSize:9, fontWeight:700,
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>{scope}</span>
      <span style={{flex:1, color:"var(--fg)", fontSize:10.5,
        whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{t}</span>
      <span style={{color:"var(--fg-dim)", fontSize:9.5}}>{id}</span>
      {pane && <span style={{color:"var(--fg-dim)", fontSize:9.5, cursor:"pointer"}}>unpin</span>}
    </div>
  );
}

function ActionLine({ icon, t, danger }) {
  return (
    <div style={{display:"flex", alignItems:"center", gap:8, padding:"5px 8px",
      borderRadius:5, cursor:"pointer"}}>
      <span style={{width:12, color: danger?"var(--danger)":"var(--fg-muted)"}}>{icon}</span>
      <span style={{color: danger?"var(--danger)":"var(--fg)"}}>{t}</span>
    </div>
  );
}

Object.assign(window, {
  ScreenSettingsClaude, ScreenProjectClaude, ScreenConsoleClaudeContext,
  ScopeHierarchy,
});
