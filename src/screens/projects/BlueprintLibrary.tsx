// Blueprint library view (#609 slice 4) — ported from the design's library.jsx. The
// landing grid of blueprint cards (+ hero + stats). Each card shows the stage flow as a
// monochrome glyph sequence (gates carry the lone accent) and a gist-sync badge. Card
// display metadata is derived with fallbacks, so a plain Blueprint (id/name/desc/
// sections) renders fine even before slice 5 populates gist/origin/uses.

import { useState } from "react";
import "../../styles/blueprints.css";
import { Ic } from "./blueprintIcons";
import { stageKind, tint, hue } from "./blueprintCatalog";
import {
  blueprintCategory, filterBlueprints, CATEGORY_META, BLUEPRINT_CATEGORIES,
  type Blueprint, type BlueprintSection, type BlueprintGist, type BlueprintOrigin, type BlueprintCategory,
} from "./blueprints";

const HUES = [70, 230, 295, 195, 145, 350, 25];

/** Stable hue from the blueprint id (when none is stored). */
function bpHue(bp: Blueprint): number {
  if (typeof bp.h === "number") return bp.h;
  let n = 0;
  for (let i = 0; i < bp.id.length; i++) n = (n + bp.id.charCodeAt(i)) % HUES.length;
  return HUES[n];
}
const bpIcon = (bp: Blueprint): string => bp.icon ?? (bp.name.trim()[0] ?? "B").toUpperCase();
const bpOrigin = (bp: Blueprint): BlueprintOrigin => bp.origin ?? "local";
const bpGist = (bp: Blueprint): BlueprintGist => bp.gist ?? { state: "local" };

export function gistBadge(g: BlueprintGist): { dot: string; label: string } {
  if (g.state === "local") return { dot: "var(--fg-dim)", label: "local only" };
  if (g.state === "dirty") return { dot: "var(--accent)", label: "unpublished changes" };
  if (g.state === "forked") return { dot: "var(--violet)", label: "forked" };
  return { dot: "var(--success)", label: "synced · " + (g.rev ?? "r1") };
}

const isGate = (s: BlueprintSection) => s.pipelines.some((p) => p.gate);

/** The card's stage ribbon: a monochrome glyph sequence; gated stages carry the accent. */
function StageSeq({ sections }: { sections: BlueprintSection[] }) {
  const cap = 9;
  const shown = sections.slice(0, cap);
  const title = sections.map((s) => s.name).join(" → ");
  return (
    <div className="seq" title={title}>
      {shown.map((s, i) => {
        const k = stageKind(s.key);
        return (
          <span key={s.uid} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {i > 0 && <span className="arr">›</span>}
            <span className={"st-g" + (isGate(s) ? " gated" : "")} title={s.name}><Ic n={k.glyph} size={13} /></span>
          </span>
        );
      })}
      {sections.length > cap && <span className="more">+{sections.length - cap}</span>}
    </div>
  );
}

export type CardMenuAction = "duplicate" | "open-menu";

