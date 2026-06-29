// Shared chrome for the MCP servers screen + the Hooks view (#mcp-hooks-split). These two
// features manage independent models (McpServer / Hook) but render identical row/drawer chrome:
// the GitHub-projects fetch, the enable toggle, the scope chips, the project-assignment field,
// and the env-var editor. Kept here so neither feature owns the other's vocabulary.

import { useState, useEffect } from "react";
import { StatusDot } from "@/shared/ui/StatusDot";
import { IconButton } from "@/shared/ui/IconButton";
import { CardListRow } from "@/shared/ui/CardListRow";
import { Chip } from "@/shared/ui/Chip";
import { ColorSwatch } from "@/shared/ui/ColorSwatch";
import { Banner } from "@/shared/ui/Banner";
import { invoke } from "@tauri-apps/api/core";
import type { CatalogItem } from "@/shared/data/mcpCatalog";
import type { GhProjectRef } from "@/shared/lib/github/types";

export type Scope = "global" | "project";

/** A GitHub Project (subset of the GraphQL `projectsV2` node). */
export type GhProject = GhProjectRef;

/** The minimal shape the shared chrome needs from a managed item (server or hook). */
export interface ManagedItem {
  id: string;
  name: string;
  enabled: boolean;
  projects: string[];
  env?: Array<[string, string]>;
}

const PROJECTS_QUERY = `{
  viewer {
    projectsV2(first: 50) {
      nodes { id title number }
    }
  }
}`;

/** The user's GitHub Projects, fetched once when a token exists. No token / empty / failure all
 *  collapse to "global only" — never a crash. */
export function useGhProjects(githubToken: string): GhProject[] {
  const [projects, setProjects] = useState<GhProject[]>([]);
  useEffect(() => {
    if (!githubToken) return;
    let cancelled = false;
    invoke<{ viewer: { projectsV2: { nodes: GhProject[] } } }>("github_graphql", {
      token: githubToken,
      query: PROJECTS_QUERY,
      variables: null,
    })
      .then(data => { if (!cancelled) setProjects(data?.viewer?.projectsV2?.nodes ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [githubToken]);
  return projects;
}

/** The enable/disable pill toggle on a row. */
export function ToggleSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div
      className={"toggle" + (on ? " on" : "")}
      title={on ? "enabled" : "disabled"}
      onClick={ev => { ev.stopPropagation(); onToggle(); }}
    />
  );
}

/** The scope summary chips on a row: off / global / named-projects. */
export function scopeChips(e: { enabled: boolean; projects: string[] }, projects: GhProject[]) {
  if (!e.enabled) return <Chip style={{ color: "var(--fg-dim)" }}>off</Chip>;
  if (e.projects.length === 0) return <Chip tone="success"><StatusDot style={{ marginRight: 4 }} />global</Chip>;
  const named = e.projects
    .map(pid => projects.find(p => p.id === pid))
    .filter(Boolean) as GhProject[];
  if (named.length === 0) {
    // Scoped to project ids we couldn't resolve (no token / not in the list).
    return <span className="ptag muted">{e.projects.length} project{e.projects.length === 1 ? "" : "s"}</span>;
  }
  return (
    <>
      {named.slice(0, 2).map(p => (
        <span key={p.id} className="ptag"><span className="pdot" style={{ background: "var(--accent-dim)" }} />{p.title}</span>
      ))}
      {named.length > 2 && <span className="ptag muted">+{named.length - 2}</span>}
    </>
  );
}

/** The project-assignment drawer field: a global toggle + a per-project multi-select. `[]` projects
 *  = global (every project); otherwise the chosen project ids. */
export function ProjectAssignment({ item, projects, onSet }: {
  item: { projects: string[] };
  projects: GhProject[];
  onSet: (ids: string[]) => void;
}) {
  const isGlobal = item.projects.length === 0;
  const toggleProject = (pid: string) => {
    const next = item.projects.includes(pid)
      ? item.projects.filter(x => x !== pid)
      : [...item.projects, pid];
    onSet(next);
  };
  return (
    <div className="field">
      <label>project assignment</label>
      <Banner tone="success" style={isGlobal ? undefined : { opacity: 0.6 }} lead={<span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />}>
        <b style={{ color: isGlobal ? "var(--success)" : "var(--fg-muted)", fontWeight: 600 }}>Global (all projects)</b>
        <div style={{ flex: 1 }} />
        <div
          className={"toggle" + (isGlobal ? " on" : "")}
          title={isGlobal ? "global" : "scoped to projects"}
          onClick={() => onSet(isGlobal ? (projects[0] ? [projects[0].id] : []) : [])}
        />
      </Banner>

      {!isGlobal && (
        <>
          {projects.length === 0
            ? <div className="hint" style={{ marginTop: 6 }}>No projects — global only. Connect GitHub in Settings to scope per project.</div>
            : (
              <div className="proj-multi" style={{ marginTop: 6 }}>
                {projects.map(p => {
                  const sel = item.projects.includes(p.id);
                  return (
                    <div key={p.id} className={"pm-row" + (sel ? " on" : "")} onClick={() => toggleProject(p.id)}>
                      <div className="check">{sel ? "✓" : ""}</div>
                      <div>
                        <div className="pname">{p.title}</div>
                        <div className="pbranch">#{p.number}</div>
                      </div>
                      <div className="pside"><ColorSwatch color="var(--accent-dim)" size={8} /></div>
                    </div>
                  );
                })}
              </div>
            )}
          {projects.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
              <span className="hint">{item.projects.length} of {projects.length} projects</span>
              <div style={{ flex: 1 }} />
              <span className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => onSet(projects.map(p => p.id))}>select all</span>
              <span className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => onSet([])}>make global</span>
            </div>
          )}
        </>
      )}
      <div className="hint" style={{ marginTop: 6 }}>Global applies to every project; otherwise only the projects you pick.</div>
    </div>
  );
}

