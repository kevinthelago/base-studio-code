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
    case "Field": {
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
    default:
      return (
        <div style={{ width: "min(320px, 100%)", height: 128, borderRadius: 10, border: `1px dashed ${t.border}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: `repeating-linear-gradient(135deg, transparent 0 9px, color-mix(in oklch, ${t.fg}, transparent 93%) 9px 10px)` }}>
          <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.fg }}>{comp.name}</div>
          <div style={{ fontFamily: mono, fontSize: 10, color: t.dim }}>{comp.role} · rendered in-app</div>
        </div>
      );
  }
}
