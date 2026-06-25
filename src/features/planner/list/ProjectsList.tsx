import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, MoreHorizontal, Trash2, Pencil, Check, Search, Layers, GitFork, Shield, Wrench, Database, Link2, Download } from "lucide-react";
import { useAppStore } from "@/store";
import { useFleetLive } from "@/shared/hooks/useFleetLive";
import { sanitizeProjectKey, isKnownPublishedKey, findByTitle } from "@/shared/lib/core/projectPaths";
import { AUTHORING_BLUEPRINT_ID, DEFAULT_BLUEPRINT_ID, CATEGORY_META, uid, type Blueprint, type BlueprintGist, type BlueprintCategory, type BlueprintSection } from "../stages/blueprints";
import { PlanGateRow } from "../pane/PlanStageBar";
import { ImportModal, type PreviewBlueprint } from "../blueprints/BlueprintModals";
import { BlueprintImportModal } from "../blueprints/BlueprintImportModal";
import { DEFAULT_GIST_SOURCE } from "../blueprints/blueprintCatalog";
import { manifestToBlueprint, bundledSkillsFromManifest } from "../blueprints/blueprintShare";
import { installFromGist, gistIdFromUrl } from "@/features/planner/lib/gist/gist";
import { useDragResize } from "@/shared/hooks/useDragResize";

// A published project's lifecycle, derived from GitHub state: open ⇒ active, closed ⇒ shipped.
// (Local, not-yet-on-GitHub work lives in the separate Drafts section.)
type ProjStatus = "active" | "shipped";
const STATUS_META: Record<ProjStatus, { label: string; cls: string; dot: string }> = {
  active:   { label: "active",   cls: "green", dot: "var(--success)" },
  shipped:  { label: "shipped",  cls: "",      dot: "var(--fg-dim)" },
};
function projStatus(p: { closed: boolean }): ProjStatus {
  return p.closed ? "shipped" : "active";
}

// ── Blueprint display helpers (#…): a hued icon tile keyed by lifecycle category, a visibility
// pill (draft / private gist / public gist), and a shortened gist link. ────────────────────────
const CAT_ICON: Record<BlueprintCategory, typeof Layers> = {
  greenfield: Layers, transform: GitFork, harden: Shield, maintain: Wrench, data: Database,
};
function catHue(cat: BlueprintCategory): string {
  return `oklch(0.75 0.13 ${CATEGORY_META[cat]?.h ?? 70})`;
}
type Visibility = "draft" | "private" | "public";
const VIS_META: Record<Visibility, { label: string; color: string }> = {
  draft:   { label: "draft",        color: "var(--accent)" },
  private: { label: "private gist", color: "var(--info)" },
  public:  { label: "public gist",  color: "var(--success)" },
};
function prettyGist(g?: BlueprintGist): string | undefined {
  if (!g) return undefined;
  if (g.url) {
    const s = g.url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    return s.length > 32 ? s.slice(0, 30) + "…" : s;
  }
  return g.id ? `gist · ${g.id.slice(0, 7)}` : undefined;
}

/** A blueprint surfaced in the Projects page: either a saved library blueprint, or an in-progress
 *  authoring draft (a planning session bound to the blueprint-author lifecycle). */
interface BpItem {
  id: string;          // library blueprint id, or "draft:<key>" for an authoring draft
  kind: "library" | "draft";
  draftKey?: string;   // present for authoring drafts (its resume / delete target)
  draftTitle?: string;
  draftPitch?: string;
  name: string;
  pitch: string;
  category: BlueprintCategory;
  stages: number;
  sections: BlueprintSection[];   // the blueprint's sections — drives the gate-row preview
  vis: Visibility;
  builtIn?: boolean;   // a code-owned app template (can't be deleted)
  gistLabel?: string;
  updatedLabel: string;
  sort: number;        // recency key (epoch ms)
}

/** Live "N agents running · M paused" pill for a project (matched by repo). */
function FleetPill({ running, paused }: { running: number; paused: number }) {
  if (running === 0 && paused === 0) return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 9px", borderRadius: 99,
      fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--success)",
      background: "color-mix(in oklch, var(--success), transparent 88%)",
      border: "1px solid color-mix(in oklch, var(--success), transparent 70%)",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--success)", animation: "pulse 1.4s ease-in-out infinite" }} />
      <span>{running} agent{running !== 1 ? "s" : ""} running</span>
      {paused > 0 && <span style={{ color: "var(--fg-dim)" }}>· {paused} paused</span>}
    </span>
  );
}

/** Lifecycle sub-group header within the Projects section (Active · Drafting · Shipped). */
function GroupHeader({ label, count, dot }: { label: string; count: number; dot: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 7px", paddingLeft: 2 }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: dot }} />
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</span>
      <span style={{ padding: "0 5px", borderRadius: 8, fontFamily: "var(--mono)", fontSize: 9, background: "var(--bg-elev2)", color: "var(--fg-muted)", border: "1px solid var(--border-soft)" }}>{count}</span>
    </div>
  );
}

