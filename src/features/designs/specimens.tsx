/* eslint-disable no-restricted-syntax -- isolated preview specimens: bespoke visual mocks rendered on a
   sandboxed surface (their own preview palette), NOT app chrome — raw elements are the point here. */
// Preview specimens for the Component Library pane (#2269) — a self-contained visual mock of each
// component, rendered on a neutral preview surface with its OWN dark/light theme (a sandbox, decoupled
// from the app theme so a component can be inspected either way). Ported from the design prototype.
// Unknown components fall back to a labeled placeholder — the pane still previews them, just generically.
import type { ReactNode } from "react";
import type { ComponentRecord } from "./lib/model";

export type PreviewTheme = "dark" | "light";

interface Tok {
  bg: string; panel: string; elev: string; border: string; borderSoft: string;
  fg: string; muted: string; dim: string;
}

/** The preview sandbox's own token set (NOT the app tokens) — a neutral surface to inspect on. */
export function previewTokens(theme: PreviewTheme): Tok {
  if (theme === "light") {
    return { bg: "oklch(0.97 0.002 250)", panel: "oklch(0.94 0.003 250)", elev: "oklch(0.91 0.003 250)", border: "oklch(0.72 0.006 250)", borderSoft: "oklch(0.83 0.005 250)", fg: "oklch(0.16 0.005 250)", muted: "oklch(0.42 0.008 250)", dim: "oklch(0.58 0.008 250)" };
  }
  return { bg: "oklch(0.13 0.005 250)", panel: "oklch(0.17 0.005 250)", elev: "oklch(0.21 0.006 250)", border: "oklch(0.30 0.006 250)", borderSoft: "oklch(0.24 0.006 250)", fg: "oklch(0.94 0.004 250)", muted: "oklch(0.66 0.008 250)", dim: "oklch(0.46 0.008 250)" };
}

const mono = "var(--mono)";

/** A single shimmering skeleton block, sandbox-themed — rides the app's ONE `skeleton-shimmer` keyframe
 *  via `.ds-skel` (reduced-motion aware), so the Studio's loading state uses the same motion vocabulary
 *  as every Skeleton elsewhere. */
function skel(w: number | string, h: number | string, r: number, t: Tok): ReactNode {
  return <div className="ds-skel" style={{ width: w, height: h, borderRadius: r, background: `linear-gradient(90deg, ${t.elev} 0%, ${t.borderSoft} 50%, ${t.elev} 100%)`, backgroundSize: "260px 100%" }} />;
}

/** The `loading` variant of a component — a shape-matched skeleton (#2302), so the Design Studio previews
 *  the loading state, not just content. */
function loadingSpecimen(comp: ComponentRecord, t: Tok): ReactNode {
  switch (comp.name) {
    case "Chip": return skel(72, 22, 99, t);
    case "Text": return <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 220 }}>{skel("100%", 11, 5, t)}{skel("100%", 11, 5, t)}{skel("60%", 11, 5, t)}</div>;
    case "TextField": case "Field": case "SelectField": return <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 240 }}>{skel(90, 9, 4, t)}{skel("100%", 30, 6, t)}</div>;
    case "TextArea": return <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 240 }}>{skel(90, 9, 4, t)}{skel("100%", 84, 7, t)}</div>;
    case "FillBar": return skel(220, 7, 99, t);
    case "Code": return <div style={{ width: 260, borderRadius: 8, border: `1px solid ${t.borderSoft}`, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>{skel("70%", 8, 4, t)}{skel("90%", 8, 4, t)}{skel("45%", 8, 4, t)}</div>;
    case "Card": case "StatCard": case "StatTile": return (
      <div style={{ width: 250, borderRadius: 10, border: `1px solid ${t.borderSoft}`, overflow: "hidden" }}>
        {skel("100%", 54, 0, t)}
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          {skel("55%", 11, 5, t)}{skel("100%", 9, 5, t)}{skel("80%", 9, 5, t)}
          <div style={{ marginTop: 6 }}>{skel(70, 24, 6, t)}</div>
        </div>
      </div>
    );
    default: return <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 220 }}>{skel("100%", 12, 6, t)}{skel("100%", 12, 6, t)}{skel("60%", 12, 6, t)}</div>;
  }
}

// ── pages (#2505/#2508) — schematic scaffolding shared by the seven page-composition specimens ──
/** The standard 280×152 page frame every page schematic sits in. */
function pageFrame(t: Tok, children: ReactNode): ReactNode {
  return <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, background: t.panel, display: "flex", flexDirection: "column" }}>{children}</div>;
}
/** The titled header bar (title · hint · spacer · control) the pages open with. */
function pageHead(t: Tok, extra?: ReactNode): ReactNode {
  return (
    <div style={{ height: 22, flex: "none", borderBottom: `1px solid ${t.borderSoft}`, background: t.elev, display: "flex", alignItems: "center", padding: "0 8px", gap: 5 }}>
      <span style={{ width: 40, height: 7, borderRadius: 3, background: t.fg, opacity: 0.75 }} />
      <span style={{ width: 22, height: 5, borderRadius: 3, background: t.dim }} />
      <span style={{ flex: 1 }} />
      {extra ?? <span style={{ width: 22, height: 8, borderRadius: 3, background: "var(--accent)" }} />}
    </div>
  );
}
/** Schematic KeyValueList rows — the pages' shared detail-panel rendering. */
function kvRows(t: Tok, n = 3): ReactNode {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "32px 1fr", rowGap: 6, columnGap: 8, alignContent: "start" }}>
      {Array.from({ length: n }).flatMap((_, i) => [
        <span key={`k${i}`} style={{ height: 5, borderRadius: 2, background: t.dim, opacity: 0.7 }} />,
        <span key={`v${i}`} style={{ height: 6, borderRadius: 2, background: t.elev, border: `1px solid ${t.borderSoft}`, width: `${88 - i * 16}%` }} />,
      ])}
    </div>
  );
}
/** The schematic detail column: a heading line over kv rows. */
function detailPanel(t: Tok, kv = 3): ReactNode {
  return (
    <div style={{ flex: 1, minWidth: 0, padding: 9, display: "flex", flexDirection: "column", gap: 7 }}>
      <span style={{ width: "55%", height: 8, borderRadius: 3, background: t.fg, opacity: 0.8 }} />
      {kvRows(t, kv)}
    </div>
  );
}

