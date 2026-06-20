// Import-from-gist view (#609 slice 5 → #923). Pulls real blueprint gists from a source GitHub
// account (default: the maintainer's; configurable "sources" land later), lists them, and imports
// one into the user's library. The mock community catalog was removed.

import { useCallback, useEffect, useState } from "react";
import "../../../styles/blueprints.css";
import { Ic } from "./blueprintIcons";
import { hue, tint, DEFAULT_GIST_SOURCE, gistUpdateAvailable } from "./blueprintCatalog";
import { listBlueprintGists, type BlueprintGistItem } from "../../../lib/planner/gist/gist";

export interface CatalogViewProps {
  /** GitHub account to pull blueprint gists from (defaults to the maintainer's). */
  source?: string;
  /** GitHub token — optional (public gists need none; raises rate limit + shows secret gists). */
  token?: string;
  /** Gist id → the locally-imported copy's recorded upstream `updatedAt` (#955). A present entry
   *  means it's already imported (no duplicate download); a newer item `updatedAt` ⇒ out of date,
   *  so an "Update" button renders instead of "✓ Imported". */
  importedById?: Record<string, { updatedAt?: string }>;
  /** Import a new gist, OR update an already-imported one in place (dedupe by gist id). The current
   *  gist `updatedAt` is passed so it's recorded for the next freshness check. */
  onImport: (gistId: string, updatedAt?: string) => void;
  onBack: () => void;
  onManualImport: () => void;
}

function timeAgo(iso: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!isFinite(s) || s < 0) return "";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

const hueFor = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };

export function CatalogView({ source = DEFAULT_GIST_SOURCE, token = "", importedById = {}, onImport, onBack, onManualImport }: CatalogViewProps) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<BlueprintGistItem[] | null>(null); // null = loading
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setItems(null);
    listBlueprintGists(source, token).then(setItems).catch(() => setItems([]));
  }, [source, token]);
  useEffect(() => { load(); }, [load]);

  const rows = (items ?? []).filter((c) =>
    (c.name + " " + c.description + " " + c.owner).toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="wrap">
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}><Ic n="arrow_back" size={14} /> Blueprints</button>
      <div className="phead">
        <div>
          <h1>Import from gist</h1>
          <p className="psub">Pull a blueprint published as a GitHub gist. Browse the source's shared blueprints and import one, or paste a gist URL / ID directly.</p>
        </div>
        <div className="pacts">
          <button className="btn" onClick={load} title="Refresh"><Ic n="refresh" size={14} /></button>
          <button className="btn" onClick={onManualImport}><Ic n="link" size={14} /> Import by URL / ID</button>
        </div>
      </div>

      <div className="hero">
        <div className="hicon" style={{ background: "color-mix(in oklch, var(--info), transparent 82%)", color: "var(--info)" }}>★</div>
        <div className="htxt">
          <div className="heyebrow" style={{ color: "var(--info)" }}>gist source · {source}</div>
          <div className="hbody">
            Blueprints published to <b>gist.github.com/{source}</b>. Importing pulls the gist into your library and links it upstream — you'll get a <b>sync prompt</b> when it's updated. <span style={{ color: "var(--fg-dim)" }}>More sources coming soon.</span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 9, marginBottom: 16, alignItems: "center" }}>
        <input className="input" placeholder="search blueprints…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, fontFamily: "var(--mono)" }} />
        <span style={{ flex: 1 }} />
        <span className="hint mono">{items === null ? "loading…" : `${rows.length} result${rows.length === 1 ? "" : "s"}`}</span>
      </div>

      {items === null ? (
        <div className="hint mono" style={{ padding: "24px 4px" }}>Loading {source}'s blueprint gists…</div>
      ) : rows.length === 0 ? (
        <div className="hint mono" style={{ padding: "24px 4px" }}>
          {q ? "No blueprints match your search." : <>No blueprint gists found for <b>{source}</b>. Publish one, or import by URL / ID.</>}
        </div>
      ) : rows.map((c, i) => {
        const local = importedById[c.id];
        const imported = !!local;
        // Out of date: the gist was re-published after we imported it (#955).
        const stale = imported && gistUpdateAvailable(c.updatedAt, local.updatedAt);
        const busy = busyId === c.id;
        const h = hueFor(c.id);
        const act = () => { setBusyId(c.id); onImport(c.id, c.updatedAt); setTimeout(() => setBusyId(null), 1200); };
        return (
          <div className="cat-row" key={c.id} style={{ animationDelay: i * 0.03 + "s" }}>
            <div className="ci" style={{ background: tint(h, 0.16), color: hue(h) }}>{c.name[0]?.toUpperCase() ?? "B"}</div>
            <div className="cmeta">
              <div className="cname">{c.name}</div>
              <div className="cby">gist.github.com/{c.owner}/{c.id.slice(0, 7)}{c.updatedAt && ` · updated ${timeAgo(c.updatedAt)}`}</div>
              {c.htmlUrl && <div className="cdesc">{c.htmlUrl}</div>}
            </div>
            <span style={{ flex: 1 }} />
            <div style={{ display: "flex", gap: 7 }}>
              {stale ? (
                // Already imported but the upstream gist is newer — offer an in-place update.
                <button className="btn sm" disabled={busy} title="A newer version is available upstream" onClick={act}
                  style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
                  {busy ? "updating…" : <><Ic n="refresh" size={13} /> Update</>}
                </button>
              ) : imported ? (
                // Already imported and up to date — no duplicate download.
                <button className="btn sm" disabled>✓ Imported</button>
              ) : (
                <button className="btn sm primary" disabled={busy} onClick={act}>
                  {busy ? "importing…" : <><Ic n="cloud_download" size={13} /> Import</>}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
