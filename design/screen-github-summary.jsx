/* global React, Titlebar, Rail, StatusBar */

// ============================================================
// Shared · page-level "Summary | Repositories" tab strip
// ============================================================

function GitHubPageMode({ active }) {
  const modes = [
    { k:"summary",  label:"Summary",       hint:"all repos · analytics" },
    { k:"repos",    label:"Repositories",  hint:"drill into a repo" },
  ];
  return (
    <div style={{
      padding:"0 24px",
      borderBottom:"1px solid var(--border-soft)",
      background:"var(--bg-panel)",
      display:"flex", alignItems:"center", gap:6,
      fontFamily:"var(--mono)", fontSize:11.5,
      height:34,
    }}>
      {modes.map(m=>{
        const on = m.k===active;
        return (
          <div key={m.k} style={{
            padding:"0 12px", height:34,
            display:"flex", alignItems:"center", gap:8,
            borderBottom:"2px solid " + (on?"var(--accent)":"transparent"),
            color: on ? "var(--accent)" : "var(--fg-muted)",
            cursor:"pointer",
          }}>
            {m.label}
            {on && <span style={{color:"var(--fg-dim)", fontSize:10}}>· {m.hint}</span>}
          </div>
        );
      })}
      <div style={{flex:1}}/>
      <div style={{display:"flex", alignItems:"center", gap:8,
        fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>
        <span style={{color:"var(--success)"}}>● sync 4m ago</span>
        <span>·</span>
        <span>lina-engelbrecht</span>
      </div>
    </div>
  );
}

// ============================================================
// Activity heatmap — 28 days × 7 weekdays
// ============================================================

function ActivityHeatmap() {
  // 28 cols × 7 rows, deterministic pseudo-random
  const cols = 28, rows = 7;
  let s = 17;
  const vals = [];
  for (let i=0; i<cols*rows; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const wkday = i % rows;
    // weekends are lighter
    const base = wkday===0 || wkday===6 ? 0.3 : 0.9;
    vals.push(((s % 100) / 100) * base);
  }
  // boost a couple of "hot" days
  vals[3*7+2] = 0.95; vals[3*7+3] = 0.92;
  vals[18*7+3] = 0.98;

  const cell = 12, gap = 3;
  const W = cols*cell + (cols-1)*gap;
  const H = rows*cell + (rows-1)*gap;
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Activity · last 28 days</h3>
        <span className="hint">commits to default branches across all repos</span>
        <div style={{flex:1}}/>
        <span style={{display:"flex", gap:6, alignItems:"center", fontFamily:"var(--mono)",
          fontSize:10, color:"var(--fg-dim)"}}>
          less
          {[0.15, 0.35, 0.55, 0.75, 0.95].map((v,i)=>(
            <span key={i} style={{width:10, height:10, borderRadius:2,
              background:`color-mix(in oklch, var(--accent) ${Math.round(v*100)}%, var(--bg-elev))`}}/>
          ))}
          more
        </span>
      </div>
      <svg width={W+30} height={H+24} style={{display:"block", maxWidth:"100%"}}>
        {["Mon","","Wed","","Fri","",""].map((d,i)=>(
          <text key={i} x={0} y={20+i*(cell+gap)} fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{d}</text>
        ))}
        {vals.map((v,i)=>{
          const c = Math.floor(i/rows), r = i%rows;
          return (
            <rect key={i}
              x={30 + c*(cell+gap)} y={r*(cell+gap)+4}
              width={cell} height={cell}
              rx={2}
              fill={`color-mix(in oklch, var(--accent) ${Math.round(v*100)}%, var(--bg-elev))`}/>
          );
        })}
      </svg>
      <div style={{display:"flex", justifyContent:"space-between", marginTop:6,
        fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)", paddingLeft:30}}>
        <span>4 weeks ago</span>
        <span>today</span>
      </div>
      <div style={{display:"flex", gap:24, marginTop:12,
        fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)"}}>
        <span><b style={{color:"var(--fg)"}}>347</b> commits</span>
        <span><b style={{color:"var(--fg)"}}>92</b> PRs merged</span>
        <span><b style={{color:"var(--fg)"}}>+18k / −7k</b> lines</span>
        <span><b style={{color:"var(--success)"}}>96%</b> CI passing</span>
      </div>
    </div>
  );
}

// ============================================================
// Language mix — horizontal stacked bar
// ============================================================

function LanguageMix() {
  const langs = [
    { n:"Rust",       pct:62, c:"oklch(0.78 0.14 30)" },
    { n:"TypeScript", pct:21, c:"oklch(0.7 0.12 240)" },
    { n:"Python",     pct:8,  c:"oklch(0.78 0.13 90)" },
    { n:"Shell",      pct:5,  c:"oklch(0.72 0.10 145)" },
    { n:"Other",      pct:4,  c:"oklch(0.5 0 0)" },
  ];
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", marginBottom:10, gap:10}}>
        <h3 style={{margin:0}}>Languages</h3>
        <span className="hint">by line count, across 4 repos</span>
      </div>
      <div style={{display:"flex", height:10, borderRadius:5, overflow:"hidden",
        background:"var(--bg-elev2)", marginBottom:10}}>
        {langs.map(l=>(
          <div key={l.n} title={`${l.n} · ${l.pct}%`}
            style={{width:`${l.pct}%`, background:l.c}}/>
        ))}
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:5,
        fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)"}}>
        {langs.map(l=>(
          <div key={l.n} style={{display:"grid", gridTemplateColumns:"12px 1fr 40px",
            gap:8, alignItems:"center"}}>
            <span style={{width:9, height:9, borderRadius:2, background:l.c}}/>
            <span style={{color:"var(--fg)"}}>{l.n}</span>
            <span style={{textAlign:"right", color:"var(--fg-dim)"}}>{l.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Top contributors widget
// ============================================================

const PEOPLE_GH = {
  lina:  { color:"oklch(0.7 0.13 30)",  initial:"L" },
  alex:  { color:"oklch(0.7 0.10 220)", initial:"A" },
  pete:  { color:"oklch(0.68 0.13 145)",initial:"P" },
  zara:  { color:"oklch(0.7 0.12 290)", initial:"Z" },
  bot:   { color:"oklch(0.45 0 0)",     initial:"⌬" },
};

function ContributorsCard() {
  const ppl = [
    { id:"lina", commits:84, prs:14, plus:5240, minus:2110 },
    { id:"alex", commits:62, prs:11, plus:3210, minus:1180 },
    { id:"pete", commits:41, prs:7,  plus:1980, minus:640  },
    { id:"zara", commits:23, prs:4,  plus:912,  minus:340  },
    { id:"bot",  commits:18, prs:0,  plus:412,  minus:88   },
  ];
  const maxCommits = Math.max(...ppl.map(p=>p.commits));
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Top contributors</h3>
        <span className="hint">28 days · across 4 repos</span>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:8}}>
        {ppl.map(p=>(
          <div key={p.id} style={{display:"grid",
            gridTemplateColumns:"22px 60px 1fr 70px", gap:10, alignItems:"center"}}>
            <span style={{
              width:20, height:20, borderRadius:"50%",
              background:PEOPLE_GH[p.id].color, color:"#1a120a",
              fontFamily:"var(--mono)", fontWeight:700, fontSize:11,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>{PEOPLE_GH[p.id].initial}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--fg)"}}>@{p.id}</span>
            <div style={{height:5, borderRadius:3, background:"var(--bg-elev2)",
              overflow:"hidden"}}>
              <div style={{width:`${p.commits/maxCommits*100}%`, height:"100%",
                background:"var(--accent)"}}/>
            </div>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)",
              textAlign:"right"}}>{p.commits} · {p.prs} PR</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Cross-repo activity feed
// ============================================================

function CrossRepoActivity() {
  const events = [
    { who:"lina", action:"merged", target:"#418 net: framing v2 + schema regen",
      repo:"acme/payments", t:"3m" },
    { who:"alex", action:"opened",  target:"#212 fix: clippy unused-import",
      repo:"acme/ledger-core", t:"24m" },
    { who:"bot",  action:"pushed",  target:"a05 release: v0.5.0",
      repo:"acme/payments", t:"1h" },
    { who:"pete", action:"reviewed", target:"#414 kb: backlinks + FTS5",
      repo:"acme/payments", t:"2h" },
    { who:"zara", action:"closed",  target:"#88 outage retro 04/12",
      repo:"acme/docs", t:"4h" },
    { who:"alex", action:"force-pushed", target:"feat/tunnel-v2",
      repo:"acme/payments", t:"5h" },
    { who:"lina", action:"opened",  target:"#103 docs: store migration",
      repo:"acme/docs", t:"yesterday" },
  ];
  const actionTone = {
    merged: "var(--info)", opened: "var(--accent)",
    pushed: "var(--success)", reviewed: "var(--fg-muted)",
    closed: "var(--fg-dim)", "force-pushed":"var(--danger)",
  };
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Recent activity</h3>
        <span className="hint">across all connected repos</span>
        <div style={{flex:1}}/>
        <select className="input" style={{height:24, width:100, fontSize:10.5}}>
          <option>all events</option><option>PRs only</option><option>commits</option>
        </select>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:1,
        borderRadius:6, border:"1px solid var(--border-soft)", overflow:"hidden"}}>
        {events.map((e,i)=>(
          <div key={i} style={{
            padding:"10px 12px",
            background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
            display:"grid", gridTemplateColumns:"22px 70px 1fr 110px 50px",
            gap:10, alignItems:"baseline", fontSize:11,
          }}>
            <span style={{
              width:20, height:20, borderRadius:"50%",
              background:PEOPLE_GH[e.who].color, color:"#1a120a",
              fontFamily:"var(--mono)", fontWeight:700, fontSize:10,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>{PEOPLE_GH[e.who].initial}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10.5,
              color: actionTone[e.action] || "var(--fg-muted)"}}>{e.action}</span>
            <span style={{color:"var(--fg)",
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{e.target}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{e.repo}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
              textAlign:"right"}}>{e.t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Open PRs across repos
// ============================================================

function OpenPRsAllRepos() {
  const prs = [
    { n:"#418", t:"net: framing v2 + schema regen", who:"lina", repo:"acme/payments",     st:"review",   ci:"ok",   age:"2h"  },
    { n:"#416", t:"orch: tool dispatch refactor",   who:"alex", repo:"acme/payments",     st:"changes",  ci:"fail", age:"1d"  },
    { n:"#212", t:"fix: clippy unused-import",      who:"alex", repo:"acme/ledger-core",  st:"draft",    ci:"ok",   age:"24m" },
    { n:"#414", t:"kb: backlinks + FTS5",           who:"lina", repo:"acme/payments",     st:"approved", ci:"ok",   age:"2d"  },
    { n:"#103", t:"docs: store migration",          who:"lina", repo:"acme/docs",         st:"review",   ci:"ok",   age:"yesterday" },
    { n:"#411", t:"docs: store migration",          who:"bot",  repo:"acme/payments",     st:"draft",    ci:"ok",   age:"3d"  },
  ];
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Open pull requests</h3>
        <span className="hint">14 across 4 repos</span>
        <div style={{flex:1}}/>
        <button className="btn ghost" style={{height:24, fontSize:10.5}}>filter by reviewer</button>
      </div>
      <div style={{borderRadius:6, border:"1px solid var(--border-soft)", overflow:"hidden"}}>
        {prs.map((p,i)=>(
          <div key={p.n} style={{
            padding:"10px 12px",
            background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
            display:"grid", gridTemplateColumns:"50px 1fr auto auto 50px",
            gap:10, alignItems:"baseline", fontSize:11,
            borderTop: i===0?"0":"1px solid var(--border-soft)",
          }}>
            <span style={{fontFamily:"var(--mono)", color:"var(--fg-dim)"}}>{p.n}</span>
            <div style={{minWidth:0}}>
              <div style={{color:"var(--fg)",
                whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{p.t}</div>
              <div style={{marginTop:3, fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>
                @{p.who} · {p.repo}
              </div>
            </div>
            <span className={"tag " + (p.st==="approved"?"green":p.st==="changes"?"":"amber")}
              style={{fontSize:9.5}}>{p.st}</span>
            <span className={"tag " + (p.ci==="ok"?"green":"")}
              style={{fontSize:9.5,
              color: p.ci==="ok"?"var(--success)":"var(--danger)"}}>ci {p.ci}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
              textAlign:"right"}}>{p.age}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Repos grid (mini cards)
// ============================================================

function ReposGrid() {
  const repos = [
    { n:"acme/payments",    lang:"rust", langC:"oklch(0.78 0.14 30)",
      desc:"Stripe + Tipalti adapters, ledger glue, settlement workers.",
      pr:5,  brn:11, ci:"passing", last:"3m",  spark:[3,5,2,8,6,9,7,4,8,12,10,7] },
    { n:"acme/ledger-core", lang:"rust", langC:"oklch(0.78 0.14 30)",
      desc:"Double-entry ledger (Rust). Core invariants live here.",
      pr:2,  brn:4,  ci:"failing", last:"24m", spark:[2,1,3,4,2,3,5,3,6,4,2,1] },
    { n:"acme/web",         lang:"ts",   langC:"oklch(0.7 0.12 240)",
      desc:"Customer dashboard (Next.js). UI lives upstream.",
      pr:8,  brn:7,  ci:"passing", last:"1h",  spark:[8,7,9,6,11,8,12,9,7,10,8,6] },
    { n:"acme/docs",        lang:"md",   langC:"oklch(0.7 0.06 90)",
      desc:"Public engineering docs, mirrored from KB.",
      pr:1,  brn:2,  ci:"passing", last:"yesterday", spark:[1,2,1,3,2,1,2,3,2,1,2,1] },
  ];
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Repositories</h3>
        <span className="hint">4 connected · click to drill in</span>
        <div style={{flex:1}}/>
        <button className="btn ghost" style={{height:24, fontSize:10.5}}>+ connect more</button>
      </div>
      <div style={{display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:8}}>
        {repos.map(r=>(
          <div key={r.n} style={{
            padding:"12px 14px", borderRadius:6,
            background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
            cursor:"pointer",
          }}>
            <div style={{display:"flex", alignItems:"baseline", gap:8, marginBottom:4}}>
              <span style={{
                width:8, height:8, borderRadius:"50%", background:r.langC,
              }}/>
              <span style={{fontFamily:"var(--mono)", fontSize:12, color:"var(--fg)"}}>{r.n}</span>
              <div style={{flex:1}}/>
              <span style={{
                fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)",
              }}>{r.last}</span>
            </div>
            <div style={{fontSize:11, color:"var(--fg-muted)", lineHeight:1.5, marginBottom:8}}>
              {r.desc}
            </div>
            <div style={{display:"flex", alignItems:"center", gap:14,
              fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)"}}>
              <span>⊕ <b style={{color:"var(--fg)"}}>{r.pr}</b> PR</span>
              <span>⎇ <b style={{color:"var(--fg)"}}>{r.brn}</b></span>
              <span style={{color: r.ci==="passing"?"var(--success)":"var(--danger)"}}>
                ◉ ci {r.ci}
              </span>
              <div style={{flex:1}}/>
              <Sparkline data={r.spark}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Sparkline({ data, w=90, h=22, color="var(--accent)" }) {
  const max = Math.max(...data, 1);
  const min = 0;
  const pts = data.map((v,i)=>{
    const x = (i/(data.length-1))*w;
    const y = h - ((v - min) / (max - min)) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={w} height={h} style={{display:"block"}}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={w} cy={h - ((data[data.length-1]-min)/(max-min))*h} r="2" fill={color}/>
    </svg>
  );
}

// ============================================================
// CI health card
// ============================================================

function CIHealthCard() {
  // 7 days × 4 repos
  const matrix = [
    ["payments",    [1,1,1,0,1,1,1]],
    ["ledger-core", [1,1,1,1,1,0,0]],
    ["web",         [1,1,1,1,1,1,1]],
    ["docs",        [1,1,1,1,1,1,1]],
  ];
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>CI health</h3>
        <span className="hint">last 7 days · all branches</span>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:6}}>
        {matrix.map(([repo, runs])=>(
          <div key={repo} style={{display:"grid",
            gridTemplateColumns:"80px 1fr 28px",
            gap:8, alignItems:"center"}}>
            <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)",
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{repo}</span>
            <div style={{display:"flex", gap:4}}>
              {runs.map((r,i)=>(
                <div key={i} style={{
                  flex:1, height:14, borderRadius:3,
                  background: r ? "var(--success)" : "var(--danger)",
                  opacity: r ? 0.85 : 0.9,
                }}/>
              ))}
            </div>
            <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-dim)",
              textAlign:"right"}}>
              {runs.filter(r=>r).length}/{runs.length}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Main · ScreenGitHubSummary
// ============================================================

function ScreenGitHubSummary() {
  return (
    <div className="app">
      <Titlebar workspace="github · summary"/>
      <div className="shell">
        <Rail active="github"/>
        <div className="main">
          <GitHubPageMode active="summary"/>

          <section style={{flex:1, overflow:"auto", padding:"20px 24px", minWidth:0,
            background:"var(--bg-canvas)"}}>
            <div style={{maxWidth:1280, margin:"0 auto"}}>
              {/* Header */}
              <div style={{display:"flex", alignItems:"flex-start", gap:14, marginBottom:14}}>
                <div style={{flex:1}}>
                  <h2 style={{margin:0, fontFamily:"var(--mono)", fontSize:20, fontWeight:600}}>
                    Across all repositories
                  </h2>
                  <div style={{color:"var(--fg-muted)", fontSize:12, marginTop:4}}>
                    4 repos · 28-day view · synced from github.com/acme
                  </div>
                </div>
                <select className="input" style={{width:140}} defaultValue="28d">
                  <option value="28d">last 28 days</option>
                  <option>last 7 days</option>
                  <option>last 90 days</option>
                  <option>this iteration</option>
                </select>
                <button className="btn">browse repositories →</button>
              </div>

              {/* KPI row */}
              <div style={{display:"grid", gridTemplateColumns:"repeat(6, 1fr)", gap:8, marginBottom:14}}>
                {[
                  ["repositories", "4",      "all connected",   "fg"],
                  ["open PRs",     "14",     "3 awaiting you",  "accent"],
                  ["commits · 28d","347",    "+12% vs prior",   "success"],
                  ["CI passing",   "96%",    "2 red builds",    "info"],
                  ["contributors", "7",      "+ 2 bots",        "muted"],
                  ["lines · 28d",  "+18k/−7k","net +11k",       "muted"],
                ].map(([k,v,sub,tone])=>(
                  <div key={k} className="card" style={{padding:"10px 12px"}}>
                    <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                      textTransform:"uppercase", letterSpacing:".06em"}}>{k}</div>
                    <div style={{fontFamily:"var(--mono)", fontSize:18, fontWeight:600,
                      color: tone==="accent"?"var(--accent)"
                           : tone==="success"?"var(--success)"
                           : tone==="info"?"var(--info)":"var(--fg)",
                      marginTop:2}}>{v}</div>
                    <div style={{fontSize:10, color:"var(--fg-muted)", marginTop:1}}>{sub}</div>
                  </div>
                ))}
              </div>

              {/* 2 col grid */}
              <div style={{display:"grid", gridTemplateColumns:"1.7fr 1fr", gap:14}}>
                <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>
                  <ActivityHeatmap/>
                  <CrossRepoActivity/>
                  <OpenPRsAllRepos/>
                </div>
                <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>
                  <CIHealthCard/>
                  <ContributorsCard/>
                  <LanguageMix/>
                  <ReposGrid/>
                </div>
              </div>
            </div>
          </section>
          <StatusBar extra={<span className="s">4 repos · 14 open PRs · CI 96%</span>}/>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenGitHubSummary, GitHubPageMode });