/** Render a specimen for `comp` in a `variant` on the `theme` sandbox. */
export function renderSpecimen(comp: ComponentRecord, variant: string, theme: PreviewTheme): ReactNode {
  const t = previewTokens(theme);
  if (variant === "loading") return loadingSpecimen(comp, t);
  switch (comp.name) {
    case "Dialog": {
      return (
        <div style={{ width: 280, borderRadius: 10, background: t.elev, border: `1px solid ${t.border}`, boxShadow: "0 20px 60px rgba(0,0,0,.5)", overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${t.borderSoft}`, fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.fg }}>Delete persona?</div>
          <div style={{ padding: "12px 14px", fontSize: 11.5, color: t.muted, lineHeight: 1.5 }}>This removes it from the global store. This can&apos;t be undone.</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: `1px solid ${t.borderSoft}` }}>
            <button style={{ height: 26, padding: "0 12px", borderRadius: 5, background: "transparent", color: t.fg, border: `1px solid ${t.borderSoft}`, fontFamily: mono, fontSize: 10.5, cursor: "default" }}>Cancel</button>
            <button style={{ height: 26, padding: "0 12px", borderRadius: 5, background: "transparent", color: "var(--danger)", border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)", fontFamily: mono, fontSize: 10.5, cursor: "default" }}>Delete</button>
          </div>
        </div>
      );
    }
    case "Toolbar": {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 4, width: 280, padding: "6px 8px", borderRadius: 8, background: t.panel, border: `1px solid ${t.borderSoft}` }}>
          <span style={{ fontFamily: mono, fontSize: 11, color: t.fg, marginRight: 6, marginLeft: 2 }}>Preview</span>
          <span style={{ flex: 1 }} />
          {["⌕", "⧉", "⟳", "⋯"].map((g) => (
            <button key={g} style={{ width: 26, height: 26, borderRadius: 5, border: 0, background: "transparent", color: t.muted, fontSize: 13, cursor: "default" }}>{g}</button>
          ))}
        </div>
      );
    }

    // ── layout ──
    case "Box":
      return <div style={{ width: 140, height: 80, borderRadius: 9, background: t.panel, border: `1px solid ${t.borderSoft}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 11, color: t.dim }}>a styled box</div>;
    case "Stack":
      return <div style={{ display: "flex", flexDirection: "column", gap: 7, width: 130 }}>{[0, 1, 2].map((i) => <span key={i} style={{ height: 20, borderRadius: 5, background: t.elev, border: `1px solid ${t.borderSoft}` }} />)}</div>;
    case "Row":
      return (
        <div style={{ display: "flex", gap: 7, alignItems: "center", width: 220 }}>
          {[0, 1, 2].map((i) => <span key={i} style={{ width: 40, height: 24, borderRadius: 5, background: t.elev, border: `1px solid ${t.borderSoft}` }} />)}
          <span style={{ flex: 1 }} />
          <span style={{ width: 24, height: 24, borderRadius: 5, background: "var(--accent-soft)", border: "1px solid var(--accent-dim)" }} />
        </div>
      );
    case "Spacer":
      return (
        <div style={{ display: "flex", alignItems: "center", width: 210 }}>
          <span style={{ width: 42, height: 22, borderRadius: 5, background: t.elev, border: `1px solid ${t.borderSoft}` }} />
          <span style={{ flex: 1, textAlign: "center", fontFamily: mono, fontSize: 9, color: t.dim }}>← flex →</span>
          <span style={{ width: 42, height: 22, borderRadius: 5, background: t.elev, border: `1px solid ${t.borderSoft}` }} />
        </div>
      );
    case "Grid":
      return <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 40px)", gap: 6 }}>{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} style={{ height: 26, borderRadius: 5, background: t.elev, border: `1px solid ${t.borderSoft}` }} />)}</div>;
    case "SectionHeader":
      return (
        <div style={{ width: 250, display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: 8, borderBottom: `1px solid ${t.borderSoft}` }}>
          <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: t.fg }}>Permissions</span>
          <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--accent)" }}>edit</span>
        </div>
      );
    case "SectionLabel":
      return <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em", color: t.dim }}>Active kits</span>;
    case "ModalScrim":
      return (
        <div style={{ position: "relative", width: 230, height: 116, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.borderSoft}`, background: t.panel }}>
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ width: 90, height: 44, borderRadius: 8, background: t.elev, border: `1px solid ${t.border}` }} />
          </div>
        </div>
      );
    case "ModalCard":
      return (
        <div style={{ width: 290, borderRadius: 10, background: t.panel, border: `1px solid ${t.border}`, boxShadow: "0 20px 60px rgba(0,0,0,.5)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 14px", borderBottom: `1px solid ${t.borderSoft}` }}>
            <span style={{ width: 24, height: 24, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 12, background: "color-mix(in oklch, var(--accent), transparent 84%)", color: "var(--accent)" }}>↓</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.fg }}>Import from gist</span>
              <span style={{ display: "block", fontSize: 9.5, color: t.dim, marginTop: 1 }}>Pull a shared blueprint</span>
            </span>
            <span style={{ color: t.dim, fontSize: 12 }}>✕</span>
          </div>
          <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 7 }}>
            <span style={{ display: "block", width: "80%", height: 8, borderRadius: 4, background: t.elev }} />
            <span style={{ display: "block", width: "60%", height: 8, borderRadius: 4, background: t.elev }} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: `1px solid ${t.borderSoft}` }}>
            <button style={{ height: 24, padding: "0 11px", borderRadius: 5, background: "transparent", color: t.fg, border: `1px solid ${t.borderSoft}`, fontFamily: mono, fontSize: 10, cursor: "default" }}>Cancel</button>
            <button style={{ height: 24, padding: "0 11px", borderRadius: 5, background: "var(--accent)", color: "var(--accent-text)", border: 0, fontFamily: mono, fontSize: 10, fontWeight: 600, cursor: "default" }}>Resolve gist</button>
          </div>
        </div>
      );

    // ── data ──
    case "CardListRow":
      return (
        <div style={{ width: 260, display: "flex", flexDirection: "column", gap: 6 }}>
          {[["Sidebar", "layout"], ["Navbar", "layout"]].map(([n, r], i) => (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, background: i === 0 ? "var(--accent-soft)" : t.panel, border: `1px solid ${i === 0 ? "var(--accent-dim)" : t.borderSoft}` }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }} />
              <span style={{ flex: 1, fontFamily: mono, fontSize: 12, color: t.fg }}>{n}</span>
              <span style={{ fontFamily: mono, fontSize: 10, color: t.dim }}>{r}</span>
            </div>
          ))}
        </div>
      );
    case "DataTableRow":
      return (
        <div style={{ width: 270, border: `1px solid ${t.borderSoft}`, borderRadius: 8, overflow: "hidden", fontFamily: mono, fontSize: 11 }}>
          {[["stream", "issues", "state"], ["ui-kit", "4", "landed"], ["planner", "6", "active"]].map((row, i) => (
            <div key={i} style={{ display: "flex", padding: "7px 11px", background: i === 0 ? t.elev : "transparent", borderTop: i ? `1px solid ${t.borderSoft}` : "none", color: i === 0 ? t.dim : t.fg }}>
              <span style={{ flex: 1 }}>{row[0]}</span><span style={{ width: 50 }}>{row[1]}</span>
              <span style={{ width: 60, color: i === 0 ? t.dim : row[2] === "landed" ? "var(--success)" : "var(--accent)" }}>{row[2]}</span>
            </div>
          ))}
        </div>
      );
    // ── charts ──
    case "StackedDayBars": {
      const seg = (h: number, c: string) => <span style={{ display: "block", width: 14, height: h, background: c }} />;
      return <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 60 }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ display: "flex", flexDirection: "column", borderRadius: "3px 3px 0 0", overflow: "hidden" }}>{seg(10 + i * 3, "var(--success)")}{seg(16, "var(--accent)")}{seg(8, "var(--state-wait)")}</div>)}</div>;
    }
    case "Spark":
      return <svg width={120} height={36} style={{ overflow: "visible" }}><polyline points="0,28 20,20 40,24 60,10 80,16 100,6 120,12" fill="none" stroke="var(--accent)" strokeWidth={2} /></svg>;
    case "LineArea":
      return (
        <svg width={132} height={50}>
          <defs><linearGradient id="dc-la" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.4} /><stop offset="100%" stopColor="var(--accent)" stopOpacity={0} /></linearGradient></defs>
          <path d="M0,40 L22,30 L44,34 L66,18 L88,24 L110,10 L132,16 L132,50 L0,50 Z" fill="url(#dc-la)" />
          <polyline points="0,40 22,30 44,34 66,18 88,24 110,10 132,16" fill="none" stroke="var(--accent)" strokeWidth={2} />
        </svg>
      );
    case "Legend":
      return <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{[["landed", "var(--success)"], ["active", "var(--accent)"], ["blocked", "var(--danger)"]].map(([n, c]) => <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 11, color: t.muted }}><span style={{ width: 10, height: 10, borderRadius: 3, background: c }} />{n}</div>)}</div>;
    case "Swimlane":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 210 }}>
          {[{ n: "ui-kit", c: "var(--accent)", off: 0.05, w: 0.5 }, { n: "planner", c: "var(--success)", off: 0.4, w: 0.45 }].map((l) => (
            <div key={l.n} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 46, fontFamily: mono, fontSize: 9, color: t.dim, textAlign: "right" }}>{l.n}</span>
              <div style={{ flex: 1, height: 12, borderRadius: 4, background: t.elev, position: "relative" }}>
                <span style={{ position: "absolute", left: `${l.off * 100}%`, width: `${l.w * 100}%`, top: 0, bottom: 0, background: l.c, borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      );

    // ── feedback ──
    case "ActivityFeed": {
      const row = (login: string, action: string, target: string, ago: string, striped: boolean) => (
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 12px", background: striped ? `color-mix(in oklch, ${t.fg}, transparent 96%)` : "transparent" }}>
          <span style={{ width: 18, height: 18, borderRadius: "50%", background: t.elev, border: `1px solid ${t.borderSoft}`, flexShrink: 0 }} />
          <span style={{ fontFamily: mono, fontSize: 10.5, color: t.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><b>{login}</b> {action} <span style={{ color: "var(--accent)" }}>{target}</span></span>
          <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 10, color: t.dim, flexShrink: 0 }}>{ago}</span>
        </div>
      );
      return (
        <div style={{ width: 270, borderRadius: 10, border: `1px solid ${t.borderSoft}`, overflow: "hidden", background: t.bg }}>
          {row("kevin", "merged", "#2408", "2h", false)}{row("director", "opened", "#2414", "3h", true)}{row("worker-api", "pushed", "api-stream", "5h", false)}
        </div>
      );
    }
    case "Pane": {
      return (
        <div style={{ width: 250, height: 150, borderRadius: 10, border: `1px solid ${t.border}`, background: t.bg, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: `1px solid ${t.borderSoft}` }}>
            <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: t.fg }}>Edit persona</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: t.dim }}>✕</span>
          </div>
          <div style={{ flex: 1, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>{skel("85%", 9, 4, t)}{skel("100%", 9, 4, t)}{skel("60%", 9, 4, t)}</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 12px", borderTop: `1px solid ${t.borderSoft}` }}>
            <span style={{ fontFamily: mono, fontSize: 10.5, color: t.muted }}>Cancel</span>
            <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--accent)" }}>Save</span>
          </div>
        </div>
      );
    }
    case "TelemetryPanel": {
      return (
        <div style={{ width: 260, borderRadius: 10, border: `1px solid ${t.borderSoft}`, background: t.elev, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: t.fg }}>Tool calls</span>
            <span style={{ fontFamily: mono, fontSize: 10, color: t.dim }}>last 24h</span>
          </div>
          <div style={{ display: "flex", gap: 6, height: 46, alignItems: "flex-end" }}>{[18, 30, 24, 42, 34, 46, 28].map((h, i) => <span key={i} style={{ width: 14, height: h, borderRadius: 3, background: "color-mix(in oklch, var(--accent), transparent 25%)" }} />)}</div>
        </div>
      );
    }
    case "ItemBars": {
      const row = (label: string, pct: number) => (
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontFamily: mono, fontSize: 10.5, color: t.muted, width: 76, textAlign: "right" }}>{label}</span>
          <span style={{ flex: 1, height: 7, borderRadius: 99, background: t.elev, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${pct}%`, borderRadius: 99, background: "var(--accent)" }} /></span>
          <span style={{ fontFamily: mono, fontSize: 10, color: t.dim, width: 24 }}>{pct}</span>
        </div>
      );
      return <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 250 }}>{row("bsc-deny", 72)}{row("bsc-scope", 41)}{row("bsc-audit", 18)}</div>;
    }
    case "SplitBar": {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 250 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 10.5 }}>
            <span style={{ color: t.muted }}>hook fires</span>
            <span><span style={{ color: "var(--ok, #3fb950)" }}>128 allow</span><span style={{ color: t.dim }}> · </span><span style={{ color: "var(--danger)" }}>9 block</span></span>
          </div>
          <div style={{ display: "flex", height: 8, borderRadius: 99, overflow: "hidden" }}>
            <span style={{ width: "93%", background: "color-mix(in oklch, var(--ok, #3fb950), transparent 20%)" }} />
            <span style={{ width: "7%", background: "var(--danger)" }} />
          </div>
        </div>
      );
    }

    // ── layouts (page-skeleton templates, #2197) — schematic mocks of the page frame ──
    case "MasterDetail": {
      const resizable = variant === "resizable";
      const row = (active?: boolean) => <div style={{ height: 9, borderRadius: 3, marginBottom: 6, background: active ? "color-mix(in oklch, var(--accent), transparent 82%)" : t.elev, border: `1px solid ${active ? "var(--accent)" : t.borderSoft}` }} />;
      return (
        <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, background: t.panel, display: "flex", flexDirection: "column" }}>
          <div style={{ height: 22, flex: "none", borderBottom: `1px solid ${t.borderSoft}`, background: t.elev, display: "flex", alignItems: "center", padding: "0 8px", gap: 5 }}>
            <span style={{ width: 40, height: 7, borderRadius: 3, background: t.dim }} /><span style={{ flex: 1 }} />
            <span style={{ width: 22, height: 8, borderRadius: 3, background: "var(--accent)" }} />
          </div>
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <div style={{ width: 92, flex: "none", borderRight: `1px solid ${t.borderSoft}`, padding: 8, overflow: "hidden" }}>{row(true)}{row()}{row()}{row()}</div>
            {resizable && <div style={{ width: 3, flex: "none", background: "var(--accent)", opacity: 0.5 }} />}
            <div style={{ flex: 1, padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
              <span style={{ width: "55%", height: 10, borderRadius: 4, background: t.fg, opacity: 0.8 }} />
              {["100%", "90%", "72%"].map((w) => <span key={w} style={{ width: w, height: 7, borderRadius: 3, background: t.elev }} />)}
            </div>
          </div>
        </div>
      );
    }
    case "SplitView": {
      const vertical = variant === "vertical";
      const label = (txt: string) => <span style={{ fontFamily: mono, fontSize: 9.5, color: t.dim, textTransform: "uppercase", letterSpacing: ".08em" }}>{txt}</span>;
      return (
        <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, display: "flex", flexDirection: vertical ? "column" : "row" }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, background: t.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>{label("primary")}</div>
          <div style={{ ...(vertical ? { height: 3, width: "100%" } : { width: 3 }), flex: "none", background: "var(--accent)", opacity: 0.5 }} />
          <div style={{ ...(vertical ? { flex: "0 0 46px" } : { flex: "0 0 96px" }), background: t.panel, display: "flex", alignItems: "center", justifyContent: "center" }}>{label("secondary")}</div>
        </div>
      );
    }
    case "GraphCanvas": {
      const withRail = variant === "with-rail";
      const node = (x: number, y: number, on?: boolean) => <div style={{ position: "absolute", left: x, top: y, width: 46, height: 24, borderRadius: 6, background: on ? "color-mix(in oklch, var(--accent), transparent 82%)" : t.elev, border: `1px solid ${on ? "var(--accent)" : t.border}` }} />;
      return (
        <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, background: t.panel, display: "flex", flexDirection: "column" }}>
          <div style={{ height: 22, flex: "none", borderBottom: `1px solid ${t.borderSoft}`, background: t.elev, display: "flex", alignItems: "center", padding: "0 8px", gap: 5 }}>
            <span style={{ width: 34, height: 7, borderRadius: 3, background: t.dim }} /><span style={{ flex: 1 }} />
            <span style={{ display: "flex", gap: 3 }}>{["−", "%", "+"].map((g) => <span key={g} style={{ width: 14, height: 12, borderRadius: 3, background: t.bg, border: `1px solid ${t.borderSoft}`, fontFamily: mono, fontSize: 8, color: t.muted, display: "flex", alignItems: "center", justifyContent: "center" }}>{g}</span>)}</span>
          </div>
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            {withRail && <div style={{ width: 58, flex: "none", borderRight: `1px solid ${t.borderSoft}`, padding: 7, display: "flex", flexDirection: "column", gap: 5 }}>{[0, 1, 2].map((i) => <span key={i} style={{ height: 8, borderRadius: 3, background: t.elev }} />)}</div>}
            <div style={{ flex: 1, position: "relative", overflow: "hidden", backgroundImage: `radial-gradient(${t.borderSoft} 1px, transparent 1px)`, backgroundSize: "12px 12px" }}>
              <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
                <path d="M33,34 C82,34 92,74 141,74" stroke={t.border} strokeWidth={1.5} fill="none" />
                <path d="M33,34 C70,34 80,104 121,104" stroke={t.border} strokeWidth={1.5} fill="none" />
              </svg>
              {node(10, 22, true)}{node(118, 62)}{node(98, 92)}
            </div>
          </div>
        </div>
      );
    }
    case "PaneGrid": {
      const [cols, rows] = variant === "1×3" ? [3, 1] : [2, 2];
      return (
        <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, background: t.panel, padding: 8, display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: 6 }}>
          {Array.from({ length: cols * rows }).map((_, i) => (
            <div key={i} style={{ borderRadius: 6, background: t.bg, border: `1px solid ${t.borderSoft}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ height: 11, flex: "none", borderBottom: `1px solid ${t.borderSoft}`, background: t.elev, display: "flex", alignItems: "center", padding: "0 5px", gap: 3 }}>
                <span style={{ width: 4, height: 4, borderRadius: "50%", background: i === 0 ? "var(--accent)" : t.dim }} />
                <span style={{ width: 20, height: 4, borderRadius: 2, background: t.dim }} />
              </div>
              <div style={{ flex: 1, padding: 5, display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ width: "80%", height: 4, borderRadius: 2, background: t.elev }} />
                <span style={{ width: "60%", height: 4, borderRadius: 2, background: t.elev }} />
              </div>
            </div>
          ))}
        </div>
      );
    }

    case "Sequence": {
      const vertical = variant === "vertical";
      const node = (kind: "done" | "active" | "up", txt: string) => (
        <span style={{ width: 16, height: 16, flex: "none", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 9, fontWeight: 700,
          ...(kind === "done" ? { background: "var(--success)", color: "var(--on-success)" }
            : kind === "active" ? { background: t.elev, color: "var(--accent)", boxShadow: "inset 0 0 0 1.5px var(--accent)" }
            : { background: t.elev, color: t.dim, boxShadow: `inset 0 0 0 1px ${t.border}` }) }}>
          {kind === "done" ? "✓" : txt}
        </span>
      );
      const kinds: ("done" | "active" | "up")[] = ["done", "done", "active", "up"];
      const detailBody = (
        <div style={{ flex: 1, minWidth: 0, padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
          <span style={{ width: "50%", height: 10, borderRadius: 4, background: t.fg, opacity: 0.8 }} />
          {["100%", "84%", "68%"].map((w) => <span key={w} style={{ width: w, height: 7, borderRadius: 3, background: t.elev }} />)}
        </div>
      );
      if (vertical) {
        return (
          <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, background: t.panel, display: "flex" }}>
            <div style={{ width: 96, flex: "none", borderRight: `1px solid ${t.borderSoft}`, padding: 9, display: "flex", flexDirection: "column" }}>
              {kinds.map((k, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {node(k, String(i + 1))}
                    <span style={{ flex: 1, height: 6, borderRadius: 3, background: k === "active" ? "color-mix(in oklch, var(--accent), transparent 75%)" : t.elev }} />
                  </div>
                  {i < kinds.length - 1 && <span style={{ width: 2, height: 10, marginLeft: 7, background: k === "done" ? "var(--success)" : t.borderSoft }} />}
                </div>
              ))}
            </div>
            {detailBody}
          </div>
        );
      }
      return (
        <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, background: t.panel, display: "flex", flexDirection: "column" }}>
          <div style={{ height: 32, flex: "none", borderBottom: `1px solid ${t.borderSoft}`, background: t.elev, display: "flex", alignItems: "center", padding: "0 10px", gap: 5 }}>
            {kinds.map((k, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, ...(i < kinds.length - 1 ? { flex: 1 } : {}) }}>
                {node(k, String(i + 1))}
                {i < kinds.length - 1 && <span style={{ flex: 1, minWidth: 14, height: 2, borderRadius: 2, background: k === "done" ? "var(--success)" : t.borderSoft }} />}
              </div>
            ))}
          </div>
          {detailBody}
        </div>
      );
    }

    case "Tree": {
      if (variant === "layered") {
        // Top-down org-chart schematic: root over two children over two grandchildren, anchor edges.
        const card = (x: number, y: number, w: number, on?: boolean) => <div style={{ position: "absolute", left: x, top: y, width: w, height: 20, borderRadius: 5, background: on ? "color-mix(in oklch, var(--accent), transparent 82%)" : t.elev, border: `1px solid ${on ? "var(--accent)" : t.border}` }} />;
        return (
          <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, background: t.panel, display: "flex", flexDirection: "column" }}>
            <div style={{ height: 22, flex: "none", borderBottom: `1px solid ${t.borderSoft}`, background: t.elev, display: "flex", alignItems: "center", padding: "0 8px", gap: 5 }}>
              <span style={{ width: 34, height: 7, borderRadius: 3, background: t.dim }} /><span style={{ flex: 1 }} />
              <span style={{ display: "flex", gap: 3 }}>{["−", "%", "+"].map((g) => <span key={g} style={{ width: 14, height: 12, borderRadius: 3, background: t.bg, border: `1px solid ${t.borderSoft}`, fontFamily: mono, fontSize: 8, color: t.muted, display: "flex", alignItems: "center", justifyContent: "center" }}>{g}</span>)}</span>
            </div>
            <div style={{ flex: 1, position: "relative", overflow: "hidden", backgroundImage: `radial-gradient(${t.borderSoft} 1px, transparent 1px)`, backgroundSize: "12px 12px" }}>
              <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
                <path d="M131,32 C110,48 100,48 84,54" stroke={t.border} strokeWidth={1.5} fill="none" />
                <path d="M147,32 C168,48 178,48 194,54" stroke={t.border} strokeWidth={1.5} fill="none" />
                <path d="M60,74 C48,90 42,90 34,96" stroke={t.border} strokeWidth={1.5} fill="none" />
                <path d="M78,74 C92,90 98,90 108,96" stroke={t.border} strokeWidth={1.5} fill="none" />
              </svg>
              {card(116, 12, 46, true)}{card(46, 54, 46)}{card(186, 54, 46)}{card(10, 96, 46)}{card(86, 96, 46)}
            </div>
          </div>
        );
      }
      // Indented (file-explorer) schematic: chevroned, depth-indented rows + the detail column.
      const chev = (open: boolean) => <span style={{ fontSize: 6, color: t.dim, width: 7, flex: "none", display: "inline-block", transform: open ? "rotate(90deg)" : "none" }}>▶</span>;
      const row = (depth: number, w: number, open?: boolean, active?: boolean, leaf?: boolean) => (
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 4px", paddingLeft: 4 + depth * 10, borderRadius: 4, marginBottom: 2, background: active ? "color-mix(in oklch, var(--accent), transparent 84%)" : "transparent", border: `1px solid ${active ? "var(--accent)" : "transparent"}` }}>
          {leaf ? <span style={{ width: 7, flex: "none" }} /> : chev(!!open)}
          <span style={{ width: w, height: 6, borderRadius: 3, background: active ? "var(--accent)" : t.elev, border: active ? undefined : `1px solid ${t.borderSoft}` }} />
        </div>
      );
      return (
        <div style={{ width: 280, height: 152, borderRadius: 10, overflow: "hidden", border: `1px solid ${t.border}`, background: t.panel, display: "flex" }}>
          <div style={{ width: 112, flex: "none", borderRight: `1px solid ${t.borderSoft}`, padding: 7, overflow: "hidden" }}>
            {row(0, 46, true)}{row(1, 38, true)}{row(2, 42, false, true, true)}{row(2, 30, false, false, true)}{row(1, 34, false)}{row(0, 40, false, false, true)}
          </div>
          <div style={{ flex: 1, padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
            <span style={{ width: "55%", height: 10, borderRadius: 4, background: t.fg, opacity: 0.8 }} />
            {["100%", "88%", "70%"].map((w) => <span key={w} style={{ width: w, height: 7, borderRadius: 3, background: t.elev }} />)}
          </div>
        </div>
      );
    }

    // ── pages (complete data-driven page compositions, #2505) — schematic mocks of each page ──
    case "TablePage": {
      const cell = (w: string, head?: boolean, tone?: string) => <span style={{ width: w, height: head ? 5 : 6, borderRadius: 2, background: tone ?? (head ? t.dim : t.elev), border: head || tone ? undefined : `1px solid ${t.borderSoft}` }} />;
      const row = (i: number, selectedRow?: boolean) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 34px 34px", gap: 6, alignItems: "center", padding: "4px 6px", borderRadius: 4, background: selectedRow ? "color-mix(in oklch, var(--accent), transparent 84%)" : i % 2 ? `color-mix(in oklch, ${t.fg}, transparent 96%)` : "transparent", border: `1px solid ${selectedRow ? "var(--accent)" : "transparent"}` }}>
          {cell("70%")}{cell("100%", false, i === 1 ? "var(--success)" : undefined)}{cell("80%")}
        </div>
      );
      return pageFrame(t, <>
        {pageHead(t)}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, padding: 7, borderRight: `1px solid ${t.borderSoft}` }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 34px 34px", gap: 6, padding: "2px 6px 5px", borderBottom: `1px solid ${t.borderSoft}`, marginBottom: 3 }}>
              {cell("55%", true)}{cell("90%", true)}{cell("70%", true)}
            </div>
            {row(0)}{row(1, true)}{row(2)}
          </div>
          <div style={{ width: 92, flex: "none" }}>{detailPanel(t)}</div>
        </div>
      </>);
    }
    case "TreeExplorerPage": {
      const chev = (open: boolean) => <span style={{ fontSize: 6, color: t.dim, width: 7, flex: "none", display: "inline-block", transform: open ? "rotate(90deg)" : "none" }}>▶</span>;
      const row = (depth: number, w: number, open?: boolean, active?: boolean, leaf?: boolean) => (
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 4px", paddingLeft: 4 + depth * 10, borderRadius: 4, marginBottom: 2, background: active ? "color-mix(in oklch, var(--accent), transparent 84%)" : "transparent", border: `1px solid ${active ? "var(--accent)" : "transparent"}` }}>
          {leaf ? <span style={{ width: 7, flex: "none" }} /> : chev(!!open)}
          <span style={{ width: w, height: 6, borderRadius: 3, background: active ? "var(--accent)" : t.elev, border: active ? undefined : `1px solid ${t.borderSoft}` }} />
        </div>
      );
      return pageFrame(t, <>
        {pageHead(t)}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ width: 104, flex: "none", borderRight: `1px solid ${t.borderSoft}`, padding: 7, overflow: "hidden" }}>
            {row(0, 44, true)}{row(1, 36, true)}{row(2, 40, false, true, true)}{row(2, 28, false, false, true)}{row(1, 32, false)}{row(0, 38, false, false, true)}
          </div>
          {detailPanel(t)}
        </div>
      </>);
    }
    case "PipelinePage": {
      const vertical = variant === "vertical";
      const node = (kind: "done" | "active" | "up", txt: string) => (
        <span style={{ width: 14, height: 14, flex: "none", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 8, fontWeight: 700,
          ...(kind === "done" ? { background: "var(--success)", color: "var(--on-success)" }
            : kind === "active" ? { background: t.elev, color: "var(--accent)", boxShadow: "inset 0 0 0 1.5px var(--accent)" }
            : { background: t.elev, color: t.dim, boxShadow: `inset 0 0 0 1px ${t.border}` }) }}>
          {kind === "done" ? "✓" : txt}
        </span>
      );
      const kinds: ("done" | "active" | "up")[] = ["done", "active", "up", "up"];
      // The focused-step detail: heading + status chip + kv facts — what sets the PAGE apart from bare Sequence.
      const stepDetail = (
        <div style={{ flex: 1, minWidth: 0, padding: 9, display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: "40%", height: 8, borderRadius: 3, background: t.fg, opacity: 0.8 }} />
            <span style={{ width: 30, height: 10, borderRadius: 99, background: "color-mix(in oklch, var(--accent), transparent 86%)", border: "1px solid color-mix(in oklch, var(--accent), transparent 70%)" }} />
          </div>
          {kvRows(t, 3)}
        </div>
      );
      if (vertical) {
        return pageFrame(t, <>
          {pageHead(t)}
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <div style={{ width: 84, flex: "none", borderRight: `1px solid ${t.borderSoft}`, padding: 8, display: "flex", flexDirection: "column" }}>
              {kinds.map((k, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    {node(k, String(i + 1))}
                    <span style={{ flex: 1, height: 5, borderRadius: 3, background: k === "active" ? "color-mix(in oklch, var(--accent), transparent 75%)" : t.elev }} />
                  </div>
                  {i < kinds.length - 1 && <span style={{ width: 2, height: 8, marginLeft: 6, background: k === "done" ? "var(--success)" : t.borderSoft }} />}
                </div>
              ))}
            </div>
            {stepDetail}
          </div>
        </>);
      }
      return pageFrame(t, <>
        {pageHead(t)}
        <div style={{ height: 26, flex: "none", borderBottom: `1px solid ${t.borderSoft}`, background: t.elev, display: "flex", alignItems: "center", padding: "0 9px", gap: 4 }}>
          {kinds.map((k, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, ...(i < kinds.length - 1 ? { flex: 1 } : {}) }}>
              {node(k, String(i + 1))}
              {i < kinds.length - 1 && <span style={{ flex: 1, minWidth: 12, height: 2, borderRadius: 2, background: k === "done" ? "var(--success)" : t.borderSoft }} />}
            </div>
          ))}
        </div>
        {stepDetail}
      </>);
    }
    case "NetworkPage": {
      const node = (x: number, y: number, on?: boolean) => <div style={{ position: "absolute", left: x, top: y, width: 42, height: 20, borderRadius: 5, background: on ? "color-mix(in oklch, var(--accent), transparent 82%)" : t.elev, border: `1px solid ${on ? "var(--accent)" : t.border}` }} />;
      const zoom = (
        <span style={{ display: "flex", gap: 3 }}>{["−", "%", "+"].map((g) => <span key={g} style={{ width: 14, height: 12, borderRadius: 3, background: t.bg, border: `1px solid ${t.borderSoft}`, fontFamily: mono, fontSize: 8, color: t.muted, display: "flex", alignItems: "center", justifyContent: "center" }}>{g}</span>)}</span>
      );
      return pageFrame(t, <>
        {pageHead(t, zoom)}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, position: "relative", overflow: "hidden", backgroundImage: `radial-gradient(${t.borderSoft} 1px, transparent 1px)`, backgroundSize: "12px 12px" }}>
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
              <path d="M80,32 C60,46 54,46 44,52" stroke={t.border} strokeWidth={1.5} fill="none" />
              <path d="M96,32 C116,46 122,46 132,52" stroke={t.border} strokeWidth={1.5} fill="none" />
              <path d="M132,72 C112,86 106,86 96,92" stroke={t.border} strokeWidth={1.5} fill="none" />
              <path d="M44,72 C64,86 70,86 80,92" stroke={t.border} strokeWidth={1.5} fill="none" />
            </svg>
            {node(66, 12)}{node(20, 52)}{node(112, 52, true)}{node(66, 92)}
          </div>
          <div style={{ width: 84, flex: "none", borderLeft: `1px solid ${t.borderSoft}` }}>{detailPanel(t)}</div>
        </div>
      </>);
    }
    case "DashboardPage": {
      const tile = (tone: string) => (
        <div style={{ flex: 1, borderRadius: 6, background: t.bg, border: `1px solid ${t.borderSoft}`, padding: "5px 7px", display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ width: "60%", height: 4, borderRadius: 2, background: t.dim }} />
          <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: tone, lineHeight: 1 }}>▮▮</span>
        </div>
      );
      const feedRow = (striped: boolean) => (
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 5px", background: striped ? `color-mix(in oklch, ${t.fg}, transparent 96%)` : "transparent" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: t.elev, border: `1px solid ${t.borderSoft}`, flexShrink: 0 }} />
          <span style={{ flex: 1, height: 4, borderRadius: 2, background: t.elev }} />
        </div>
      );
      return pageFrame(t, <>
        {pageHead(t)}
        <div style={{ flex: 1, minHeight: 0, padding: 8, display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ display: "flex", gap: 6 }}>{tile(t.fg)}{tile("var(--success)")}{tile("var(--danger)")}</div>
          <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "2fr 1fr", gap: 6 }}>
            <div style={{ borderRadius: 6, background: t.bg, border: `1px solid ${t.borderSoft}`, padding: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ width: "40%", height: 4, borderRadius: 2, background: t.dim }} />
              <svg width="100%" height="34" preserveAspectRatio="none" viewBox="0 0 120 34">
                <path d="M0,28 L20,22 L40,25 L60,12 L80,17 L100,7 L120,12 L120,34 L0,34 Z" fill="color-mix(in oklch, var(--accent), transparent 82%)" />
                <polyline points="0,28 20,22 40,25 60,12 80,17 100,7 120,12" fill="none" stroke="var(--accent)" strokeWidth={1.5} />
              </svg>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 18, height: 18, borderRadius: "50%", flexShrink: 0, background: `conic-gradient(var(--accent) 0 60%, var(--success) 60% 85%, ${t.elev} 85% 100%)` }} />
                {[0, 1].map((i) => <span key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 5, height: 5, borderRadius: 2, background: i ? "var(--success)" : "var(--accent)" }} /><span style={{ width: 16, height: 4, borderRadius: 2, background: t.elev }} /></span>)}
              </div>
            </div>
            <div style={{ borderRadius: 6, background: t.bg, border: `1px solid ${t.borderSoft}`, padding: 4, display: "flex", flexDirection: "column", gap: 1, overflow: "hidden" }}>
              {feedRow(false)}{feedRow(true)}{feedRow(false)}{feedRow(true)}
            </div>
          </div>
        </div>
      </>);
    }
    case "CollectionPage": {
      const row = (active?: boolean) => (
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 6px", borderRadius: 6, marginBottom: 4, background: active ? "color-mix(in oklch, var(--accent), transparent 84%)" : t.bg, border: `1px solid ${active ? "var(--accent)" : t.borderSoft}` }}>
          <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: "48%", height: 5, borderRadius: 2, background: active ? "var(--accent)" : t.muted }} />
              <span style={{ width: 18, height: 8, borderRadius: 99, background: `color-mix(in oklch, ${active ? "var(--accent)" : t.dim}, transparent 84%)`, border: `1px solid color-mix(in oklch, ${active ? "var(--accent)" : t.dim}, transparent 66%)` }} />
            </span>
            <span style={{ width: "70%", height: 4, borderRadius: 2, background: t.elev }} />
          </span>
          <span style={{ width: 12, height: 4, borderRadius: 2, background: t.dim, flexShrink: 0 }} />
        </div>
      );
      return pageFrame(t, <>
        {pageHead(t)}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ width: 112, flex: "none", borderRight: `1px solid ${t.borderSoft}`, padding: 7, overflow: "hidden" }}>
            {row(true)}{row()}{row()}
          </div>
          {detailPanel(t)}
        </div>
      </>);
    }
    case "RecordPage": {
      // Identity header: title + status pill next to it, the actions block right-aligned.
      const head = (
        <div style={{ height: 22, flex: "none", borderBottom: `1px solid ${t.borderSoft}`, background: t.elev, display: "flex", alignItems: "center", padding: "0 8px", gap: 5 }}>
          <span style={{ width: 40, height: 7, borderRadius: 3, background: t.fg, opacity: 0.75 }} />
          <span style={{ width: 20, height: 9, borderRadius: 99, background: "color-mix(in oklch, var(--success), transparent 86%)", border: "1px solid color-mix(in oklch, var(--success), transparent 70%)" }} />
          <span style={{ width: 22, height: 5, borderRadius: 3, background: t.dim }} />
          <span style={{ flex: 1 }} />
          <span style={{ width: 22, height: 8, borderRadius: 3, background: "var(--accent)" }} />
        </div>
      );
      // One labelled field group: a SectionLabel line over kv rows.
      const group = (n: number) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ width: 34, height: 4, borderRadius: 2, background: t.dim }} />
          {kvRows(t, n)}
        </div>
      );
      return pageFrame(t, <>
        {head}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, padding: 9, display: "flex", flexDirection: "column", gap: 9, overflow: "hidden" }}>
            {group(3)}{group(2)}
          </div>
          <div style={{ width: 84, flex: "none", borderLeft: `1px solid ${t.borderSoft}` }}>{detailPanel(t)}</div>
        </div>
      </>);
    }

    // (The examples-kit specimens — the #2456 persona-manager demo app — were retired with the kit,
    // #2506; react-ui's pages tier, #2505, is the exemplar now.)

    default:
      return (
        <div style={{ width: "min(320px, 100%)", height: 128, borderRadius: 10, border: `1px dashed ${t.border}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: `repeating-linear-gradient(135deg, transparent 0 9px, color-mix(in oklch, ${t.fg}, transparent 93%) 9px 10px)` }}>
          <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.fg }}>{comp.name}</div>
          <div style={{ fontFamily: mono, fontSize: 10, color: t.dim }}>{comp.role} · rendered in-app</div>
        </div>
      );
  }
}
