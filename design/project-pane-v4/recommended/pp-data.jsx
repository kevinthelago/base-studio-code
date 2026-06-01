/* global React */
// pp-data.jsx — shared sample data + primitive components for the project pane.
// Honest density: a project spanning 2 repos, 6 agents of mixed roles,
// 2 milestones with epics + issues, a handful of context files.

// ── role palette ───────────────────────────────────────────────
const ROLES = {
  planner:   { c:"oklch(0.72 0.10 230)", label:"planner"   },
  worker:    { c:"oklch(0.80 0.14 70)",  label:"worker"    },
  reviewer:  { c:"oklch(0.70 0.12 300)", label:"reviewer"  },
  triage:    { c:"oklch(0.72 0.10 195)", label:"triage"    },
  tester:    { c:"oklch(0.72 0.13 145)", label:"tester"    },
  director:  { c:"oklch(0.70 0.14 350)", label:"director"  },
};

// ── the 7 permission capabilities (order matters; used as columns) ──
const CAPS = [
  { k:"read",    g:"R", label:"read files" },
  { k:"edit",    g:"E", label:"edit files" },
  { k:"create",  g:"C", label:"create & delete" },
  { k:"run",     g:"$", label:"run commands" },
  { k:"net",     g:"N", label:"network" },
  { k:"push",    g:"⇡", label:"commit & push" },
  { k:"pkg",     g:"P", label:"install packages" },
];

// presets → per-cap posture
const PRESETS = {
  Plan:   { read:"allow", edit:"deny",  create:"deny",  run:"ask",   net:"ask",   push:"deny",  pkg:"deny"  },
  Build:  { read:"allow", edit:"allow", create:"allow", run:"allow", net:"ask",   push:"ask",   pkg:"ask"   },
  Review: { read:"allow", edit:"deny",  create:"deny",  run:"allow", net:"deny",  push:"deny",  pkg:"deny"  },
  Triage: { read:"allow", edit:"deny",  create:"ask",   run:"deny",  net:"allow", push:"deny",  pkg:"deny"  },
  Full:   { read:"allow", edit:"allow", create:"allow", run:"allow", net:"allow", push:"allow", pkg:"allow" },
};

// ── the fleet ──────────────────────────────────────────────────
const AGENTS = [
  { id:"planner",  name:"@planner",  role:"planner",  status:"wait", repo:"acme/payments",
    color:"oklch(0.72 0.10 230)", initial:"P",
    owns:["docs/**","specs/**"], issues:["M1","M2"],
    preset:"Plan",  perm:{...PRESETS.Plan},
    flow:{ autonomy:"confirm", push:"none", gate:"soft" }, ctx:3 },

  { id:"framer",   name:"@framer",   role:"worker",   status:"run", repo:"acme/payments",
    color:"oklch(0.80 0.14 70)", initial:"F",
    owns:["crates/ws-server/**"], issues:["#418","#416"], focus:true,
    preset:"Build", perm:{...PRESETS.Build},
    flow:{ autonomy:"checkpoint", push:"push-confirm", gate:"hard" }, ctx:4 },

  { id:"auth",     name:"@auth",     role:"worker",   status:"run", repo:"acme/payments",
    color:"oklch(0.78 0.13 50)", initial:"A",
    owns:["crates/auth/**","crates/gh/**"], issues:["#417","#413"],
    preset:"Build", perm:{...PRESETS.Build, push:"allow"},
    flow:{ autonomy:"continuous", push:"auto-PR", gate:"hard" }, ctx:5 },

  { id:"tester",   name:"@tester",   role:"tester",   status:"on", repo:"acme/payments",
    color:"oklch(0.72 0.13 145)", initial:"T",
    owns:["tests/**"], issues:["#408"],
    preset:"Review", perm:{...PRESETS.Review, run:"allow"},
    flow:{ autonomy:"continuous", push:"commit-only", gate:"hard" }, ctx:2 },

  { id:"triage",   name:"@triage",   role:"triage",   status:"on", repo:"both",
    color:"oklch(0.72 0.10 195)", initial:"Δ",
    owns:["— issues only"], issues:["board"],
    preset:"Triage", perm:{...PRESETS.Triage},
    flow:{ autonomy:"continuous", push:"none", gate:"soft" }, ctx:1 },

  { id:"reviewer", name:"@reviewer", role:"reviewer", status:"idle", repo:"acme/web-dashboard",
    color:"oklch(0.70 0.12 300)", initial:"R",
    owns:["src/**"], issues:["#414"],
    preset:"Review", perm:{...PRESETS.Review},
    flow:{ autonomy:"checkpoint", push:"commit-only", gate:"hard" }, ctx:2 },
];