function BlueprintCard({ bp, index, active, onOpen, onUse, onMenu }: {
  bp: Blueprint; index: number; active?: boolean;
  onOpen: (id: string) => void;
  onUse?: (id: string) => void;
  onMenu: (action: CardMenuAction, bp: Blueprint, e: React.MouseEvent) => void;
}) {
  const pipes = bp.sections.reduce((n, s) => n + s.pipelines.length, 0);
  const gates = bp.sections.reduce((n, s) => n + s.pipelines.filter((p) => p.gate).length, 0);
  const gb = gistBadge(bpGist(bp));
  const h = bpHue(bp);
  const origin = bpOrigin(bp);
  return (
    <div className={"bp-card" + (active ? " is-active" : "")} style={{ animationDelay: index * 0.03 + "s" }} onClick={() => onOpen(bp.id)}>
      <div className="bp-actions">
        <button className="iconbtn" title="Duplicate" onClick={(e) => { e.stopPropagation(); onMenu("duplicate", bp, e); }}>⧉</button>
        <button className="iconbtn" title="More" onClick={(e) => { e.stopPropagation(); onMenu("open-menu", bp, e); }}>⋯</button>
      </div>
      <div className="bp-top">
        <div className="bp-icon" style={{ background: tint(h, 0.16), color: hue(h), borderColor: tint(h, 0.4) }}>{bpIcon(bp)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{bp.name}
            {(() => { const c = blueprintCategory(bp); const m = CATEGORY_META[c];
              return <span className="tag" title={`${m.label} blueprint`} style={{ color: hue(m.h), borderColor: tint(m.h, 0.5) }}>{m.label}</span>; })()}
            {origin === "built-in" && <span className="tag">built-in</span>}
            {origin === "forked" && <span className="tag violet">forked</span>}
            {origin === "imported" && <span className="tag info">imported</span>}
            {active && <span className="tag" style={{ color: "var(--success)", borderColor: "color-mix(in oklch, var(--success), transparent 55%)" }}>✓ selected</span>}
          </h3>
          <p className="bp-desc">{bp.desc}</p>
        </div>
      </div>

      <StageSeq sections={bp.sections} />

      <div className="bp-foot">
        <span>{bp.sections.length} stages</span>
        {pipes > 0 && <span>· {pipes} pipelines</span>}
        {gates > 0 && <span style={{ color: "var(--accent)" }}>· {gates} gates</span>}
        <span className="gsync"><i style={{ background: gb.dot }} />{gb.label}</span>
        <span className="sp" />
        {/* Select this blueprint for new projects (without opening the editor). */}
        <button
          className={"btn sm" + (active ? "" : " ghost")}
          title={active ? "This blueprint seeds new projects" : "Use this blueprint for new projects"}
          onClick={(e) => { e.stopPropagation(); onUse?.(bp.id); }}
          style={active ? { color: "var(--success)", borderColor: "var(--success)" } : undefined}
        >{active ? "✓ in use" : "use"}</button>
      </div>
    </div>
  );
}

export interface LibraryViewProps {
  blueprints: Blueprint[];
  onOpen: (id: string) => void;
  onMenu: (action: CardMenuAction, bp: Blueprint, e: React.MouseEvent) => void;
  onNew: () => void;
  onImport: () => void;
  /** The currently-selected blueprint id (seeds new projects) — flagged on its card. */
  activeId?: string;
  /** Select a blueprint for new projects without opening its editor. */
  onUse?: (id: string) => void;
  /** All-time count of projects seeded from blueprints (a stat). */
  seeded?: number;
}

export function LibraryView({ blueprints, onOpen, onMenu, onNew, onImport, activeId, onUse, seeded = 0 }: LibraryViewProps) {
  const totalStages = blueprints.reduce((n, b) => n + b.sections.length, 0);
  const published = blueprints.filter((b) => bpGist(b).state !== "local").length;
  const gates = blueprints.reduce((n, b) => n + b.sections.reduce((m, s) => m + s.pipelines.filter((p) => p.gate).length, 0), 0);
  const top = [...blueprints].sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0))[0];

  // Search + category filter (#645).
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<BlueprintCategory | "all">("all");
  const shown = filterBlueprints(blueprints, { query, category: cat });

  return (
    <div className="wrap">
      <div className="phead">
        <div>
          <h1>Blueprints</h1>
          <p className="psub">Reusable planning templates — an ordered set of stages, each with its own prompt module and attached pipelines. Pick one to seed every new project's planning session.</p>
        </div>
        <div className="pacts">
          <span className="sync-dot" style={{ marginRight: 4 }}><i />gist sync on</span>
          <button className="btn" onClick={onImport}><Ic n="cloud_download" size={14} /> Import from gist</button>
          <button className="btn primary" onClick={onNew}><Ic n="add" size={14} /> New blueprint</button>
        </div>
      </div>

      <div className="hero">
        <div className="hicon">B</div>
        <div className="htxt">
          <div className="heyebrow">Blueprints · library</div>
          <div className="hbody">
            <b>{blueprints.length} blueprints</b> in your library — seeding planning across the fleet.{" "}
            {top && <><b>{top.name}</b> is the workhorse at <span className="em-amber">{top.uses ?? 0} uses</span>. </>}
            {published > 0 && <>{published} are <b>published to gists</b> and shareable; </>}
            author your own, then publish in one click to share with others.
          </div>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="sk">Blueprints</div><div className="sv">{blueprints.length}</div><div className="sm">in library</div></div>
        <div className="stat"><div className="sk">Stages · total</div><div className="sv">{totalStages}</div><div className="sm">across all blueprints</div></div>
        <div className="stat"><div className="sk">Gate pipelines</div><div className="sv am">{gates}</div><div className="sm">block until they pass</div></div>
        <div className="stat"><div className="sk">Published</div><div className="sv ok">{published}</div><div className="sm">shared via gist</div></div>
        <div className="stat"><div className="sk">Projects seeded</div><div className="sv">{seeded}</div><div className="sm">all-time</div></div>
      </div>

      <div className="seclabel">Your library<span className="ln" /><span className="dim">{shown.length}{shown.length !== blueprints.length ? ` / ${blueprints.length}` : ""}</span></div>

      {/* search + category filter (#645) */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search blueprints…"
          aria-label="Search blueprints"
          style={{
            flex: "1 1 220px", minWidth: 180, padding: "6px 10px", borderRadius: 6,
            background: "var(--bg-inset)", border: "1px solid var(--border)",
            color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 12,
          }}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className={"btn ghost sm" + (cat === "all" ? " primary" : "")} onClick={() => setCat("all")}>All</button>
          {BLUEPRINT_CATEGORIES.map((c) => {
            const m = CATEGORY_META[c];
            return (
              <button
                key={c}
                className="btn ghost sm"
                onClick={() => setCat(c)}
                title={`${m.label} blueprints`}
                style={cat === c ? { color: hue(m.h), borderColor: tint(m.h, 0.5) } : undefined}
              >{m.label}</button>
            );
          })}
        </div>
      </div>

      <div className="bp-grid">
        {shown.map((bp, i) => (
          <BlueprintCard key={bp.id} bp={bp} index={i} active={bp.id === activeId} onOpen={onOpen} onUse={onUse} onMenu={onMenu} />
        ))}
        {shown.length === 0 && (
          <div className="hint" style={{ gridColumn: "1 / -1", padding: "24px 0", textAlign: "center" }}>
            No blueprints match{query ? ` "${query}"` : ""}{cat !== "all" ? ` in ${CATEGORY_META[cat].label}` : ""}.
          </div>
        )}
        <button className="bp-card" onClick={onNew}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, color: "var(--fg-dim)", border: "1px dashed var(--border)", background: "transparent", minHeight: 150 }}>
          <Ic n="add" size={22} style={{ opacity: .7 }} />
          <span className="mono" style={{ fontSize: 11 }}>New blueprint</span>
          <span className="hint">start blank, or design it with Claude</span>
        </button>
      </div>
    </div>
  );
}
