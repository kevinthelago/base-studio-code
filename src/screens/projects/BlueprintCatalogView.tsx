// Community catalog view (#609 slice 5) — ported from the design's library.jsx
// CatalogView. Browse the shared gist-blueprint catalog, search / sort, preview, and
// fork into your library (or paste a gist URL/ID to import directly). Static catalog
// for now; discovery becomes federated "sources" later (#598).

import { useState } from "react";
import "../../styles/blueprints.css";
import { Ic } from "./blueprintIcons";
import { CATALOG, tint, hue, type CatalogEntry } from "./blueprintCatalog";

export interface CatalogViewProps {
  /** The community catalog (defaults to the built-in CATALOG). */
  catalog?: CatalogEntry[];
  /** Catalog ids already forked into the user's library (Fork shows ✓). */
  forkedIds: string[];
  onFork: (cat: CatalogEntry) => void;
  onPreview: (cat: CatalogEntry) => void;
  onBack: () => void;
  onManualImport: () => void;
}

export function CatalogView({ catalog = CATALOG, forkedIds, onFork, onPreview, onBack, onManualImport }: CatalogViewProps) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"stars" | "name">("stars");
  const rows = catalog
    .filter((c) => (c.name + " " + c.tags.join(" ") + " " + c.author).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === "stars" ? b.stars - a.stars : a.name.localeCompare(b.name)));

  return (
    <div className="wrap">
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}><Ic n="arrow_back" size={14} /> Blueprints</button>
      <div className="phead">
        <div>
          <h1>Import from gist</h1>
          <p className="psub">Bring a blueprint in from a GitHub gist — browse the community catalog and fork one, or paste a gist URL / ID directly.</p>
        </div>
        <div className="pacts">
          <button className="btn" onClick={onManualImport}><Ic n="link" size={14} /> Import by URL / ID</button>
        </div>
      </div>

      <div className="hero">
        <div className="hicon" style={{ background: "color-mix(in oklch, var(--info), transparent 82%)", color: "var(--info)" }}>★</div>
        <div className="htxt">
          <div className="heyebrow" style={{ color: "var(--info)" }}>gist catalog · community</div>
          <div className="hbody">
            <b>{catalog.length} shared blueprints</b> from the community. Forking pulls the gist into your library and links it upstream — you'll get a <b>sync prompt</b> when the author ships updates.
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 9, marginBottom: 16, alignItems: "center" }}>
        <input className="input" placeholder="search blueprints, tags, authors…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, fontFamily: "var(--mono)" }} />
        <div className="seg">
          <button className={sort === "stars" ? "on" : ""} onClick={() => setSort("stars")}>most starred</button>
          <button className={sort === "name" ? "on" : ""} onClick={() => setSort("name")}>name</button>
        </div>
        <span style={{ flex: 1 }} />
        <span className="hint mono">{rows.length} results</span>
      </div>

      {rows.map((c, i) => {
        const forked = forkedIds.includes(c.id);
        return (
          <div className="cat-row" key={c.id} style={{ animationDelay: i * 0.03 + "s" }}>
            <div className="ci" style={{ background: tint(c.h, 0.16), color: hue(c.h) }}>{c.icon}</div>
            <div className="cmeta">
              <div className="cname">{c.name}{c.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
              <div className="cby">gist.github.com/{c.author}/{c.gistId} · updated {c.updated}</div>
              <div className="cdesc">{c.desc}</div>
            </div>
            <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
              <span className="cstars"><span style={{ color: "var(--accent)" }}>★</span> {c.stars.toLocaleString()}</span>
              <span className="hint mono">{c.stageCount} stages</span>
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              <button className="btn sm ghost" onClick={() => onPreview(c)}>Preview</button>
              <button className="btn sm primary" disabled={forked} onClick={() => onFork(c)}>{forked ? "✓ Forked" : <><Ic n="fork_right" size={13} /> Fork</>}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
