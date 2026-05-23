import { PULL_REQUESTS, RECENT_COMMITS } from "../../data/mock";

const LANES = [
  { name: "main",               color: "var(--accent)",  y: 36  },
  { name: "feat/tunnel-v2",     color: "var(--info)",    y: 76  },
  { name: "fix/retry-loop",     color: "var(--success)", y: 116 },
  { name: "docs/migrate-store", color: "var(--fg-muted)",y: 156 },
];

const COMMITS_GRAPH = [
  { lane: 0, x:  80, sha: "a01" },
  { lane: 0, x: 140, sha: "a02" },
  { lane: 1, x: 200, sha: "b01", from: 0 },
  { lane: 0, x: 230, sha: "a03" },
  { lane: 1, x: 260, sha: "b02" },
  { lane: 2, x: 300, sha: "c01", from: 0 },
  { lane: 1, x: 330, sha: "b03" },
  { lane: 2, x: 360, sha: "c02" },
  { lane: 0, x: 400, sha: "a04", merge: 2 },
  { lane: 1, x: 430, sha: "b04" },
  { lane: 3, x: 470, sha: "d01", from: 0 },
  { lane: 1, x: 500, sha: "b05", current: true },
  { lane: 3, x: 540, sha: "d02" },
  { lane: 0, x: 600, sha: "a05", head: true },
] as const;

const HEATMAP_FILES = [
  { p: "crates/ws-server/src/proto.rs", w: 42 },
  { p: "crates/ws-server/src/frame.rs", w: 28 },
  { p: "crates/orch/src/agent.rs",      w: 34 },
  { p: "crates/orch/src/tools/mod.rs",  w: 18 },
  { p: "crates/orch/src/stream.rs",     w: 12 },
  { p: "crates/kb/src/store.rs",        w: 22 },
  { p: "crates/kb/src/fts.rs",          w:  9 },
  { p: "crates/kb/src/embed.rs",        w: 14 },
  { p: "crates/ui-bridge/src/main.rs",  w:  6 },
  { p: "crates/gh/src/webhook.rs",      w: 25 },
  { p: "crates/gh/src/oauth.rs",        w:  4 },
  { p: "src/App.tsx",                   w: 31 },
  { p: "src/console/Grid.tsx",          w: 24 },
  { p: "src/console/Pane.tsx",          w: 19 },
  { p: "src/settings/GitHub.tsx",       w:  8 },
  { p: "docs/protocol.md",              w:  7 },
  { p: "schema.json",                   w: 13 },
];

