import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import ReactMarkdown from "react-markdown";
import { useAppStore } from "../../store";
import type { AutomationSuggestion } from "../../store";
import { projectRepoCwd } from "../../lib/projectPaths";
import { buildGhStructure, parsePhases } from "./ghStructure";
import type { Section, SectionKey, SectionState, GhNode, GhRepoNode, GhStructure } from "./ghStructure";
import { parsePlanFocus, stripPlanFocus, buildSectionConfirmMessage } from "./planningSession";

const SECTION_DEFS: { k: SectionKey; title: string }[] = [
  { k: "goal",         title: "Goal"         },
  { k: "scope",        title: "Scope"        },
  { k: "stack",        title: "Stack"        },
  { k: "architecture", title: "Architecture" },
  { k: "schema",       title: "Schema"       },
  { k: "api",          title: "API"          },
  { k: "testing",      title: "Testing"      },
  { k: "cicd",         title: "CI/CD"        },
  { k: "phases",       title: "Phases"       },
  { k: "risks",        title: "Risks"        },
];

const TERM_THEME: import("@xterm/xterm").ITheme = {
  background:          "#181a1f",
  foreground:          "#eeeae4",
  cursor:              "#c4923a",
  cursorAccent:        "#181a1f",
  selectionBackground: "#c4923a44",
  black:               "#181a1f", brightBlack:   "#44474f",
  red:                 "#d4554f", brightRed:     "#e06c75",
  green:               "#5fb467", brightGreen:   "#98c379",
  yellow:              "#c4923a", brightYellow:  "#e5c07b",
  blue:                "#5694c7", brightBlue:    "#61afef",
  magenta:             "#9b59b6", brightMagenta: "#c678dd",
  cyan:                "#4aabb5", brightCyan:    "#64d5e4",
  white:               "#939aa4", brightWhite:   "#eeeae4",
};

// Covers all common VT/ANSI escape sequences:
//   CSI  \x1b [ <0x20-0x3f>* <0x40-0x7e>   — includes private ?/>/< params
//   OSC  \x1b ] <text> (\x07 | \x1b\)       — BEL or ST terminator
//   Char-set  \x1b [()][…]
//   Other C1  \x1b <any single byte>         — fallback: ESC + one char
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[\x20-\x3f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[\x40-\x7e])/g;

function stripAnsi(s: string): string {
  return (
    s
      .replace(ANSI_RE, "")  // remove escape sequences
      .replace(/\r/g, "")    // remove lone carriage returns (spinner overwrites)
      .replace(/\x1b/g, "")  // remove any leftover bare ESC bytes
  );
}


function PlanSectionCard({
  section,
  onConfirm,
  flashing,
  active,
}: {
  section: Section;
  onConfirm: (k: SectionKey) => void;
  flashing: boolean;
  active: boolean;
}) {
  // pending and confirmed start collapsed; drafted auto-expands when content arrives
  const [collapsed, setCollapsed] = useState(section.state !== "drafted");
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (section.state === "drafted")   setCollapsed(false);
    if (section.state === "confirmed") setCollapsed(true);
  }, [section.state]);

  // When Claude starts discussing this section, surface it: expand and scroll in.
  useEffect(() => {
    if (active) {
      setCollapsed(false);
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [active]);

  const hasContent = section.state !== "pending";
  const isDrafted  = section.state === "drafted";

  const phases = section.k === "phases" ? parsePhases(section.content) : [];

  return (
    <div ref={cardRef} style={{
      borderRadius: 6,
      border: "1px solid " + (active ? "var(--accent)" : isDrafted ? "var(--accent-dim)" : "var(--border-soft)"),
      boxShadow: active ? "0 0 0 1px var(--accent)" : "none",
      background: (active || isDrafted)
        ? "color-mix(in oklch, var(--accent), var(--bg-canvas) 96%)"
        : "var(--bg-canvas)",
      // Active overrides the dimming so the in-discussion section is never faded.
      opacity: (section.state === "pending" && !active) ? 0.45 : 1,
      overflow: "hidden",
      flexShrink: 0,
      transition: "border-color 0.2s, background 0.2s, box-shadow 0.2s",
    }}>
      <div
        onClick={hasContent ? () => setCollapsed(c => !c) : undefined}
        style={{
          padding: "7px 10px",
          background: isDrafted ? "color-mix(in oklch, var(--accent), var(--bg-elev) 92%)" : "var(--bg-elev)",
          borderBottom: (hasContent && !collapsed) ? "1px solid var(--border-soft)" : "none",
          display: "flex", alignItems: "center", gap: 8,
          fontFamily: "var(--mono)", fontSize: 10.5,
          cursor: hasContent ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        <span style={{
          display: "inline-block", width: 10, textAlign: "center",
          fontSize: 8, color: "var(--fg-dim)",
          transform: hasContent && !collapsed ? "rotate(0deg)" : "rotate(-90deg)",
          transition: "transform 0.15s",
          opacity: hasContent ? 1 : 0.3,
        }}>▼</span>
        <span style={{ color: "var(--fg)" }}>{section.title}</span>
        <div style={{ flex: 1 }} />
        {active && section.state !== "confirmed" && (
          <span style={{ color: "var(--accent)", fontSize: 10 }}>● in discussion</span>
        )}
        {section.state === "confirmed" && (
          <span style={{ color: "var(--success)", fontSize: 10 }}>✓ confirmed</span>
        )}
        {section.state === "pending" && !active && (
          <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>○ pending</span>
        )}
        {isDrafted && (
          <button
            className={flashing ? "confirm-flash" : ""}
            onClick={(e) => { e.stopPropagation(); onConfirm(section.k); }}
            style={{
              padding: "3px 14px", borderRadius: 4, cursor: "pointer",
              background: "var(--accent)", border: "none",
              color: "#1a120a", fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
              letterSpacing: "0.02em",
            }}
          >✓ looks good</button>
        )}
      </div>
      {hasContent && !collapsed && (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.7 }}>
          {section.k === "phases" && phases.length > 0
            ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {phases.map((ph, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: "var(--mono)", fontSize: 10.5 }}>
                    <span style={{ color: "var(--accent)" }}>·</span>
                    <span style={{ color: "var(--fg)" }}>{ph.name}</span>
                    {ph.description && <span style={{ color: "var(--fg-dim)" }}>— {ph.description}</span>}
                  </div>
                ))}
              </div>
            )
            : (
              <div className="plan-md">
                <ReactMarkdown>{section.content}</ReactMarkdown>
              </div>
            )
          }
        </div>
      )}
    </div>
  );
}

interface PlanningRepoStripProps {
  projectId: string;
  repos: string[];
}

