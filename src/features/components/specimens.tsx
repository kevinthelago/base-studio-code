/* eslint-disable no-restricted-syntax -- isolated preview specimens: bespoke visual mocks rendered on a
   sandboxed surface (their own preview palette), NOT app chrome — raw elements are the point here. */
// Preview specimens for the Component Library pane (#2269) — a self-contained visual mock of each
// component, rendered on a neutral preview surface with its OWN dark/light theme (a sandbox, decoupled
// from the app theme so a component can be inspected either way). Ported from the design prototype.
// Unknown components fall back to a labeled placeholder — the pane still previews them, just generically.
import type { CSSProperties, ReactNode } from "react";
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

/** Render a specimen for `comp` in a `variant` on the `theme` sandbox. */
export function renderSpecimen(comp: ComponentRecord, variant: string, theme: PreviewTheme): ReactNode {
  const t = previewTokens(theme);
  switch (comp.name) {
    case "Button": {
      const base: CSSProperties = { height: 30, padding: "0 16px", borderRadius: 6, fontFamily: mono, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid transparent", cursor: "default" };
      let s: CSSProperties, label = "Button";
      if (variant === "primary") { s = { ...base, background: "var(--accent)", color: "var(--accent-text)" }; label = "Launch stage"; }
      else if (variant === "ghost") { s = { ...base, background: "transparent", color: t.fg, borderColor: t.borderSoft }; label = "Cancel"; }
      else if (variant === "danger") { s = { ...base, background: "transparent", color: "var(--danger)", borderColor: "color-mix(in oklch, var(--danger), transparent 60%)" }; label = "Delete"; }
      else if (variant === "sm") { s = { ...base, height: 24, fontSize: 10.5, padding: "0 10px", background: t.elev, color: t.fg, borderColor: t.borderSoft }; label = "clone"; }
      else { s = { ...base, background: t.elev, color: t.fg, borderColor: t.borderSoft }; }
      return <button style={s}>{label}</button>;
    }
    case "Chip": {
      const map: Record<string, string> = { neutral: t.muted, accent: "var(--accent)", success: "var(--success)", info: "var(--info)", danger: "var(--danger)" };
      const col = map[variant] || t.muted;
      const chip = (c: string, txt: string) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: mono, fontSize: 10.5, color: c, background: `color-mix(in oklch, ${c}, transparent 88%)`, border: `1px solid color-mix(in oklch, ${c}, transparent 72%)`, borderRadius: 99, padding: "3px 10px" }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: c }} />{txt}
        </span>
      );
      return <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>{chip(col, variant)}{chip(t.muted, "v2.3.0")}</div>;
    }
    case "TextField": {
      const err = variant === "error", dis = variant === "disabled";
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 240, opacity: dis ? 0.55 : 1 }}>
          <label style={{ fontFamily: mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: t.muted }}>Persona name</label>
          <div style={{ height: 30, display: "flex", alignItems: "center", padding: "0 10px", borderRadius: 6, background: t.bg, border: `1px solid ${err ? "var(--danger)" : t.borderSoft}`, color: t.fg, fontFamily: mono, fontSize: 12 }}>{dis ? "" : "Senior Reviewer"}</div>
          {err && <span style={{ fontFamily: mono, fontSize: 10, color: "var(--danger)" }}>Name is required</span>}
        </div>
      );
    }
    case "StatusDot": {
      const map: Record<string, string> = { run: "var(--state-run)", wait: "var(--state-wait)", idle: "var(--state-idle)", stopped: "var(--state-stopped)" };
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {["run", "wait", "idle", "stopped"].map((k) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: map[k], animation: k === variant && k === "run" ? "pulse 1.4s ease-in-out infinite" : undefined, boxShadow: k === variant ? `0 0 0 3px color-mix(in oklch, ${map[k]}, transparent 78%)` : undefined }} />
              <span style={{ fontFamily: mono, fontSize: 11, color: k === variant ? t.fg : t.muted }}>{k}</span>
            </div>
          ))}
        </div>
      );
    }
    case "SegmentedControl": {
      const joined = variant === "joined";
      return (
        <div style={joined ? { display: "inline-flex", border: `1px solid ${t.borderSoft}`, borderRadius: 5, overflow: "hidden" } : { display: "inline-flex", gap: 3, padding: 3, background: t.elev, border: `1px solid ${t.borderSoft}`, borderRadius: 6 }}>
          {["dark", "light"].map((o, i) => (
            <button key={o} style={{ height: 24, padding: "0 14px", border: joined ? (i ? `1px solid ${t.borderSoft}` : "0") : "1px solid " + (i === 0 ? "var(--accent-dim)" : "transparent"), borderLeftWidth: joined && i ? 1 : undefined, background: i === 0 ? (joined ? "var(--accent-soft)" : t.bg) : "transparent", color: i === 0 ? "var(--accent)" : t.muted, fontFamily: mono, fontSize: 10.5, borderRadius: joined ? 0 : 4, cursor: "default" }}>{o}</button>
          ))}
        </div>
      );
    }
    case "Card": {
      const toned = variant === "tone", inter = variant === "interactive";
      return (
        <div style={{ width: 250, padding: "13px 14px", borderRadius: 10, background: t.panel, border: `1px solid ${toned ? "color-mix(in oklch, var(--accent), transparent 60%)" : t.borderSoft}`, boxShadow: inter ? "0 6px 22px rgba(0,0,0,.3)" : "none" }}>
          <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.fg, marginBottom: 4 }}>Senior Reviewer</div>
          <div style={{ fontSize: 11.5, color: t.muted, lineHeight: 1.5 }}>Reviews diffs for correctness and style before merge.</div>
          <div style={{ marginTop: 10, fontFamily: mono, fontSize: 9.5, color: t.dim }}>{inter ? "click to select →" : "role · reviewer"}</div>
        </div>
      );
    }
    case "EmptyState": {
      const dashed = variant === "dashed";
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "8px 12px", maxWidth: 260 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, marginBottom: 12, background: dashed ? "transparent" : t.elev, border: `1px ${dashed ? "dashed" : "solid"} ${t.border}`, color: dashed ? t.dim : "var(--accent)" }}>{dashed ? "∅" : "✦"}</div>
          <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: t.fg }}>{dashed ? "No results" : "No personas yet"}</div>
          <div style={{ fontSize: 11.5, color: t.muted, marginTop: 6, lineHeight: 1.5 }}>{dashed ? "Try a different search term." : "Create one to get started."}</div>
          {!dashed && <button style={{ marginTop: 14, height: 28, padding: "0 14px", borderRadius: 6, background: "var(--accent)", color: "var(--accent-text)", border: 0, fontFamily: mono, fontSize: 11, fontWeight: 600, cursor: "default" }}>+ New persona</button>}
        </div>
      );
    }
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

    // ── typography ──
    case "Text":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontFamily: mono, fontSize: 15, fontWeight: 600, color: t.fg }}>The quick brown fox</span>
          <span style={{ fontFamily: mono, fontSize: 12, color: t.muted }}>muted · secondary copy</span>
          <span style={{ fontFamily: mono, fontSize: 11, color: "var(--accent)" }}>accent · a highlighted value</span>
        </div>
      );

    // ── controls ──
    case "IconButton":
      return (
        <div style={{ display: "flex", gap: 8 }}>
          {["✕", "⋯", "⟳"].map((g, i) => (
            <button key={g} style={{ width: 30, height: 30, borderRadius: 7, border: `1px solid ${i === 0 ? "color-mix(in oklch, var(--danger), transparent 55%)" : t.borderSoft}`, background: t.elev, color: i === 0 ? "var(--danger)" : t.muted, fontSize: 13, cursor: "default", display: "flex", alignItems: "center", justifyContent: "center" }}>{g}</button>
          ))}
        </div>
      );
    case "Checkbox": {
      const box = (on: boolean, label: string) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 15, height: 15, borderRadius: 4, border: `1px solid ${on ? "var(--accent)" : t.border}`, background: on ? "var(--accent)" : "transparent", color: "var(--accent-text)", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>{on ? "✓" : ""}</span>
          <span style={{ fontFamily: mono, fontSize: 11.5, color: t.fg }}>{label}</span>
        </div>
      );
      return <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>{box(true, "Auto-approve PRs")}{box(false, "Require review")}</div>;
    }
    case "Toggle": {
      const sw = (on: boolean, label: string) => (
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 30, height: 17, borderRadius: 99, padding: 1, background: on ? "var(--accent)" : t.elev, border: `1px solid ${on ? "var(--accent-dim)" : t.border}`, display: "flex", justifyContent: on ? "flex-end" : "flex-start" }}>
            <span style={{ width: 13, height: 13, borderRadius: "50%", background: on ? "var(--accent-text)" : t.dim }} />
          </span>
          <span style={{ fontFamily: mono, fontSize: 11.5, color: t.fg }}>{label}</span>
        </div>
      );
      return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{sw(true, "Bypass mode")}{sw(false, "Sandbox")}</div>;
    }
    case "SelectField":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 240 }}>
          <label style={{ fontFamily: mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: t.muted }}>Model</label>
          <div style={{ height: 30, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", borderRadius: 6, background: t.bg, border: `1px solid ${t.borderSoft}`, color: t.fg, fontFamily: mono, fontSize: 12 }}>
            <span>claude-opus-4-8</span><span style={{ color: t.dim }}>▾</span>
          </div>
        </div>
      );
    case "BackButton":
      return (
        <button style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 28, padding: "0 12px 0 9px", borderRadius: 7, background: t.elev, border: `1px solid ${t.borderSoft}`, color: t.fg, fontFamily: mono, fontSize: 11.5, cursor: "default" }}>
          <span style={{ fontSize: 13 }}>←</span> Back to library
        </button>
      );
    case "ColorSwatch":
      return (
        <div style={{ display: "flex", gap: 8 }}>
          {["var(--accent)", "var(--success)", "var(--danger)", "var(--info)", "var(--state-wait)"].map((c, i) => (
            <span key={c} style={{ width: 26, height: 26, borderRadius: 7, background: c, boxShadow: i === 0 ? `0 0 0 2px ${t.bg}, 0 0 0 3px ${c}` : "none" }} />
          ))}
        </div>
      );
    case "ConfirmButton":
      return (
        <div style={{ display: "inline-flex", borderRadius: 7, overflow: "hidden", border: "1px solid color-mix(in oklch, var(--danger), transparent 55%)" }}>
          <span style={{ height: 28, display: "flex", alignItems: "center", padding: "0 12px", background: "color-mix(in oklch, var(--danger), transparent 86%)", color: "var(--danger)", fontFamily: mono, fontSize: 11.5 }}>Delete?</span>
          <span style={{ height: 28, display: "flex", alignItems: "center", padding: "0 12px", background: "var(--danger)", color: "var(--accent-text)", fontFamily: mono, fontSize: 11.5, fontWeight: 600 }}>Confirm</span>
        </div>
      );

    // ── data ──
    case "StatTile": {
      const tile = (k: string, v: string, tone: string) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 74 }}>
          <span style={{ fontFamily: mono, fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em", color: t.dim }}>{k}</span>
          <span style={{ fontFamily: mono, fontSize: 19, fontWeight: 700, color: tone }}>{v}</span>
        </div>
      );
      return <div style={{ display: "flex", gap: 22 }}>{tile("agents", "6", t.fg)}{tile("landed", "4", "var(--success)")}{tile("blocked", "1", "var(--danger)")}</div>;
    }
    case "FillBar": {
      const bar = (v: number, c: string, label: string) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, width: 220 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 10, color: t.muted }}><span>{label}</span><span>{Math.round(v * 100)}%</span></div>
          <div style={{ height: 7, borderRadius: 99, background: t.elev, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${v * 100}%`, background: c, borderRadius: 99 }} /></div>
        </div>
      );
      return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{bar(0.72, "var(--accent)", "context used")}{bar(0.34, "var(--success)", "tests passing")}</div>;
    }
    case "Code": {
      const line = (indent: number, parts: [string, string][]) => (
        <div style={{ paddingLeft: indent * 12 }}>{parts.map(([txt, c], i) => <span key={i} style={{ color: c }}>{txt}</span>)}</div>
      );
      return (
        <div style={{ width: 264, borderRadius: 8, background: t.bg, border: `1px solid ${t.borderSoft}`, padding: "10px 12px", fontFamily: mono, fontSize: 11, lineHeight: 1.7 }}>
          {line(0, [["export function ", t.muted], ["Widget", "var(--accent)"], ["(props) {", t.muted]])}
          {line(1, [["return ", "var(--danger)"], ["<div ", t.muted], ["{...props}", "var(--info)"], [" />;", t.muted]])}
          {line(0, [["}", t.muted]])}
        </div>
      );
    }
    case "Avatar": {
      const av = (initials: string, c: string) => (
        <span style={{ width: 30, height: 30, borderRadius: "50%", background: `color-mix(in oklch, ${c}, transparent 80%)`, color: c, border: `1px solid color-mix(in oklch, ${c}, transparent 60%)`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 11, fontWeight: 600 }}>{initials}</span>
      );
      return <div style={{ display: "flex", gap: 8 }}>{av("AR", "var(--accent)")}{av("KL", "var(--success)")}{av("DV", "var(--info)")}</div>;
    }
    case "IconBox":
      return (
        <div style={{ display: "flex", gap: 10 }}>
          {[["✦", "var(--accent)"], ["◫", t.muted], ["⚙", t.muted]].map(([g, c], i) => (
            <span key={i} style={{ width: 34, height: 34, borderRadius: 9, background: t.elev, border: `1px solid ${t.borderSoft}`, color: c, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>{g}</span>
          ))}
        </div>
      );
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
    case "StatCard":
      return (
        <div style={{ width: 150, padding: "12px 14px", borderRadius: 10, background: t.panel, border: `1px solid ${t.borderSoft}` }}>
          <div style={{ fontFamily: mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: t.dim }}>Landed today</div>
          <div style={{ fontFamily: mono, fontSize: 24, fontWeight: 700, color: t.fg, margin: "4px 0" }}>12</div>
          <span style={{ fontFamily: mono, fontSize: 10, color: "var(--success)" }}>▲ 4 vs yesterday</span>
        </div>
      );

    // ── charts ──
    case "Bars":
      return <div style={{ display: "flex", gap: 5, alignItems: "flex-end", height: 60 }}>{[24, 40, 30, 52, 36, 58].map((h, i) => <span key={i} style={{ width: 12, height: h, borderRadius: "3px 3px 0 0", background: "var(--accent)" }} />)}</div>;
    case "HBars":
      return <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 180 }}>{[0.9, 0.6, 0.75, 0.4].map((v, i) => <div key={i} style={{ height: 12, borderRadius: 4, background: t.elev, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${v * 100}%`, background: "var(--accent)", borderRadius: 4 }} /></div>)}</div>;
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
    case "Donut":
      return (
        <div style={{ width: 60, height: 60, borderRadius: "50%", background: "conic-gradient(var(--accent) 0 62%, var(--success) 62% 84%, " + t.elev + " 84% 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ width: 34, height: 34, borderRadius: "50%", background: t.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 11, color: t.fg }}>62%</span>
        </div>
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
    case "Banner": {
      const map: Record<string, string> = { info: "var(--info)", success: "var(--success)", warn: "var(--state-wait)", danger: "var(--danger)", accent: "var(--accent)", neutral: t.muted };
      const c = map[variant] || "var(--info)";
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 9, width: 280, padding: "9px 12px", borderRadius: 8, background: `color-mix(in oklch, ${c}, transparent 90%)`, border: `1px solid color-mix(in oklch, ${c}, transparent 68%)`, color: t.fg, fontFamily: mono, fontSize: 11.5 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, flex: "none" }} />
          <span style={{ flex: 1 }}>Staging deploy finished.</span>
          <span style={{ color: t.dim }}>✕</span>
        </div>
      );
    }
    case "InlineError":
      return (
        <div style={{ width: 260, padding: "8px 12px", borderRadius: 6, background: "color-mix(in oklch, var(--danger), transparent 90%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)", color: "var(--danger)", fontFamily: mono, fontSize: 11, lineHeight: 1.5 }}>
          Failed to reach the relay — retrying in 5s.
        </div>
      );
    case "Skeleton": {
      const bar = (w: string) => <span style={{ display: "block", height: 10, width: w, borderRadius: 5, background: `linear-gradient(90deg, ${t.elev}, ${t.borderSoft}, ${t.elev})` }} />;
      return <div style={{ display: "flex", flexDirection: "column", gap: 9, width: 240 }}>{bar("60%")}{bar("100%")}{bar("85%")}</div>;
    }

    default:
      return (
        <div style={{ width: "min(320px, 100%)", height: 128, borderRadius: 10, border: `1px dashed ${t.border}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: `repeating-linear-gradient(135deg, transparent 0 9px, color-mix(in oklch, ${t.fg}, transparent 93%) 9px 10px)` }}>
          <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.fg }}>{comp.name}</div>
          <div style={{ fontFamily: mono, fontSize: 10, color: t.dim }}>{comp.role} · rendered in-app</div>
        </div>
      );
  }
}
