/* global React, Titlebar, Rail, StatusBar */

// ============================================================
// Shared · page-level "Summary | Projects" tab strip
// ============================================================

function ProjectsPageMode({ active }) {
  const modes = [
    { k:"summary",  label:"Summary",   hint:"portfolio · analytics" },
    { k:"projects", label:"Projects",  hint:"drill into a project" },
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
        <span style={{color:"var(--success)"}}>● github sync 4m ago</span>
      </div>
    </div>
  );
}

// ============================================================
// People avatars used here
// ============================================================
const PEOPLE_PR = {
  lina:  { color:"oklch(0.7 0.13 30)",  initial:"L" },
  alex:  { color:"oklch(0.7 0.10 220)", initial:"A" },
  pete:  { color:"oklch(0.68 0.13 145)",initial:"P" },
  zara:  { color:"oklch(0.7 0.12 290)", initial:"Z" },
  bot:   { color:"oklch(0.45 0 0)",     initial:"⌬" },
};

// ============================================================
// Iteration burn-down (combined across projects)
// ============================================================

function IterationBurnDown() {
  const days = 14;
  const ideal = Array.from({length:days+1}, (_,i)=>56 - 56*(i/days));
  const actual = [56,55,54,52,49,48,47,45,42,40,39,36,null,null,null];
  const todayDay = 11;
  const W = 720, H = 180, PAD = {l:36, r:20, t:14, b:24};
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = i => PAD.l + (i/days)*innerW;
  const y = v => PAD.t + (1 - v/56)*innerH;
  const idealPath = ideal.map((v,i)=>`${i===0?"M":"L"} ${x(i)} ${y(v)}`).join(" ");
  const actualPath = actual.filter(v=>v!=null).map((v,i)=>`${i===0?"M":"L"} ${x(i)} ${y(v)}`).join(" ");
  const lastActual = actual.filter(v=>v!=null).pop();

  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:6}}>
        <h3 style={{margin:0}}>Iteration burn-down</h3>
        <span className="hint">issues remaining across all active projects · iter 24</span>
        <div style={{flex:1}}/>
        <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--success)"}}>● on track</span>
      </div>
      <svg width={W} height={H} style={{width:"100%", maxWidth:W, display:"block"}}>
        {[0,15,30,45,56].map(v=>(
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
        <line x1={x(todayDay)} y1={PAD.t} x2={x(todayDay)} y2={H-PAD.b}
          stroke="var(--accent)" strokeDasharray="2 3" strokeWidth="1"/>
        <text x={x(todayDay)} y={PAD.t-3} textAnchor="middle"
          fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">today</text>
        <text x={x(days)-2} y={y(lastActual)-6} textAnchor="end"
          fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">actual · {lastActual}</text>
        <text x={x(days)-2} y={y(ideal[days])-6} textAnchor="end"
          fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">ideal · 0</text>
      </svg>
    </div>
  );
}

// ============================================================
// Where the team is — project allocation
// ============================================================

function ProjectAllocation() {
  // % of issues "doing" per project across all assignees this week
  const items = [
    { k:"prj_31a", n:"Settlement webhooks v2",  pct:46, c:"oklch(0.78 0.14 70)" },
    { k:"prj_27e", n:"Knowledge → Notion sync", pct:24, c:"oklch(0.7 0.10 220)" },
    { k:"prj_2fa", n:"Offline pairing mode",    pct:18, c:"oklch(0.7 0.12 145)" },
    { k:"prj_24b", n:"Tunnel framing v2",        pct:9,  c:"oklch(0.6 0.06 50)" },
    { k:"scratch", n:"Scratch · unscoped",       pct:3,  c:"oklch(0.45 0 0)" },
  ];
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Where the team is</h3>
        <span className="hint">share of in-progress work this week</span>
      </div>
      <div style={{display:"flex", height:10, borderRadius:5, overflow:"hidden",
        background:"var(--bg-elev2)", marginBottom:12}}>
        {items.map(it=>(
          <div key={it.k} title={`${it.n} · ${it.pct}%`}
            style={{width:`${it.pct}%`, background:it.c}}/>
        ))}
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:5,
        fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)"}}>
        {items.map(it=>(
          <div key={it.k} style={{display:"grid",
            gridTemplateColumns:"12px 1fr 40px", gap:8, alignItems:"center"}}>
            <span style={{width:9, height:9, borderRadius:2, background:it.c}}/>
            <span style={{color:"var(--fg)",
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{it.n}</span>
            <span style={{textAlign:"right", color:"var(--fg-dim)"}}>{it.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Velocity sparkline (issues closed / week across projects)
// ============================================================

function VelocityCard() {
  const weeks = ["w17","w18","w19","w20","w21","w22","w23","w24"];
  const closed = [12,9,14,17,15,11,18,14];
  const opened = [10,11,12,16,11,9,15,13];
  const maxV = Math.max(...closed, ...opened);
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Velocity</h3>
        <span className="hint">issues opened vs closed · last 8 weeks</span>
      </div>
      <svg width="100%" height="100" viewBox="0 0 320 100">
        {[0,5,10,15,20].map(v=>(
          <line key={v} x1={30} y1={90 - (v/maxV)*80} x2={310} y2={90-(v/maxV)*80}
            stroke="var(--border-soft)" strokeDasharray="2 3"/>
        ))}
        {weeks.map((w,i)=>{
          const cx = 30 + (i/(weeks.length-1))*280;
          const colW = 14;
          const oH = (opened[i]/maxV)*80;
          const cH = (closed[i]/maxV)*80;
          return (
            <g key={w}>
              <rect x={cx-colW} y={90-oH} width={colW-1} height={oH}
                fill="color-mix(in oklch, var(--info), transparent 50%)"/>
              <rect x={cx+1} y={90-cH} width={colW-1} height={cH}
                fill="var(--accent)"/>
              <text x={cx} y={99} textAnchor="middle"
                fontFamily="var(--mono)" fontSize="8" fill="var(--fg-dim)">{w}</text>
            </g>
          );
        })}
      </svg>
      <div style={{display:"flex", gap:14, marginTop:6,
        fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)"}}>
        <span><span style={{display:"inline-block", width:9, height:9, borderRadius:2,
          background:"color-mix(in oklch, var(--info), transparent 50%)"}}/> opened</span>
        <span><span style={{display:"inline-block", width:9, height:9, borderRadius:2,
          background:"var(--accent)"}}/> closed</span>
        <div style={{flex:1}}/>
        <span>avg <b style={{color:"var(--fg)"}}>13.8 closed/wk</b></span>
      </div>
    </div>
  );
}

// ============================================================
// Upcoming milestones · cross-project mini-timeline
// ============================================================

function UpcomingMilestones() {
  const today = 3.2; // week 3 of an 8-week view
  const milestones = [
    { id:"P1·M3", proj:"Settlement webhooks", t:"Dashboard live-update", week:1, length:2, st:"upnext", c:"oklch(0.78 0.14 70)" },
    { id:"P2·M2", proj:"Notion sync",         t:"Two-way reconcile",     week:2, length:3, st:"doing",  pct:0.4, c:"oklch(0.7 0.10 220)" },
    { id:"P1·M4", proj:"Settlement webhooks", t:"Replay + dead-letter",  week:3, length:3, st:"upnext", c:"oklch(0.78 0.14 70)" },
    { id:"P1·M5", proj:"Settlement webhooks", t:"Cutover + shadow",      week:5, length:3, st:"backlog", c:"oklch(0.78 0.14 70)" },
    { id:"P2·M3", proj:"Notion sync",         t:"Backfill old blocks",   week:6, length:2, st:"backlog", c:"oklch(0.7 0.10 220)" },
  ];
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:14}}>
        <h3 style={{margin:0}}>Upcoming milestones</h3>
        <span className="hint">across all active projects · 8-week view</span>
        <div style={{flex:1}}/>
        <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--accent)"}}>
          M2 due Fri · M3 due in 2w
        </span>
      </div>

      {/* Week header */}
      <div style={{display:"grid", gridTemplateColumns:"220px 1fr", gap:14, marginBottom:8}}>
        <div/>
        <div style={{position:"relative", height:18,
          display:"grid", gridTemplateColumns:"repeat(8, 1fr)"}}>
          {Array.from({length:8}, (_,i)=>(
            <div key={i} style={{
              fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)",
              borderLeft: i===0 ? "none" : "1px dashed var(--border-soft)",
              paddingLeft:6, paddingTop:2,
            }}>w{i+1}</div>
          ))}
          <div style={{
            position:"absolute", top:0, bottom:-220,
            left:`${today/8*100}%`,
            width:0, borderLeft:"1.5px dashed var(--accent)",
            zIndex:2,
          }}>
            <span style={{position:"absolute", top:-2, left:4,
              fontFamily:"var(--mono)", fontSize:9.5, color:"var(--accent)"}}>today</span>
          </div>
        </div>
      </div>

      <div style={{display:"flex", flexDirection:"column", gap:6}}>
        {milestones.map(m=>(
          <div key={m.id} style={{
            display:"grid", gridTemplateColumns:"220px 1fr", gap:14, alignItems:"center",
          }}>
            <div>
              <div style={{display:"flex", alignItems:"baseline", gap:6}}>
                <span style={{width:8, height:8, borderRadius:2, background:m.c, flex:"0 0 8px"}}/>
                <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--accent)"}}>{m.id}</span>
              </div>
              <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)",
                marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{m.t}</div>
            </div>
            <div style={{position:"relative", height:24}}>
              {Array.from({length:8}, (_,i)=>(
                <div key={i} style={{
                  position:"absolute", top:0, bottom:0,
                  left:`${i/8*100}%`, width:1,
                  background:"var(--border-soft)",
                }}/>
              ))}
              <div style={{
                position:"absolute", top:3, bottom:3,
                left:`${m.week/8*100}%`,
                width:`${m.length/8*100}%`,
                borderRadius:4,
                background:`color-mix(in oklch, ${m.c}, transparent 65%)`,
                border: `1px solid color-mix(in oklch, ${m.c}, transparent 40%)`,
                overflow:"hidden",
                display:"flex", alignItems:"center",
              }}>
                {m.pct > 0 && (
                  <div style={{position:"absolute", inset:0, width:`${m.pct*100}%`,
                    background:`color-mix(in oklch, ${m.c}, transparent 30%)`}}/>
                )}
                <span style={{position:"relative", padding:"0 8px",
                  fontFamily:"var(--mono)", fontSize:10,
                  color: m.st==="backlog" ? "var(--fg-muted)" : "var(--fg)"}}>
                  {m.length}w {m.pct>0 ? `· ${Math.round(m.pct*100)}%` : ""}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Risks across projects
// ============================================================

function RiskRegister() {
  const risks = [
    { sev:"med",  proj:"Settlement", r:"HMAC secret leaks via env dump",        own:"alex" },
    { sev:"med",  proj:"Notion sync",r:"Rate-limit on Notion's API on backfill", own:"pete" },
    { sev:"low",  proj:"Settlement", r:"Replay storm during cutover",            own:"alex" },
    { sev:"low",  proj:"Offline pairing", r:"Bonjour discovery on enterprise wifi", own:"lina" },
  ];
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Risk register</h3>
        <span className="hint">2 medium · 2 low across active projects</span>
        <div style={{flex:1}}/>
        <button className="btn ghost" style={{height:24, fontSize:10.5}}>view all</button>
      </div>
      <div style={{borderRadius:6, border:"1px solid var(--border-soft)", overflow:"hidden"}}>
        <div style={{display:"grid", gridTemplateColumns:"50px 110px 1fr 60px",
          gap:8, padding:"7px 12px",
          background:"var(--bg-elev2)", borderBottom:"1px solid var(--border-soft)",
          fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
          textTransform:"uppercase", letterSpacing:".06em"}}>
          <span>sev</span><span>project</span><span>risk</span><span>owner</span>
        </div>
        {risks.map((r,i)=>(
          <div key={i} style={{
            display:"grid", gridTemplateColumns:"50px 110px 1fr 60px",
            gap:8, padding:"8px 12px", alignItems:"center",
            background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
            borderTop: i===0?"0":"1px solid var(--border-soft)",
            fontSize:11.5,
          }}>
            <span style={{fontFamily:"var(--mono)", fontSize:10,
              color: r.sev==="high"?"var(--danger)":r.sev==="med"?"var(--accent)":"var(--fg-dim)"}}>
              ● {r.sev}
            </span>
            <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--fg-muted)",
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{r.proj}</span>
            <span style={{color:"var(--fg)"}}>{r.r}</span>
            <span style={{
              width:20, height:20, borderRadius:"50%",
              background:PEOPLE_PR[r.own].color, color:"#1a120a",
              fontFamily:"var(--mono)", fontWeight:700, fontSize:10,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>{PEOPLE_PR[r.own].initial}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Cross-project activity feed
// ============================================================

function CrossProjectActivity() {
  const events = [
    { who:"lina", act:"closed", target:"#418 net: framing v2",          proj:"Settlement", t:"3m" },
    { who:"alex", act:"moved",  target:"#421 dead-letter ops surface → In progress", proj:"Settlement", t:"24m" },
    { who:"pete", act:"opened", target:"#318 backfill missing block titles", proj:"Notion sync", t:"1h" },
    { who:"bot",  act:"linked", target:"PR #418 to issue M1 Publisher MVP", proj:"Settlement", t:"2h" },
    { who:"lina", act:"published", target:"prj_2fa from planner session", proj:"Offline pairing", t:"yesterday" },
    { who:"zara", act:"commented", target:"#103 docs reorg proposal",     proj:"Notion sync", t:"yesterday" },
  ];
  const actionTone = {
    closed:"var(--success)", moved:"var(--info)", opened:"var(--accent)",
    linked:"var(--fg-muted)", published:"var(--accent)", commented:"var(--fg-muted)",
  };
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Recent activity</h3>
        <span className="hint">across all projects</span>
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:1,
        borderRadius:6, border:"1px solid var(--border-soft)", overflow:"hidden"}}>
        {events.map((e,i)=>(
          <div key={i} style={{
            padding:"10px 12px",
            background: i%2 ? "var(--bg-panel)" : "var(--bg-elev)",
            display:"grid", gridTemplateColumns:"22px 80px 1fr 110px 50px",
            gap:10, alignItems:"baseline", fontSize:11,
          }}>
            <span style={{
              width:20, height:20, borderRadius:"50%",
              background:PEOPLE_PR[e.who].color, color:"#1a120a",
              fontFamily:"var(--mono)", fontWeight:700, fontSize:10,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>{PEOPLE_PR[e.who].initial}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10.5,
              color: actionTone[e.act] || "var(--fg-muted)"}}>{e.act}</span>
            <span style={{color:"var(--fg)",
              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{e.target}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)"}}>{e.proj}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)",
              textAlign:"right"}}>{e.t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Projects grid (mini cards) — at-a-glance per project
// ============================================================

function ProjectsGrid() {
  const projects = [
    { id:"prj_31a", gh:14, name:"Settlement webhooks v2",
      iter:"Iter 24", repo:"acme/payments", c:"oklch(0.78 0.14 70)",
      open:17, total:23, prs:3, ms:5, sprite:[4,6,5,8,11,9,7,12,10],
      st:"active", health:"on-track" },
    { id:"prj_27e", gh:9,  name:"Knowledge → Notion sync",
      iter:"Iter 12", repo:"acme/docs", c:"oklch(0.7 0.10 220)",
      open:9, total:18, prs:1, ms:4, sprite:[2,3,3,4,5,4,5,6,5],
      st:"active", health:"on-track" },
    { id:"prj_2fa", gh:15, name:"Offline pairing mode",
      iter:"drafting", repo:"(pending)", c:"oklch(0.7 0.12 145)",
      open:0, total:0, prs:0, ms:0, sprite:[],
      st:"drafting", health:"planning · 38%" },
    { id:"prj_24b", gh:6,  name:"Tunnel framing v2",
      iter:"shipped", repo:"acme/payments", c:"oklch(0.6 0.06 50)",
      open:0, total:21, prs:0, ms:6, sprite:[2,5,7,11,9,4,2,1,0],
      st:"shipped", health:"shipped 1w ago" },
  ];
  return (
    <div className="card" style={{padding:"14px 16px"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:10, marginBottom:10}}>
        <h3 style={{margin:0}}>Projects</h3>
        <span className="hint">4 projects · click to open the board</span>
        <div style={{flex:1}}/>
        <button className="btn ghost" style={{height:24, fontSize:10.5}}>view list →</button>
      </div>
      <div style={{display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:8}}>
        {projects.map(p=>{
          const pct = p.total ? (p.total - p.open) / p.total : (p.st==="drafting" ? 0.38 : 0);
          return (
            <div key={p.id} style={{
              padding:"12px 14px", borderRadius:6,
              background:"var(--bg-elev)", border:"1px solid var(--border-soft)",
              cursor:"pointer",
            }}>
              <div style={{display:"flex", alignItems:"baseline", gap:8, marginBottom:4}}>
                <span style={{width:8, height:8, borderRadius:2, background:p.c, flex:"0 0 8px"}}/>
                <span style={{fontFamily:"var(--mono)", fontSize:12, color:"var(--fg)",
                  whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", flex:1}}>{p.name}</span>
                <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-dim)"}}>{p.iter}</span>
              </div>
              <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-dim)", marginBottom:8}}>
                {p.id} · {p.repo}
              </div>
              <div style={{display:"flex", justifyContent:"space-between", marginBottom:5,
                fontFamily:"var(--mono)", fontSize:9.5, color:"var(--fg-muted)"}}>
                <span>completion</span>
                <span style={{color:"var(--fg)"}}>{Math.round(pct*100)}%</span>
              </div>
              <div style={{height:4, borderRadius:2, background:"var(--bg-elev2)",
                overflow:"hidden", marginBottom:8}}>
                <div style={{width:`${pct*100}%`, height:"100%",
                  background: p.st==="shipped" ? "var(--fg-dim)"
                    : p.st==="drafting" ? "var(--accent)"
                    : "var(--success)"}}/>
              </div>
              <div style={{display:"flex", alignItems:"center", gap:12,
                fontFamily:"var(--mono)", fontSize:10, color:"var(--fg-muted)"}}>
                <span><b style={{color:"var(--fg)"}}>{p.open}</b>/{p.total}</span>
                <span><b style={{color:"var(--fg)"}}>{p.ms}</b> ms</span>
                <span>⊕ {p.prs}</span>
                <div style={{flex:1}}/>
                {p.sprite.length > 0 && (
                  <ProjectSparkline data={p.sprite} color={p.c}/>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProjectSparkline({ data, w=80, h=18, color }) {
  const max = Math.max(...data, 1);
  const pts = data.map((v,i)=>{
    const x = (i/(data.length-1))*w;
    const y = h - (v/max)*h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={w} height={h} style={{display:"block"}}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ============================================================
// AI insight strip — Claude's summary
// ============================================================

function AISummary() {
  return (
    <div className="card" style={{
      padding:"14px 18px",
      background:"linear-gradient(135deg, color-mix(in oklch, var(--accent), transparent 88%), var(--bg-panel) 60%)",
      border:"1px solid var(--accent-dim)",
    }}>
      <div style={{display:"flex", gap:12}}>
        <div style={{
          flex:"0 0 28px", width:28, height:28, borderRadius:7,
          background:"linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
          color:"#1a120a", fontFamily:"var(--mono)", fontWeight:700, fontSize:13,
          display:"flex", alignItems:"center", justifyContent:"center",
        }}>C</div>
        <div style={{flex:1, fontSize:12, lineHeight:1.6, color:"var(--fg-muted)"}}>
          <div style={{display:"flex", alignItems:"baseline", gap:8, marginBottom:4}}>
            <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--accent)",
              textTransform:"uppercase", letterSpacing:".06em"}}>weekly digest · claude</span>
            <span className="hint">generated 02:00 today · run #14</span>
            <div style={{flex:1}}/>
            <button className="btn ghost" style={{height:22, fontSize:10}}>regenerate</button>
          </div>
          <p style={{margin:0}}>
            Iter 24 is on track — burndown is <b style={{color:"var(--success)"}}>2 issues ahead</b> of ideal.
            Settlement webhooks dominates the week at <b style={{color:"var(--fg)"}}>46%</b> of doing work,
            with M2 due Friday. Two medium risks open; neither has moved.
            Notion sync's backfill PR (#318) needs a reviewer — suggest <b style={{color:"var(--fg)"}}>@pete</b>.
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Main · ScreenProjectsSummary
// ============================================================

function ScreenProjectsSummary() {
  return (
    <div className="app">
      <Titlebar workspace="projects · summary"/>
      <div className="shell">
        <Rail active="projects"/>
        <div className="main">
          <ProjectsPageMode active="summary"/>

          <section style={{flex:1, overflow:"auto", padding:"20px 24px", minWidth:0,
            background:"var(--bg-canvas)"}}>
            <div style={{maxWidth:1280, margin:"0 auto"}}>
              {/* Header */}
              <div style={{display:"flex", alignItems:"flex-start", gap:14, marginBottom:14}}>
                <div style={{flex:1}}>
                  <h2 style={{margin:0, fontFamily:"var(--mono)", fontSize:20, fontWeight:600}}>
                    Portfolio
                  </h2>
                  <div style={{color:"var(--fg-muted)", fontSize:12, marginTop:4}}>
                    3 active · 1 drafting · 1 shipped this iteration · iter 24 ends Fri
                  </div>
                </div>
                <select className="input" style={{width:160}} defaultValue="iter">
                  <option value="iter">current iteration</option>
                  <option>last iteration</option>
                  <option>last 90 days</option>
                </select>
                <button className="btn">browse projects →</button>
              </div>

              {/* AI weekly digest */}
              <div style={{marginBottom:14}}>
                <AISummary/>
              </div>

              {/* KPI row */}
              <div style={{display:"grid", gridTemplateColumns:"repeat(6, 1fr)", gap:8, marginBottom:14}}>
                {[
                  ["projects",       "5",     "3 active · 1 drafting",   "fg"],
                  ["open issues",    "56",    "across 5 projects",       "accent"],
                  ["this iter",      "iter 24",  "ends Fri · 4d left",   "info"],
                  ["velocity",       "13.8/wk", "−1.2 vs prior",         "muted"],
                  ["milestones",     "3",     "due in next 2 weeks",     "info"],
                  ["risks",          "4",     "2 medium · 0 high",       "accent"],
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

              {/* 2-col layout */}
              <div style={{display:"grid", gridTemplateColumns:"1.6fr 1fr", gap:14}}>
                <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>
                  <IterationBurnDown/>
                  <UpcomingMilestones/>
                  <CrossProjectActivity/>
                </div>
                <div style={{display:"flex", flexDirection:"column", gap:14, minWidth:0}}>
                  <ProjectAllocation/>
                  <VelocityCard/>
                  <RiskRegister/>
                  <ProjectsGrid/>
                </div>
              </div>
            </div>
          </section>
          <StatusBar extra={<span className="s">5 projects · 56 open · iter 24 · on track</span>}/>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenProjectsSummary, ProjectsPageMode });