function PlanningRepoStrip({ projectId, repos }: PlanningRepoStripProps) {
  const { projectLocalRepos, bscBaseDir } = useAppStore();
  const clonedNames = projectLocalRepos[projectId] ?? [];
  const [cloning, setCloning]     = useState<Set<string>>(new Set());
  const [cloneErrors, setCloneErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded]   = useState(false);
  // Ref guards against starting the same clone twice when `repos` grows.
  const cloningRef = useRef<Set<string>>(new Set());
  const multi = repos.length > 1;

  // Auto-clone every repo into the app-managed directory as soon as it appears.
  useEffect(() => {
    if (!projectId) return;
    const currentCloned = new Set(useAppStore.getState().projectLocalRepos[projectId] ?? []);
    const unresolved = repos.filter(r => !currentCloned.has(r) && !cloningRef.current.has(r));
    for (const fullName of unresolved) {
      cloningRef.current.add(fullName);
      setCloning(s => new Set([...s, fullName]));
      invoke<string>("clone_repo", { project: projectId, fullName })
        .then(() => {
          useAppStore.getState().addProjectRepo(projectId, fullName);
        })
        .catch(e => setCloneErrors(prev => ({ ...prev, [fullName]: String(e) })))
        .finally(() => {
          cloningRef.current.delete(fullName);
          setCloning(s => { const n = new Set(s); n.delete(fullName); return n; });
        });
    }
  // repos in deps so new repo_link entries trigger a clone pass.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, repos]);

  async function handleClone(fullName: string) {
    setCloning(s => new Set([...s, fullName]));
    setCloneErrors(e => { const n = { ...e }; delete n[fullName]; return n; });
    try {
      await invoke<string>("clone_repo", { project: projectId, fullName });
      useAppStore.getState().addProjectRepo(projectId, fullName);
    } catch (e) {
      setCloneErrors(prev => ({ ...prev, [fullName]: String(e) }));
    } finally {
      setCloning(s => { const n = new Set(s); n.delete(fullName); return n; });
    }
  }

  if (repos.length === 0) return null;

  const resolvedCount = repos.filter(r => clonedNames.includes(r)).length;
  const failedRepos   = repos.filter(r => !!cloneErrors[r] && !cloning.has(r));

  function RepoRow({ fullName }: { fullName: string }) {
    const isCloned  = clonedNames.includes(fullName);
    const isCloning = cloning.has(fullName);
    const err       = cloneErrors[fullName];
    const localPath = projectRepoCwd(bscBaseDir, projectId, fullName);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ color: "var(--fg-muted)" }}>{fullName}</span>
        {isCloned ? (
          <span title={localPath} style={{ color: "var(--success)", fontSize: 10 }}>
            ● {fullName.split("/")[1]}
          </span>
        ) : isCloning ? (
          <span style={{ color: "var(--accent)" }}>cloning…</span>
        ) : (
          <span
            onClick={() => handleClone(fullName)}
            style={{
              padding: "1px 6px", borderRadius: 3,
              background: "var(--bg-elev)", border: "1px solid var(--border)",
              color: err ? "var(--danger)" : "var(--fg-muted)",
              cursor: "pointer", fontSize: 10,
            }}
          >{err ? "retry clone" : "clone →"}</span>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "6px 24px 0", fontFamily: "var(--mono)", fontSize: 10.5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ color: "var(--fg-dim)" }}>repos</span>

        {multi ? (
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              background: "none", border: "none", padding: 0, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
              fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
            }}
          >
            <span style={{
              display: "inline-block", fontSize: 8, color: "var(--fg-dim)",
              transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s",
            }}>▼</span>
            <span>
              {repos.length} repositories
              {resolvedCount > 0 && <span style={{ color: "var(--success)" }}> · {resolvedCount} cloned</span>}
              {cloning.size > 0 && <span style={{ color: "var(--accent)" }}> · cloning…</span>}
            </span>
          </button>
        ) : (
          <RepoRow fullName={repos[0]} />
        )}

        {failedRepos.length > 0 && (
          <span
            onClick={() => failedRepos.forEach(r => handleClone(r))}
            style={{
              padding: "1px 8px", borderRadius: 3,
              background: "var(--bg-elev)", border: "1px solid var(--border)",
              color: "var(--danger)", cursor: "pointer", fontSize: 10,
              fontFamily: "var(--mono)",
            }}
          >retry failed →</span>
        )}
      </div>

      {multi && expanded && (
        <div style={{
          marginTop: 6, paddingLeft: 16,
          display: "flex", flexDirection: "column", gap: 5,
          borderLeft: "2px solid var(--border-soft)",
        }}>
          {repos.map(fullName => <RepoRow key={fullName} fullName={fullName} />)}
        </div>
      )}
    </div>
  );
}