/** One row in an Installed list. Kind-specific bits (`desc`, the optional `aside` control) are
 *  passed in; the row chrome (health dot, name, tag, scope chips, enable toggle) is shared. */
export function InstalledRow({ name, tagCls, tagLabel, desc, scopeChip, aside, on, selected, onSelect, onToggle }: {
  name: string;
  tagCls: string;
  tagLabel: string;
  desc: React.ReactNode;
  scopeChip: React.ReactNode;
  aside?: React.ReactNode;
  on: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <CardListRow
      selected={selected}
      off={!on}
      onClick={onSelect}
      lead={<div className={"health " + (on ? "" : "off")} />}
      title={name || "Untitled"}
      badge={<Chip tone={tagCls === "green" ? "success" : tagCls === "info" ? "info" : tagCls === "amber" ? "accent" : "neutral"}>{tagLabel}</Chip>}
      subtitle={desc}
      trailing={
        <>
          <div className="row-stats">
            <div className="row-chips">{scopeChip}</div>
            <div>—</div>
          </div>
          {aside}
          <ToggleSwitch on={on} onToggle={onToggle} />
        </>
      }
    />
  );
}

/** One catalog card. The action button (download vs. add) is passed in by the feature. */
export function CatalogCard({ item, action }: { item: CatalogItem; action: React.ReactNode }) {
  return (
    <div className="cat-card">
      <div className="cat-head">
        <div className="cat-icon">{item.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cat-name">{item.name}</div>
          <div className="cat-by">{item.by}</div>
        </div>
      </div>
      <div className="cat-desc">{item.desc}</div>
      {item.install && <div className="hint" style={{ marginTop: 6, fontSize: 10 }}>{item.install}</div>}
      <div className="cat-foot">
        <span className="hint">{item.by.startsWith("@modelcontextprotocol") ? "official MCP" : (item.by === "first-party" || item.link) ? "first-party" : "third-party"}</span>
        <div className="spacer" />
        {action}
      </div>
    </div>
  );
}

/** The env-var key/value editor drawer field (shared by servers + hooks). */
export function EnvEditor({ env, onChange }: { env: Array<[string, string]>; onChange: (env: Array<[string, string]>) => void }) {
  return (
    <div className="field"><label>environment</label>
      <div className="kv-list">
        {env.map(([k, v], i) => (
          <div className="kv-row" key={i}>
            <input
              className="input k"
              value={k}
              onChange={ev => onChange(env.map((row, j) => j === i ? [ev.target.value, row[1]] : row))}
            />
            <input
              className="input"
              value={v}
              onChange={ev => onChange(env.map((row, j) => j === i ? [row[0], ev.target.value] : row))}
            />
            <IconButton aria-label="remove" size="xs" onClick={() => onChange(env.filter((_, j) => j !== i))} />
          </div>
        ))}
        <button
          className="btn ghost"
          style={{ height: 24, fontSize: 10.5, width: "fit-content" }}
          onClick={() => onChange([...env, ["", ""]])}
        >+ env var</button>
      </div>
    </div>
  );
}

/** The config drawer body, shared by servers + hooks: name + stat block + project assignment +
 *  the feature's own config fields (`children`) + env editor. */
export function DrawerBody({ item, kindLabel, projects, onName, onSetProjects, onSetEnv, children }: {
  item: ManagedItem;
  kindLabel: string;
  projects: GhProject[];
  onName: (name: string) => void;
  onSetProjects: (ids: string[]) => void;
  onSetEnv: (env: Array<[string, string]>) => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="field">
        <label>name</label>
        <input className="input" value={item.name} onChange={ev => onName(ev.target.value)} />
      </div>

      <div className="dr-stat">
        <div className="k">status</div><div className="v" style={{ color: item.enabled ? "var(--success)" : "var(--fg-dim)" }}>{item.enabled ? "enabled" : "disabled"}</div>
        <div className="k">kind</div><div className="v">{kindLabel}</div>
        <div className="k">last used</div><div className="v">—</div>
        <div className="k">calls (24h)</div><div className="v">—</div>
      </div>

      <ProjectAssignment item={item} projects={projects} onSet={onSetProjects} />
      {children}
      <EnvEditor env={item.env ?? []} onChange={onSetEnv} />
    </>
  );
}
