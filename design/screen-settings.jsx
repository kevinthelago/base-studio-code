/* global React, Titlebar, Rail, StatusBar */

// Settings shell — sub-nav without Automations.

function SettingsShell({ section, children }) {
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
// Settings · GitHub
// ============================================================

function ScreenSettingsGitHub() {
  const repos = [
    { name:"acme/payments",      on:true,  branch:"main",    desc:"Stripe + Tipalti adapters",     priv:true,  hooks:"PR · push · issue" },
    { name:"acme/ledger-core",   on:true,  branch:"main",    desc:"Double-entry ledger (Rust)",    priv:true,  hooks:"PR · push" },
    { name:"acme/web",           on:false, branch:"develop", desc:"Customer dashboard (Next.js)",  priv:true,  hooks:"—" },
    { name:"acme/docs",          on:true,  branch:"main",    desc:"Public engineering docs",        priv:false, hooks:"push" },
    { name:"lina/playground",    on:false, branch:"main",    desc:"Personal scratch repos",         priv:false, hooks:"—" },
  ];
  return (
    <SettingsShell section="github">
      <div style={{maxWidth:760}}>
        <h2 style={{fontFamily:"var(--mono)", fontSize:18, margin:"0 0 4px", fontWeight:600}}>GitHub</h2>
        <p style={{color:"var(--fg-muted)", margin:"0 0 22px", fontSize:12}}>
          Connect your GitHub account to browse repos, branches, and pull requests.
        </p>

        <div className="card" style={{display:"flex", alignItems:"center", gap:16}}>
          <div style={{
            width:44, height:44, borderRadius:"50%",
            background:"var(--bg-elev2)", border:"1px solid var(--border-soft)",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontFamily:"var(--mono)", fontSize:18, color:"var(--fg)",
          }}>L</div>
          <div style={{flex:1}}>
            <div style={{display:"flex", alignItems:"center", gap:8}}>
              <b style={{fontFamily:"var(--mono)", fontSize:13}}>lina-engelbrecht</b>
              <span className="tag green">● connected</span>
              <span className="tag">scopes: repo · read:org · read:user</span>
            </div>
            <div className="hint" style={{marginTop:3}}>token rotated 14 days ago · expires in 76 days</div>
          </div>
          <button className="btn">Re-authenticate</button>
          <button className="btn danger">Disconnect</button>
        </div>

        <div style={{height:18}}/>

        <div className="card">
          <div style={{display:"flex", alignItems:"baseline", marginBottom:12, gap:10}}>
            <h3 style={{margin:0}}>Repositories</h3>
            <span className="hint">3 of 5 selected — these show up in the GitHub tab.</span>
            <div style={{flex:1}}/>
            <input className="input" placeholder="filter…" style={{width:180}}/>
          </div>

          <div style={{display:"flex", flexDirection:"column", gap:1, borderRadius:6, overflow:"hidden",
            border:"1px solid var(--border-soft)"}}>
            {repos.map((r,i)=>(
              <div key={r.name} style={{
                display:"grid", gridTemplateColumns:"24px 1.4fr 1fr 1.6fr 90px",
                alignItems:"center", gap:12, padding:"11px 14px",
                background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
                fontSize:11.5,
              }}>
                <div style={{
                  width:16, height:16, borderRadius:4,
                  background: r.on ? "var(--accent)" : "transparent",
                  border:"1px solid " + (r.on?"var(--accent)":"var(--border)"),
                  display:"flex", alignItems:"center", justifyContent:"center",
                  color:"#1a120a", fontSize:11, fontWeight:700,
                }}>{r.on ? "✓" : ""}</div>
                <div>
                  <div style={{fontFamily:"var(--mono)"}}>{r.name}</div>
                  <div className="hint">{r.desc}</div>
                </div>
                <div>
                  <span className="tag">{r.priv ? "private" : "public"}</span>
                  <span style={{marginLeft:6, fontFamily:"var(--mono)", color:"var(--fg-muted)"}}>{r.branch}</span>
                </div>
                <div style={{fontFamily:"var(--mono)", color:"var(--fg-dim)", fontSize:10.5}}>{r.hooks}</div>
                <div style={{textAlign:"right"}}>
                  <button className="btn ghost" style={{height:24, padding:"0 8px", fontSize:10.5}}>configure</button>
                </div>
              </div>
            ))}
          </div>

          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:14}}>
            <div className="hint">Webhook deliveries land on <span className="kbd">/gh/webhook</span>.</div>
            <button className="btn">+ Install on more repos</button>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}

// ============================================================
// Settings · Integrations (Claude only)
// ============================================================

function ScreenSettingsIntegrations() {
  return (
    <SettingsShell section="integrations">
      <div style={{maxWidth:820}}>
        <h2 style={{fontFamily:"var(--mono)", fontSize:18, margin:"0 0 4px", fontWeight:600}}>Integrations</h2>
        <p style={{color:"var(--fg-muted)", margin:"0 0 22px", fontSize:12}}>
          External services your agents can reach.
        </p>

        <div className="card">
          <div style={{display:"flex", alignItems:"baseline", marginBottom:12, gap:10}}>
            <h3 style={{margin:0}}>Anthropic Claude</h3>
            <span className="tag green">● healthy</span>
            <span className="hint">last call 12s ago · 14.2k ctx</span>
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
              <label>Default model</label>
              <select className="input" defaultValue="sonnet-4.5">
                <option>opus-4.5</option>
                <option value="sonnet-4.5">sonnet-4.5</option>
                <option>haiku-4.5</option>
              </select>
              <div className="hint">Per-pane override available from the hamburger menu.</div>
            </div>
            <div className="field">
              <label>Per-agent context cap</label>
              <input className="input" defaultValue="64000"/>
            </div>
            <div className="field">
              <label>Monthly spend cap</label>
              <input className="input" defaultValue="$150"/>
            </div>
            <div className="field" style={{gridColumn:"1 / -1"}}>
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
          </div>
        </div>

        <div style={{height:18}}/>

        <div className="card">
          <div style={{display:"flex", alignItems:"baseline", marginBottom:12, gap:10}}>
            <h3 style={{margin:0}}>Tools available to agents</h3>
            <span className="hint">Tools the runtime exposes to Claude via the local registry.</span>
          </div>
          <div style={{display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:8}}>
            {[
              ["read",  "Read files inside cwd", true],
              ["write", "Write & patch files",  true],
              ["bash",  "Run shell commands (sandboxed)", true],
              ["git",   "Local git operations", true],
              ["gh",    "Authenticated GitHub API calls", true],
              ["kb",    "Read/write Knowledge blocks", true],
              ["http",  "Outbound HTTP (allowlisted hosts)", false],
              ["browser","Headless browsing for docs", false],
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
                    <span style={{
                      position:"absolute", top:1, [on?"right":"left"]:1,
                      width:10, height:10, borderRadius:"50%",
                      background: on ? "#1a120a" : "var(--fg-dim)",
                    }}/>
                  </span>
                </div>
                <div className="hint">{d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}

Object.assign(window, { SettingsShell, ScreenSettingsGitHub, ScreenSettingsIntegrations });
