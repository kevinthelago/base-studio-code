/* global React */
// Shared app chrome + primitives for the analytics example pages.
// Recreates the base-studio-code shell (mac titlebar + icon rail + page-mode strip
// + status bar) so the analytics views sit in a faithful context. Exported to window.

const { useState, useRef, useEffect, useCallback } = React;

// ── helpers ───────────────────────────────────────────────────────────────────
const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
const pct = (n) => `${Math.round(n)}%`;

function timeAgo(min) {
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)}m ago`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// deterministic color from a string (mirrors loginColor in ProjectsSummary)
function loginColor(login) {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  return `oklch(0.68 0.12 ${h % 360})`;
}

// ── lucide-ish stroke icons (rail) ─────────────────────────────────────────────
function Icon({ d, size = 18, fill, children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ?? "none"}
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children ?? <path d={d} />}
    </svg>
  );
}
const ICONS = {
  console: <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></Icon>,
  projects: <Icon><rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="11" rx="1" /></Icon>,
  github: <Icon><path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.3 1.3 5.3 1.6 5.3 1.6a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 3.9 8c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V19" /></Icon>,
  automation: <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>,
  extensions: <Icon><path d="M14 4a2 2 0 1 0-4 0v2H6a2 2 0 0 0-2 2v3h2a2 2 0 1 1 0 4H4v3a2 2 0 0 0 2 2h3v-2a2 2 0 1 1 4 0v2h3a2 2 0 0 0 2-2v-4h-2a2 2 0 1 1 0-4h2V8a2 2 0 0 0-2-2h-4V4Z" /></Icon>,
  agents: <Icon><path d="M12 2 4 6v6c0 5 3.4 8.3 8 10 4.6-1.7 8-5 8-10V6l-8-4Z" /></Icon>,
  skills: <Icon><path d="M12 3l1.9 4.6L18.5 9l-3.6 3 .9 4.8L12 14.6 8.2 16.8l.9-4.8L5.5 9l4.6-1.4L12 3Z" /></Icon>,
  knowledge: <Icon><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" /><path d="M19 17H6" /></Icon>,
  settings: <Icon><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></Icon>,
};

// ── Titlebar (macOS variant) ────────────────────────────────────────────────
function Titlebar({ workspace, meta }) {
  return (
    <div className="titlebar mac">
      <div className="tl-lights"><i /><i /><i /></div>
      <div className="tl-title">{workspace}</div>
      <div className="tl-meta">
        {(meta ?? []).map((m, i) => (
          <span key={i}>{m.label} <b>{m.value}</b></span>
        ))}
      </div>
    </div>
  );
}

// ── Rail (cross-page nav between the two example pages) ──────────────────────
const RAIL_ITEMS = [
  { k: "console", label: "Console" },
  { k: "projects", label: "Projects", href: "Fleet Analytics.html" },
  { k: "knowledge", label: "Knowledge" },
  { k: "github", label: "GitHub", href: "Repo Pulse.html" },
  { k: "automation", label: "Automations" },
  { k: "extensions", label: "Extensions" },
  { k: "skills", label: "Skills", href: "Skills.html" },
  { k: "agents", label: "Agents" },
];
function Rail({ active }) {
  return (
    <nav className="rail">
      <div className="logo">S</div>
      {RAIL_ITEMS.map(it => {
        const on = it.k === active;
        const cls = on ? "active" : "";
        const inner = ICONS[it.k];
        return it.href
          ? <a key={it.k} className={`rail-link ${cls}`} href={it.href} title={it.label}
               style={{ all: "unset" }}>
              <button className={cls} title={it.label}>{inner}</button>
            </a>
          : <button key={it.k} className={cls} title={it.label}>{inner}</button>;
      })}
      <div className="spacer" />
      <button title="Settings">{ICONS.settings}</button>
    </nav>
  );
}

// ── page-mode strip (Summary / Projects|Repos / + new analytics mode) ────────
function ModeStrip({ modes, active, sync = "github sync" }) {
  return (
    <div className="modestrip">
      {modes.map(m => (
        <a key={m.k} className={`m ${m.k === active ? "on" : ""}`} href={m.href ?? "#"}>
          {m.label}
          {m.k === active && m.hint && <span className="mh">· {m.hint}</span>}
        </a>
      ))}
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 10, color: "var(--success)" }}>● {sync}</span>
    </div>
  );
}

function StatusBar({ items }) {
  return (
    <div className="statusbar">
      {(items ?? []).map((it, i) => (
        <span key={i} className="s"><i className={it.tone ?? ""} /> {it.text}</span>
      ))}
      <div className="spacer" />
      <span style={{ color: "var(--fg-dim)" }}>base-studio-code · 0.7.0-dev</span>
    </div>
  );
}

// ── shared primitives ─────────────────────────────────────────────────────────
function Avatar({ login, size = 20, bot = false }) {
  const color = bot ? "oklch(0.78 0.14 70)" : loginColor(login);
  return (
    <span title={login} style={{
      width: size, height: size, borderRadius: bot ? size * 0.28 : "50%",
      background: color, color: "#1a120a",
      fontFamily: "var(--mono)", fontWeight: 700, fontSize: size * 0.46,
      display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>
      {bot ? "◆" : (login.replace(/^@/, "")[0]?.toUpperCase() ?? "?")}
    </span>
  );
}

function CardHead({ title, hint, right }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {hint && <span className="hint">{hint}</span>}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

function StatCard({ k, v, sub, tone, delta }) {
  const color = tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)"
    : tone === "success" ? "var(--success)" : tone === "danger" ? "var(--danger)" : "var(--fg)";
  return (
    <div className="card statcard">
      <div className="k">{k}</div>
      <div className="v" style={{ color }}>{v}</div>
      <div className="sub">
        {delta && <span className={`delta ${delta.dir}`}>{delta.dir === "up" ? "▲" : delta.dir === "down" ? "▼" : "■"} {delta.text}</span>}
        {sub}
      </div>
    </div>
  );
}

// time-range segmented control
function RangeToggle({ value, onChange, options = ["7d", "14d", "30d"] }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o} className={o === value ? "on" : ""} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  );
}

// shared lightweight tooltip controller
function useTip() {
  const [tip, setTip] = useState(null);
  const show = useCallback((x, y, content) => setTip({ x, y, content }), []);
  const hide = useCallback(() => setTip(null), []);
  const node = tip ? (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y, transform: "translate(-50%,-120%)" }}>
      {tip.content}
    </div>
  ) : null;
  return { show, hide, node };
}

Object.assign(window, {
  fmt, pct, timeAgo, loginColor, Icon, ICONS,
  Titlebar, Rail, ModeStrip, StatusBar,
  Avatar, CardHead, StatCard, RangeToggle, useTip,
});