function KbAssignedCard({ blockIds, onRemove }: { blockIds: string[]; onRemove: (id: string) => void }) {
  const { kbBlocks } = useAppStore();
  if (blockIds.length === 0) return null;
  return (
    <div style={{
      borderRadius: 6, border: "1px solid var(--border-soft)",
      background: "var(--bg-canvas)", overflow: "hidden", flexShrink: 0,
    }}>
      <div style={{
        padding: "7px 10px", background: "var(--bg-elev)",
        borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 8,
        fontFamily: "var(--mono)", fontSize: 10.5,
      }}>
        <span style={{ color: "var(--fg)" }}>Knowledge Blocks</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>{blockIds.length} assigned</span>
      </div>
      <div style={{ padding: "8px 10px", display: "flex", flexWrap: "wrap", gap: 6 }}>
        {blockIds.map(id => {
          const block = kbBlocks.find(b => b.id === id);
          return (
            <span key={id} style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "2px 8px", borderRadius: 99,
              background: "color-mix(in oklch, var(--info), transparent 88%)",
              border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--info)",
            }}>
              {block?.title ?? id}
              <span
                onClick={() => onRemove(id)}
                style={{ cursor: "pointer", opacity: 0.7, lineHeight: 1 }}
              >×</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function AutomationsCard({ automations, onRemove }: { automations: AutomationSuggestion[]; onRemove: (idx: number) => void }) {
  if (automations.length === 0) return null;
  return (
    <div style={{
      borderRadius: 6, border: "1px solid var(--border-soft)",
      background: "var(--bg-canvas)", overflow: "hidden", flexShrink: 0,
    }}>
      <div style={{
        padding: "7px 10px", background: "var(--bg-elev)",
        borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 8,
        fontFamily: "var(--mono)", fontSize: 10.5,
      }}>
        <span style={{ color: "var(--fg)" }}>Automations</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>{automations.length} suggested</span>
      </div>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 7 }}>
        {automations.map((a, i) => (
          <div key={i} style={{
            padding: "7px 9px", borderRadius: 5,
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            fontFamily: "var(--mono)", fontSize: 10.5,
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
              <span style={{ color: "var(--fg)" }}>{a.name}</span>
              {a.schedule && (
                <span className="tag" style={{ fontSize: 9 }}>{a.schedule}</span>
              )}
              <div style={{ flex: 1 }} />
              <span
                onClick={() => onRemove(i)}
                style={{ color: "var(--fg-dim)", cursor: "pointer", fontSize: 11 }}
              >×</span>
            </div>
            <div style={{ color: "var(--fg-dim)", fontSize: 10, fontFamily: "var(--mono)" }}>
              <code style={{ color: "var(--accent)" }}>{a.command}</code>
            </div>
            {a.description && (
              <div style={{ color: "var(--fg-muted)", fontSize: 10, marginTop: 3 }}>{a.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── GitHub structure card ─────────────────────────────────────────────────────
//
// A live map of the GitHub objects this plan produces. Each node mirrors a real
// GitHub primitive (repository, project board, milestone, issue) and carries a
// status that the publish flow updates in place so the user can watch each
// object get created.

type GhItemStatus = "planned" | "running" | "created" | "exists" | "skipped" | "error";
interface GhItemState { status: GhItemStatus; detail?: string; url?: string; }
type GhStatusMap = Record<string, GhItemState>;

const GH_STATUS_GLYPH: Record<GhItemStatus, { icon: string; color: string }> = {
  planned: { icon: "○", color: "var(--fg-dim)" },
  running: { icon: "⟳", color: "var(--accent)" },
  created: { icon: "✓", color: "var(--success)" },
  exists:  { icon: "=", color: "var(--info)" },
  skipped: { icon: "–", color: "var(--fg-dim)" },
  error:   { icon: "✗", color: "var(--danger)" },
};

function GhItemRow({ node, state }: { node: GhNode; state: GhItemState }) {
  const g = GH_STATUS_GLYPH[state.status];
  return (
    <div style={{
      display: "flex", alignItems: "baseline", gap: 8,
      fontFamily: "var(--mono)", fontSize: 10.5,
      opacity: state.status === "planned" ? 0.6 : 1,
    }}>
      <span style={{ width: 11, textAlign: "center", flexShrink: 0, color: g.color }}>{g.icon}</span>
      <span style={{
        color: state.status === "error" ? "var(--danger)" : "var(--fg)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{node.label}</span>
      {state.url ? (
        <a href={state.url} target="_blank" rel="noreferrer"
          style={{ color: "var(--fg-dim)", fontSize: 9.5, textDecoration: "none" }}
          title={state.url}>
          {state.detail ?? "open"} ↗
        </a>
      ) : state.detail ? (
        <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>· {state.detail}</span>
      ) : null}
    </div>
  );
}

function GhGroup({ title, count, nodes, status, empty }: {
  title: string; count?: number; nodes: GhNode[]; status: GhStatusMap; empty?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase",
        letterSpacing: ".06em", color: "var(--fg-muted)",
      }}>
        <span>{title}</span>
        {count !== undefined && <span style={{ color: "var(--fg-dim)" }}>{count}</span>}
      </div>
      {nodes.length === 0
        ? <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", opacity: 0.6, paddingLeft: 19 }}>{empty}</div>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 8 }}>
            {nodes.map(n => (
              <GhItemRow key={n.id} node={n} state={status[n.id] ?? { status: "planned" }} />
            ))}
          </div>
        )
      }
    </div>
  );
}

// Repositories group: each repo row owns its phase tracking issues, indented
// beneath it with a connector so issue ownership is clear at a glance.
function GhReposGroup({ repos, status }: { repos: GhRepoNode[]; status: GhStatusMap }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase",
        letterSpacing: ".06em", color: "var(--fg-muted)",
      }}>
        <span>Repositories</span>
        <span style={{ color: "var(--fg-dim)" }}>{repos.length}</span>
      </div>
      {repos.length === 0
        ? <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", opacity: 0.6, paddingLeft: 19 }}>
            none linked — ask Claude to create or link repositories
          </div>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 8 }}>
            {repos.map(r => (
              <div key={r.node.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <GhItemRow node={r.node} state={status[r.node.id] ?? { status: "planned" }} />
                {r.issues.length > 0 && (
                  <div style={{
                    display: "flex", flexDirection: "column", gap: 2,
                    paddingLeft: 14, marginLeft: 5,
                    borderLeft: "1px solid var(--border-soft)",
                  }}>
                    {r.issues.map(iss => (
                      <GhItemRow key={iss.id} node={iss} state={status[iss.id] ?? { status: "planned" }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      }
    </div>
  );
}

function GitHubStructureCard({ structure, status }: { structure: GhStructure; status: GhStatusMap }) {
  return (
    <div style={{
      padding: "12px 14px", borderRadius: 6,
      background: "color-mix(in oklch, var(--info), transparent 92%)",
      border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
      display: "flex", flexDirection: "column", gap: 12,
      flexShrink: 0,
    }}>
      <div style={{
        color: "var(--info)", textTransform: "uppercase", letterSpacing: ".06em",
        fontFamily: "var(--mono)", fontSize: 10,
      }}>
        github structure
      </div>
      <GhGroup title="Project board" nodes={[structure.project]} status={status} />
      <GhGroup title="Milestones" count={structure.milestones.length} nodes={structure.milestones} status={status}
        empty="defined by the Phases section" />
      <GhReposGroup repos={structure.repos} status={status} />
    </div>
  );
}

export function Planning({ visible }: { visible: boolean }) {
  const {
    setProjectsView,
    planningPitch, planningRepo, planningTitle, setPlanningTitle,
    planningSessionKey,
    activeProjectId, activeProjectName, activeProjectNumber,
    githubToken,
    kbBlocks,
    activeProjectRepos,
    projectLocalRepos,
    planSections, planConfirmedSections,
    planKbAssignments, removePlanKbAssignment,
    planAutomations,
    commands, schedules,
  } = useAppStore();

  // The session key (set once at session entry) is the single source of truth
  // for the planning directory, PTY slot, and plan buckets — identical to the
  // remount key in projects/index.tsx. It is frozen for the session, so the
  // publish flow assigning a GitHub Project id or a title edit cannot move the
  // working directory. The ref fallbacks keep older/in-flight sessions working.
  const sessionKeyRef = useRef(planningSessionKey || activeProjectId || planningTitle || planningPitch);
  const effectiveProjectId = sessionKeyRef.current;

  // Per-project PTY slot — mirrors the sanitize_project_key() logic in lib.rs so
  // the pane ID and the planning directory always correspond to the same project.
  const paneId = `planning_${effectiveProjectId.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)}`;

  // Prefer activeProjectRepos (populated from board items) but fall back to
  // any previously-cloned repos for this project if the board hasn't loaded yet.
  const effectiveRepos: string[] = activeProjectId
    ? (activeProjectRepos.length > 0
        ? activeProjectRepos
        : (projectLocalRepos[activeProjectId] ?? []))
    : [];

  // Full_names that are both linked to this project and known to be cloned.
  const linkedRepos: string[] =
    (projectLocalRepos[effectiveProjectId] ?? []).filter(r =>
      effectiveRepos.includes(r)
    );

  // Repos surfaced by <repo_link> tags emitted by Claude during this session.
  const [repoLinkFullNames, setRepoLinkFullNames] = useState<string[]>([]);

  const isExisting = !!activeProjectId;

  // Canonical set of repos for publish/sync — union of project-linked repos,
  // Claude-surfaced repo_link tags, and the store's planningRepo fallback.
  // Feeds both handlePublish and the GitHubStructureCard.
  const publishRepos = [...new Set([
    ...effectiveRepos,
    ...repoLinkFullNames,
    ...(planningRepo ? [planningRepo] : []),
  ])].filter(Boolean);

  const savedSections  = planSections[effectiveProjectId] ?? {};
  const confirmedSet   = new Set(planConfirmedSections[effectiveProjectId] ?? []);
  const [sections, setSections] = useState<Section[]>(
    SECTION_DEFS.map(d => {
      const saved = savedSections[d.k];
      const state = confirmedSet.has(d.k) ? "confirmed" : (saved ? "drafted" : "pending");
      return { ...d, state: state as SectionState, content: saved ?? "" };
    })
  );

  // Title + derived GitHub object graph that the structure card renders and the
  // publish flow fills in. Kept in sync with handlePublish's own derivation.
  const goalForTitle = sections.find(s => s.k === "goal")?.content ?? "";
  const projectTitle = planningTitle || goalForTitle.split(/[.!?\n]/)[0].trim() || activeProjectName || "New project";
  const ghStructure  = buildGhStructure(sections, publishRepos, projectTitle);
  const [restarting, setRestarting] = useState(false);

  type PublishPhase = "idle" | "running" | "done" | "error";
  const [publishPhase, setPublishPhase] = useState<PublishPhase>("idle");
  const [flashConfirm, setFlashConfirm] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function triggerFlash() {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashConfirm(false);
    // Force a re-render so re-adding the class restarts the animation
    requestAnimationFrame(() => {
      setFlashConfirm(true);
      flashTimerRef.current = setTimeout(() => setFlashConfirm(false), 700);
    });
  }
  // Live status of each GitHub object, keyed by the ids in buildGhStructure.
  const [ghStatus, setGhStatus] = useState<GhStatusMap>({});

  // The section Claude is currently discussing, driven by <plan_focus> tags.
  // Null until the first focus tag arrives. Highlights the matching card.
  const [activeSection, setActiveSection] = useState<SectionKey | null>(null);

  const containerRef   = useRef<HTMLDivElement>(null);
  const termRef        = useRef<Terminal | null>(null);
  const fitRef         = useRef<FitAddon | null>(null);
  const unlistenData   = useRef<UnlistenFn | null>(null);
  const unlistenExit   = useRef<UnlistenFn | null>(null);
  // Accumulated stripped output used to scan for complete <plan_update> tags
  const bufRef         = useRef("");
  // Tracks whether the auto-send of the initial pitch has fired this session
  const initSentRef    = useRef(false);
  const initSendTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const confirmedCount     = sections.filter(s => s.state === "confirmed").length;
  const draftedOrConfirmed = sections.filter(s => s.state !== "pending").length;
  // Ready to publish when every section that has content is confirmed.
  // Sections Claude never filled stay "pending" and don't block publishing.
  const allConfirmed = draftedOrConfirmed > 0 &&
    sections.every(s => s.state !== "drafted");
  // Existing projects can sync as soon as any section is confirmed.
  // New projects must confirm everything before first publish.
  const canPublish = isExisting ? confirmedCount > 0 : allConfirmed;

  // Mount xterm.js and spawn the planning PTY (once per Planning screen lifecycle).
  // pty_kill is called on unmount so navigating away ends the session cleanly.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current  = fitAddon;

    term.onData(data => {
      invoke("pty_write", { paneId: paneId, data }).catch(console.error);
    });

    // Capture state at mount time for workspace sync.
    const kbSnapshot      = kbBlocks;
    const repoSnapshot    = linkedRepos;  // string[] of full_names
    const isExistingSnap  = isExisting;
    const projNameSnap    = activeProjectName;
    const projNumberSnap  = activeProjectNumber;
    const pitchSnap       = planningPitch;
    const projIdSnap      = effectiveProjectId;
    // True only for brand-new sessions — no prior plan sections saved for this project
    const isFreshSession  = !isExisting && Object.keys(planSections[effectiveProjectId] ?? {}).length === 0;
    const ghLoginSnap     = useAppStore.getState().githubUser?.login ?? "";
    const ghNameSnap      = useAppStore.getState().githubUser?.name  ?? "";
    const automationsSnap = [
      ...commands.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
      ...schedules.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
    ];

    requestAnimationFrame(async () => {
      fitAddon.fit();

      // Subscribe before creating the PTY so we never miss early output.
      unlistenData.current = await listen<string>(`pty_data_${paneId}`, ev => {
        term.write(ev.payload);

        // Parse structured tags out of the stripped output stream.
        bufRef.current += stripAnsi(ev.payload);

        // Quote-flexible helper: matches " U+0022, " U+201C, " U+201D so LLM
        // smart-quote output doesn't silently break tag detection.
        // q(s) wraps a string in a char-class that matches any of those three.
        const Q = '["“”]';

        let m: RegExpExecArray | null;

        // ── <plan_update section="key">content</plan_update> ─────────────────
        const planRe = new RegExp(
          `<plan_update\\s+section=${Q}(\\w+)${Q}\\s*>([\\s\\S]*?)<\\/plan_update>`,
          'g'
        );
        let foundPlan = false;
        while ((m = planRe.exec(bufRef.current)) !== null) {
          const key     = m[1] as SectionKey;
          const content = m[2].trim();
          if (SECTION_DEFS.some(d => d.k === key)) {
            setSections(prev => {
              const idx = prev.findIndex(s => s.k === key);
              if (idx >= 0 && prev[idx].state !== "confirmed") {
                const next = [...prev];
                next[idx] = { ...next[idx], state: "drafted", content };
                return next;
              }
              return prev;
            });
            useAppStore.getState().setPlanSection(projIdSnap, key, content);
            foundPlan = true;
          }
        }
        if (foundPlan) {
          bufRef.current = bufRef.current.replace(
            new RegExp(`<plan_update\\s+section=${Q}\\w+${Q}\\s*>[\\s\\S]*?<\\/plan_update>`, 'g'),
            ""
          );
        }

        // ── <plan_focus section="key" /> ─────────────────────────────────────
        // Marks the section Claude is currently discussing. The last focus tag
        // in this chunk wins (Claude emits one per section as it advances).
        const focusKeys = parsePlanFocus(bufRef.current)
          .filter(k => SECTION_DEFS.some(d => d.k === k)) as SectionKey[];
        if (focusKeys.length > 0) {
          setActiveSection(focusKeys[focusKeys.length - 1]);
          bufRef.current = stripPlanFocus(bufRef.current);
        }

        // ── <repo_link full_name="owner/repo" /> ─────────────────────────────
        const repoLinkRe = new RegExp(
          `<repo_link\\s+full_name=${Q}([^\\u0022\\u201c\\u201d]+)${Q}\\s*\\/>`,'g'
        );
        let foundLink = false;
        while ((m = repoLinkRe.exec(bufRef.current)) !== null) {
          const fullName = m[1];
          setRepoLinkFullNames(prev =>
            prev.includes(fullName) ? prev : [...prev, fullName]
          );
          // PlanningRepoStrip auto-clones when repoLinkFullNames grows — no action needed here.
          foundLink = true;
        }
        if (foundLink) {
          bufRef.current = bufRef.current.replace(
            new RegExp(`<repo_link\\s+full_name=${Q}[^\\u0022\\u201c\\u201d]+${Q}\\s*\\/>`, 'g'),
            ""
          );
        }

        // ── <kb_assign id="block-id" /> ───────────────────────────────────────
        const kbAssignRe = new RegExp(`<kb_assign\\s+id=${Q}([^\\u0022\\u201c\\u201d]+)${Q}\\s*\\/>`, 'g');
        let foundKb = false;
        while ((m = kbAssignRe.exec(bufRef.current)) !== null) {
          useAppStore.getState().addPlanKbAssignment(projIdSnap, m[1].trim());
          foundKb = true;
        }
        if (foundKb) {
          bufRef.current = bufRef.current.replace(
            new RegExp(`<kb_assign\\s+id=${Q}[^\\u0022\\u201c\\u201d]+${Q}\\s*\\/>`, 'g'), ""
          );
        }

        // ── <automation_assign name="..." command="..." … /> ──────────────────
        const autoAssignRe = /<automation_assign([^/]*)\s*\/>/g;
        let foundAuto = false;
        while ((m = autoAssignRe.exec(bufRef.current)) !== null) {
          const attrs  = m[1];
          // Each attr value may use straight or curly quotes
          const attrRe = (k: string) => new RegExp(`\\b${k}=${Q}([^\\u0022\\u201c\\u201d]*)${Q}`);
          const nameM  = attrRe("name").exec(attrs);
          const cmdM   = attrRe("command").exec(attrs);
          const schedM = attrRe("schedule").exec(attrs);
          const descM  = attrRe("description").exec(attrs);
          if (nameM && cmdM) {
            useAppStore.getState().addPlanAutomation(projIdSnap, {
              name:        nameM[1],
              command:     cmdM[1],
              schedule:    schedM?.[1],
              description: descM?.[1],
            });
          }
          foundAuto = true;
        }
        if (foundAuto) {
          bufRef.current = bufRef.current.replace(/<automation_assign[^/]*\/>/g, "");
        }

        // Cap buffer to prevent unbounded growth while preserving any partial
        // in-progress tag that hasn't received its closing counterpart yet.
        const MAX_BUF = 120_000;
        if (bufRef.current.length > MAX_BUF) {
          const lastTagStart = bufRef.current.lastIndexOf("<");
          bufRef.current = bufRef.current.slice(
            lastTagStart > 0 && lastTagStart > bufRef.current.length - MAX_BUF
              ? lastTagStart
              : bufRef.current.length - MAX_BUF
          );
        }
      });

      unlistenExit.current = await listen<unknown>(`pty_exit_${paneId}`, () => {
        term.write("\r\n\x1b[33m[session ended — navigate away and back to restart]\x1b[0m\r\n");
      });

      // Create isolated workspace directories with settings.json + CLAUDE.md,
      // and sync all KB blocks to disk so the planner can Read them via ../kb/.
      const paths = await invoke<{ kb_dir: string; planning_dir: string }>(
        "setup_workspaces",
        {
          kbBlocks: kbSnapshot.map(b => ({
            id:      b.id,
            title:   b.title,
            tags:    b.tags,
            content: b.content,
          })),
          repoFullNames: repoSnapshot,
          automations:   automationsSnap,
          isExisting:    isExistingSnap,
          projectName:   projNameSnap,
          projectNumber: projNumberSnap,
          pitch:         pitchSnap,
          projectKey:    projIdSnap,
          githubLogin:   ghLoginSnap,
          githubName:    ghNameSnap,
        },
      ).catch((e: unknown) => {
        console.error("workspace setup failed:", e);
        return null;
      });

      // Launch claude inside the isolated planning directory.
      // Inject the stored GitHub token so `gh` CLI and direct API calls work
      // without requiring the user to separately authenticate the gh CLI.
      const token = useAppStore.getState().githubToken;
      const ghEnv = token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
      await invoke("pty_create", {
        paneId:  paneId,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     paths?.planning_dir ?? "",
        initCmd: "claude --continue 2>/dev/null || claude",
        env:     ghEnv,
      }).catch(console.error);

      // For brand-new sessions, send the pitch automatically once Claude has
      // had time to finish its startup banner and reach the input prompt.
      // The 3-second delay is intentionally generous — bytes written to a PTY
      // are buffered by the kernel, so they arrive at Claude regardless of
      // whether we race with its banner. We just want to avoid sending before
      // Claude switches the terminal into raw (interactive) mode.
      if (isFreshSession && pitchSnap && !initSentRef.current) {
        initSendTimer.current = setTimeout(() => {
          if (!initSentRef.current) {
            initSentRef.current = true;
            invoke("pty_write", { paneId, data: `${pitchSnap}\r` }).catch(console.error);
          }
        }, 3000);
      }
    });

    const ro = new ResizeObserver(() => {
      // No visibility guard: a hidden panel is display:none → zero client size,
      // already skipped below. Guarding on a `visible` ref instead raced with
      // React's commit and dropped the first fit after un-hiding, leaving the
      // terminal smaller than its container.
      const { clientWidth, clientHeight } = el;
      if (clientWidth === 0 || clientHeight === 0) return;
      fitAddon.fit();
      invoke("pty_resize", { paneId: paneId, cols: term.cols, rows: term.rows }).catch(console.error);
    });
    ro.observe(el);

    return () => {
      if (initSendTimer.current !== null) clearTimeout(initSendTimer.current);
      unlistenData.current?.();
      unlistenExit.current?.();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
      invoke("pty_kill", { paneId: paneId }).catch(console.error);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit the terminal when the planning panel becomes visible (hidden → shown).
  // The panel mounts lazily and has variable-height content above the terminal,
  // so a single in-RAF fit can measure before the final layout — and cell metrics
  // are wrong until the mono font loads. Re-fit on the frame, after a short delay,
  // and once fonts are ready so it reliably fills the available space.
  useEffect(() => {
    if (!visible) return;
    const refit = (focusToo: boolean) => {
      const fit = fitRef.current, term = termRef.current, el = containerRef.current;
      if (!fit || !term || !el || el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      invoke("pty_resize", { paneId: paneId, cols: term.cols, rows: term.rows }).catch(console.error);
      if (focusToo) term.focus();
    };
    let cancelled = false;
    const raf = requestAnimationFrame(() => refit(true));
    const delayed = setTimeout(() => refit(false), 120);
    document.fonts?.ready?.then(() => { if (!cancelled) refit(false); }).catch(() => {});
    return () => { cancelled = true; cancelAnimationFrame(raf); clearTimeout(delayed); };
  }, [visible]);

  // Poll plan section files written by Claude every 2 seconds while visible.
  // Claude writes to plans/{key}.md via its Write tool; this is more reliable
  // than parsing the raw PTY stream for <plan_update> tags.
  useEffect(() => {
    if (!visible) return;

    const poll = async () => {
      try {
        const result = await invoke<Record<string, string>>("read_plan_sections", { projectKey: effectiveProjectId });
        const entries = Object.entries(result);
        if (entries.length === 0) return;

        const store = useAppStore.getState();
        const saved = store.planSections[effectiveProjectId] ?? {};
        const updates: Record<string, string> = {};

        for (const [key, content] of entries) {
          if (content && content !== (saved[key] ?? "")) {
            updates[key] = content;
            store.setPlanSection(effectiveProjectId, key, content);
          }
        }

        if (Object.keys(updates).length > 0) {
          setSections(prev => {
            const next = [...prev];
            let changed = false;
            for (const [key, content] of Object.entries(updates)) {
              const idx = next.findIndex(s => s.k === key);
              if (idx >= 0 && next[idx].state !== "confirmed") {
                next[idx] = { ...next[idx], state: "drafted", content };
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      } catch {
        // plans dir may not exist yet — ignore
      }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, effectiveProjectId]);

  // Re-sync CLAUDE.md whenever a repo resolves after the initial mount.
  // kbBlocks is captured via ref to avoid including it in deps (it's large and
  // stable — we don't want to re-run on every KB edit).
  const kbBlocksRef = useRef(kbBlocks);
  useEffect(() => { kbBlocksRef.current = kbBlocks; }, [kbBlocks]);

  useEffect(() => {
    if (linkedRepos.length === 0) return;
    const { commands: cmds, schedules: scheds } = useAppStore.getState();
    invoke("setup_workspaces", {
      kbBlocks: kbBlocksRef.current.map(b => ({
        id: b.id, title: b.title, tags: b.tags, content: b.content,
      })),
      repoFullNames: linkedRepos,
      automations: [
        ...cmds.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
        ...scheds.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
      ],
      isExisting:    isExisting,
      projectName:   activeProjectName,
      projectNumber: activeProjectNumber,
      pitch:         planningPitch,
      projectKey:    effectiveProjectId,
      githubLogin:   useAppStore.getState().githubUser?.login ?? "",
      githubName:    useAppStore.getState().githubUser?.name  ?? "",
    }).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRepos]);


  async function handleRestart() {
    const term = termRef.current;
    if (!term || restarting) return;
    setRestarting(true);
    bufRef.current = "";
    term.clear();
    await invoke("pty_kill", { paneId: paneId }).catch(console.error);
    const store = useAppStore.getState();
    const currentAutomations = [
      ...store.commands.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
      ...store.schedules.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
    ];
    const paths = await invoke<{ kb_dir: string; planning_dir: string }>(
      "setup_workspaces",
      {
        kbBlocks: kbBlocks.map(b => ({ id: b.id, title: b.title, tags: b.tags, content: b.content })),
        repoFullNames: linkedRepos,
        automations: currentAutomations,
        isExisting,
        projectName: activeProjectName,
        projectNumber: activeProjectNumber,
        pitch: planningPitch,
        projectKey: effectiveProjectId,
        githubLogin: store.githubUser?.login ?? "",
        githubName:  store.githubUser?.name  ?? "",
      },
    ).catch((e: unknown) => { console.error("restart setup failed:", e); return null; });
    const token = store.githubToken;
    const ghEnv = token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
    await invoke("pty_create", {
      paneId: paneId,
      cols: term.cols,
      rows: term.rows,
      cwd: paths?.planning_dir ?? "",
      initCmd: "claude",
      env: ghEnv,
    }).catch(console.error);
    setRestarting(false);
  }

  function handleConfirm(k: SectionKey) {
    setSections(prev => prev.map(s => s.k === k ? { ...s, state: "confirmed" } : s));
    useAppStore.getState().confirmPlanSection(effectiveProjectId, k);
    // Tell Claude the user approved this section so the discovery loop advances.
    const title = SECTION_DEFS.find(d => d.k === k)?.title ?? k;
    invoke("pty_write", { paneId, data: `${buildSectionConfirmMessage(title)}\r` }).catch(console.error);
    // Clear the highlight; Claude will set the next active section via <plan_focus>.
    if (activeSection === k) setActiveSection(null);
  }

  // Publish the plan to GitHub: repositories → project board → milestones →
  // issues. Every step is idempotent (check-then-create) so re-running acts as a
  // sync. Status is reported through ghStatus, keyed by the buildGhStructure ids,
  // so the GitHubStructureCard reflects each object as it is created.
  async function handlePublish() {
    if (!canPublish || !githubToken) return;
    const token = githubToken;

    const repos       = publishRepos;
    const noRepo      = repos.length === 0;
    const phases      = parsePhases(sections.find(s => s.k === "phases")?.content ?? "");
    const goalContent = sections.find(s => s.k === "goal")?.content ?? "";
    const projectTitle = planningTitle || goalContent.split(/[.!?\n]/)[0].trim() || activeProjectName || "New project";
    const projectDesc  = goalContent.split(/\n/)[0].slice(0, 350);

    // Seed every node as "planned" so the card shows the full structure upfront.
    // Issues are namespaced per repo so each repo tracks its own phase issues.
    const status: GhStatusMap = {};
    status["project"] = { status: "planned" };
    phases.forEach((_, i) => { status[`ms:${i}`] = { status: "planned" }; });
    repos.forEach(r => {
      status[`repo:${r}`] = { status: "planned" };
      phases.forEach((_, i) => { status[`issue:${r}:${i}`] = { status: "planned" }; });
    });
    setGhStatus({ ...status });
    setPublishPhase("running");

    let anyError = false;
    const upd = (id: string, patch: Partial<GhItemState>) => {
      status[id] = { ...(status[id] ?? { status: "planned" }), ...patch };
      if (patch.status === "error") anyError = true;
      setGhStatus({ ...status });
    };

    const gql = (query: string, variables: unknown) =>
      invoke<Record<string, unknown>>("github_graphql", { token, query, variables });
    const rest = <T,>(path: string) => invoke<T>("github_request", { token, path });
    const post = <T,>(path: string, body: unknown) => invoke<T>("github_post", { token, path, body });

    try {
      // ── 1. Repositories — verify each exists; create if missing ───────────
      const repoNodeIds: Record<string, string> = {};
      let viewerLogin = "";
      try {
        const v = await gql(`{ viewer { login } }`, null) as { viewer?: { login?: string } };
        viewerLogin = v.viewer?.login ?? "";
      } catch { /* non-fatal: fall back to org repo path */ }

      for (const fullName of repos) {
        const id = `repo:${fullName}`;
        const [owner, name] = fullName.split("/");
        upd(id, { status: "running" });
        try {
          const existing = await rest<{ node_id: string; html_url: string }>(`repos/${fullName}`).catch(() => null);
          if (existing?.node_id) {
            repoNodeIds[fullName] = existing.node_id;
            upd(id, { status: "exists", detail: "on github", url: existing.html_url });
          } else {
            const path = owner.toLowerCase() === viewerLogin.toLowerCase() ? "user/repos" : `orgs/${owner}/repos`;
            const created = await post<{ node_id: string; html_url: string }>(path, {
              name, private: true, description: projectDesc,
            });
            repoNodeIds[fullName] = created.node_id;
            upd(id, { status: "created", detail: "created", url: created.html_url });
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 2. Project board — reuse existing or create a Projects v2 board ───
      let projectId = activeProjectId;
      {
        const id = "project";
        upd(id, { status: "running" });
        try {
          if (projectId) {
            upd(id, { status: "exists", detail: activeProjectNumber ? `#${activeProjectNumber}` : "linked" });
          } else {
            const ownerLogin = repos[0]?.split("/")[0] || viewerLogin;
            if (!ownerLogin) throw new Error("no owner to create project under");
            const ownerData = await gql(
              `query($login:String!){ repositoryOwner(login:$login){ id } }`,
              { login: ownerLogin },
            ) as { repositoryOwner?: { id?: string } };
            const ownerId = ownerData.repositoryOwner?.id;
            if (!ownerId) throw new Error(`could not resolve owner '${ownerLogin}'`);
            const created = await gql(
              `mutation($ownerId:ID!,$title:String!){
                 createProjectV2(input:{ownerId:$ownerId,title:$title}){ projectV2 { id number url } }
               }`,
              { ownerId, title: projectTitle },
            ) as { createProjectV2?: { projectV2?: { id: string; number: number; url: string } } };
            const pv = created.createProjectV2?.projectV2;
            if (!pv) throw new Error("project not created");
            projectId = pv.id;
            // Reflect in the store so the projects list + future syncs treat it as existing.
            useAppStore.getState().setActiveProjectMeta(pv.id, projectTitle, repos[0] ?? "", pv.number, repos);
            upd(id, { status: "created", detail: `#${pv.number}`, url: pv.url });
          }
          // Link every repo to the board (idempotent server-side).
          for (const fullName of repos) {
            const repoNodeId = repoNodeIds[fullName];
            if (projectId && repoNodeId) {
              await gql(
                `mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){ repository { id } } }`,
                { p: projectId, r: repoNodeId },
              ).catch(() => { /* already linked — ignore */ });
            }
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 3. Milestones — one per phase in every repo ───────────────────────
      // Existing milestones per repo for idempotency; remember each repo's
      // milestone number per phase so that repo's issues can be assigned to it.
      // Existing milestones per repo (matched by the stable phase name). Fail
      // CLOSED: if a repo's fetch fails, record it and skip creating milestones
      // there rather than risk duplicates.
      const existingMs: Record<string, Map<string, number>> = {};
      const msFetchFailed = new Set<string>();
      if (!noRepo) {
        await Promise.all(repos.map(async r => {
          try {
            const list = await rest<{ title: string; number: number }[]>(
              `repos/${r}/milestones?state=all&per_page=100`,
            );
            existingMs[r] = new Map(list.map(m => [m.title, m.number]));
          } catch {
            msFetchFailed.add(r);
            existingMs[r] = new Map();
          }
        }));
      }
      // repo full_name → phase index → milestone number
      const msNumbers: Record<string, Record<number, number>> = {};
      for (let pi = 0; pi < phases.length; pi++) {
        const ph = phases[pi];
        const id = `ms:${pi}`;
        if (noRepo) { upd(id, { status: "skipped", detail: "no repo linked" }); continue; }
        upd(id, { status: "running" });
        try {
          let created = 0, existed = 0, unverified = 0;
          for (const r of repos) {
            if (!msNumbers[r]) msNumbers[r] = {};
            if (msFetchFailed.has(r)) { unverified++; continue; } // couldn't verify — skip
            const existingNum = existingMs[r]?.get(ph.name);
            if (existingNum !== undefined) {
              msNumbers[r][pi] = existingNum;
              existed++;
              continue;
            }
            const ms = await post<{ number: number }>(`repos/${r}/milestones`, {
              title: ph.name, description: ph.description ?? "",
            });
            msNumbers[r][pi] = ms.number;
            created++;
          }
          const suffix = repos.length > 1 ? ` · ${repos.length} repos` : "";
          if (created === 0 && existed === 0 && unverified > 0) {
            upd(id, { status: "error", detail: `couldn't verify existing milestones — skipped${suffix}` });
          } else {
            const parts: string[] = [];
            if (created)    parts.push(`${created} created`);
            if (existed)    parts.push(`${existed} existed`);
            if (unverified) parts.push(`${unverified} unverified`);
            upd(id, {
              status: created === 0 ? "exists" : "created",
              detail: (parts.length ? parts.join(", ") : "already exists") + suffix,
            });
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 4. Issues — one tracking issue per phase in EVERY repo, each pinned
      //      to that repo's milestone and added to the project board. ─────────
      for (const fullName of repos) {
        // Check what already exists BEFORE creating so a re-sync never duplicates.
        // Fail CLOSED: if we can't fetch the repo's issues, skip creating here
        // rather than risk blindly duplicating them.
        let existingTitles: string[];
        try {
          const existing = await rest<{ title: string }[]>(
            `repos/${fullName}/issues?state=all&per_page=100`,
          );
          existingTitles = existing.map(i => i.title);
        } catch {
          for (let pi = 0; pi < phases.length; pi++) {
            upd(`issue:${fullName}:${pi}`, { status: "error", detail: "couldn't verify existing issues — skipped" });
          }
          continue;
        }
        for (let pi = 0; pi < phases.length; pi++) {
          const ph    = phases[pi];
          const id    = `issue:${fullName}:${pi}`;
          const title = `[${ph.name}] ${projectTitle}`;
          // Match on the stable `[phase]` prefix — the project-title suffix can
          // change between syncs and would otherwise cause a duplicate.
          const marker = `[${ph.name}]`;
          if (existingTitles.some(t => t.startsWith(marker))) {
            upd(id, { status: "exists", detail: "already exists" });
            continue;
          }
          upd(id, { status: "running" });
          try {
            const body: Record<string, unknown> = {
              title,
              body: `## ${ph.name}\n\n${ph.description ?? ""}\n\n---\n_Auto-generated by base-studio-code planner._`,
            };
            const msNum = msNumbers[fullName]?.[pi];
            if (msNum !== undefined) body.milestone = msNum;
            const issue = await post<{ number: number; node_id: string; html_url: string }>(
              `repos/${fullName}/issues`, body,
            );
            // Add the issue to the project board so it shows up as a tracked item.
            if (projectId && issue.node_id) {
              await gql(
                `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`,
                { p: projectId, c: issue.node_id },
              ).catch(() => { /* already on board — ignore */ });
            }
            upd(id, { status: "created", detail: `#${issue.number}`, url: issue.html_url });
          } catch (e) {
            upd(id, { status: "error", detail: String(e) });
          }
        }
      }

      setPublishPhase(anyError ? "error" : "done");
    } catch (e) {
      console.error("publish failed", e);
      setPublishPhase("error");
    }
  }

  // % of filled sections still needing confirmation (shown in the disabled button).
  const unconfirmedFilled = sections.filter(s => s.state === "drafted").length;
  const remainingPct = draftedOrConfirmed === 0 ? 100
    : Math.round((unconfirmedFilled / draftedOrConfirmed) * 100);

  const noRepoReady = !githubToken;

  return (
    <>
      {/* Header */}
      <div style={{ padding: "14px 24px 0", display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <button
              onClick={() => setProjectsView(isExisting ? "board" : "list")}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
                padding: 0, marginRight: 4,
              }}
            >{isExisting ? "← board" : "← projects"}</button>
            <span style={{ color: "var(--border-soft)" }}>·</span>
            {isExisting
              ? (
                <>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{activeProjectNumber}</span>
                  <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>{activeProjectName}</h2>
                </>
              )
              : (
                <input
                  value={planningTitle}
                  onChange={e => setPlanningTitle(e.target.value)}
                  placeholder="project title…"
                  style={{
                    background: "none", border: "none", outline: "none",
                    fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600,
                    color: planningTitle ? "var(--fg)" : "var(--fg-dim)",
                    width: Math.max(160, (planningTitle.length || 14) * 9 + 20),
                    minWidth: 160, maxWidth: 400,
                    padding: 0,
                  }}
                />
              )
            }
            <span className="tag amber">● {isExisting ? "expanding" : "drafting"}</span>
            {publishRepos.length === 1 && <span className="tag">{publishRepos[0]}</span>}
            {publishRepos.length > 1 && (
              <span className="tag" title={publishRepos.join("\n")}>{publishRepos.length} repos</span>
            )}
          </div>
          <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
            claude cli · interactive pty · {confirmedCount}/{SECTION_DEFS.length} sections confirmed
          </div>
        </div>
        <button className="btn ghost" onClick={() => setProjectsView(isExisting ? "board" : "list")}>
          save & exit
        </button>
        {(() => {
          const verb    = isExisting ? "sync" : "publish";
          const verbCap = isExisting ? "Sync changes →" : "Publish to GitHub →";
          const pending = isExisting
            ? `sync to github · ${remainingPct > 0 ? `${remainingPct}% to go` : "confirm at least one section"}`
            : `publish to github · ${remainingPct > 0 ? `${remainingPct}% to go` : "confirm all sections"}`;
          if (publishPhase === "running") return (
            <button className="btn primary" disabled style={{ opacity: 0.7 }}>
              {verb}ing…
            </button>
          );
          // After a successful run the flow stays re-runnable — every step is
          // idempotent, so clicking again syncs new/changed objects to GitHub.
          if (publishPhase === "done") return (
            <button
              className="btn primary"
              onClick={handlePublish}
              title="Re-run the publish — existing objects are skipped"
              style={{ background: "var(--success)", borderColor: "var(--success)" }}
            >
              ↻ sync again
            </button>
          );
          if (!canPublish) return (
            <div onClick={triggerFlash} title="Confirm at least one section first" style={{ cursor: "pointer" }}>
              <button className="btn primary" disabled style={{ opacity: 0.5, cursor: "not-allowed", pointerEvents: "none" }}>
                {pending}
              </button>
            </div>
          );
          if (noRepoReady) return (
            <button className="btn primary" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}
              title="Add a GitHub token in Settings → Integrations">
              no github token
            </button>
          );
          return (
            <button
              className="btn primary"
              onClick={handlePublish}
              style={publishPhase === "error" ? { borderColor: "var(--danger)", color: "var(--danger)", background: "transparent" } : {}}
            >
              {publishPhase === "error" ? `↺ retry ${verb}` : verbCap}
            </button>
          );
        })()}
      </div>

      {/* Repo strip — always visible so state is clear at a glance */}
      {(() => {
        const stripRepos = [...new Set([...effectiveRepos, ...repoLinkFullNames])];
        if (stripRepos.length > 0) {
          return <PlanningRepoStrip projectId={effectiveProjectId} repos={stripRepos} />;
        }
        return (
          <div style={{ padding: "6px 24px 0", display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 10.5 }}>
            <span style={{ color: "var(--fg-dim)" }}>repos</span>
            <span style={{ color: "var(--fg-dim)", opacity: 0.55 }}>none linked — ask Claude to create or link repositories</span>
          </div>
        );
      })()}

      {/* Section progress bar */}
      <div style={{ padding: "14px 24px 12px", display: "flex", gap: 6 }}>
        {sections.map(s => {
          const tone = s.state === "confirmed" ? "var(--accent)"
                     : s.state === "drafted"   ? "color-mix(in oklch, var(--accent), transparent 50%)"
                     : "var(--bg-elev2)";
          return (
            <div key={s.k} style={{ flex: 1, height: 5, borderRadius: 3, background: tone }} title={s.title} />
          );
        })}
      </div>

      {/* Split panel */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden", borderTop: "1px solid var(--border-soft)" }}>
        {/* Claude CLI terminal */}
        <section style={{ flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", borderRight: "1px solid var(--border-soft)" }}>
          <div style={{
            padding: "10px 18px", background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
          }}>
            <span style={{ color: "var(--accent)" }}>▸ claude cli · planning session</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
              emit{" "}
              <code style={{ color: "var(--fg)", background: "var(--bg-elev)", padding: "0 4px", borderRadius: 3 }}>
                &lt;plan_update section="goal"&gt;…&lt;/plan_update&gt;
              </code>
              {" "}to populate sections →
            </span>
            <button
              onClick={handleRestart}
              disabled={restarting}
              style={{
                padding: "2px 8px", borderRadius: 3, cursor: restarting ? "not-allowed" : "pointer",
                background: "transparent", border: "1px solid var(--border-soft)",
                color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10,
                opacity: restarting ? 0.5 : 1,
              }}
            >{restarting ? "restarting…" : "↺ restart"}</button>
          </div>


          <div
            ref={containerRef}
            style={{
              flex: 1, minHeight: 0, overflow: "hidden",
              background: TERM_THEME.background as string,
              display: "flex",
              padding: "6px 4px",
            }}
          />
        </section>

        {/* Plan sections / publish progress panel */}
        <aside style={{ flex: "0 0 430px", display: "flex", flexDirection: "column", background: "var(--bg-panel)", minHeight: 0, overflow: "hidden" }}>
          {publishPhase === "idle" ? (
            <>
              <div style={{
                padding: "10px 18px", borderBottom: "1px solid var(--border-soft)",
                display: "flex", alignItems: "center", gap: 8,
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
              }}>
                <span style={{ color: "var(--accent)" }}>
                  ⌘ plan · {draftedOrConfirmed > 0 ? "building" : "waiting"}
                </span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10 }}>{confirmedCount}/{SECTION_DEFS.length} confirmed</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                {sections.map(s => (
                  <PlanSectionCard key={s.k} section={s} onConfirm={handleConfirm} flashing={flashConfirm && s.state === "drafted"} active={activeSection === s.k} />
                ))}
                <KbAssignedCard
                  blockIds={planKbAssignments[effectiveProjectId] ?? []}
                  onRemove={(id) => removePlanKbAssignment(effectiveProjectId, id)}
                />
                <AutomationsCard
                  automations={planAutomations[effectiveProjectId] ?? []}
                  onRemove={(idx) => {
                    const current = planAutomations[effectiveProjectId] ?? [];
                    const filtered = current.filter((_, i) => i !== idx);
                    useAppStore.getState().clearPlanAutomations(effectiveProjectId);
                    filtered.forEach(a => useAppStore.getState().addPlanAutomation(effectiveProjectId, a));
                  }}
                />
                <GitHubStructureCard structure={ghStructure} status={ghStatus} />
              </div>
            </>
          ) : (
            <>
              {/* Publish progress header */}
              <div style={{
                padding: "10px 18px", borderBottom: "1px solid var(--border-soft)",
                display: "flex", alignItems: "center", gap: 8,
                fontFamily: "var(--mono)", fontSize: 11,
              }}>
                <span style={{
                  color: publishPhase === "done"  ? "var(--success)"
                       : publishPhase === "error" ? "var(--danger)"
                       : "var(--accent)",
                }}>
                  {publishPhase === "running" ? "⟳ publishing…"
                   : publishPhase === "done"  ? "✓ published"
                   : "✗ publish failed"}
                </span>
                <div style={{ flex: 1 }} />
                {(publishPhase === "done" || publishPhase === "error") && (
                  <button
                    onClick={() => setPublishPhase("idle")}
                    style={{
                      padding: "2px 8px", borderRadius: 3, cursor: "pointer",
                      background: "transparent", border: "1px solid var(--border-soft)",
                      color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10,
                    }}
                  >← back to plan</button>
                )}
              </div>

              {/* Live GitHub structure — each node updates as it is created */}
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                <GitHubStructureCard structure={ghStructure} status={ghStatus} />
              </div>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