// ── repos ──────────────────────────────────────────────────────
// Planning page: what matters per repo is the default branch + the
// feature branches the planned work will land on (each maps to an issue).
const REPOS = [
  { id:"acme/payments", branch:"main", ahead:2, behind:0,
    agents:["planner","framer","auth","tester"], primary:true,
    branches:[
      { n:"feat/framing-v2",      issue:418, state:"active", ahead:5, behind:2 },
      { n:"feat/webhook-emitter", issue:416, state:"draft",  ahead:0, behind:0 },
      { n:"feat/hmac-mw",         issue:417, state:"active", ahead:3, behind:0 },
      { n:"fix/token-revocation", issue:413, state:"review", ahead:2, behind:1 },
    ]},
  { id:"acme/web-dashboard", branch:"main", ahead:0, behind:0,
    agents:["reviewer","triage"], primary:false,
    branches:[
      { n:"feat/live-updates",  issue:414, state:"review", ahead:3, behind:1 },
      { n:"feat/cutover-flag",  issue:420, state:"draft",  ahead:0, behind:0 },
    ]},
];

// ── github structure: milestone → epic → issue → sub-issue ─────
// Each milestone is scoped to a repo; issues carry a target branch,
// owner, acceptance count, deps, and sub-issues (the planning breakdown).
const STRUCTURE = [
  { id:"M1", title:"Publisher MVP", repo:"acme/payments", pct:0.72, state:"doing",
    epics:[
      { id:"E1", title:"Framing v2", pct:0.7, issues:[
        { n:418, t:"net: framing v2 + schema regen", state:"doing", owner:"framer",
          ac:3, branch:"feat/framing-v2", deps:[], sub:[
            { t:"spec the v2 frame shape", done:true },
            { t:"encoder + round-trip tests", done:false },
            { t:"regen schema.json on build", done:false },
          ]},
        { n:416, t:"worker → webhook emitter", state:"doing", owner:"framer",
          ac:2, branch:"feat/webhook-emitter", deps:[418], sub:[
            { t:"emit on settlement event", done:false },
            { t:"backpressure + retry", done:false },
          ]},
      ]},
      { id:"E2", title:"Auth surface", pct:0.5, issues:[
        { n:417, t:"HMAC verification middleware", state:"doing", owner:"auth",
          ac:4, branch:"feat/hmac-mw", deps:[], sub:[
            { t:"verify signature header", done:true },
            { t:"timing-safe compare", done:false },
            { t:"key rotation hook", done:false },
          ]},
        { n:413, t:"tokenized webhook path + revocation", state:"review", owner:"auth",
          ac:2, branch:"fix/token-revocation", deps:[417], sub:[] },
      ]},
    ]},
  { id:"M2", title:"Dashboard live-update", repo:"acme/web-dashboard", pct:0.32, state:"doing",
    epics:[
      { id:"E3", title:"Live updates", pct:0.3, issues:[
        { n:414, t:"subscribe + render live deliveries", state:"review", owner:"reviewer",
          ac:3, branch:"feat/live-updates", deps:[], sub:[
            { t:"websocket client hook", done:true },
            { t:"optimistic row updates", done:false },
          ]},
        { n:420, t:"cutover plan + flag wiring", state:"backlog", owner:"planner",
          ac:1, branch:"feat/cutover-flag", deps:[413,414], sub:[] },
      ]},
    ]},
];

// helper: the milestones planned for a given repo
function structFor(repoId){ return STRUCTURE.filter(m=>m.repo===repoId); }