function BranchGraph() {
  return (
    <div className="card" style={{ padding: "14px 16px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Branch graph</h3>
        <span className="hint">last 14 days · main + 3 active branches</span>
        <div style={{ flex: 1 }} />
        <select className="input" style={{ height: 24, width: 130, fontSize: 10.5 }}>
          <option>all branches</option><option>open PRs only</option><option>mine</option>
        </select>
      </div>
      <div style={{ overflow: "auto" }}>
        <svg width="680" height="200" style={{ display: "block" }}>
          {LANES.map((l) => (
            <g key={l.name}>
              <line x1={56} y1={l.y} x2={650} y2={l.y}
                stroke="var(--border-soft)" strokeWidth="1" strokeDasharray="2 4" />
              <text x={50} y={l.y + 4} textAnchor="end"
                fontFamily="var(--mono)" fontSize="10" fill="var(--fg-muted)">{l.name}</text>
              <circle cx={648} cy={l.y} r="3" fill={l.color} />
            </g>
          ))}
          {COMMITS_GRAPH.filter(c => "from" in c).map(c => (
            <path key={"f" + c.sha}
              d={`M ${c.x - 30} ${LANES["from" in c ? (c as { from: number }).from : 0].y} Q ${c.x - 10} ${LANES["from" in c ? (c as { from: number }).from : 0].y} ${c.x} ${LANES[c.lane].y}`}
              fill="none" stroke={LANES[c.lane].color} strokeWidth="1.5" opacity=".7" />
          ))}
          {COMMITS_GRAPH.filter(c => "merge" in c).map(c => (
            <path key={"m" + c.sha}
              d={`M ${c.x - 30} ${LANES["merge" in c ? (c as { merge: number }).merge : 0].y} Q ${c.x - 10} ${LANES[c.lane].y} ${c.x} ${LANES[c.lane].y}`}
              fill="none" stroke={LANES["merge" in c ? (c as { merge: number }).merge : 0].color} strokeWidth="1.5" opacity=".7" />
          ))}
          {LANES.map((l, i) => {
            const xs = COMMITS_GRAPH.filter(c => c.lane === i).map(c => c.x).sort((a, b) => a - b);
            return xs.slice(0, -1).map((x, j) => (
              <line key={`l${i}-${j}`} x1={x} y1={l.y} x2={xs[j + 1]} y2={l.y}
                stroke={l.color} strokeWidth="1.5" />
            ));
          })}
          {COMMITS_GRAPH.map(c => {
            const y = LANES[c.lane].y;
            const isHead = "head" in c && c.head;
            const isCurrent = "current" in c && c.current;
            return (
              <g key={c.sha}>
                <circle cx={c.x} cy={y} r={isHead ? 6 : isCurrent ? 5 : 4}
                  fill={isHead ? "var(--accent)" : isCurrent ? "var(--bg-canvas)" : LANES[c.lane].color}
                  stroke={isCurrent ? "var(--accent)" : "transparent"}
                  strokeWidth={isCurrent ? 2 : 0} />
                {isHead && (
                  <rect x={c.x - 12} y={y - 22} width="28" height="14" rx="2"
                    fill="var(--accent)" opacity=".9" />
                )}
                {isHead && (
                  <text x={c.x + 2} y={y - 12} textAnchor="middle"
                    fontFamily="var(--mono)" fontSize="9" fill="#1a120a" fontWeight="700">HEAD</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
        {LANES.map(l => (
          <span key={l.name} style={{
            display: "inline-flex", gap: 6, alignItems: "center",
            fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
          }}>
            <span style={{ width: 10, height: 2, background: l.color, borderRadius: 1 }} />
            {l.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function FileHeatmap() {
  const maxW = Math.max(...HEATMAP_FILES.map(f => f.w));
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Churn heatmap</h3>
        <span className="hint">lines changed in last 14 days · darker = hotter</span>
        <div style={{ flex: 1 }} />
        <select className="input" style={{ height: 24, width: 120, fontSize: 10.5 }}>
          <option>14 days</option><option>7 days</option><option>30 days</option>
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4 }}>
        {HEATMAP_FILES.map(f => {
          const t = f.w / maxW;
          const a = 0.18 + 0.72 * t;
          return (
            <div key={f.p} title={`${f.p} · ±${f.w} lines`} style={{
              padding: "8px 9px", borderRadius: 4, minHeight: 54,
              background: `color-mix(in oklch, var(--accent) ${Math.round(a * 100)}%, var(--bg-elev))`,
              border: "1px solid var(--border-soft)",
              color: t > 0.55 ? "#1a120a" : "var(--fg-muted)",
              fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.35,
              display: "flex", flexDirection: "column", justifyContent: "space-between",
              overflow: "hidden",
            }}>
              <span style={{
                display: "block",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                color: t > 0.55 ? "#1a120a" : "var(--fg)",
              }}>{f.p.split("/").pop()}</span>
              <span style={{ fontSize: 9, opacity: .75 }}>{f.p.replace(/\/[^/]+$/, "")}</span>
              <span style={{ fontSize: 9.5, fontWeight: 600 }}>±{f.w}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function OverviewBody() {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        {([
          ["open PRs",     "5",      "2 awaiting review", "accent"],
          ["branches",     "11",     "3 active this week", "info"],
          ["contributors", "7",      "+ 2 bots",           "muted"],
          ["ahead / behind","12 / 0","vs origin/main",     "success"],
        ] as const).map(([k, v, sub, tone]) => (
          <div key={k} className="card" style={{ padding: "10px 14px" }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
              textTransform: "uppercase", letterSpacing: ".06em",
            }}>{k}</div>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600,
              color: tone === "accent" ? "var(--accent)" : tone === "success" ? "var(--success)" : "var(--fg)",
              marginTop: 2,
            }}>{v}</div>
            <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <BranchGraph />
          <FileHeatmap />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Open PRs</h3>
              <span className="hint">5 open</span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>view all</button>
            </div>
            <div style={{
              display: "flex", flexDirection: "column", gap: 1,
              borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden",
            }}>
              {PULL_REQUESTS.map((p, i) => (
                <div key={p.n} style={{
                  padding: "10px 12px",
                  background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
                  display: "grid", gridTemplateColumns: "40px 1fr 60px",
                  gap: 8, alignItems: "baseline", fontSize: 11,
                }}>
                  <span style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>{p.n}</span>
                  <div>
                    <div style={{ color: "var(--fg)" }}>{p.t}</div>
                    <div style={{
                      marginTop: 3, display: "flex", gap: 6,
                      fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
                    }}>
                      <span>@{p.who}</span>
                      <span className={"tag " + (p.st === "approved" ? "green" : p.st === "changes" ? "" : "amber")}
                        style={{ fontSize: 9.5 }}>{p.st}</span>
                      <span className={"tag " + (p.ci === "ok" ? "green" : "")}
                        style={{ fontSize: 9.5, color: p.ci === "ok" ? "var(--success)" : "var(--danger)" }}>
                        ci {p.ci}
                      </span>
                    </div>
                  </div>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right",
                  }}>{p.age}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Recent commits</h3>
              <span className="hint">main · last 24h</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {RECENT_COMMITS.map(c => (
                <div key={c.s} style={{
                  display: "grid", gridTemplateColumns: "40px 1fr 60px",
                  gap: 8, alignItems: "baseline", fontSize: 11,
                }}>
                  <span style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{c.s}</span>
                  <span style={{ color: "var(--fg-muted)" }}>
                    {c.m}
                    <span style={{ color: "var(--fg-dim)" }}> · @{c.who}</span>
                  </span>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right",
                  }}>{c.t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
