/* =====================================================================
   phaseViews.jsx — the seven focused phase views + shared primitives.
   Each view owns the full pane width for its phase of planning.
   ===================================================================== */
const { useState, useEffect, useRef } = React;

/* ---------- shared primitives ---------- */
function Avatar({ id, sz = 18 }) {
  const a = window.AGENTS.find((x) => x.id === id);
  const color = a ? a.color : "var(--fg-dim)";
  const initial = a ? a.initial : "?";
  return <span className="av" style={{ width: sz, height: sz, background: color, fontSize: sz * 0.5 }}>{initial}</span>;
}
function RoleChip({ role, mute }) {
  const R = window.ROLES[role] || { c: "var(--fg-dim)", label: role };
  return (
    <span className="role-chip" style={{
      background: `color-mix(in oklch, ${R.c}, transparent ${mute ? 88 : 82}%)`,
      color: R.c, border: `1px solid color-mix(in oklch, ${R.c}, transparent 72%)`,
    }}><i style={{ background: R.c }} />{R.label}</span>
  );
}
function Tile({ v, unit, k }) {
  return <div className="tile"><div className="v">{v}{unit && <small> {unit}</small>}</div><div className="k">{k}</div></div>;
}
function GrpLabel({ children, right }) {
  return (
    <div className="row" style={{ gap: 6, padding: "0 1px 8px", marginTop: 4 }}>
      <span className="grp-label">{children}</span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}

/* ===================================================================
   1 · CONTEXT
   =================================================================== */
function ContextView({ context, onTogglePin, onView }) {
  const pinned = context.filter((f) => f.pinned);
  const lib = context.filter((f) => !f.pinned);
  const totalTok = pinned.reduce((s, f) => s + parseFloat(f.tok), 0);

  function Card({ f }) {
    const kind = window.CTX_KIND[f.kind];
    return (
      <div className={"ctx-card" + (f.pinned ? " pinned" : "")} onClick={() => onView(f)}>
        <span className="ctx-kind" style={{ background: kind.c }} />
        <span className="ctx-name">{f.name}</span>
        <span className="chip" style={{ fontSize: 8.5 }}>{kind.label}</span>
        <span className="ctx-meta">{f.scope}</span>
        <span className="ctx-meta">{f.tok}</span>
        <span className="ctx-pin" style={{ color: f.pinned ? "var(--accent)" : "var(--fg-dim)" }}
          onClick={(e) => { e.stopPropagation(); onTogglePin(f.name); }}>{f.pinned ? "✦" : "+"}</span>
      </div>
    );
  }

  // budget bar segmented by kind
  const segs = pinned.map((f) => ({ w: parseFloat(f.tok), c: window.CTX_KIND[f.kind].c }));
  const sum = segs.reduce((s, x) => s + x.w, 0) || 1;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div>
        <div className="row" style={{ gap: 8, marginBottom: 7 }}>
          <span className="grp-label">context budget</span>
          <span style={{ flex: 1 }} />
          <span className="mono-sm" style={{ color: "var(--accent)" }}>✦ {pinned.length} pinned</span>
          <span className="mono-sm">{totalTok.toFixed(1)}k / 200k tok</span>
        </div>
        <div className="budget">
          {segs.map((s, i) => <i key={i} style={{ width: `${(s.w / sum) * (totalTok / 200) * 100}%`, background: s.c }} />)}
          <i style={{ flex: 1, background: "transparent" }} />
        </div>
        <div className="row" style={{ gap: 10, marginTop: 7, flexWrap: "wrap" }}>
          {Object.entries(window.CTX_KIND).map(([k, v]) => (
            <span key={k} className="row" style={{ gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: v.c }} />
              <span className="mono-sm">{v.label}</span>
            </span>
          ))}
        </div>
      </div>

      <div>
        <GrpLabel right={<span className="mono-sm">drag to reorder priority</span>}>pinned to context</GrpLabel>
        <div className="col" style={{ gap: 6 }}>{pinned.map((f) => <Card key={f.name} f={f} />)}</div>
      </div>

      <div>
        <GrpLabel right={<span className="mono-sm">{lib.length} available</span>}>library</GrpLabel>
        <div className="col" style={{ gap: 5 }}>{lib.map((f) => <Card key={f.name} f={f} />)}</div>
      </div>

      <div className="dropzone">＋ drop a spec, doc, or knowledge block to add context</div>
    </div>
  );
}

/* ===================================================================
   2 · REPOS
   =================================================================== */