/** Milestone-progress bar: fraction of the project's items that are closed. */
function ProgressBar({ pct }: { pct: number }) {
  return (
    <span title={`${Math.round(pct * 100)}% of items closed`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 56, height: 4, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", height: "100%", width: `${pct * 100}%`, background: pct >= 1 ? "var(--success)" : "var(--accent)" }} />
      </span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{Math.round(pct * 100)}%</span>
    </span>
  );
}

interface GhProjectItem { content: { __typename?: string; state?: string } | null }
interface GhProject {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  url: string;
  closed: boolean;
  updatedAt: string;
  items: { totalCount: number; nodes: GhProjectItem[] };
  repositories: { nodes: Array<{ nameWithOwner: string }> };
}

// Open count + closed fraction from the fetched item states (capped at 100 items;
// totalCount is the true item count, used for the headline number).
function projectProgress(p: GhProject): { open: number; pct: number } {
  let open = 0, closed = 0;
  for (const n of p.items?.nodes ?? []) {
    const s = n.content?.state;
    if (s === "OPEN") open++;
    else if (s === "CLOSED" || s === "MERGED") closed++;
  }
  const total = open + closed;
  return { open, pct: total ? closed / total : 0 };
}

const PROJECTS_QUERY = `{
  viewer {
    projectsV2(first: 20) {
      nodes {
        id number title shortDescription url closed updatedAt
        items(first: 100) {
          totalCount
          nodes { content { __typename ... on Issue { state } ... on PullRequest { state } } }
        }
        repositories(first: 20) { nodes { nameWithOwner } }
      }
    }
  }
}`;

const DELETE_MUTATION = `
  mutation DeleteProject($projectId: ID!) {
    deleteProjectV2(input: { projectId: $projectId }) {
      projectV2 { id }
    }
  }
`;

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function timeAgoMs(ms: number): string {
  return ms > 0 ? timeAgo(new Date(ms).toISOString()) : "—";
}

interface ProjectRowProps {
  p: GhProject;
  running: number;
  paused: number;
  onPlan: (p: GhProject) => void;
  onBoard: (p: GhProject) => void;
  onDelete: (p: GhProject) => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
}

export function ProjectRow({ p, running, paused, onPlan, onBoard, onDelete, menuOpenId, setMenuOpenId }: ProjectRowProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isOpen  = menuOpenId === p.id;
  const [hover, setHover] = useState(false);
  const status = projStatus(p);
  const repos  = (p.repositories?.nodes ?? []).map(r => r.nameWithOwner.split("/")[1] ?? r.nameWithOwner);
  const { open, pct } = projectProgress(p);

  // Close the menu on an outside mousedown, but NOT on a mousedown inside it —
  // otherwise the menu unmounts before a menu item's click fires.
  useEffect(() => {
    if (!isOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpenId(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [isOpen, setMenuOpenId]);

  return (
    <div
      onClick={() => onPlan(p)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        padding: "13px 16px 13px 18px", display: "grid", gridTemplateColumns: "1fr auto", gap: 16, alignItems: "center",
        cursor: "pointer", borderLeft: "2px solid " + (hover ? "var(--accent)" : "transparent"),
        background: hover ? "var(--bg-elev)" : "var(--bg-panel)",
      }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5, flexWrap: "wrap" }}>
          <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_META[status].dot, flexShrink: 0 }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{p.number}</span>
          <h3 style={{ margin: 0, fontFamily: "var(--sans)", fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{p.title}</h3>
          <span className={"tag " + STATUS_META[status].cls} style={{ fontSize: 9.5 }}>{STATUS_META[status].label}</span>
          {repos.slice(0, 2).map(r => <span key={r} className="tag" style={{ fontSize: 9.5 }}>{r}</span>)}
          {repos.length > 2 && <span className="tag" style={{ fontSize: 9.5 }}>+{repos.length - 2}</span>}
        </div>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5, marginBottom: 9, maxWidth: 620 }}>
          {p.shortDescription ?? "No description."}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", flexWrap: "wrap" }}>
          {p.items.totalCount > 0 && <span><b style={{ color: "var(--fg)" }}>{p.items.totalCount}</b> items</span>}
          {open > 0 && <span><b style={{ color: "var(--fg)" }}>{open}</b> open</span>}
          {p.items.totalCount > 0 && <ProgressBar pct={pct} />}
          <span style={{ color: "var(--fg-dim)" }}>updated {timeAgo(p.updatedAt)}</span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <FleetPill running={running} paused={paused} />
        <span style={{
          fontFamily: "var(--mono)", fontSize: 10.5, whiteSpace: "nowrap",
          color: hover ? "var(--accent)" : "var(--fg-dim)", transition: "color .12s",
        }}>open planning →</span>

        {/* ⋯ menu — stops row-click propagation */}
        <div ref={menuRef} style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <button
            className="btn ghost"
            style={{ height: 26, width: 26, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMenuOpenId(isOpen ? null : p.id)}
            title="More options"
          >
            <MoreHorizontal size={14} />
          </button>

          {isOpen && (
            <div style={{
              position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 100,
              background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-md)", padding: "4px 0", minWidth: 178,
              boxShadow: "0 6px 22px rgba(0,0,0,0.45)",
            }}>
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onBoard(p); }}>
                <ExternalLink size={12} /> open board on GitHub
              </button>
              <div style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
              <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete(p); }}>
                <Trash2 size={12} /> delete project
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface DraftRow { key: string; title: string; pitch: string; sort: number }

/** A compact blueprint card for the right rail — hued icon tile + name + ⋯ menu, then a
 *  category / stages / visibility meta row and an optional gist link. */
function BlueprintCard({ b, onUse, onOpen, onDelete, activeId, menuOpenId, setMenuOpenId }: {
  b: BpItem;
  onUse: (id: string) => void;
  onOpen: (b: BpItem) => void;
  onDelete: (b: BpItem) => void;
  activeId?: string;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
}) {
  const isActive = b.id === activeId;
  const menuId = "bp:" + b.id;
  const isOpen = menuOpenId === menuId;
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    function onDown(e: MouseEvent) { if (!menuRef.current?.contains(e.target as Node)) setMenuOpenId(null); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [isOpen, setMenuOpenId]);

  const hue = catHue(b.category);
  const Icon = CAT_ICON[b.category] ?? Layers;
  const vis = VIS_META[b.vis];

  return (
    <div
      onClick={() => onUse(b.id)}
      title={isActive ? "Selected — new projects use this blueprint" : "Select this blueprint for new projects"}
      style={{
        padding: "12px 13px", background: isActive ? "var(--bg-elev2)" : "var(--bg-elev)",
        border: "1px solid " + (isActive ? "var(--accent)" : "var(--border-soft)"),
        borderRadius: 9, cursor: "pointer", position: "relative",
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
        <span style={{
          width: 30, height: 30, flex: "0 0 30px", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
          background: `color-mix(in oklch, ${hue}, transparent 88%)`, border: `1px solid color-mix(in oklch, ${hue}, transparent 70%)`, color: hue,
        }}><Icon size={15} /></span>
        <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
        <div ref={menuRef} style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <button
            className="btn ghost"
            style={{ height: 22, width: 22, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMenuOpenId(isOpen ? null : menuId)}
            title="More options"
          ><MoreHorizontal size={13} /></button>
          {isOpen && (
            <div style={{
              position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 100,
              background: "var(--bg-elev2)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-md)", padding: "4px 0", minWidth: 158, boxShadow: "0 6px 22px rgba(0,0,0,0.45)",
            }}>
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onUse(b.id); }}>
                <Check size={12} /> use for new projects
              </button>
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onOpen(b); }}>
                <Pencil size={12} /> modify in planner
              </button>
              {!b.builtIn && (
                <>
                  <div style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
                  <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete(b); }}>
                    <Trash2 size={12} /> delete blueprint
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
        <span style={{
          padding: "1px 6px", borderRadius: 99, color: hue,
          background: `color-mix(in oklch, ${hue}, transparent 90%)`, border: `1px solid color-mix(in oklch, ${hue}, transparent 78%)`,
        }}>{b.category}</span>
        <span><b style={{ color: "var(--fg-muted)", fontWeight: 600 }}>{b.stages}</b> stage{b.stages !== 1 ? "s" : ""}</span>
        <span style={{ color: vis.color }}>{vis.label}</span>
        {b.builtIn && <span style={{ color: "var(--fg-dim)" }}>built-in</span>}
        {isActive && <span style={{ color: "var(--accent)", fontWeight: 600 }}>✓ selected</span>}
      </div>
      {/* Gated-stage progression (#blueprints): one segment per enabled, applicable section,
          colored by gate status — a preview of the lifecycle this blueprint walks through. */}
      <PlanGateRow sections={b.sections} signals={{}} />
      {b.gistLabel && (
        <div style={{ marginTop: 7, fontFamily: "var(--mono)", fontSize: 9, color: "var(--info)", display: "flex", alignItems: "center", gap: 5 }}>
          <Link2 size={10} />{b.gistLabel}
        </div>
      )}
    </div>
  );
}

export function ProjectsList() {
  const { githubToken, activeScreen, setScreen, setGithubTab, setProjectsView, setActiveProjectMeta, openGithubBoard, setPlanningContext, setPlanningTitle, setPlanningSession, deleteLocalProject, hiddenProjectIds, dismissProject, localDraftProjects, addDraftProject, removeDraftProject, projectKeyAlias, setProjectKeyAlias, projectBlueprintId, setProjectBlueprintId, planAuthoredBlueprint, setAuthoredBlueprint, blueprints, activeBlueprintId, setActiveBlueprint, removeBlueprint, setBlueprintSections, updateBlueprintMeta, importBlueprint, installBundledSkills, githubUser } = useAppStore();
  const [projects, setProjects]   = useState<GhProject[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [lastSync, setLastSync]   = useState<Date | null>(null);
  const [title, setTitle]         = useState("");
  const [newOpen, setNewOpen]     = useState(false);
  // New-project form: dismiss by clicking outside (no cancel button). The typed title is KEPT in
  // state on dismiss, so a mistaken click outside doesn't lose it — reopening restores what was typed.
  const newFormRef = useRef<HTMLDivElement>(null);
  const newBtnRef  = useRef<HTMLButtonElement>(null);
  const [bpNewOpen, setBpNewOpen] = useState(false);   // rail "+ author a blueprint" inline form
  const [bpTitle, setBpTitle]     = useState("");
  const [importOpen, setImportOpen]   = useState(false); // manual "paste a gist URL / ID" modal
  const [catalogOpen, setCatalogOpen] = useState(false); // browse-my-gists catalog overlay
  // Drag-resizable blueprints rail (mirrors the GitHub / planning splitters). It sits on the
  // right, so it grows as the pointer moves left → invert. Wider default to seat each card's
  // gated-icon progression comfortably.
  const blueprintsRail = useDragResize({ initial: 460, min: 340, max: 760, axis: "x", invert: true });
  const [query, setQuery]         = useState("");
  const [sort, setSort]           = useState<"recency" | "name">("recency");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GhProject | null>(null);
  const [deleting, setDeleting]   = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Published-delete is a two-step Keep-vs-Delete flow (#1216): the modal first offers Keep (default,
  // safe) vs "delete everything"; choosing the destructive path arms a deliberate second confirm
  // before it runs the GitHub project DELETE_MUTATION.
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  // Draft-delete now requires a confirmation (#1216) — an accidental ✕ click must not destroy the
  // draft + its folder. Holds the draft pending confirmation.
  const [draftDeleteTarget, setDraftDeleteTarget] = useState<DraftRow | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  // On-disk local projects (#…) — the durable source of truth for unpublished work, since the
  // store's draft map drifts out of sync with the `projects/` dir.
  const [localProjects, setLocalProjects] = useState<{ key: string; title: string; hasPlan: boolean; updatedAt: number; published: boolean }[]>([]);
  // Live fleet (for the per-project "agents running" pill).
  const { workers } = useFleetLive();

  // Dismiss the new-project form on an outside click (#…) — closes without clearing the title, so a
  // stray click keeps what was typed. The trigger button is excluded so it keeps toggling the form.
  useEffect(() => {
    if (!newOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (newFormRef.current?.contains(t) || newBtnRef.current?.contains(t)) return;
      setNewOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [newOpen]);

  const fetchProjects = useCallback(() => {
    if (!githubToken) return;
    setLoading(true);
    setError(null);
    invoke<{ viewer: { projectsV2: { nodes: GhProject[] } } }>("github_graphql", {
      token: githubToken,
      query: PROJECTS_QUERY,
      variables: null,
    })
      .then(data => {
        setProjects(data.viewer?.projectsV2?.nodes ?? []);
        setLastSync(new Date());
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken]);

  // Re-fetch whenever the Projects tab becomes active (the screen stays mounted
  // across navigation, so a plain mount effect wouldn't refresh on re-open) as
  // well as on token change, so newly created/renamed projects appear.
  useEffect(() => {
    if (activeScreen === "projects") fetchProjects();
  }, [activeScreen, fetchProjects]);

  // Enumerate on-disk local projects whenever the tab opens, so unpublished local work always
  // shows even when it isn't in the store's draft map or on GitHub (#…).
  const refreshLocalProjects = useCallback(() => {
    return invoke<{ key: string; title: string; hasPlan: boolean; updatedAt: number; published: boolean }[]>("list_local_projects")
      // Coerce to an array: a null/garbage return would make `for (const lp of localProjects)`
      // non-iterable and throw during render (#874).
      .then((list) => { const arr = Array.isArray(list) ? list : []; setLocalProjects(arr); return arr; })
      .catch(() => { setLocalProjects([]); return []; });
  }, []);
  useEffect(() => {
    if (activeScreen !== "projects") return;
    void refreshLocalProjects();
  }, [activeScreen, refreshLocalProjects]);

  // Reconcile published markers (#922): a local hub that matches a GitHub board (by title or alias)
  // but isn't yet flagged published gets its in-place `.published` marker stamped. This is what
  // promotes a hub that couldn't be flagged at publish time — e.g. a project published under the old
  // #904 location split, or one whose publish-time write lost a race — and it catches the hub the
  // startup migration moved out of draft/ as soon as its board is known. Runs whenever the list or
  // boards change (NOT one-time): marking flips `lp.published`, so the set drains and it converges.
  // The hub never moves and the marker is written in place, so this can't fail on a cwd lock. Gated
  // on a completed GitHub sync (`lastSync`) so an unloaded board list can't look like "no boards".
  useEffect(() => {
    if (activeScreen !== "projects" || lastSync === null) return;
    const publishedTitles = new Set(projects.map(p => p.title.toLowerCase()));
    const toMark = localProjects.filter(lp =>
      !lp.published &&
      (publishedTitles.has(lp.title.toLowerCase()) || isKnownPublishedKey(lp.key, projectKeyAlias)),
    );
    if (toMark.length === 0) return;
    (async () => {
      for (const lp of toMark) {
        await invoke("mark_published", { projectKey: lp.key })
          .catch((e) => console.warn(`mark_published ${lp.key} failed:`, e));
      }
      await refreshLocalProjects();
    })();
  }, [activeScreen, lastSync, localProjects, projects, projectKeyAlias, refreshLocalProjects]);

  // Reconcile legacy board node ids → on-disk folder keys (#…). The alias was never populated, so
  // a project opened from the board keyed its store state under the node id, splitting it from the
  // title-keyed on-disk hub. When a published project has a matching local folder and no alias yet,
  // record it — safely (record-if-absent never clobbers a publish-set alias; only fires when the
  // folder actually exists, so we never alias to a phantom key).
  useEffect(() => {
    for (const p of projects) {
      if (projectKeyAlias[p.id]) continue;
      const folderKey = sanitizeProjectKey(p.title);
      if (localProjects.some(lp => lp.key === folderKey)) setProjectKeyAlias(p.id, folderKey);
    }
  }, [projects, localProjects, projectKeyAlias, setProjectKeyAlias]);

  // The GitHub Projects v2 board now lives on the GitHub page (#498).
  function handleOpenGithubBoard(p: GhProject) {
    const repos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, repos[0] ?? "", p.number, repos);
    setGithubTab("projects"); // so "← portfolio" returns to the Projects tab
    setScreen("github");
    openGithubBoard("board");
  }

  function handleEditPlan(p: GhProject) {
    const allRepos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const repo     = allRepos[0] ?? "";
    setActiveProjectMeta(p.id, p.title, repo, p.number, allRepos);
    setPlanningContext(p.shortDescription ?? p.title, repo);
    // Key the session by the project name so the working directory is stable and
    // human-readable, and matches a from-scratch session of the same name. The
    // GitHub node id stays in activeProjectId for API calls only.
    setPlanningSession(p.title);
    setProjectsView("planning");
  }

  function closeDeleteModal() {
    setDeleteTarget(null);
    setDeleteError(null);
    setConfirmDeleteAll(false);
  }

  // Remove ONLY the local footprint of a published project (#1216 "Keep the app"): the on-disk hub +
  // per-project store state + a persisted dismissal so the next GitHub sync doesn't re-list it. The
  // GitHub board / milestones / issues / repos are left completely untouched (no DELETE_MUTATION).
  // Shared by Keep and by "delete everything" (which layers the GitHub teardown on top).
  async function removeLocalFootprint(p: GhProject) {
    // delete_project_dir clears Windows read-only files first (#793) and handles relocated worktrees
    // without following a node_modules junction into the shared main node_modules.
    await invoke("delete_project_dir", { projectKey: p.title })
      .catch((e) => console.warn(`delete_project_dir failed: ${e}`));
    // Pass BOTH the title and the GitHub node id: deleteLocalProject resolves the node id through the
    // alias to the slug-keyed maps (#997) and guards undefined slices (#874/#791), and clears the
    // active/planning session if this was the open project.
    deleteLocalProject([p.title, p.id]);
    // Persist the removal so the next GitHub sync (which still returns closed / not-yet-purged
    // boards) doesn't re-add the card (#85).
    dismissProject(p.id);
    setProjects(prev => prev.filter(x => x.id !== p.id));
  }

  // "Keep the app — stop tracking it here" (#1216, the default / safe path): local cleanup only.
  async function handleDeleteKeep() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    await removeLocalFootprint(deleteTarget);
    setDeleting(false);
    closeDeleteModal();
  }

  // "Delete everything" (#1216, the explicitly destructive path): the local cleanup PLUS the GitHub
  // Project DELETE_MUTATION (tears down the project BOARD — not the repos / their code).
  async function handleDeleteEverything() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    // Best-effort GitHub delete: a project already deleted on the web returns a GraphQL "could not
    // resolve to a node" error, which must NOT block removing it locally — that was the bug where
    // stale projects couldn't be cleared (#85).
    if (githubToken) {
      try {
        await invoke("github_graphql", {
          token: githubToken,
          query: DELETE_MUTATION,
          variables: { projectId: deleteTarget.id },
        });
      } catch (e) {
        console.warn(`github project delete failed (removing locally anyway): ${e}`);
      }
    }
    await removeLocalFootprint(deleteTarget);
    setDeleting(false);
    closeDeleteModal();
  }

  // The GitHub list is re-fetched on every sync, so a project removed in-app is
  // filtered out here (persisted) rather than only spliced from local state.
  const visibleProjects = projects.filter(p => !hiddenProjectIds.includes(p.id));

  const titleTrimmed = title.trim();
  // One title matcher (#380) — case/whitespace-insensitive — so the guard that no-ops a
  // re-typed existing-project name agrees with everywhere else "title already taken" is judged.
  const titleConflict = findByTitle(visibleProjects, titleTrimmed, p => p.title);

  async function handleStartPlanning() {
    // Never start over — or delete the folder of — an existing project. The button is disabled
    // on titleConflict, but the Enter-key handler isn't, so this guard is what actually stops a
    // re-typed published-project name from wiping its plan (#380).
    if (!titleTrimmed || titleConflict) return;
    // New project starts as a DRAFT (#379). The planning-dir id is the sanitized title — a
    // clean, stable folder name (no random suffix), so the folder and the project resolve the
    // same regardless of how it is later reopened or published. Re-using a title replaces an
    // earlier *unpublished* draft, so clear that draft's folder FIRST for a stale-free start.
    const draftKey = sanitizeProjectKey(titleTrimmed);
    removeDraftProject(draftKey);
    deleteLocalProject([draftKey]);
    // Belt-and-suspenders: never delete a folder that belongs to a project already published
    // to GitHub (its node id is aliased to this name) — even if titleConflict missed it because
    // the project list hadn't loaded. Only a genuinely unpublished draft's folder is cleared.
    if (!isKnownPublishedKey(draftKey, projectKeyAlias)) {
      await invoke("delete_project_dir", { projectKey: draftKey }).catch(() => {});
    }
    setPlanningTitle(titleTrimmed);
    // The pitch is described in the planning conversation now — creation only needs the title (#…).
    setPlanningContext("", "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(draftKey, { title: titleTrimmed, pitch: "", createdAt: Date.now() });
    // Bind the blueprint AT CREATION (#988) — the explicit consent point — capturing whatever's
    // selected now. Opening the project later never adopts the (freely-changing) global selection,
    // so its blueprint can't switch without the user's intent.
    setProjectBlueprintId(draftKey, activeBlueprintId || DEFAULT_BLUEPRINT_ID);
    setPlanningSession(draftKey);
    setNewOpen(false);
    setTitle("");
    setProjectsView("planning");
  }

  function reopenDraft(d: { key: string; title: string; pitch: string }) {
    setPlanningTitle(d.title);
    setPlanningContext(d.pitch, "");
    setActiveProjectMeta(null, "", "", 0);
    setPlanningSession(d.key);
    setProjectsView("planning");
  }

  // Delete a local/draft project: remove its on-disk folder FIRST (awaited, so a failure —
  // e.g. the folder is open in a console session — surfaces instead of silently leaving it to
  // reappear on the next scan), then clear the store entries AND prune it from `localProjects`
  // so the card disappears immediately (it isn't in the draft map, so removeDraftProject alone
  // never removed it).
  async function deleteDraft(key: string) {
    setDraftError(null);
    try {
      await invoke("delete_project_dir", { projectKey: key });
    } catch (e) {
      setDraftError(`Couldn't delete the folder for "${key}": ${e}. It may be open in a console session — close it and retry.`);
      return;
    }
    // The folder is gone; clear the store + on-disk list. Guard the store mutations too —
    // a throw here would otherwise become an unhandled rejection (and the card would linger)
    // rather than a surfaced error (#874).
    try {
      removeDraftProject(key);
      deleteLocalProject([key]);
      setLocalProjects(prev => (Array.isArray(prev) ? prev : []).filter(lp => lp.key !== key));
    } catch (e) {
      setDraftError(`Removed the folder for "${key}" but couldn't update the project list: ${e}.`);
    }
  }

  // Confirmed draft delete (#1216): run the destructive delete, then dismiss the confirmation modal.
  // On a folder-locked failure deleteDraft surfaces the inline draftError and leaves the card; close
  // the modal regardless so the error (rendered in the list) is visible.
  async function confirmDeleteDraft() {
    if (!draftDeleteTarget) return;
    const key = draftDeleteTarget.key;
    setDraftDeleteTarget(null);
    await deleteDraft(key);
  }

  const repos = new Set(visibleProjects.flatMap(p => p.repositories?.nodes?.map(r => r.nameWithOwner) ?? []));

  // Per-project live fleet counts: a worker belongs to a project when its repo is
  // one of the project's repos (running vs parked = asking/waiting/blocked).
  const fleetByProject = useMemo(() => {
    const m: Record<string, { running: number; paused: number }> = {};
    for (const p of visibleProjects) {
      const projRepos = new Set((p.repositories?.nodes ?? []).map(r => r.nameWithOwner));
      let running = 0, paused = 0;
      for (const w of workers) {
        if (!projRepos.has(w.repo)) continue;
        if (w.status === "running") running++;
        else if (w.status !== "idle") paused++;
      }
      m[p.id] = { running, paused };
    }
    return m;
  }, [visibleProjects, workers]);

  // ── Local drafts (durable on-disk truth ∪ store draft map), dropping anything already published.
  const allDrafts = useMemo<DraftRow[]>(() => {
    const publishedKeys = new Set<string>([
      ...Object.values(projectKeyAlias),
      ...visibleProjects.map(p => sanitizeProjectKey(p.title)),
    ]);
    const byKey = new Map<string, DraftRow>();
    for (const lp of Array.isArray(localProjects) ? localProjects : []) {
      if (!lp?.hasPlan) continue; // skip bare scaffold dirs
      byKey.set(lp.key, { key: lp.key, title: lp.title, pitch: "", sort: lp.updatedAt });
    }
    for (const [key, d] of Object.entries(localDraftProjects)) {
      const ex = byKey.get(key);
      byKey.set(key, { key, title: d.title, pitch: d.pitch, sort: Math.max(ex?.sort ?? 0, d.createdAt) });
    }
    return [...byKey.values()].filter(d => !publishedKeys.has(d.key));
  }, [localProjects, localDraftProjects, projectKeyAlias, visibleProjects]);

  // A draft bound to the blueprint-author lifecycle is an in-progress BLUEPRINT — it belongs in the
  // Blueprints section, not the normal Drafts list (#923 / Projects-tab redesign).
  const isAuthoringKey = useCallback((key: string) => projectBlueprintId[key] === AUTHORING_BLUEPRINT_ID, [projectBlueprintId]);
  const normalDrafts = useMemo(() => allDrafts.filter(d => !isAuthoringKey(d.key)), [allDrafts, isAuthoringKey]);
  const authoringDrafts = useMemo(() => allDrafts.filter(d => isAuthoringKey(d.key)), [allDrafts, isAuthoringKey]);

  // ── Blueprints surfaced here: ALL blueprints — the built-in app templates AND the user's saved
  // library — so a blueprint can be SELECTED for the next project right here (#blueprints), plus any
  // in-progress authoring drafts not yet saved. The saved/published version wins the dedup (by name)
  // over a still-open authoring draft.
  const blueprintItems = useMemo<BpItem[]>(() => {
    const items: BpItem[] = [];
    const seen = new Set<string>();
    for (const b of blueprints) {
      seen.add(b.name.toLowerCase());
      const hasGist = !!b.gist?.id;
      const vis: Visibility = hasGist ? (b.gist?.public ? "public" : "private") : "draft";
      const sortMs = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      items.push({
        id: b.id, kind: "library", name: b.name,
        pitch: b.pitch ?? b.desc ?? "",
        category: b.category ?? "greenfield",
        stages: b.sections.length, sections: b.sections, vis,
        builtIn: b.origin === "built-in",
        gistLabel: hasGist ? prettyGist(b.gist) : undefined,
        updatedLabel: timeAgoMs(sortMs), sort: sortMs,
      });
    }
    for (const d of authoringDrafts) {
      const bp = planAuthoredBlueprint[d.key] as Blueprint | undefined;
      const name = bp?.name ?? d.title;
      if (seen.has(name.toLowerCase())) continue;
      items.push({
        id: "draft:" + d.key, kind: "draft", draftKey: d.key, draftTitle: d.title, draftPitch: d.pitch,
        name, pitch: bp?.pitch ?? bp?.desc ?? d.pitch ?? "",
        category: bp?.category ?? "greenfield",
        stages: bp?.sections?.length ?? 0, sections: bp?.sections ?? [], vis: "draft",
        updatedLabel: timeAgoMs(d.sort), sort: d.sort,
      });
    }
    return items;
  }, [blueprints, authoringDrafts, planAuthoredBlueprint]);

  // ── Search + sort over every list (#… redesign). ───────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const matchP = (p: GhProject) => !q || (p.title + " " + (p.shortDescription ?? "")).toLowerCase().includes(q);
  const matchD = (d: DraftRow) => !q || (d.title + " " + d.pitch).toLowerCase().includes(q);
  const matchB = (b: BpItem) => !q || (b.name + " " + b.pitch).toLowerCase().includes(q);

  // Group the published projects by lifecycle, filtered + sorted (#499 + redesign).
  const grouped = useMemo(() => {
    const cmpP = (a: GhProject, b: GhProject) =>
      sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase())
                      : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    const by: Record<ProjStatus, GhProject[]> = { active: [], shipped: [] };
    for (const p of visibleProjects) { if (matchP(p)) by[projStatus(p)].push(p); }
    (Object.keys(by) as ProjStatus[]).forEach(s => by[s].sort(cmpP));
    return by;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleProjects, sort, q]);

  const fDrafts = useMemo(() => {
    const arr = normalDrafts.filter(matchD);
    arr.sort((a, b) => sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) : b.sort - a.sort);
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalDrafts, sort, q]);

  const fBlueprints = useMemo(() => {
    const arr = blueprintItems.filter(matchB);
    arr.sort((a, b) => sort === "name" ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : b.sort - a.sort);
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprintItems, sort, q]);

  const publishedCount = grouped.active.length + grouped.shipped.length;
  const grandTotal = publishedCount + fDrafts.length + fBlueprints.length;
  // The main (projects) column is empty when there are no projects or drafts; the
  // blueprints rail shows its own empty state independently.
  const projectsEmpty = publishedCount === 0 && fDrafts.length === 0;

  // "open & edit" a blueprint always lands in the project planning page (#…): an in-progress
  // authoring draft resumes its session; a saved library blueprint re-opens an authoring session
  // keyed by its name, seeded with the blueprint so the planner + focused pane edit it in place.
  function openBlueprint(b: BpItem) {
    if (b.kind === "draft" && b.draftKey) {
      reopenDraft({ key: b.draftKey, title: b.draftTitle ?? b.name, pitch: b.draftPitch ?? "" });
      return;
    }
    const full = blueprints.find(x => x.id === b.id);
    const key = sanitizeProjectKey(b.name);
    setProjectBlueprintId(key, AUTHORING_BLUEPRINT_ID);
    if (full) setAuthoredBlueprint(key, full);
    setPlanningTitle(b.name);
    setPlanningContext(b.pitch || "Design a reusable blueprint to publish as a gist.", "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(key, { title: b.name, pitch: b.pitch ?? "", createdAt: Date.now() });
    setPlanningSession(key);
    setProjectsView("planning");
  }
  function deleteBlueprint(b: BpItem) {
    // An in-progress authoring draft is a folder on disk — confirm before destroying it (#1216),
    // same as a normal draft chip. A saved library blueprint is store-only, no confirm needed.
    if (b.kind === "draft" && b.draftKey) {
      setDraftDeleteTarget({ key: b.draftKey, title: b.draftTitle ?? b.name, pitch: b.draftPitch ?? "", sort: b.sort });
    } else removeBlueprint(b.id);
  }

  // The rail "+" authors a NEW blueprint: bind a fresh key to the authoring lifecycle and open the
  // planner seeded for it (the blueprint-author lifecycle), which designs + publishes a gist.
  function startNewBlueprint() {
    const title = bpTitle.trim();
    if (!title) return;
    const key = sanitizeProjectKey(title);
    setProjectBlueprintId(key, AUTHORING_BLUEPRINT_ID);
    setPlanningTitle(title);
    setPlanningContext("Design a reusable blueprint to publish as a gist.", "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(key, { title, pitch: "Design a reusable blueprint.", createdAt: Date.now() });
    setPlanningSession(key);
    setBpNewOpen(false);
    setBpTitle("");
    setProjectsView("planning");
  }

  // ── Import a blueprint from a gist (#blueprints): the only piece kept from the removed
  // Blueprints tab — resolve a gist ref to a previewable blueprint, then add/update it in the
  // library (dedupe by source gist id, #955). Editing happens via "modify in planner".
  const freshSections = (s: BlueprintSection[]): BlueprintSection[] => s.map((x) => ({ ...x, uid: uid("sec") }));
  async function resolveBlueprintImport(ref: string): Promise<PreviewBlueprint> {
    const r = await installFromGist(ref, githubToken);
    if (!r.ok) throw new Error(r.error);
    const bpRes = manifestToBlueprint(r.manifest);
    if (!bpRes.ok) throw new Error(bpRes.error);
    const bp = bpRes.blueprint;
    return {
      name: bp.name, icon: bp.icon ?? bp.name[0]?.toUpperCase() ?? "B", h: bp.h ?? 70,
      sections: bp.sections, blueprint: bp,
      bundled: bundledSkillsFromManifest(r.manifest), gistId: gistIdFromUrl(ref) ?? undefined,
    };
  }
  function importBlueprintPreview(preview: PreviewBlueprint, opts: { updatedAt?: string } = {}) {
    // Reconstitute the share's embedded skills so the blueprint's skill refs resolve once imported.
    if (preview.bundled?.length) installBundledSkills(preview.bundled);
    const base = preview.blueprint;
    const gId = preview.gistId;
    // Dedupe (#955): a gist already in the library updates in place rather than duplicating.
    const existing = gId ? blueprints.find((b) => b.gist?.id === gId) : undefined;
    if (existing) {
      setBlueprintSections(existing.id, freshSections(base?.sections ?? preview.sections));
      updateBlueprintMeta(existing.id, {
        ...(base?.name ? { name: base.name } : {}),
        gist: {
          ...(existing.gist ?? { state: "synced" }), state: "synced", id: gId,
          author: preview.author ?? existing.gist?.author, rev: preview.rev ?? existing.gist?.rev ?? "r1",
          updatedAt: opts.updatedAt ?? existing.gist?.updatedAt, behind: false,
        },
      });
      // Close only the manual paste dialog; the catalog stays open so its rows update live.
      setImportOpen(false);
      return;
    }
    const bp: Blueprint = {
      ...(base ?? { id: "tmp", name: preview.name, desc: "Imported from gist.", sections: preview.sections }),
      icon: preview.icon, h: preview.h, origin: "imported", tags: ["imported"],
      gist: { state: "synced", id: gId, author: preview.author, rev: preview.rev ?? "r1", public: true, updatedAt: opts.updatedAt },
    };
    importBlueprint(bp);
    setImportOpen(false);
  }

  const totalSummary = `${visibleProjects.length} published · ${normalDrafts.length} draft${normalDrafts.length !== 1 ? "s" : ""} · ${blueprintItems.length} blueprint${blueprintItems.length !== 1 ? "s" : ""} · ${repos.size} repo${repos.size !== 1 ? "s" : ""}`;
  const sortBtn = (active: boolean) => ({
    height: 28, padding: "0 11px", border: 0, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5,
    background: active ? "var(--bg-elev2)" : "transparent", color: active ? "var(--fg)" : "var(--fg-dim)",
  } as const);

  return (
    <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", overflow: "hidden" }}>
      {/* ░░ MAIN — projects ░░
          A min-width floor (not 0) so the projects column stays usable in a narrow / half window:
          the shrinkable blueprints rail (below) gives back space first, instead of this column
          collapsing to nothing and the fixed-width rail overflowing the clipped section. */}
      <div style={{ flex: "1 1 0", minWidth: 320, display: "flex", flexDirection: "column" }}>
        {/* fixed header: title · summary · sync/new · new-project form · search+sort */}
        <div style={{ flex: "0 0 auto", padding: "20px 28px 0" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 19, fontWeight: 600, color: "var(--fg)" }}>Projects</h2>
                <span style={{ padding: "1px 7px", borderRadius: 8, fontFamily: "var(--mono)", fontSize: 10, background: "var(--bg-elev2)", color: "var(--fg-muted)", border: "1px solid var(--border-soft)" }}>{publishedCount + fDrafts.length}</span>
              </div>
              <div style={{ color: "var(--fg-muted)", fontSize: 11.5, marginTop: 7, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontFamily: "var(--mono)" }}>
                <span style={{ color: "var(--success)" }}>● github connected</span>
                <span style={{ color: "var(--fg-dim)" }}>·</span>
                <span>{totalSummary}</span>
                {lastSync && (
                  <>
                    <span style={{ color: "var(--fg-dim)" }}>·</span>
                    <span style={{ color: "var(--fg-dim)" }}>last sync {timeAgo(lastSync.toISOString())}</span>
                  </>
                )}
              </div>
            </div>
            <button className="btn ghost" onClick={fetchProjects} disabled={loading}>
              {loading ? "syncing…" : "↻ sync"}
            </button>
            <button ref={newBtnRef} className="btn primary" onClick={() => setNewOpen(o => !o)}>+ New project</button>
          </div>

          {/* new project — inline; click outside to dismiss (the title is kept for next time) */}
          {newOpen && (
            <div ref={newFormRef} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", marginTop: 14,
              background: "var(--bg-panel)", border: "1px solid var(--accent-dim)", borderRadius: 8,
            }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>+ plan</span>
              <input
                autoFocus
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleStartPlanning(); if (e.key === "Escape") setNewOpen(false); }}
                placeholder="project title…"
                style={{
                  flex: 1, minWidth: 0, background: "none", border: "none", outline: "none",
                  fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)",
                }}
              />
              {titleConflict && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)", whiteSpace: "nowrap" }}>⚠ exists</span>
              )}
              <button
                onClick={handleStartPlanning}
                disabled={!titleTrimmed || !!titleConflict}
                className="btn primary"
                style={{ height: 24, fontSize: 10.5, opacity: (titleTrimmed && !titleConflict) ? 1 : 0.4, whiteSpace: "nowrap" }}
              >start planning →</button>
            </div>
          )}

          {/* search + sort */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, paddingBottom: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, height: 30, padding: "0 10px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", flex: "0 1 300px", minWidth: 0 }}>
              <Search size={13} style={{ color: "var(--fg-dim)" }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="search projects & blueprints…"
                style={{ flex: 1, background: "none", border: "none", outline: "none", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>sort</span>
              <div style={{ display: "flex", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
                <button onClick={() => setSort("recency")} style={sortBtn(sort === "recency")}>recency</button>
                <span style={{ width: 1, background: "var(--border-soft)" }} />
                <button onClick={() => setSort("name")} style={sortBtn(sort === "name")}>name</button>
              </div>
            </div>
            {q && <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{grandTotal} match{grandTotal !== 1 ? "es" : ""}</span>}
          </div>
        </div>

        {/* scroll area: errors · drafts chips · active/shipped groups · empty */}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 28px 28px" }}>
          {error && (
            <div style={{
              padding: "12px 16px", borderRadius: 6, marginBottom: 16,
              background: "color-mix(in oklch, var(--danger), transparent 88%)",
              border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
              fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
            }}>
              {error.includes("read:project")
                ? 'This token lacks the "read:project" scope. Re-authenticate in Settings → GitHub with project access.'
                : error}
            </div>
          )}

          {loading && visibleProjects.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
              Loading projects…
            </div>
          )}

          {draftError && (
            <div style={{
              padding: "8px 12px", borderRadius: "var(--r-md)", marginBottom: 12, fontFamily: "var(--mono)", fontSize: 11,
              color: "var(--danger)", background: "color-mix(in oklch, var(--danger), transparent 88%)",
              border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)",
            }}>{draftError}</div>
          )}

          {/* drafts — compact chips (click = resume · ✕ = delete) */}
          {fDrafts.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 20, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".08em", whiteSpace: "nowrap" }}>
                {fDrafts.length} draft{fDrafts.length !== 1 ? "s" : ""}
              </span>
              {fDrafts.map(d => (
                <span
                  key={d.key}
                  onClick={() => reopenDraft(d)}
                  title={d.pitch || undefined}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 12px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: 7, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", cursor: "pointer" }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--accent)", flexShrink: 0 }} />
                  {d.title}
                  <span style={{ color: "var(--fg-dim)" }}>{timeAgoMs(d.sort)}</span>
                  <span
                    onClick={e => { e.stopPropagation(); setDraftDeleteTarget(d); }}
                    title="delete draft"
                    style={{ color: "var(--fg-dim)", cursor: "pointer", paddingLeft: 2 }}
                  >✕</span>
                </span>
              ))}
            </div>
          )}

          {/* published projects, grouped by lifecycle */}
          {(["active", "shipped"] as ProjStatus[]).map(status => {
            const items = grouped[status];
            if (items.length === 0) return null;
            return (
              <div key={status} style={{ marginBottom: 22 }}>
                <GroupHeader label={STATUS_META[status].label} count={items.length} dot={STATUS_META[status].dot} />
                <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "visible", opacity: status === "shipped" ? 0.82 : 1 }}>
                  {items.map((p, i) => (
                    <div key={p.id} style={{ borderTop: i ? "1px solid var(--border-soft)" : "none" }}>
                      <ProjectRow
                        p={p}
                        running={fleetByProject[p.id]?.running ?? 0}
                        paused={fleetByProject[p.id]?.paused ?? 0}
                        onPlan={handleEditPlan}
                        onBoard={handleOpenGithubBoard}
                        onDelete={setDeleteTarget}
                        menuOpenId={menuOpenId}
                        setMenuOpenId={setMenuOpenId}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* empty (main column only — the rail has its own) */}
          {!loading && projectsEmpty && (
            q ? (
              <div style={{ textAlign: "center", padding: "48px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
                No projects match “{query}”.
              </div>
            ) : !error && (
              <div style={{ textAlign: "center", padding: "48px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
                Nothing here yet. Start a plan with <b style={{ color: "var(--fg-muted)" }}>+ New project</b>.
              </div>
            )
          )}
        </div>
      </div>

      {/* ░░ RAIL — blueprints ░░ (drag-resizable; wider default to seat each card's gate-row, #blueprints)
          Shrinkable (`0 1`, not `0 0`) with a min floor so a narrow / half window reclaims width from
          the rail instead of it overflowing the clipped section and getting cut off. `overflow:hidden`
          keeps its cards from forcing it back wide. */}
      <div className="resize-x" {...blueprintsRail.handleProps} title="Drag to resize" />
      <div style={{ flex: `0 1 ${blueprintsRail.size}px`, minWidth: 240, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg-panel)", borderLeft: "1px solid var(--border-soft)" }}>
        <div style={{ flex: "0 0 auto", padding: "20px 18px 14px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ width: 23, height: 23, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)" }}>
              <Layers size={13} />
            </span>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>Blueprints</h3>
            <span style={{ padding: "0 6px", borderRadius: 8, fontFamily: "var(--mono)", fontSize: 9.5, background: "var(--bg-elev2)", color: "var(--fg-muted)", border: "1px solid var(--border-soft)" }}>{fBlueprints.length}</span>
            <span style={{ flex: 1 }} />
            <button
              className="btn ghost"
              title="Import a blueprint from a gist"
              onClick={() => setCatalogOpen(true)}
              style={{ height: 24, width: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            ><Download size={12} /></button>
            <button
              className="btn ghost"
              title="Author a new blueprint"
              onClick={() => { setBpNewOpen(o => !o); setBpTitle(""); }}
              style={{ height: 24, width: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            >+</button>
          </div>
          {bpNewOpen && (
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
              <input
                autoFocus
                value={bpTitle}
                onChange={e => setBpTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") startNewBlueprint(); if (e.key === "Escape") { setBpNewOpen(false); setBpTitle(""); } }}
                placeholder="blueprint name…"
                style={{ flex: 1, minWidth: 0, height: 26, padding: "0 8px", background: "var(--bg-canvas)", border: "1px solid var(--accent-dim)", borderRadius: 6, outline: "none", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}
              />
              <button
                className="btn primary"
                onClick={startNewBlueprint}
                disabled={!bpTitle.trim()}
                style={{ height: 26, fontSize: 10, whiteSpace: "nowrap", opacity: bpTitle.trim() ? 1 : 0.4 }}
              >author →</button>
            </div>
          )}
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 9, lineHeight: 1.5 }}>reusable plan templates · published as gists</div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 9 }}>
          {fBlueprints.length === 0 ? (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.6, padding: "6px 2px" }}>
              {q ? "No blueprints match your search." : <>No blueprints yet. Press <b style={{ color: "var(--fg-muted)" }}>+</b> to author one.</>}
            </div>
          ) : (
            fBlueprints.map(b => (
              <BlueprintCard key={b.id} b={b} onUse={setActiveBlueprint} onOpen={openBlueprint} onDelete={deleteBlueprint} activeId={activeBlueprintId} menuOpenId={menuOpenId} setMenuOpenId={setMenuOpenId} />
            ))
          )}
        </div>
      </div>

      {/* Import a blueprint from a gist (moved here from the removed Blueprints tab) */}
      {catalogOpen && (
        <BlueprintImportModal
          source={githubUser?.login ?? DEFAULT_GIST_SOURCE}
          token={githubToken}
          importedById={Object.fromEntries(blueprints.filter(b => b.gist?.id).map(b => [b.gist!.id!, { updatedAt: b.gist!.updatedAt }]))}
          onImport={(gistId, updatedAt) => resolveBlueprintImport(gistId).then(p => importBlueprintPreview(p, { updatedAt }))}
          onPreview={resolveBlueprintImport}
          onManualImport={() => { setCatalogOpen(false); setImportOpen(true); }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)} onResolve={resolveBlueprintImport} onImport={importBlueprintPreview} />
      )}

      {/* Published-project delete — Keep vs Delete (#1216). A published project is a real shipped app
          on GitHub (board + milestones + issues + repos), so removing it from base-studio-code must
          NOT silently tear down that structure. Keep (default/safe) = local cleanup only; Delete
          everything (deliberate, secondary) layers the GitHub project DELETE_MUTATION on top, behind
          an explicit second confirm. */}
      {deleteTarget && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 200,
          background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={e => { if (e.target === e.currentTarget && !deleting) closeDeleteModal(); }}>
          <div style={{
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-lg)", padding: "24px 28px", width: 460, maxWidth: "90vw",
          }}>
            {!confirmDeleteAll ? (
              <>
                <h3 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg)" }}>
                  Remove “{deleteTarget.title}”?
                </h3>
                <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
                  This project is published to GitHub. Choose whether to keep the shipped app on GitHub
                  or delete everything.
                </p>
                {deleteError && (
                  <div style={{
                    padding: "8px 12px", borderRadius: 4, marginBottom: 14,
                    background: "color-mix(in oklch, var(--danger), transparent 88%)",
                    border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
                    fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
                  }}>
                    {deleteError}
                  </div>
                )}
                {/* Keep — the default / safe primary action. */}
                <button
                  className="btn primary"
                  onClick={handleDeleteKeep}
                  disabled={deleting}
                  autoFocus
                  style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", marginBottom: 10 }}
                >
                  <span style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>Keep the app — stop tracking it here</span>
                  <span style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5, fontFamily: "var(--mono)" }}>
                    Removes the local copy only. Your GitHub project board, milestones, issues, and repos stay intact.
                  </span>
                </button>
                {/* Delete everything — secondary; arms the explicit destructive confirm (NOT the default). */}
                <button
                  className="btn ghost"
                  onClick={() => { setConfirmDeleteAll(true); setDeleteError(null); }}
                  disabled={deleting}
                  style={{ width: "100%", textAlign: "left", padding: "11px 14px", height: "auto", display: "block", color: "var(--danger)", marginBottom: 16 }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                    <Trash2 size={12} /> Delete everything
                  </span>
                  <span style={{ display: "block", fontSize: 10.5, opacity: 0.85, marginTop: 3, lineHeight: 1.5, fontFamily: "var(--mono)" }}>
                    Removes the local copy AND deletes the GitHub project board. (Your repos and their code are not deleted.)
                  </span>
                </button>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button className="btn ghost" onClick={closeDeleteModal} disabled={deleting}>cancel</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 14, color: "var(--danger)" }}>
                  Delete everything?
                </h3>
                <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
                  This permanently deletes the <b style={{ color: "var(--fg)" }}>GitHub project board</b> for{" "}
                  <b style={{ color: "var(--fg)" }}>{deleteTarget.title}</b> (its milestones and issue cards) and
                  removes the local copy. <b style={{ color: "var(--fg)" }}>Your repositories and their code are not deleted</b> —
                  only the project board is.
                </p>
                {deleteError && (
                  <div style={{
                    padding: "8px 12px", borderRadius: 4, marginBottom: 14,
                    background: "color-mix(in oklch, var(--danger), transparent 88%)",
                    border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
                    fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
                  }}>
                    {deleteError}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    className="btn ghost"
                    onClick={() => { setConfirmDeleteAll(false); setDeleteError(null); }}
                    disabled={deleting}
                  >back</button>
                  <button
                    className="btn danger"
                    onClick={handleDeleteEverything}
                    disabled={deleting}
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <Trash2 size={12} />
                    {deleting ? "deleting…" : "delete everything"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Draft delete confirmation (#1216) — drafts destroy an on-disk folder, so an accidental ✕
          must not delete instantly. */}
      {draftDeleteTarget && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 200,
          background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={e => { if (e.target === e.currentTarget) setDraftDeleteTarget(null); }}>
          <div style={{
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-lg)", padding: "24px 28px", width: 420, maxWidth: "90vw",
          }}>
            <h3 style={{ margin: "0 0 8px", fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg)" }}>
              Delete draft?
            </h3>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
              <b style={{ color: "var(--fg)" }}>{draftDeleteTarget.title}</b> and its local planning folder
              will be permanently deleted. This draft was never published to GitHub, so there's nothing on
              GitHub to remove.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setDraftDeleteTarget(null)}>cancel</button>
              <button
                className="btn danger"
                onClick={confirmDeleteDraft}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <Trash2 size={12} /> delete draft
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
