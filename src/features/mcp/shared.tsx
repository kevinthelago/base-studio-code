// Shared chrome for the MCP servers screen + the Hooks view (#mcp-hooks-split). These two
// features manage independent models (McpServer / Hook) but render identical row/drawer chrome:
// the GitHub-projects fetch, the enable toggle, the scope chips, the project-assignment field,
// and the env-var editor. Kept here so neither feature owns the other's vocabulary.

import { useState, useEffect } from "react";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { CardListRow } from "@/shared/ui/data/CardListRow";
import { Chip } from "@/shared/ui/data/Chip";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Button } from "@/shared/ui/controls/Button";
import { TextField } from "@/shared/ui/controls/Field";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
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
    <Box
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
    return <Box as="span" className="ptag muted">{e.projects.length} project{e.projects.length === 1 ? "" : "s"}</Box>;
  }
  return (
    <>
      {named.slice(0, 2).map(p => (
        <Box as="span" key={p.id} className="ptag"><Box as="span" className="pdot" bg="var(--accent-dim)" />{p.title}</Box>
      ))}
      {named.length > 2 && <Box as="span" className="ptag muted">+{named.length - 2}</Box>}
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
    <Box className="field">
      <label>project assignment</label>
      <Banner tone="success" style={isGlobal ? undefined : { opacity: 0.6 }} lead={<Box as="span" bg="var(--success)" style={{ width: 7, height: 7, borderRadius: "50%"}} />}>
        <b style={{ color: isGlobal ? "var(--success)" : "var(--fg-muted)", fontWeight: 600 }}>Global (all projects)</b>
        <Spacer />
        <Box
          className={"toggle" + (isGlobal ? " on" : "")}
          title={isGlobal ? "global" : "scoped to projects"}
          onClick={() => onSet(isGlobal ? (projects[0] ? [projects[0].id] : []) : [])}
        />
      </Banner>

      {!isGlobal && (
        <>
          {projects.length === 0
            ? <Box className="hint" style={{ marginTop: 6 }}>No projects — global only. Connect GitHub in Settings to scope per project.</Box>
            : (
              <Box className="proj-multi" style={{ marginTop: 6 }}>
                {projects.map(p => {
                  const sel = item.projects.includes(p.id);
                  return (
                    <Box key={p.id} className={"pm-row" + (sel ? " on" : "")} onClick={() => toggleProject(p.id)}>
                      <Box className="check">{sel ? "✓" : ""}</Box>
                      <Box>
                        <Text as="div" className="pname">{p.title}</Text>
                        <Text as="div" className="pbranch">#{p.number}</Text>
                      </Box>
                      <Box className="pside"><ColorSwatch color="var(--accent-dim)" size={8} /></Box>
                    </Box>
                  );
                })}
              </Box>
            )}
          {projects.length > 0 && (
            <Row gap={8} style={{ marginTop: 4 }}>
              <Text as="span" className="hint">{item.projects.length} of {projects.length} projects</Text>
              <Spacer />
              <Box as="span" className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => onSet(projects.map(p => p.id))}>select all</Box>
              <Box as="span" className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => onSet([])}>make global</Box>
            </Row>
          )}
        </>
      )}
      <Box className="hint" style={{ marginTop: 6 }}>Global applies to every project; otherwise only the projects you pick.</Box>
    </Box>
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
      lead={<Box className={"health " + (on ? "" : "off")} />}
      title={name || "Untitled"}
      badge={<Chip tone={tagCls === "green" ? "success" : tagCls === "info" ? "info" : tagCls === "amber" ? "accent" : "neutral"}>{tagLabel}</Chip>}
      subtitle={desc}
      trailing={
        <>
          <Box className="row-stats">
            <Box className="row-chips">{scopeChip}</Box>
            <Box>—</Box>
          </Box>
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
    <Box className="cat-card">
      <Box className="cat-head">
        <Box className="cat-icon">{item.icon}</Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text as="div" className="cat-name">{item.name}</Text>
          <Text as="div" className="cat-by">{item.by}</Text>
        </Box>
      </Box>
      <Text as="div" className="cat-desc">{item.desc}</Text>
      {item.install && <Box className="hint" style={{ marginTop: 6, fontSize: 10 }}>{item.install}</Box>}
      <Box className="cat-foot">
        <Text as="span" className="hint">{item.by.startsWith("@modelcontextprotocol") ? "official MCP" : (item.by === "first-party" || item.link) ? "first-party" : "third-party"}</Text>
        <Box className="spacer" />
        {action}
      </Box>
    </Box>
  );
}

/** The env-var key/value editor drawer field (shared by servers + hooks). */
export function EnvEditor({ env, onChange }: { env: Array<[string, string]>; onChange: (env: Array<[string, string]>) => void }) {
  return (
    <Box className="field"><label>environment</label>
      <Box className="kv-list">
        {env.map(([k, v], i) => (
          <Box className="kv-row" key={i}>
            {/* eslint-disable-next-line no-restricted-syntax -- inline kv-row key input (.input.k, part of a key/value/remove row); TextField's .field wrapper would change layout */}
            <input
              className="input k"
              value={k}
              onChange={ev => onChange(env.map((row, j) => j === i ? [ev.target.value, row[1]] : row))}
            />
            {/* eslint-disable-next-line no-restricted-syntax -- inline kv-row value input (part of a key/value/remove row); TextField's .field wrapper would change layout */}
            <input
              className="input"
              value={v}
              onChange={ev => onChange(env.map((row, j) => j === i ? [row[0], ev.target.value] : row))}
            />
            <IconButton aria-label="remove" size="xs" onClick={() => onChange(env.filter((_, j) => j !== i))} />
          </Box>
        ))}
        <Button
          variant="ghost"
          style={{ height: 24, fontSize: 10.5, width: "fit-content" }}
          onClick={() => onChange([...env, ["", ""]])}
        >+ env var</Button>
      </Box>
    </Box>
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
      <TextField label="name" value={item.name} onChange={onName} />

      <Box className="dr-stat">
        <Text as="div" className="k">status</Text><Text as="div" className="v" style={{ color: item.enabled ? "var(--success)" : "var(--fg-dim)" }}>{item.enabled ? "enabled" : "disabled"}</Text>
        <Text as="div" className="k">kind</Text><Text as="div" className="v">{kindLabel}</Text>
        <Text as="div" className="k">last used</Text><Text as="div" className="v">—</Text>
        <Text as="div" className="k">calls (24h)</Text><Text as="div" className="v">—</Text>
      </Box>

      <ProjectAssignment item={item} projects={projects} onSet={onSetProjects} />
      {children}
      <EnvEditor env={item.env ?? []} onChange={onSetEnv} />
    </>
  );
}