function ReposView({ repos }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="tiles" style={{ marginBottom: 2 }}>
        <Tile v={repos.length} k="repositories" />
        <Tile v={repos.filter((r) => r.cloned).length} k="cloned" />
        <Tile v={repos.reduce((s, r) => s + r.branches.length, 0)} k="branches" />
      </div>
      {repos.map((r) => (
        <div key={r.id} className={"repo-card" + (r.primary ? " primary" : "")}>
          <div className="row" style={{ gap: 8 }}>
            <span className="sdot on" />
            <span className="repo-name">{r.id}</span>
            {r.primary && <span className="chip" style={{ color: "var(--accent)", borderColor: "var(--accent-dim)" }}>primary</span>}
            <span style={{ flex: 1 }} />
            <span className="chip">{r.lang}</span>
            <span className="mono-sm" style={{ color: "var(--success)" }}>● cloned</span>
          </div>
          <div className="mono-sm" style={{ margin: "7px 0 9px", color: "var(--fg-muted)" }}>{r.desc}</div>
          <div className="row" style={{ gap: 8, marginBottom: 9 }}>
            <span className="branch-chip" style={{ color: "var(--fg-muted)" }}>⎇ {r.branch}</span>
            <span className="mono-sm" style={{ color: "var(--success)" }}>↑{r.ahead}</span>
            <span className="mono-sm" style={{ color: "var(--info)" }}>↓{r.behind}</span>
            <span style={{ flex: 1 }} />
            <span className="row" style={{ gap: -4 }}>
              {r.agents.map((id, i) => (
                <span key={id} style={{ marginLeft: i ? -5 : 0 }}><Avatar id={id} sz={16} /></span>
              ))}
            </span>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {r.branches.map((b) => (
              <span key={b.n} className="branch-chip"
                style={{ color: b.state === "review" ? "var(--success)" : b.state === "draft" ? "var(--fg-dim)" : "var(--info)" }}>
                ⎇ {b.n} <span style={{ color: "var(--fg-dim)" }}>#{b.issue}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
      <div className="dropzone">＋ link another repository</div>
    </div>
  );
}

/* ===================================================================
   3 · UI DESIGN — render-preview walkthrough
   =================================================================== */
function UIView({ screens, onApprove }) {
  const firstUnapproved = screens.find((s) => !s.approved) || screens[0];
  const [active, setActive] = useState(firstUnapproved.id);
  const cur = screens.find((s) => s.id === active);
  const approvedCount = screens.filter((s) => s.approved).length;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="grp-label">live preview</span>
        <span style={{ flex: 1 }} />
        <span className="mono-sm">{approvedCount}/{screens.length} screens approved</span>
      </div>

      {/* preview stage */}
      <div className="preview-stage">
        <div className="preview-bar">
          <span className="preview-light" /><span className="preview-light" /><span className="preview-light" />
          <span style={{ marginLeft: 6 }}>{cur.route}</span>
          <span style={{ flex: 1 }} />
          <span>esbuild-wasm · sandboxed</span>
        </div>
        <div className="preview-screen">
          {cur.blocks.map((b, i) => (
            <div key={b} className="skl" style={{
              height: b === "topbar" ? 22 : i === 1 ? 30 : "auto",
              flex: b === "topbar" || i === 1 ? "0 0 auto" : "1 1 0",
              display: "flex", alignItems: "center", paddingLeft: 9,
            }}>
              <span className="mono-sm" style={{ color: "var(--fg-dim)" }}>{b}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="nav-btn" onClick={() => {
          const i = screens.findIndex((s) => s.id === active);
          setActive(screens[(i - 1 + screens.length) % screens.length].id);
        }}>← prev</button>
        <button className={"nav-btn" + (cur.approved ? "" : " primary")}
          onClick={() => onApprove(cur.id)} disabled={cur.approved}>
          {cur.approved ? "✓ approved" : "approve screen →"}
        </button>
        <span style={{ flex: 1 }} />
        <button className="nav-btn" onClick={() => {
          const i = screens.findIndex((s) => s.id === active);
          setActive(screens[(i + 1) % screens.length].id);
        }}>next →</button>
      </div>

      {/* thumbnails */}
      <GrpLabel>screen skeletons</GrpLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))", gap: 10 }}>
        {screens.map((s) => (
          <div key={s.id} className={"screen-frame" + (s.id === active ? " sel" : "")} onClick={() => setActive(s.id)}>
            <div className="screen-canvas">
              {s.blocks.slice(0, 4).map((b, i) => (
                <div key={i} className="skl" style={{ height: i === 0 ? 8 : "auto", flex: i === 0 ? "0 0 auto" : "1 1 0" }} />
              ))}
            </div>
            <div className="screen-cap">
              <span style={{ color: s.approved ? "var(--success)" : "var(--fg-dim)" }}>{s.approved ? "✓" : "○"}</span>
              <span style={{ color: "var(--fg)" }}>{s.name}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===================================================================
   4 · STRUCTURE — milestone → epic → issue → sub-issue
   =================================================================== */
function StructureView({ structure }) {
  const [open, setOpen] = useState(() => new Set(structure.flatMap((m) => [m.id, ...m.epics.map((e) => e.id)])));
  const [openIssue, setOpenIssue] = useState(() => new Set([418, 417]));
  const tog = (set, setter, id) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n); };
  const issueCount = structure.flatMap((m) => m.epics.flatMap((e) => e.issues)).length;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="tiles">
        <Tile v={structure.length} k="milestones" />
        <Tile v={structure.flatMap((m) => m.epics).length} k="epics" />
        <Tile v={issueCount} k="issues" />
      </div>

      {structure.map((m) => (
        <div key={m.id} className="node" style={{ background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 9, padding: "9px 10px" }}>
          <div className="node-row" onClick={() => tog(open, setOpen, m.id)} style={{ cursor: "pointer" }}>
            <span style={{ color: "var(--fg-dim)", fontSize: 9 }}>{open.has(m.id) ? "▼" : "▶"}</span>
            <span className="chip" style={{ color: "var(--info)", borderColor: "color-mix(in oklch,var(--info),transparent 65%)" }}>{m.id}</span>
            <span style={{ color: "var(--fg)", fontSize: 12 }}>{m.title}</span>
            <span style={{ flex: 1 }} />
            <span className="mono-sm">{m.repo.split("/")[1]}</span>
            <span className="track" style={{ width: 46, display: "block" }}><i style={{ width: `${m.pct * 100}%` }} /></span>
          </div>
          {open.has(m.id) && m.epics.map((e) => (
            <div key={e.id} style={{ paddingLeft: 16, borderLeft: "1px solid var(--border-soft)", marginLeft: 8 }}>
              <div className="node-row" onClick={() => tog(open, setOpen, e.id)} style={{ cursor: "pointer" }}>
                <span style={{ color: "var(--fg-dim)", fontSize: 9 }}>{open.has(e.id) ? "▼" : "▶"}</span>
                <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>◆ {e.title}</span>
                <span style={{ flex: 1 }} />
                <span className="track" style={{ width: 36, display: "block" }}><i className="green" style={{ width: `${e.pct * 100}%` }} /></span>
              </div>
              {open.has(e.id) && e.issues.map((iss) => (
                <div key={iss.n} style={{ paddingLeft: 16, borderLeft: "1px solid var(--border-soft)", marginLeft: 8 }}>
                  <div className="node-row" onClick={() => tog(openIssue, setOpenIssue, iss.n)} style={{ cursor: "pointer" }}>
                    <span className="sdot" style={{ background: window.ISSUE_STATE[iss.state] }} />
                    <span className="issue-num">#{iss.n}</span>
                    <span style={{ color: "var(--fg)", fontSize: 10.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{iss.t}</span>
                    <Avatar id={iss.owner} sz={15} />
                    <span className="chip" style={{ fontSize: 8 }}>{iss.ac} AC</span>
                  </div>
                  {openIssue.has(iss.n) && iss.sub.length > 0 && (
                    <div style={{ paddingLeft: 26, paddingBottom: 4, display: "flex", flexDirection: "column", gap: 4 }}>
                      {iss.sub.map((s, si) => (
                        <div key={si} className="subitem">
                          <span className={"subbox" + (s.done ? " done" : "")}>{s.done ? "✓" : ""}</span>
                          <span style={{ textDecoration: s.done ? "line-through" : "none" }}>{s.t}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ===================================================================
   5 · PERMISSIONS — the full-width matrix
   =================================================================== */
function PermissionsView({ agents, onCell, onPreset }) {
  const CAPS = window.CAPS, PRESETS = window.PRESETS;
  const cycle = (v) => (v === "allow" ? "ask" : v === "ask" ? "deny" : "allow");
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="mono-sm" style={{ lineHeight: 1.5 }}>
        Each work stream runs under its own least-privilege posture. Click a cell to cycle
        <span style={{ color: "var(--success)" }}> allow</span> →
        <span style={{ color: "var(--accent)" }}> ask</span> →
        <span style={{ color: "var(--danger)" }}> deny</span>.
      </div>

      <table className="matrix">
        <thead>
          <tr>
            <th className="agent-th">stream</th>
            {CAPS.map((c) => <th key={c.k} title={c.label}>{c.g}</th>)}
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td className="agent-td">
                <span className="row" style={{ gap: 6 }}>
                  <Avatar id={a.id} sz={16} />
                  <span style={{ color: "var(--fg)", fontSize: 10 }}>{a.name}</span>
                </span>
              </td>
              {CAPS.map((c) => (
                <td key={c.k}>
                  <div className={"mcell " + a.perm[c.k]} title={`${a.name} · ${c.label}: ${a.perm[c.k]}`}
                    onClick={() => onCell(a.id, c.k, cycle(a.perm[c.k]))}>
                    {a.perm[c.k] === "allow" ? "✓" : a.perm[c.k] === "ask" ? "?" : "✕"}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <GrpLabel>per-stream detail</GrpLabel>
      <div className="col" style={{ gap: 8 }}>
        {agents.map((a) => (
          <div key={a.id} className="list-card" style={{ flexWrap: "wrap", rowGap: 8 }}>
            <Avatar id={a.id} sz={20} />
            <div className="col" style={{ gap: 4, flex: 1, minWidth: 120 }}>
              <span className="row" style={{ gap: 6 }}>
                <span style={{ color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 11 }}>{a.name}</span>
                <RoleChip role={a.role} mute />
              </span>
              <span className="mono-sm" style={{ color: "var(--info)" }}>⎇ {a.repo} · owns {a.owns[0]}{a.owns.length > 1 ? ` +${a.owns.length - 1}` : ""}</span>
            </div>
            <div className="row" style={{ gap: 5 }}>
              {Object.keys(PRESETS).map((p) => (
                <span key={p} className={"preset-pill" + (a.preset === p ? " on" : "")}
                  onClick={() => onPreset(a.id, p)}>{p}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===================================================================
   6 · AUTOMATIONS
   =================================================================== */
function AutomationsView({ automations, onToggle }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="tiles">
        <Tile v={automations.filter((a) => a.on).length} unit={`/ ${automations.length}`} k="active" />
        <Tile v={automations.filter((a) => a.kind === "command").length} k="commands" />
        <Tile v={automations.filter((a) => a.kind === "knowledge").length} k="injections" />
      </div>
      <div className="col" style={{ gap: 8 }}>
        {automations.map((a) => (
          <div key={a.id} className="list-card">
            <div className={"toggle" + (a.on ? " on" : "")} onClick={() => onToggle(a.id)} />
            <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
              <span className="row" style={{ gap: 7 }}>
                <span style={{ color: a.on ? "var(--fg)" : "var(--fg-muted)", fontSize: 11.5 }}>{a.name}</span>
                <span className="chip" style={{ fontSize: 8,
                  color: a.kind === "command" ? "var(--accent)" : "var(--info)",
                  borderColor: a.kind === "command" ? "color-mix(in oklch,var(--accent),transparent 70%)" : "color-mix(in oklch,var(--info),transparent 70%)" }}>
                  {a.kind === "command" ? "⌘ command" : "✦ knowledge"}
                </span>
              </span>
              <span className="mono-sm" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.detail}</span>
            </div>
            <div className="col" style={{ alignItems: "flex-end", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--fg-muted)" }}>{a.cron}</span>
              <span className="mono-sm">{a.target}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="dropzone">＋ schedule a command or knowledge injection</div>
    </div>
  );
}

/* ===================================================================
   7 · SKILLS
   =================================================================== */
function SkillsView({ skills, onToggle }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="grp-label">reusable skills</span>
        <span style={{ flex: 1 }} />
        <span className="mono-sm">{skills.filter((s) => s.indexed).length} indexed for this project</span>
      </div>
      <div className="col" style={{ gap: 8 }}>
        {skills.map((s) => (
          <div key={s.id} className="list-card" style={{ alignItems: "flex-start" }}>
            <div className="col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <span className="row" style={{ gap: 7 }}>
                <span style={{ color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 11.5 }}>{s.name}</span>
                {s.tags.map((t) => <span key={t} className="glob">{t}</span>)}
              </span>
              <span className="mono-sm" style={{ color: "var(--fg-muted)", lineHeight: 1.45, whiteSpace: "normal" }}>{s.desc}</span>
            </div>
            <button className={"preset-pill" + (s.indexed ? " on" : "")} onClick={() => onToggle(s.id)}
              style={{ flex: "0 0 auto" }}>{s.indexed ? "✓ indexed" : "+ index"}</button>
          </div>
        ))}
      </div>
      <div className="dropzone">＋ author a new skill from this project's patterns</div>
    </div>
  );
}

Object.assign(window, {
  ContextView, ReposView, UIView, StructureView, PermissionsView, AutomationsView, SkillsView,
  PV_Avatar: Avatar, PV_RoleChip: RoleChip,
});
