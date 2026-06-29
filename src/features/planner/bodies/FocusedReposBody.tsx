// Repos stage body (#674, split from FocusedBodies.tsx #1757) — lists linked repos with clone
// status + per-repo and project-default GitHub visibility toggles.
import { useState } from "react";
import type { Repo } from "@/features/planner/pane/projectPaneData";
import { Tile, Avatar } from "@/features/planner/pane/focusedPrimitives";

/** Branch-chip color by lifecycle state (matches the design): review → success,
 *  draft → dim, anything else (active) → info. */
function branchStateColor(state: string): string {
  return state === "review" ? "var(--success)" : state === "draft" ? "var(--fg-dim)" : "var(--info)";
}

/** Repos stage body — lists linked repos with clone status. (#674) */
export function FocusedReposBody({ repos, onLinkRepo, isPublic, onSetPublic, repoOverrides, onSetRepoPublic }: {
  repos?: Repo[];
  onLinkRepo?: (r: string) => void;
  /** Project-level DEFAULT GitHub visibility for new repos (#…). Default false ⇒ private. */
  isPublic?: boolean;
  onSetPublic?: (isPublic: boolean) => void;
  /** Per-repo visibility overrides, keyed by repo full-name; absent ⇒ inherits the default (#1227). */
  repoOverrides?: Record<string, boolean>;
  onSetRepoPublic?: (repoId: string, isPublic: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const [linking, setLinking] = useState(false);
  const list = repos ?? [];

  const submit = () => {
    const v = input.trim();
    if (v.includes("/")) { onLinkRepo?.(v); setInput(""); setLinking(false); }
  };

  // Project-level DEFAULT visibility (#1227): new repos inherit this unless individually
  // overridden on their card below. New repos are PRIVATE by default; flip to set the default for
  // the whole project (and the fallback for any repo without its own toggle).
  const visibilityControl = onSetPublic && (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      <span className="mono-label">default</span>
      <div style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
        {([[false, "🔒 Private"], [true, "🌐 Public"]] as const).map(([val, label], i) => {
          const on = !!isPublic === val;
          return (
            <button
              key={label}
              onClick={() => { if (!on) onSetPublic(val); }}
              aria-pressed={on}
              className="mono"
              style={{
                height: 24, padding: "0 11px", border: 0, borderLeft: i ? "1px solid var(--border-soft)" : "none", cursor: on ? "default" : "pointer",
                fontSize: 10.5,
                background: on ? "var(--bg-elev2)" : "transparent", color: on ? "var(--fg)" : "var(--fg-dim)",
              }}
            >{label}</button>
          );
        })}
      </div>
      <span style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 9, color: "var(--fg-dim)" }}>
        default for new repos · override per repo below
      </span>
    </div>
  );

  // A compact per-repo visibility toggle for a card (#1227): resolves to the repo's own override,
  // else the project default. Setting one card never touches another.
  const repoVisToggle = (repoId: string) => {
    if (!onSetRepoPublic) return null;
    const pub = repoOverrides?.[repoId] ?? !!isPublic;
    return (
      <span
        style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden", marginLeft: 6 }}
        title={`Visibility when this repo is created on GitHub${repoOverrides?.[repoId] === undefined ? " (using the project default)" : ""}`}
      >
        {([[false, "🔒"], [true, "🌐"]] as const).map(([val, glyph], i) => {
          const on = pub === val;
          return (
            <button
              key={glyph}
              onClick={() => { if (!on) onSetRepoPublic(repoId, val); }}
              aria-pressed={on}
              aria-label={val ? `Make ${repoId} public` : `Make ${repoId} private`}
              style={{
                height: 20, padding: "0 6px", border: 0, borderLeft: i ? "1px solid var(--border-soft)" : "none",
                cursor: on ? "default" : "pointer", fontSize: 10,
                background: on ? "var(--bg-elev2)" : "transparent", opacity: on ? 1 : 0.5,
              }}
            >{glyph}</button>
          );
        })}
      </span>
    );
  };

  // The "link another repository" affordance — a dashed dropzone that expands into an
  // owner/repo input on click (matches the design's `.dropzone`).
  const linkAffordance = onLinkRepo && (
    linking ? (
      <div className="repo-linkrow">
        <input
          autoFocus
          aria-label="Link a repository"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") { setLinking(false); setInput(""); }
          }}
          placeholder="owner/repo"
        />
        <button className="mini accent" disabled={!input.includes("/")} onClick={submit}>link</button>
        <button className="mini" onClick={() => { setLinking(false); setInput(""); }}>cancel</button>
      </div>
    ) : (
      <button type="button" className="dropzone" onClick={() => setLinking(true)}>
        ＋ link another repository
      </button>
    )
  );

  if (list.length === 0) {
    return (
      <div className="repos-view">
        {visibilityControl}
        <div className="empty-state">
          <span className="empty-icon">⎇</span>
          <span>No repositories linked yet</span>
        </div>
        {linkAffordance}
      </div>
    );
  }

  const cloned = list.filter((r) => r.cloned).length;
  const branchCount = list.reduce((s, r) => s + (r.branches?.length ?? 0), 0);

  return (
    <div className="repos-view">
      {visibilityControl}
      <div className="tiles">
        <Tile v={list.length} k="repositories" />
        <Tile v={cloned} k="cloned" />
        <Tile v={branchCount} k="branches" />
      </div>
      {list.map((r) => (
        <div key={r.id} className={"repo-card" + (r.primary ? " primary" : "")}>
          <div className="repo-row">
            <span className="sdot on" />
            <span className="repo-name">{r.id}</span>
            {r.primary && <span className="chip accent">primary</span>}
            <span style={{ flex: 1 }} />
            {r.lang && <span className="chip">{r.lang}</span>}
            {r.cloned !== undefined && (
              <span className="repo-stat" style={{ color: r.cloned ? "var(--success)" : "var(--fg-dim)" }}>
                {r.cloned ? "● cloned" : "○ not cloned"}
              </span>
            )}
            {repoVisToggle(r.id)}
          </div>
          {r.desc && <div className="repo-desc">{r.desc}</div>}
          <div className="repo-row repo-branchline">
            <span className="branch-chip">⎇ {r.branch}</span>
            <span className="repo-stat" style={{ color: "var(--success)" }}>↑{r.ahead}</span>
            <span className="repo-stat" style={{ color: "var(--info)" }}>↓{r.behind}</span>
            <span style={{ flex: 1 }} />
            {r.agents.length > 0 && (
              <span className="repo-agents">
                {r.agents.map((id, i) => (
                  <span key={id} style={{ marginLeft: i ? -5 : 0 }}><Avatar id={id} sz={16} /></span>
                ))}
              </span>
            )}
          </div>
          {r.branches && r.branches.length > 0 && (
            <div className="repo-branches">
              {r.branches.map((b) => (
                <span key={b.n} className="branch-chip" style={{ color: branchStateColor(b.state) }}>
                  ⎇ {b.n} <span style={{ color: "var(--fg-dim)" }}>#{b.issue}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      {linkAffordance}
    </div>
  );
}