// ── context files ──────────────────────────────────────────────
const CONTEXT = [
  { name:"settlement-webhooks.spec.md", kind:"spec",   tok:"4.1k", pinned:true,  scope:"project" },
  { name:"CLAUDE.md",                   kind:"claude", tok:"1.2k", pinned:true,  scope:"global"  },
  { name:"blk_71fe · framing v2",       kind:"kb",     tok:"0.8k", pinned:true,  scope:"project" },
  { name:"blk_2199 · sqlite>lmdb",      kind:"kb",     tok:"0.6k", pinned:true,  scope:"project" },
  { name:"acme/payments · CLAUDE.md",   kind:"claude", tok:"0.9k", pinned:false, scope:"repo"    },
  { name:"docs/architecture.md",        kind:"doc",    tok:"3.4k", pinned:false, scope:"repo"    },
  { name:"blk_44a1 · retry policy",     kind:"kb",     tok:"0.5k", pinned:false, scope:"project" },
];
const CTX_KIND = {
  spec:   "oklch(0.72 0.10 230)",
  claude: "oklch(0.80 0.14 70)",
  kb:     "oklch(0.70 0.12 300)",
  doc:    "oklch(0.66 0.06 200)",
};

// =================================================================
// primitives
// =================================================================
function Dot({ s }) { return <span className={"sdot "+s}/>; }

function RoleChip({ role, mute }) {
  const R = ROLES[role] || { c:"var(--fg-dim)", label:role };
  return (
    <span className="role" style={{
      background:`color-mix(in oklch, ${R.c}, transparent ${mute?90:84}%)`,
      color:R.c, border:`1px solid color-mix(in oklch, ${R.c}, transparent 72%)`,
    }}>
      <i style={{background:R.c}}/>{R.label}
    </span>
  );
}

function Avatar({ id, sz=17 }) {
  const a = AGENTS.find(x=>x.id===id);
  const color = a ? a.color : "var(--fg-dim)";
  const initial = a ? a.initial : "?";
  return <span className="av" style={{ width:sz, height:sz, background:color, fontSize:sz*0.53 }}>{initial}</span>;
}

// posture mini-bar: 7 cells
function Posture({ perm }) {
  return (
    <span className="posture" title="read · edit · create · run · net · push · pkg">
      {CAPS.map(c=>(
        <i key={c.k} className={perm[c.k]} title={`${c.label}: ${perm[c.k]}`}/>
      ))}
    </span>
  );
}

// tri-state Allow/Ask/Deny
function Tri({ value, onChange }) {
  return (
    <span className="tri">
      {["allow","ask","deny"].map(v=>(
        <button key={v} className={(value===v?"on ":"")+v}
          onClick={()=>onChange && onChange(v)}>
          {v==="allow"?"allow":v==="ask"?"ask":"deny"}
        </button>
      ))}
    </span>
  );
}

// flow badges trio
function FlowBadges({ flow, compact }) {
  return (
    <span style={{display:"inline-flex", gap:4, flexWrap:"wrap"}}>
      <span className="fbadge" title="autonomy">{flow.autonomy}</span>
      <span className="fbadge" title="push policy">{flow.push}</span>
      <span className={"fbadge"+(flow.gate==="hard"?" hard":"")} title="enforcement gate">
        {flow.gate} gate
      </span>
    </span>
  );
}

function Track({ pct, green }) {
  return <span className="track" style={{display:"block"}}>
    <i className={green?"green":""} style={{width:`${Math.round(pct*100)}%`}}/>
  </span>;
}

// collapsible section shell
function Sec({ title, count, open=true, right, children }) {
  const [o,setO] = React.useState(open);
  return (
    <div className="sec">
      <div className="sec-head" onClick={()=>setO(!o)}>
        <span className="chev">{o?"▼":"▶"}</span>
        <span className="t">{title}</span>
        {count!=null && <span className="count">{count}</span>}
        <span className="spacer"/>
        {right}
      </div>
      {o && <div className="sec-body">{children}</div>}
    </div>
  );
}

// state dot color for issues
const ISSUE_STATE = {
  doing:   "var(--accent)",
  review:  "var(--success)",
  backlog: "var(--fg-dim)",
  done:    "var(--fg-muted)",
};

Object.assign(window, {
  ROLES, CAPS, PRESETS, AGENTS, REPOS, STRUCTURE, structFor, CONTEXT, CTX_KIND, ISSUE_STATE,
  Dot, RoleChip, Avatar, Posture, Tri, FlowBadges, Track, Sec,
});
