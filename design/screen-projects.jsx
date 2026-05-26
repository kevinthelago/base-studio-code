/* global React, Titlebar, Rail, StatusBar */

// ============================================================
// Projects · shell
// ============================================================

function ProjectsShell({ children, extra, workspace, tab, project, pageMode="projects" }) {
  return (
    <div className="app">
      <Titlebar workspace={workspace || "project planning"}/>
      <div className="shell">
        <Rail active="projects"/>
        <div className="main">
          {pageMode && typeof ProjectsPageMode !== "undefined" && <ProjectsPageMode active={pageMode}/>}
          {children}
          <StatusBar extra={extra}/>
        </div>
      </div>
    </div>
  );
}

function ProjectsHeader({ project, tab }) {
  const tabs = [
    { k:"board",    label:"Board",    hint:"kanban · per column" },
    { k:"roadmap",  label:"Roadmap",  hint:"milestones over time" },
    { k:"issues",   label:"Issues",   hint:"flat list · filter & sort" },
    { k:"insights", label:"Insights", hint:"velocity · burndown" },
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
            <span style={{
              padding:"1px 6px", borderRadius:3,
              fontFamily:"var(--mono)", fontSize:9.5, color:"var(--info)",
              background:"color-mix(in oklch, var(--info), transparent 88%)",
              border:"1px solid color-mix(in oklch, var(--info), transparent 70%)",
            }}>⎇ synced w/ github.com/{project.repo}/projects/{project.gh}</span>
          </div>
          <div style={{color:"var(--fg-muted)", fontSize:12, marginTop:4}}>{project.pitch}</div>
        </div>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          <input className="input" placeholder="⌕ filter…" style={{width:200}}/>
          <button className="btn ghost">claude triage</button>
          <button className="btn">+ issue</button>
        </div>
      </div>
      <div style={{
        height:36, marginTop:12,
        borderBottom:"1px solid var(--border-soft)",
        padding:"0 24px",
        display:"flex", alignItems:"end", gap:2,
      }}>
        {tabs.map(t=>{
          const on = t.k===tab;
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
              {on && <span style={{color:"var(--fg-dim)", fontSize:10}}>· {t.hint}</span>}
            </div>
          );
        })}
        <div style={{flex:1}}/>
        <div style={{display:"flex", gap:6, alignSelf:"center", paddingBottom:6,
          fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>
          group by · <span style={{color:"var(--accent)", cursor:"pointer"}}>status</span> ·
          <span style={{cursor:"pointer"}}>assignee</span> ·
          <span style={{cursor:"pointer"}}>milestone</span>
        </div>
      </div>
    </>
  );
}

// ============================================================
// Screen · Gated empty state (GitHub not connected)
// ============================================================

function ScreenProjectsGated() {
  return (
    <ProjectsShell pageMode={null} extra={<span className="s" style={{color:"var(--fg-dim)"}}>
      <i className="off"/> github · not connected · projects locked
    </span>}>
      <section style={{flex:1, display:"flex", alignItems:"center", justifyContent:"center",
        background:"var(--bg-canvas)", padding:"40px 32px", overflow:"auto"}}>
        <div style={{maxWidth:880, width:"100%", display:"grid", gridTemplateColumns:"1.1fr 1fr", gap:32, alignItems:"center"}}>
          {/* Lock card */}
          <div style={{
            padding:"34px 32px",
            background:"var(--bg-panel)",
            border:"1px solid var(--border-soft)",
            borderRadius:14,
            boxShadow:"0 18px 50px rgba(0,0,0,0.4)",
          }}>
            <div style={{
              width:54, height:54, borderRadius:14,
              background:"var(--bg-elev)", border:"1px solid var(--border)",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:"var(--mono)", fontSize:24, color:"var(--accent)", marginBottom:18,
            }}>🔒</div>
            <h2 style={{margin:"0 0 8px", fontFamily:"var(--mono)", fontSize:20, fontWeight:600}}>
              Projects need GitHub
            </h2>
            <p style={{margin:"0 0 22px", color:"var(--fg-muted)", fontSize:13, lineHeight:1.6}}>
              Boards, issues, and milestones in base-studio mirror real
              GitHub Projects — no parallel database, no drift, no
              re-keying. Connect once and your Kanban becomes the
              same Kanban your team sees on github.com.
            </p>

            <button className="btn primary" style={{
              height:38, padding:"0 22px", fontSize:13, fontWeight:600,
              width:"100%", justifyContent:"center", gap:10,
            }}>
              <span style={{fontFamily:"var(--mono)", fontSize:15}}>⎇</span>
              Connect with GitHub
            </button>

            <div style={{display:"flex", alignItems:"center", gap:10, margin:"16px 0",
              fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>
              <span style={{flex:1, height:1, background:"var(--border-soft)"}}/>
              <span>or</span>
              <span style={{flex:1, height:1, background:"var(--border-soft)"}}/>
            </div>

            <button className="btn ghost" style={{
              width:"100%", justifyContent:"center", height:34, fontSize:12,
            }}>Open a one-off AI scoping session (won't be saved)</button>

            <div style={{
              marginTop:20, padding:"12px 14px",
              borderRadius:6, background:"var(--bg-elev)",
              border:"1px solid var(--border-soft)",
            }}>
              <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                textTransform:"uppercase", letterSpacing:".06em", marginBottom:6}}>
                Scopes requested
              </div>
              <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
                <span className="tag">repo</span>
                <span className="tag">project</span>
                <span className="tag">issues</span>
                <span className="tag">read:org</span>
              </div>
            </div>
          </div>

          {/* What you get */}
          <div style={{display:"flex", flexDirection:"column", gap:14}}>
            <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
              textTransform:"uppercase", letterSpacing:".08em"}}>
              what you get
            </div>
            {[
              ["Kanban board",         "Real-time mirror of a GitHub Project. Drag to move; columns map to GH status fields."],
              ["AI issue breakdowns",  "Open any issue, ask Claude to break it into subtasks. Optionally creates them as linked issues."],
              ["Paired scoping",       "Start a new project from a one-line pitch; Claude asks questions until it can create issues + a milestone."],
              ["Roadmap view",         "Milestones laid out across time, with PR / commit activity inline."],
              ["Two-way sync",         "Edits here land on github.com immediately. Webhook events update the board live."],
            ].map(([h,b],i)=>(
              <div key={h} style={{
                padding:"12px 14px",
                background:"var(--bg-panel)",
                border:"1px solid var(--border-soft)", borderRadius:8,
                display:"grid", gridTemplateColumns:"22px 1fr", gap:10,
              }}>
                <span style={{
                  width:20, height:20, borderRadius:5,
                  background:"var(--bg-elev2)",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  color:"var(--accent)", fontFamily:"var(--mono)", fontWeight:700, fontSize:11,
                  marginTop:1,
                }}>{i+1}</span>
                <div>
                  <div style={{fontFamily:"var(--mono)", fontSize:12, color:"var(--fg)"}}>{h}</div>
                  <div style={{fontSize:11.5, color:"var(--fg-muted)", lineHeight:1.55, marginTop:2}}>{b}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </ProjectsShell>
  );
}

// ============================================================
// Screen · Projects list (GitHub-connected)
// ============================================================

const GH_PROJECTS = [
  { id:"prj_31a", gh:14, name:"Settlement webhooks v2",
    pitch:"Sub-second merchant dashboard notifications via webhook fanout.",
    repo:"acme/payments", iteration:"Iter 24 · ends Fri",
    issues:{open:17, total:23}, prs:3, milestones:5, owner:"lina",
    last:"4m ago", planning:false },
  { id:"prj_2fa", gh:15, name:"Offline pairing mode",
    pitch:"Same-LAN desktop ↔ mobile pairing without relay round-trip.",
    repo:"acme/payments", iteration:"drafting",
    issues:{open:0, total:0}, prs:0, milestones:0, owner:"lina",
    last:"yesterday", planning:true, progress:0.38 },
  { id:"prj_27e", gh:9,  name:"Knowledge → Notion sync",
    pitch:"One-way mirror of selected #docs blocks into a Notion workspace.",
    repo:"acme/docs", iteration:"Iter 12 · ends Wed",
    issues:{open:9, total:18}, prs:1, milestones:4, owner:"alex",
    last:"2d ago" },
  { id:"prj_24b", gh:6,  name:"Tunnel framing v2",
    pitch:"CBOR frames with prompt-cache hints for faster mobile streaming.",
    repo:"acme/payments", iteration:"shipped",
    issues:{open:0, total:21}, prs:0, milestones:6, owner:"lina",
    last:"last week" },
];

function ScreenProjectsList() {
  return (
    <ProjectsShell extra={<span className="s">{GH_PROJECTS.length} projects · github · lina-engelbrecht</span>}>
      <section style={{flex:1, overflow:"auto", padding:"24px 32px", minWidth:0}}>
        <div style={{maxWidth:1080, margin:"0 auto"}}>
          <div style={{display:"flex", alignItems:"flex-start", gap:14, marginBottom:18}}>
            <div style={{flex:1}}>
              <h2 style={{margin:0, fontFamily:"var(--mono)", fontSize:18, fontWeight:600}}>
                Projects
              </h2>
              <div style={{color:"var(--fg-muted)", fontSize:12, marginTop:4,
                display:"flex", alignItems:"center", gap:8}}>
                <span style={{color:"var(--success)"}}>● github connected</span>
                <span>·</span>
                <span>4 projects across 2 repos</span>
                <span>·</span>
                <span>last sync 4m ago</span>
              </div>
            </div>
            <button className="btn ghost">↻ sync</button>
            <button className="btn">import existing</button>
          </div>

          {/* Start-new CTA */}
          <div style={{
            background:"linear-gradient(135deg, color-mix(in oklch, var(--accent), transparent 86%), var(--bg-panel) 70%)",
            border:"1px solid var(--accent-dim)",
            borderRadius:12,
            padding:"22px 24px",
            marginBottom:20,
          }}>
            <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:10}}>
              <div style={{
                width:30, height:30, borderRadius:7,
                background:"linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
                color:"#1a120a", fontFamily:"var(--mono)", fontWeight:700, fontSize:13,
                display:"flex", alignItems:"center", justifyContent:"center",
              }}>C</div>
              <h3 style={{margin:0, fontFamily:"var(--mono)", fontSize:14}}>Plan a new project</h3>
              <span className="tag amber" style={{fontSize:10}}>publishes to github when ready</span>
              <div style={{flex:1}}/>
              <span className="hint">avg session: ~12 questions, 8 min → milestone + issues</span>
            </div>
            <div style={{
              padding:"12px 14px",
              background:"var(--bg-canvas)",
              border:"1px solid var(--border-soft)",
              borderRadius:8,
              display:"flex", alignItems:"center", gap:10,
              fontFamily:"var(--mono)", fontSize:12,
            }}>
              <span style={{color:"var(--accent)"}}>▸</span>
              <span style={{flex:1, color:"var(--fg-dim)"}}>
                pitch what you want to build…
              </span>
              <select className="input" style={{height:24, fontSize:10.5, width:170}} defaultValue="payments">
                <option value="payments">target · acme/payments</option>
                <option>acme/ledger-core</option>
                <option>acme/docs</option>
              </select>
              <span style={{padding:"3px 10px", borderRadius:4,
                background:"var(--accent)", color:"#1a120a", fontWeight:600, fontSize:11}}>
                ↵ start planning
              </span>
            </div>
            <div style={{display:"flex", gap:8, marginTop:10, fontSize:10.5,
              fontFamily:"var(--mono)", color:"var(--fg-muted)"}}>
              <span>from template:</span>
              {["bug fix","new feature","tech-debt","spike","migration","runbook"].map(t=>(
                <span key={t} style={{
                  padding:"2px 7px", borderRadius:99,
                  background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
                  color:"var(--fg-muted)", cursor:"pointer",
                }}>{t}</span>
              ))}
            </div>
          </div>

          {/* List */}
          <div style={{display:"flex", flexDirection:"column", gap:10}}>
            {GH_PROJECTS.map(p=>(<ProjectRow key={p.id} p={p}/>))}
          </div>
        </div>
      </section>
    </ProjectsShell>
  );
}

function ProjectRow({ p }) {
  const completion = p.issues.total ? (p.issues.total - p.issues.open) / p.issues.total : 0;
  const shipped = p.iteration === "shipped";

  return (
    <div className="card" style={{padding:"14px 18px",
      display:"grid", gridTemplateColumns:"1fr 220px 130px", gap:18, alignItems:"center"}}>
      <div style={{minWidth:0}}>
        <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:5}}>
          <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{p.id}</span>
          <h3 style={{margin:0, fontFamily:"var(--sans)", fontSize:14, color:"var(--fg)"}}>{p.name}</h3>
          {p.planning && <span className="tag amber" style={{fontSize:9.5}}>● drafting</span>}
          {shipped && <span className="tag" style={{fontSize:9.5}}>● shipped</span>}
          {!p.planning && !shipped && <span className="tag green" style={{fontSize:9.5}}>● active</span>}
          <span className="tag" style={{fontSize:9.5}}>{p.repo}</span>
          <span style={{
            fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)",
          }}>gh/projects/{p.gh}</span>
        </div>
        <div style={{color:"var(--fg-muted)", fontSize:12, lineHeight:1.55, marginBottom:8}}>{p.pitch}</div>

        {p.planning ? (
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            <div style={{
              flex:"0 0 220px", height:5, borderRadius:3,
              background:"var(--bg-elev2)", overflow:"hidden",
            }}>
              <div style={{width:`${(p.progress||0)*100}%`, height:"100%",
                background:"var(--accent)"}}/>
            </div>
            <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)"}}>
              {Math.round((p.progress||0)*100)}% planned · @planner asking
            </span>
          </div>
        ) : (
          <div style={{display:"flex", gap:14, fontFamily:"var(--mono)", fontSize:10.5,
            color:"var(--fg-muted)", flexWrap:"wrap"}}>
            <span><b style={{color:"var(--fg)"}}>{p.iteration}</b></span>
            <span>·</span>
            <span><b style={{color:"var(--fg)"}}>{p.milestones}</b> milestones</span>
            <span><b style={{color:"var(--fg)"}}>{p.issues.open}</b>/{p.issues.total} issues</span>
            <span><b style={{color:"var(--fg)"}}>{p.prs}</b> open PRs</span>
            <span>· @{p.owner}</span>
          </div>
        )}
      </div>

      {/* Completion bar */}
      {!p.planning && (
        <div style={{display:"flex", flexDirection:"column", gap:5}}>
          <div style={{display:"flex", justifyContent:"space-between",
            fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>
            <span>completion</span>
            <span style={{color:"var(--fg-muted)"}}>{Math.round(completion*100)}%</span>
          </div>
          <div style={{
            height:5, borderRadius:3,
            background:"var(--bg-elev2)", overflow:"hidden",
          }}>
            <div style={{width:`${completion*100}%`, height:"100%",
              background: shipped ? "var(--fg-dim)" : "var(--success)"}}/>
          </div>
        </div>
      )}
      {p.planning && <div/>}

      <div style={{display:"flex", flexDirection:"column", gap:6, alignItems:"flex-end"}}>
        <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{p.last}</span>
        <div style={{display:"flex", gap:6}}>
          {p.planning   && <button className="btn primary" style={{height:24, fontSize:10.5}}>resume</button>}
          {!p.planning  && <button className="btn primary" style={{height:24, fontSize:10.5}}>open board →</button>}
          <button className="btn ghost" style={{height:24, padding:"0 8px", fontSize:10.5}}>⋯</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Kanban board
// ============================================================

const CURRENT_PROJECT = {
  id:"prj_31a", name:"Settlement webhooks v2", gh:14,
  repo:"acme/payments", iteration:"Iter 24 · ends Fri",
  pitch:"Sub-second merchant dashboard notifications via webhook fanout. Replaces polling for the dashboard path only.",
};

const COLUMNS = [
  { k:"backlog",  title:"Backlog",     n:9,  color:"var(--fg-dim)" },
  { k:"upnext",   title:"Up next",     n:4,  color:"var(--info)" },
  { k:"doing",    title:"In progress", n:3,  color:"var(--accent)" },
  { k:"review",   title:"In review",   n:2,  color:"var(--success)" },
  { k:"done",     title:"Done · iter 24", n:5,  color:"var(--fg-muted)" },
];

const PEOPLE = {
  lina:  { color:"oklch(0.7 0.13 30)",  initial:"L" },
  alex:  { color:"oklch(0.7 0.10 220)", initial:"A" },
  pete:  { color:"oklch(0.68 0.13 145)",initial:"P" },
  zara:  { color:"oklch(0.7 0.12 290)", initial:"Z" },
  bot:   { color:"oklch(0.45 0 0)",     initial:"⌬" },
};

const LABELS = {
  net:        { c:"oklch(0.72 0.13 250)", t:"net" },
  perf:       { c:"oklch(0.78 0.14 70)",  t:"perf" },
  security:   { c:"oklch(0.7 0.18 25)",   t:"security" },
  docs:       { c:"oklch(0.7 0.06 90)",   t:"docs" },
  refactor:   { c:"oklch(0.68 0.05 280)", t:"refactor" },
  bug:        { c:"oklch(0.72 0.16 15)",  t:"bug" },
  infra:      { c:"oklch(0.65 0.08 195)", t:"infra" },
  api:        { c:"oklch(0.72 0.12 175)", t:"api" },
  test:       { c:"oklch(0.72 0.10 145)", t:"test" },
  "good-first":{ c:"oklch(0.65 0.10 130)", t:"good-first" },
};

const ISSUES = {
  backlog: [
    { n:432, t:"Add OpenAPI spec for /webhook publish",       labels:["docs","api"], who:[], ai:0, comments:1 },
    { n:431, t:"Document HMAC rotation runbook",              labels:["docs","security"], who:[], ai:2, comments:0 },
    { n:430, t:"Retry semantics: distinguish 4xx from 5xx",   labels:["refactor","net"], who:[], ai:0, comments:3 },
    { n:429, t:"Surface delivery errors in merchant dashboard",labels:["api"], who:["pete"], ai:4, comments:0 },
    { n:428, t:"Replay queue ops dashboard",                  labels:["infra"], who:[], ai:0, comments:0 },
    { n:427, t:"Limit concurrent retries per merchant",       labels:["net","perf"], who:[], ai:0, comments:1 },
    { n:426, t:"Subscriber SDK helper (Node + Python)",       labels:["api"], who:[], ai:6, comments:2 },
    { n:425, t:"Sandbox endpoint for partner testing",        labels:["infra","good-first"], who:[], ai:0, comments:0 },
    { n:424, t:"Audit log for delivered events",              labels:["security","infra"], who:[], ai:0, comments:0 },
  ],
  upnext: [
    { n:422, t:"Replay storm rate-limit",     labels:["net","perf"], who:["alex"], ai:2, comments:1, m:"M4" },
    { n:421, t:"Dead-letter queue + ops surface", labels:["infra"], who:["pete"], ai:3, comments:0, m:"M4" },
    { n:420, t:"Cutover plan + flag wiring",  labels:["net"], who:["lina"], ai:0, comments:2, m:"M5" },
    { n:419, t:"Decommission polling consumer (after shadow)", labels:["refactor"], who:["lina","alex"], ai:0, comments:0, m:"M5" },
  ],
  doing: [
    { n:418, t:"net: framing v2 + schema regen", labels:["net"],
      who:["lina","alex"], ai:3, comments:5, pr:"#418", m:"M1", focused:true,
      sub:["spec the v2 frame", "encoder + tests", "regen schema.json"] },
    { n:417, t:"Subscriber HMAC verification middleware", labels:["security","net"],
      who:["alex"], ai:2, comments:1, pr:"#417 draft", m:"M2" },
    { n:416, t:"Worker → webhook emitter", labels:["net"],
      who:["pete"], ai:1, comments:2, m:"M1" },
  ],
  review: [
    { n:414, t:"kb: backlinks + FTS5",            labels:["refactor"],
      who:["lina"], ai:0, comments:4, pr:"#414 ✓ approved", m:"M2" },
    { n:413, t:"Webhook URL: tokenized path + revocation", labels:["security","api"],
      who:["alex"], ai:0, comments:6, pr:"#413 needs work", m:"M2" },
  ],
  done: [
    { n:411, t:"docs: store migration",            labels:["docs"],     who:["bot"], ai:0, comments:0 },
    { n:410, t:"Spike: CBOR framing perf bench",   labels:["perf"],     who:["lina"], ai:0, comments:3 },
    { n:409, t:"Pick prompt-cache strategy",       labels:["perf"],     who:["lina"], ai:0, comments:2 },
    { n:408, t:"Worker tests: ledger event shape", labels:["test"],     who:["pete"], ai:0, comments:0 },
    { n:407, t:"Outage retro: 04/12 9-min lag",    labels:["docs","infra"], who:["zara"], ai:0, comments:5 },
  ],
};

function IssueCard({ c, focused, mini }) {
  return (
    <div style={{
      background: focused ? "color-mix(in oklch, var(--accent), transparent 92%)" : "var(--bg-canvas)",
      border:"1px solid " + (focused ? "var(--accent-dim)" : "var(--border-soft)"),
      borderRadius:6,
      padding: mini ? "7px 9px" : "9px 11px",
      display:"flex", flexDirection:"column", gap:5,
      cursor:"pointer",
      boxShadow: focused ? "0 4px 14px rgba(0,0,0,0.25)" : "none",
    }}>
      <div style={{display:"flex", alignItems:"baseline", gap:6}}>
        <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>#{c.n}</span>
        {c.m && <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--accent)"}}>{c.m}</span>}
        <div style={{flex:1}}/>
        {c.pr && (
          <span style={{
            fontFamily:"var(--mono)", fontSize:9, color:"var(--info)",
            padding:"1px 5px", borderRadius:3,
            background:"color-mix(in oklch, var(--info), transparent 88%)",
            border:"1px solid color-mix(in oklch, var(--info), transparent 70%)",
            whiteSpace:"nowrap",
          }}>⊕ {c.pr}</span>
        )}
      </div>

      <div style={{
        fontFamily:"var(--sans)", fontSize: mini ? 11 : 12,
        color:"var(--fg)", lineHeight:1.4,
      }}>{c.t}</div>

      {c.labels.length > 0 && (
        <div style={{display:"flex", gap:4, flexWrap:"wrap"}}>
          {c.labels.map(l=>{
            const L = LABELS[l] || {c:"var(--fg-dim)", t:l};
            return (
              <span key={l} style={{
                display:"inline-flex", alignItems:"center", gap:4,
                padding:"1px 6px", borderRadius:99,
                fontFamily:"var(--mono)", fontSize:9,
                background:`color-mix(in oklch, ${L.c}, transparent 84%)`,
                color: L.c,
                border: `1px solid color-mix(in oklch, ${L.c}, transparent 70%)`,
              }}>
                <span style={{width:5, height:5, borderRadius:"50%", background:L.c}}/>
                {L.t}
              </span>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div style={{display:"flex", alignItems:"center", gap:6, marginTop:1}}>
        {/* Avatars */}
        <div style={{display:"flex"}}>
          {c.who.map((w,i)=>{
            const P = PEOPLE[w];
            return (
              <span key={w} title={"@"+w} style={{
                width:18, height:18, borderRadius:"50%",
                background:P.color,
                color:"#1a120a",
                fontFamily:"var(--mono)", fontWeight:700, fontSize:10,
                display:"flex", alignItems:"center", justifyContent:"center",
                marginLeft: i===0 ? 0 : -6,
                border:"1.5px solid var(--bg-canvas)",
              }}>{P.initial}</span>
            );
          })}
          {c.who.length===0 && <span style={{
            width:18, height:18, borderRadius:"50%",
            border:"1px dashed var(--border)", color:"var(--fg-dim)",
            fontFamily:"var(--mono)", fontSize:10,
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>?</span>}
        </div>
        <div style={{flex:1}}/>
        <div style={{display:"flex", gap:7, fontFamily:"var(--mono)", fontSize:9.5,
          color:"var(--fg-dim)"}}>
          {c.ai > 0 && (
            <span title="AI-suggested subtasks" style={{color:"var(--accent)"}}>
              ✦ {c.ai}
            </span>
          )}
          {c.comments > 0 && <span>💬 {c.comments}</span>}
        </div>
      </div>
    </div>
  );
}

function Column({ col, issues }) {
  return (
    <div style={{
      flex:"1 1 0", minWidth:230,
      display:"flex", flexDirection:"column",
      background:"var(--bg-panel)",
      borderRadius:8,
      border:"1px solid var(--border-soft)",
      overflow:"hidden",
    }}>
      <div style={{
        padding:"10px 12px",
        borderBottom:"1px solid var(--border-soft)",
        background:"var(--bg-elev)",
        display:"flex", alignItems:"center", gap:8,
        fontFamily:"var(--mono)", fontSize:11,
      }}>
        <span style={{width:7, height:7, borderRadius:"50%", background:col.color}}/>
        <span style={{color:"var(--fg)"}}>{col.title}</span>
        <span style={{color:"var(--fg-dim)"}}>{col.n}</span>
        <div style={{flex:1}}/>
        <span style={{color:"var(--fg-dim)", cursor:"pointer"}}>+</span>
        <span style={{color:"var(--fg-dim)", cursor:"pointer"}}>⋯</span>
      </div>

      <div style={{
        flex:1, overflow:"auto",
        padding:8, display:"flex", flexDirection:"column", gap:7,
      }}>
        {issues.map(c=>(<IssueCard key={c.n} c={c} focused={c.focused}/>))}
        <div style={{
          marginTop:4, padding:"7px 9px",
          border:"1px dashed var(--border)",
          borderRadius:5, textAlign:"center",
          fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
          cursor:"pointer",
        }}>+ new card</div>
      </div>
    </div>
  );
}

function ScreenProjectBoard() {
  return (
    <ProjectsShell
      workspace={`projects · ${CURRENT_PROJECT.name} · board`}
      extra={<span className="s">{CURRENT_PROJECT.id} · github sync 4m ago · 17 open</span>}>
      <ProjectsHeader project={CURRENT_PROJECT} tab="board"/>
      <section style={{flex:1, padding:"14px 16px", overflow:"hidden",
        background:"var(--bg-canvas)"}}>
        <div style={{display:"flex", gap:10, height:"100%", overflow:"auto"}}>
          {COLUMNS.map(col=>(
            <Column key={col.k} col={col} issues={ISSUES[col.k]}/>
          ))}
        </div>
      </section>
    </ProjectsShell>
  );
}

// ============================================================
// Issue drawer — full card with AI subtask breakdown
// ============================================================

function ScreenIssueDrawer() {
  const issue = ISSUES.doing[0]; // #418
  return (
    <ProjectsShell
      workspace={`projects · ${CURRENT_PROJECT.name} · #${issue.n}`}
      extra={<span className="s">{CURRENT_PROJECT.id} · viewing issue #{issue.n}</span>}>
      <ProjectsHeader project={CURRENT_PROJECT} tab="board"/>

      <section style={{flex:1, position:"relative", overflow:"hidden",
        background:"var(--bg-canvas)"}}>
        {/* Board faded behind */}
        <div style={{position:"absolute", inset:0, padding:"14px 16px", opacity:0.35, pointerEvents:"none"}}>
          <div style={{display:"flex", gap:10, height:"100%"}}>
            {COLUMNS.map(col=>(
              <Column key={col.k} col={col} issues={ISSUES[col.k].slice(0,3)}/>
            ))}
          </div>
        </div>

        {/* Drawer */}
        <aside style={{
          position:"absolute", top:0, right:0, bottom:0,
          width:680,
          background:"var(--bg-panel)",
          borderLeft:"1px solid var(--border)",
          boxShadow:"-20px 0 60px rgba(0,0,0,0.5)",
          display:"flex", flexDirection:"column",
        }}>
          {/* Drawer header */}
          <div style={{padding:"14px 20px", borderBottom:"1px solid var(--border-soft)",
            background:"var(--bg-elev)",
            display:"flex", alignItems:"flex-start", gap:10}}>
            <div style={{flex:1}}>
              <div style={{display:"flex", alignItems:"baseline", gap:10}}>
                <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--fg-dim)"}}>#{issue.n}</span>
                <h3 style={{margin:0, fontFamily:"var(--sans)", fontSize:15, color:"var(--fg)"}}>{issue.t}</h3>
              </div>
              <div style={{display:"flex", gap:6, marginTop:8, flexWrap:"wrap", alignItems:"center"}}>
                <span className="tag amber" style={{fontSize:9.5}}>● in progress</span>
                <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)"}}>{issue.m} · Publisher MVP</span>
                {issue.labels.map(l=>{
                  const L=LABELS[l]||{c:"var(--fg-dim)",t:l};
                  return (
                    <span key={l} style={{
                      display:"inline-flex", alignItems:"center", gap:4,
                      padding:"1px 6px", borderRadius:99,
                      fontFamily:"var(--mono)", fontSize:9,
                      background:`color-mix(in oklch, ${L.c}, transparent 84%)`,
                      color:L.c,
                      border:`1px solid color-mix(in oklch, ${L.c}, transparent 70%)`,
                    }}>
                      <span style={{width:5, height:5, borderRadius:"50%", background:L.c}}/>{L.t}
                    </span>
                  );
                })}
              </div>
            </div>
            <button className="btn ghost" style={{height:26}}>open on github →</button>
            <button className="btn ghost" style={{height:26, padding:"0 8px"}}>✕</button>
          </div>

          <div style={{flex:1, overflow:"auto", display:"flex", flexDirection:"column"}}>
            {/* Body */}
            <div style={{padding:"16px 20px", borderBottom:"1px solid var(--border-soft)"}}>
              <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                textTransform:"uppercase", letterSpacing:".06em", marginBottom:8}}>description</div>
              <div style={{fontFamily:"var(--sans)", fontSize:12.5, color:"var(--fg-muted)", lineHeight:1.65}}>
                Replace the v1 fixed-size frame with a CBOR-encoded variant carrying capability
                hints and a payload version. The encoder should expose a `Frame::new(payload, caps)`
                constructor and regenerate <code style={{fontFamily:"var(--mono)", color:"var(--fg)"}}>schema.json</code> on build.
                <br/><br/>
                See blk_71fe for the framing decision and acceptance bar.
              </div>
            </div>

            {/* AI subtask breakdown */}
            <div style={{padding:"14px 20px", borderBottom:"1px solid var(--border-soft)"}}>
              <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
                <div style={{
                  width:20, height:20, borderRadius:5,
                  background:"linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
                  color:"#1a120a", fontFamily:"var(--mono)", fontWeight:700, fontSize:11,
                  display:"flex", alignItems:"center", justifyContent:"center",
                }}>C</div>
                <span style={{fontFamily:"var(--mono)", fontSize:11.5, color:"var(--fg)"}}>Claude · subtask breakdown</span>
                <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>generated 3m ago</span>
                <div style={{flex:1}}/>
                <button className="btn ghost" style={{height:22, padding:"0 8px", fontSize:10}}>regenerate</button>
              </div>
              <div style={{display:"flex", flexDirection:"column", gap:6}}>
                {[
                  { n:1, t:"Spec the v2 frame shape", done:true,
                    note:"checked-in to docs/framing.md @ b04",
                    estimate:"½d" },
                  { n:2, t:"Encoder + tests (round-trip + size budget)",
                    note:"draft on feat/tunnel-v2 · 70% complete",
                    estimate:"1d" },
                  { n:3, t:"Regenerate schema.json from proto.rs",
                    note:"CI must fail on drift — see ci.yml step",
                    estimate:"¼d" },
                  { n:4, t:"Capability negotiation in pairing hello", isNew:true,
                    note:"suggested · client must downgrade gracefully",
                    estimate:"½d" },
                ].map(s=>(
                  <div key={s.n} style={{
                    display:"grid", gridTemplateColumns:"22px 1fr auto auto",
                    gap:10, padding:"8px 10px",
                    background: s.isNew ? "color-mix(in oklch, var(--accent), transparent 92%)" : "var(--bg-canvas)",
                    border:"1px solid " + (s.isNew?"var(--accent-dim)":"var(--border-soft)"),
                    borderRadius:5, alignItems:"start",
                  }}>
                    <span style={{
                      width:16, height:16, borderRadius:4,
                      border:"1px solid " + (s.done?"var(--success)":"var(--border)"),
                      background: s.done ? "var(--success)" : "transparent",
                      color:"#1a120a", fontFamily:"var(--mono)", fontSize:11, fontWeight:700,
                      display:"flex", alignItems:"center", justifyContent:"center",
                    }}>{s.done?"✓":""}</span>
                    <div>
                      <div style={{fontFamily:"var(--sans)", fontSize:12,
                        color: s.done?"var(--fg-muted)":"var(--fg)",
                        textDecoration: s.done?"line-through":"none"}}>
                        {s.t}
                        {s.isNew && <span style={{
                          marginLeft:8, padding:"1px 5px", borderRadius:3,
                          fontFamily:"var(--mono)", fontSize:9, color:"var(--accent)",
                          background:"color-mix(in oklch, var(--accent), transparent 80%)",
                        }}>✦ new suggestion</span>}
                      </div>
                      <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)", marginTop:2}}>{s.note}</div>
                    </div>
                    <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)"}}>{s.estimate}</span>
                    <span style={{color:"var(--fg-dim)", fontFamily:"var(--mono)", fontSize:11, cursor:"pointer"}}>⋯</span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex", gap:8, marginTop:10}}>
                <button className="btn primary" style={{height:24, fontSize:10.5}}>
                  ✦ create 1 new issue from suggestion
                </button>
                <button className="btn ghost" style={{height:24, fontSize:10.5}}>break down further…</button>
                <div style={{flex:1}}/>
                <span className="hint">estimates fed back into M1 burn-down</span>
              </div>
            </div>

            {/* Activity */}
            <div style={{padding:"14px 20px", borderBottom:"1px solid var(--border-soft)"}}>
              <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                textTransform:"uppercase", letterSpacing:".06em", marginBottom:10}}>activity · 5</div>
              <div style={{display:"flex", flexDirection:"column", gap:9, fontSize:11.5}}>
                {[
                  { who:"lina", a:"opened the issue", t:"yesterday 16:02" },
                  { who:"alex", a:"left a comment: \"can we hold for the encoder benchmark?\"", t:"yesterday 17:14" },
                  { who:"bot",  a:"linked PR #418 (draft)", t:"yesterday 18:01" },
                  { who:"lina", a:"moved to In progress · self-assigned + @alex", t:"today 10:42" },
                  { who:"bot",  a:"CI · clippy passed · cargo test passed", t:"today 11:08" },
                ].map((a,i)=>(
                  <div key={i} style={{display:"grid", gridTemplateColumns:"22px 1fr auto", gap:10, alignItems:"baseline"}}>
                    <span style={{
                      width:18, height:18, borderRadius:"50%",
                      background:PEOPLE[a.who].color,
                      color:"#1a120a", fontFamily:"var(--mono)", fontWeight:700, fontSize:10,
                      display:"flex", alignItems:"center", justifyContent:"center",
                    }}>{PEOPLE[a.who].initial}</span>
                    <div>
                      <b style={{color:"var(--fg)", fontFamily:"var(--mono)", fontSize:11}}>@{a.who}</b>
                      <span style={{color:"var(--fg-muted)"}}> {a.a}</span>
                    </div>
                    <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{a.t}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Composer */}
            <div style={{padding:"14px 20px", display:"flex", flexDirection:"column", gap:8,
              background:"var(--bg-elev)"}}>
              <textarea className="input" placeholder="leave a comment, or /assign, /label, /close, /ai breakdown…"
                style={{height:60, padding:"8px 10px", fontFamily:"var(--mono)", fontSize:11}}/>
              <div style={{display:"flex", gap:8, alignItems:"center"}}>
                <button className="btn ghost" style={{height:24, fontSize:10.5}}>✦ ask claude…</button>
                <button className="btn ghost" style={{height:24, fontSize:10.5}}>open in pane</button>
                <div style={{flex:1}}/>
                <button className="btn ghost" style={{height:24, fontSize:10.5}}>close</button>
                <button className="btn primary" style={{height:24, fontSize:10.5}}>comment</button>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </ProjectsShell>
  );
}

// ============================================================
// Roadmap / timeline view
// ============================================================

function ScreenProjectRoadmap() {
  const milestones = [
    { id:"M1", t:"Publisher MVP",                week:0, length:2, st:"doing",  pct:0.72, who:["lina","pete"] },
    { id:"M2", t:"Subscriber endpoint + auth",   week:1, length:3, st:"doing",  pct:0.40, who:["alex"] },
    { id:"M3", t:"Dashboard live-update",        week:2, length:2, st:"upnext", pct:0.0,  who:["lina"] },
    { id:"M4", t:"Replay + dead-letter",         week:3, length:3, st:"upnext", pct:0.0,  who:["alex","pete"] },
    { id:"M5", t:"Shadow + cutover",             week:5, length:3, st:"backlog",pct:0.0,  who:["lina","alex"] },
  ];
  const today = 2.3; // week 2.3 of 8

  return (
    <ProjectsShell
      workspace={`projects · ${CURRENT_PROJECT.name} · roadmap`}
      extra={<span className="s">{CURRENT_PROJECT.id} · iter 24 · 5 milestones · 8 weeks</span>}>
      <ProjectsHeader project={CURRENT_PROJECT} tab="roadmap"/>
      <section style={{flex:1, overflow:"auto", padding:"18px 24px"}}>
        <div style={{maxWidth:1240, margin:"0 auto"}}>
          {/* Stats */}
          <div style={{display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:10, marginBottom:18}}>
            {[
              ["this iteration", "17 issues open", "of 23 · 5 in progress","accent"],
              ["velocity",       "8.2/wk",         "last 4 weeks",         "info"],
              ["burn-down",      "on track",       "−2.4 issues/wk avg",   "success"],
              ["risk",           "1 medium",       "M4 — replay storm",    "danger"],
            ].map(([k,v,sub,tone])=>(
              <div key={k} className="card" style={{padding:"10px 14px"}}>
                <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                  textTransform:"uppercase", letterSpacing:".06em"}}>{k}</div>
                <div style={{fontFamily:"var(--mono)", fontSize:16, fontWeight:600,
                  color: tone==="accent"?"var(--accent)"
                       : tone==="info"?"var(--info)"
                       : tone==="success"?"var(--success)"
                       : tone==="danger"?"var(--danger)":"var(--fg)",
                  marginTop:2}}>{v}</div>
                <div style={{fontSize:10.5, color:"var(--fg-muted)", marginTop:1}}>{sub}</div>
              </div>
            ))}
          </div>

          {/* Gantt */}
          <div className="card" style={{padding:"16px 20px"}}>
            <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:14}}>
              <h3 style={{margin:0}}>Milestones · weeks</h3>
              <span className="hint">drag to reschedule · click a bar for issue list</span>
              <div style={{flex:1}}/>
              <select className="input" style={{height:24, fontSize:10.5, width:120}} defaultValue="weeks">
                <option value="weeks">by week</option>
                <option>by day</option>
                <option>by iteration</option>
              </select>
            </div>

            {/* Header row of weeks */}
            <div style={{display:"grid", gridTemplateColumns:"230px 1fr", gap:14, marginBottom:8}}>
              <div/>
              <div style={{position:"relative", height:24,
                display:"grid", gridTemplateColumns:"repeat(8, 1fr)"}}>
                {Array.from({length:8}, (_,i)=>(
                  <div key={i} style={{
                    fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
                    borderLeft: i===0 ? "none" : "1px dashed var(--border-soft)",
                    paddingLeft:6, paddingTop:4,
                  }}>w{i+1}</div>
                ))}
                {/* today marker */}
                <div style={{
                  position:"absolute", top:0, bottom:-300,
                  left:`${today/8*100}%`,
                  width:0, borderLeft:"1.5px dashed var(--accent)",
                  zIndex:2,
                }}>
                  <span style={{position:"absolute", top:-2, left:4,
                    fontFamily:"var(--mono)", fontSize:9.5, color:"var(--accent)"}}>today</span>
                </div>
              </div>
            </div>

            {/* Rows */}
            <div style={{display:"flex", flexDirection:"column", gap:8}}>
              {milestones.map(m=>(
                <div key={m.id} style={{
                  display:"grid", gridTemplateColumns:"230px 1fr",
                  gap:14, alignItems:"center",
                }}>
                  <div>
                    <div style={{display:"flex", alignItems:"baseline", gap:6}}>
                      <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--accent)"}}>{m.id}</span>
                      <span style={{fontFamily:"var(--sans)", fontSize:12, color:"var(--fg)"}}>{m.t}</span>
                    </div>
                    <div style={{display:"flex", gap:4, marginTop:5}}>
                      {m.who.map((w,i)=>{
                        const P=PEOPLE[w];
                        return (
                          <span key={w} style={{
                            width:16, height:16, borderRadius:"50%",
                            background:P.color, color:"#1a120a",
                            fontFamily:"var(--mono)", fontWeight:700, fontSize:9,
                            display:"flex", alignItems:"center", justifyContent:"center",
                            marginLeft: i===0?0:-4,
                            border:"1.5px solid var(--bg-panel)",
                          }}>{P.initial}</span>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{position:"relative", height:32}}>
                    {/* row background grid */}
                    {Array.from({length:8}, (_,i)=>(
                      <div key={i} style={{
                        position:"absolute", top:0, bottom:0,
                        left:`${i/8*100}%`, width:1,
                        background:"var(--border-soft)",
                      }}/>
                    ))}
                    {/* bar */}
                    <div style={{
                      position:"absolute", top:4, bottom:4,
                      left:`${m.week/8*100}%`,
                      width:`${m.length/8*100}%`,
                      borderRadius:5,
                      background: m.st==="doing" ? "color-mix(in oklch, var(--accent), transparent 70%)"
                                : m.st==="upnext"? "color-mix(in oklch, var(--info), transparent 80%)"
                                : "var(--bg-elev2)",
                      border:"1px solid " + (m.st==="doing"?"var(--accent-dim)":m.st==="upnext"?"color-mix(in oklch, var(--info), transparent 60%)":"var(--border-soft)"),
                      overflow:"hidden",
                      display:"flex", alignItems:"center",
                    }}>
                      {m.pct > 0 && (
                        <div style={{
                          position:"absolute", inset:0,
                          width:`${m.pct*100}%`,
                          background:"color-mix(in oklch, var(--accent), transparent 40%)",
                        }}/>
                      )}
                      <span style={{
                        position:"relative",
                        padding:"0 10px",
                        fontFamily:"var(--mono)", fontSize:10.5,
                        color: m.st==="backlog" ? "var(--fg-muted)" : "var(--fg)",
                        whiteSpace:"nowrap",
                      }}>
                        {m.length}w · {m.pct>0 ? `${Math.round(m.pct*100)}% done` : "not started"}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Burn-down */}
          <div className="card" style={{padding:"16px 20px", marginTop:14}}>
            <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:14}}>
              <h3 style={{margin:0}}>Burn-down · iter 24</h3>
              <span className="hint">23 issues opened · 6 closed · 17 remaining</span>
            </div>
            <BurnDown/>
          </div>
        </div>
      </section>
    </ProjectsShell>
  );
}

function BurnDown() {
  // 14 days
  const days = 14;
  const ideal = Array.from({length:days+1}, (_,i)=>23 - 23*(i/days));
  const actual = [23,23,22,22,21,20,20,19,19,18,18,17,null,null,null];
  const W = 1140, H = 160, PAD = {l:36, r:20, t:14, b:24};
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = i => PAD.l + (i/days)*innerW;
  const y = v => PAD.t + (1 - v/23)*innerH;
  const idealPath = ideal.map((v,i)=>`${i===0?"M":"L"} ${x(i)} ${y(v)}`).join(" ");
  const actualPath = actual.filter(v=>v!=null).map((v,i)=>`${i===0?"M":"L"} ${x(i)} ${y(v)}`).join(" ");
  return (
    <svg width={W} height={H} style={{width:"100%", maxWidth:W, display:"block"}}>
      {/* gridlines */}
      {[0,5,10,15,20,23].map(v=>(
        <g key={v}>
          <line x1={PAD.l} y1={y(v)} x2={W-PAD.r} y2={y(v)} stroke="var(--border-soft)" strokeDasharray="2 3"/>
          <text x={PAD.l-4} y={y(v)+3} textAnchor="end"
            fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{v}</text>
        </g>
      ))}
      {Array.from({length:days+1}, (_,i)=>(
        i%2===0 ? (
          <text key={i} x={x(i)} y={H-PAD.b+12} textAnchor="middle"
            fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">d{i+1}</text>
        ) : null
      ))}
      <path d={idealPath} fill="none" stroke="var(--fg-dim)" strokeDasharray="3 4" strokeWidth="1.5"/>
      <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth="2"/>
      {actual.map((v,i)=>v!=null && (
        <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill="var(--accent)"/>
      ))}
      {/* today marker */}
      <line x1={x(11)} y1={PAD.t} x2={x(11)} y2={H-PAD.b}
        stroke="var(--accent)" strokeDasharray="2 3" strokeWidth="1"/>
      <text x={x(11)} y={PAD.t-3} textAnchor="middle"
        fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">today</text>
      <text x={x(days)-2} y={y(actual.filter(v=>v!=null).pop())-6} textAnchor="end"
        fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">actual · 17</text>
      <text x={x(days)-2} y={y(ideal[days])-6} textAnchor="end"
        fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">ideal · 0</text>
    </svg>
  );
}

// ============================================================
// (kept) Active planning session — now publishes to GitHub
// ============================================================

const PLAN_TURNS = [
  { role:"assistant", blocks:[
    { kind:"text", text:"Got it — settlement webhooks v2. Let's scope it.\n\nFirst: **what's breaking with the current polling setup?** Is it latency for customers, infra cost, or both?" },
  ]},
  { role:"user", text:"mostly latency. p95 is 9–12s and merchants are noticing. cost is fine for now." },
  { role:"assistant", blocks:[
    { kind:"tool", tool:"kb.search", args:"settlement, polling, sla", ok:true, summary:"3 blocks pinned" },
    { kind:"text", text:"Found prior decisions — pinning **blk_2199 (SQLite over LMDB)** and **blk_71fe (Tunnel framing v2)** for context.\n\nWhat's your target p95? And who's the audience for the notification — the merchant dashboard, an email/SMS hook, or both?" },
  ]},
  { role:"user", text:"sub-second for the dashboard. email/SMS can stay async; we don't need that to be fast." },
  { role:"assistant", blocks:[
    { kind:"thinking", dur:"2s", text:"Two surfaces with different SLAs — that splits the design cleanly. The dashboard path is the hard part." },
    { kind:"text", text:"Logged **Goal 1: dashboard p95 ≤ 1s**. Next: **who pays the webhook?** Our own settlement worker, Stripe events, or a mix?" },
  ]},
];

const PLAN_SECTIONS = [
  { k:"pitch",       title:"Pitch",       state:"confirmed",
    body:"Move settlement events off polling and onto webhooks for sub-second customer notifications." },
  { k:"problem",     title:"Problem",     state:"confirmed",
    body:"Polling-based settlement updates land in the merchant dashboard at p95 9–12s; merchants notice." },
  { k:"users",       title:"Audiences",   state:"confirmed",
    items:[
      { label:"merchant dashboard", note:"sub-second SLA · the hard target" },
      { label:"email / SMS hooks",  note:"can stay async · no SLA change" },
    ]},
  { k:"goals",       title:"Goals",       state:"confirmed",
    items:[
      { label:"dashboard p95 ≤ 1s",          tag:"primary" },
      { label:"no regression on email/SMS",  tag:"guardrail" },
    ]},
  { k:"non-goals",   title:"Non-goals",   state:"drafted",
    items:[
      { label:"replacing the stripe-events fanout pipeline" },
      { label:"merchant-side webhook delivery (out of scope this quarter)" },
    ]},
  { k:"constraints", title:"Constraints", state:"asking",
    pendingQ:"who pays the webhook? are these stripe-issued, our own worker, or both?",
    items:[
      { label:"deadline · this quarter", note:"merchant op-review on July 14" },
      { label:"team · 2 engineers", note:"lina + alex" },
    ]},
  { k:"approach",    title:"Approach · phases", state:"pending" },
  { k:"risks",       title:"Risks",       state:"pending" },
  { k:"open",        title:"Open questions", state:"pending", items:[] },
];

function ScreenProjectPlanning() {
  return (
    <ProjectsShell
      workspace="project planning · settlement webhooks v2"
      extra={<span className="s">prj_2fa · drafting · 38% planned · paired with @planner · will publish to acme/payments</span>}
    >
      <div style={{padding:"14px 24px 0", display:"flex", alignItems:"flex-start", gap:14}}>
        <div style={{flex:1}}>
          <div style={{display:"flex", alignItems:"baseline", gap:10}}>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>prj_2fa</span>
            <h2 style={{margin:0, fontFamily:"var(--mono)", fontSize:16, fontWeight:600}}>Settlement webhooks v2</h2>
            <span className="tag amber">● drafting</span>
            <span className="tag">acme/payments</span>
            <span style={{
              padding:"1px 6px", borderRadius:3,
              fontFamily:"var(--mono)", fontSize:9.5, color:"var(--info)",
              background:"color-mix(in oklch, var(--info), transparent 88%)",
              border:"1px solid color-mix(in oklch, var(--info), transparent 70%)",
            }}>will publish as gh project + 5 issues</span>
          </div>
          <div style={{color:"var(--fg-muted)", fontSize:12, marginTop:4}}>
            paired with <b style={{color:"var(--fg)"}}>@planner</b> · sonnet-4.5 · 6 of an estimated 12 questions
          </div>
        </div>
        <button className="btn ghost">save & exit</button>
        <button className="btn">pause</button>
        <button className="btn primary" disabled style={{opacity:.5, cursor:"not-allowed"}}>publish to github · 62% to go</button>
      </div>

      <div style={{padding:"14px 24px 12px", display:"flex", gap:6}}>
        {PLAN_SECTIONS.map(s=>{
          const tone = s.state==="confirmed" ? "var(--accent)"
                    : s.state==="drafted"   ? "color-mix(in oklch, var(--accent), transparent 50%)"
                    : s.state==="asking"    ? "var(--info)"
                    :                          "var(--bg-elev2)";
          return (
            <div key={s.k} style={{
              flex:1, height:5, borderRadius:3,
              background:tone,
              border: s.state==="asking" ? "1px solid var(--info)" : "0",
              boxShadow: s.state==="asking" ? "0 0 0 2px color-mix(in oklch, var(--info), transparent 75%)" : "none",
            }} title={s.title}/>
          );
        })}
      </div>

      <div style={{flex:1, display:"flex", minHeight:0,
        borderTop:"1px solid var(--border-soft)"}}>

        <section style={{flex:"1 1 0", display:"flex", flexDirection:"column",
          borderRight:"1px solid var(--border-soft)"}}>
          <div style={{padding:"10px 18px", background:"var(--bg-panel)",
            borderBottom:"1px solid var(--border-soft)",
            display:"flex", alignItems:"center", gap:8,
            fontFamily:"var(--mono)", fontSize:11, color:"var(--fg-muted)"}}>
            <span style={{color:"var(--accent)"}}>▸ planning chat</span>
            <span>·</span><span>question 6 of ~12</span>
            <div style={{flex:1}}/>
            <span style={{color:"var(--fg-dim)"}}>tools: kb.search · gh.issues · git.log</span>
          </div>
          <div style={{flex:1, overflow:"auto", padding:"16px 22px",
            display:"flex", flexDirection:"column", gap:14,
            fontFamily:"var(--sans)", fontSize:12, lineHeight:1.6}}>
            {PLAN_TURNS.map((t,i)=>(<PlanTurn key={i} t={t}/>))}
          </div>
          <div style={{padding:"12px 18px", borderTop:"1px solid var(--border-soft)",
            background:"var(--bg-panel)"}}>
            <div style={{padding:"10px 12px", background:"var(--bg-canvas)",
              border:"1px solid var(--border-soft)", borderRadius:6,
              display:"flex", flexDirection:"column", gap:8, minHeight:60}}>
              <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--fg)"}}>
                our own worker. stripe events come in separately and we re-emit.
              </div>
              <div style={{display:"flex", alignItems:"center", gap:6, marginTop:4,
                fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>
                <span className="kbd">⌘↵</span> send
                <span>·</span>
                <span className="kbd">/skip</span> skip
                <span>·</span>
                <span className="kbd">/revisit</span> revisit a section
                <div style={{flex:1}}/>
                <span style={{color:"var(--accent)"}}>↵ send answer</span>
              </div>
            </div>
          </div>
        </section>

        <aside style={{flex:"0 0 430px", display:"flex", flexDirection:"column",
          background:"var(--bg-panel)"}}>
          <div style={{padding:"10px 18px", borderBottom:"1px solid var(--border-soft)",
            display:"flex", alignItems:"center", gap:8,
            fontFamily:"var(--mono)", fontSize:11, color:"var(--fg-muted)"}}>
            <span style={{color:"var(--accent)"}}>⌘ plan · building</span>
            <div style={{flex:1}}/>
            <span style={{color:"var(--fg-dim)"}}>preview on github →</span>
          </div>
          <div style={{flex:1, overflow:"auto", padding:"14px 18px",
            display:"flex", flexDirection:"column", gap:12}}>
            {PLAN_SECTIONS.map(s=>(<PlanSection key={s.k} s={s}/>))}

            {/* GH publish preview */}
            <div style={{
              padding:"12px 14px", borderRadius:6,
              background:"color-mix(in oklch, var(--info), transparent 90%)",
              border:"1px solid color-mix(in oklch, var(--info), transparent 70%)",
              fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)", lineHeight:1.6,
            }}>
              <div style={{color:"var(--info)", textTransform:"uppercase", letterSpacing:".06em", marginBottom:6}}>
                will publish (after confirm)
              </div>
              <div>+ project · <b style={{color:"var(--fg)"}}>Settlement webhooks v2</b></div>
              <div>+ milestone · <b style={{color:"var(--fg)"}}>v2 launch · Jul 14</b></div>
              <div>+ 5 issues · 1 per phase, w/ labels & assignees</div>
              <div>+ 1 knowledge block · auto-pinned to project</div>
            </div>
          </div>
        </aside>
      </div>
    </ProjectsShell>
  );
}

function PlanTurn({ t }) {
  if (t.role === "user") {
    return (
      <div style={{display:"flex", justifyContent:"flex-end"}}>
        <div style={{maxWidth:"80%", padding:"8px 12px", borderRadius:8,
          background:"color-mix(in oklch, var(--info), transparent 86%)",
          border:"1px solid color-mix(in oklch, var(--info), transparent 70%)",
          color:"var(--fg)"}}>{t.text}</div>
      </div>
    );
  }
  return (
    <div style={{display:"flex", gap:10}}>
      <div style={{flex:"0 0 26px", width:26, height:26, borderRadius:6,
        background:"linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
        color:"#1a120a", fontFamily:"var(--mono)", fontWeight:700, fontSize:12,
        display:"flex", alignItems:"center", justifyContent:"center", marginTop:2}}>C</div>
      <div style={{flex:1, display:"flex", flexDirection:"column", gap:6}}>
        {t.blocks.map((b,i)=>{
          if (b.kind === "thinking") return (
            <div key={i} style={{padding:"6px 10px", borderRadius:6, background:"var(--bg-elev)",
              border:"1px dashed var(--border-soft)",
              fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-dim)", fontStyle:"italic"}}>
              <span style={{color:"var(--fg-muted)", fontStyle:"normal"}}>thinking · {b.dur} ▾</span> {b.text}
            </div>
          );
          if (b.kind === "tool") return (
            <div key={i} style={{padding:"5px 10px", borderRadius:6,
              background:"color-mix(in oklch, var(--success), transparent 90%)",
              border:"1px solid var(--border-soft)",
              fontFamily:"var(--mono)", fontSize:10.5, display:"flex", gap:8}}>
              <span style={{color:"var(--success)", fontWeight:600}}>{b.tool}</span>
              <span style={{color:"var(--fg-muted)", flex:1}}>{b.args}</span>
              <span style={{color:"var(--success)"}}>✓ {b.summary}</span>
            </div>
          );
          return (
            <div key={i} style={{color:"var(--fg)", whiteSpace:"pre-wrap"}}
              dangerouslySetInnerHTML={{__html: b.text.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')}}/>
          );
        })}
      </div>
    </div>
  );
}

function PlanSection({ s }) {
  const stateColor = {
    confirmed: "var(--success)", drafted: "var(--accent)",
    asking: "var(--info)", pending: "var(--fg-dim)",
  }[s.state];
  const stateLabel = {
    confirmed: "✓ confirmed", drafted: "✎ drafted",
    asking: "→ asking", pending: "○ pending",
  }[s.state];
  return (
    <div style={{borderRadius:6,
      border:"1px solid " + (s.state==="asking" ? "var(--info)" : "var(--border-soft)"),
      background:"var(--bg-canvas)",
      opacity: s.state==="pending" ? 0.55 : 1,
      boxShadow: s.state==="asking" ? "0 0 0 2px color-mix(in oklch, var(--info), transparent 80%)" : "none",
      overflow:"hidden"}}>
      <div style={{padding:"7px 10px", background:"var(--bg-elev)",
        borderBottom: s.state==="pending" ? "0" : "1px solid var(--border-soft)",
        display:"flex", alignItems:"center", gap:8,
        fontFamily:"var(--mono)", fontSize:10.5}}>
        <span style={{color:"var(--fg)"}}>{s.title}</span>
        <div style={{flex:1}}/>
        <span style={{color:stateColor, fontSize:10}}>{stateLabel}</span>
      </div>
      {s.state !== "pending" && (
        <div style={{padding:"10px 12px", fontSize:11.5, color:"var(--fg-muted)", lineHeight:1.55}}>
          {s.body && <div>{s.body}</div>}
          {s.items && s.items.length > 0 && (
            <div style={{display:"flex", flexDirection:"column", gap:5, marginTop: s.body?8:0}}>
              {s.items.map((it,i)=>(
                <div key={i} style={{display:"flex", alignItems:"baseline", gap:6,
                  fontFamily:"var(--mono)", fontSize:10.5}}>
                  <span style={{color:"var(--accent)"}}>·</span>
                  <span style={{color:"var(--fg)"}}>{it.label}</span>
                  {it.tag && <span className="tag amber" style={{fontSize:9}}>{it.tag}</span>}
                  {it.note && <span style={{color:"var(--fg-dim)"}}>— {it.note}</span>}
                </div>
              ))}
            </div>
          )}
          {s.pendingQ && (
            <div style={{marginTop:8, padding:"6px 9px",
              borderLeft:"2px solid var(--info)",
              background:"color-mix(in oklch, var(--info), transparent 90%)",
              fontFamily:"var(--mono)", fontSize:10.5, color:"var(--info)"}}>
              <b style={{color:"var(--fg)"}}>asking:</b> "{s.pendingQ}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

Object.assign(window, {
  ScreenProjectsGated,
  ScreenProjectsList,
  ScreenProjectBoard,
  ScreenIssueDrawer,
  ScreenProjectRoadmap,
  ScreenProjectPlanning,
});
