import { useState, useRef } from "react";
import { useClickOutside } from "@/shared/hooks/useClickOutside";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { Search } from "lucide-react";
import { useAppStore } from "@/store";
import { projectSlug } from "@/shared/lib/core/projectPaths";
import { timeAgo } from "@/shared/lib/core/format";
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { DEFAULT_BLUEPRINT_ID } from "../../stages/blueprints";
import { addDbProject } from "../projectsDbBridge";
import type { GhProject } from "./publishedModel";
import type { LocalProjectLite } from "../drafts";

interface PublishedHeaderProps {
  visibleProjects: GhProject[];
  /** On-disk local hubs — a new name that slugs onto an existing hub key is a collision too (#2409). */
  localProjects: LocalProjectLite[];
  /** Published count (active + shipped) + local drafts, for the header badge. */
  publishedAndDrafts: number;
  /** Cross-section summary line ("N published · M drafts · K blueprints · R repos"). */
  totalSummary: string;
  lastSync: Date | null;
  loading: boolean;
  /** Re-fetch the published boards; `force: true` (the manual ↻ sync) bypasses the TTL cache (#2447). */
  fetchProjects: (opts?: { force?: boolean }) => void;
  query: string;
  setQuery: (s: string) => void;
  sort: "recency" | "name";
  setSort: (s: "recency" | "name") => void;
  /** Total matches across all three lists (drives the "N matches" pill while searching). */
  grandTotal: number;
  /** Open a clashing PUBLISHED project (the collision modal's "open existing", #2409). */
  openExistingPublished: (p: GhProject) => void;
  /** Open a clashing LOCAL project/draft (the collision modal's "open existing", #2409). */
  openExistingLocal: (lp: LocalProjectLite) => void;
}

/** The fixed page header: title · summary · sync/new · new-project form · search+sort.
 *  Owns the new-project form (title input + start-planning flow) — the one place the header
 *  reaches the store to mint a fresh draft. */
export function PublishedHeader({
  visibleProjects, localProjects, publishedAndDrafts, totalSummary, lastSync, loading, fetchProjects,
  query, setQuery, sort, setSort, grandTotal, openExistingPublished, openExistingLocal,
}: PublishedHeaderProps) {
  const {
    setProjectsView, setActiveProjectMeta, setPlanningContext, setPlanningTitle, setPlanningSession,
    addDraftProject, setProjectBlueprintId, activeBlueprintId, blueprints,
  } = useAppStore();
  const [title, setTitle]         = useState("");
  const [newOpen, setNewOpen]     = useState(false);
  // The existing project a would-be new name collides with (#2409) — a published board or a local
  // hub/draft. When set, the collision modal is up: the name IS the identity, so we never silently
  // fork (or adopt) a second hub for it. The modal resolves it: open the existing project, or pick
  // a different name.
  const [collision, setCollision] = useState<{ title: string; published?: GhProject; local?: LocalProjectLite } | null>(null);
  // New-project form: dismiss by clicking outside (no cancel button). The typed title is KEPT in
  // state on dismiss, so a mistaken click outside doesn't lose it — reopening restores what was typed.
  const newFormRef = useRef<HTMLDivElement>(null);
  const newBtnRef  = useRef<HTMLButtonElement>(null);

  // Dismiss the new-project form on an outside click (#…) — closes without clearing the title, so a
  // stray click keeps what was typed. The trigger button is excluded so it keeps toggling the form.
  useClickOutside(newFormRef, () => setNewOpen(false), newOpen, newBtnRef);

  const titleTrimmed = title.trim();

  function handleStartPlanning() {
    if (!titleTrimmed) return;
    // The project's KEY is a readable slug of its name (#2409) — the single identity that names the hub,
    // plan.db, worktrees, pane ids, and the 1:1 GitHub project. Two names that slug to the SAME key would
    // share a hub, so a collision opens the modal instead of silently forking (the class of bug that made
    // "video game" recover the wrong plan). Match on the slug so "Video Game" and "video-game" also clash,
    // against BOTH the published boards and the on-disk local hubs.
    const draftKey = projectSlug(titleTrimmed);
    const published = visibleProjects.find((p) => projectSlug(p.title) === draftKey);
    const local = (Array.isArray(localProjects) ? localProjects : []).find((lp) => lp.key === draftKey);
    if (published || local) { setCollision({ title: (published?.title ?? local?.title) || titleTrimmed, published, local }); return; }
    setPlanningTitle(titleTrimmed);
    // The pitch is described in the planning conversation now — creation only needs the title (#…).
    setPlanningContext("", "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(draftKey, { title: titleTrimmed, pitch: "", createdAt: Date.now() });
    // Bind the blueprint AT CREATION (#988) — the explicit consent point — capturing whatever's
    // selected now. Opening the project later never adopts the (freely-changing) global selection,
    // so its blueprint can't switch without the user's intent.
    const bpId = activeBlueprintId || DEFAULT_BLUEPRINT_ID;
    // Durable dual-write (#2995): mirror the draft into the projects DB so it survives a restart even
    // if the `localDraftProjects` cache misses. Fire-and-forget; degrades silently. KEEPS the store write.
    void addDbProject({ key: draftKey, title: titleTrimmed, pitch: "", blueprint: bpId, category: blueprints.find((b) => b.id === bpId)?.category ?? null, state: "drafted" });
    // Persist the user's title into the hub (`projects/<key>/.title`) so the on-disk name is their
    // input from the start — not a title fabricated from the opaque key when `goal.md` isn't authored
    // yet (which then leaked into the session skill-group name, GitHub structure, and tab labels).
    fireInvoke("set_project_title", { projectKey: draftKey, title: titleTrimmed });
    setProjectBlueprintId(draftKey, bpId);
    setPlanningSession(draftKey);
    setNewOpen(false);
    setTitle("");
    setProjectsView("planning");
  }

  const q = query.trim().toLowerCase();
  const sortBtn = (active: boolean) => ({
    height: 28, padding: "0 11px", border: 0, cursor: "pointer", fontSize: 10.5,
    background: active ? "var(--bg-elev2)" : "transparent", color: active ? "var(--fg)" : "var(--fg-dim)",
  } as const);

  return (
    // fixed header: title · summary · sync/new · new-project form · search+sort
    <Box style={{ flex: "0 0 auto", padding: "20px 28px 0" }}>
      <Row align="start" gap={14}>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Row gap={10}>
            <Text as="h2" mono size={19} weight={600} style={{ margin: 0, color: "var(--fg)" }}>Projects</Text>
            <Box as="span" className="mono" pad={[1, 7]} bg="var(--bg-elev2)" border="soft" radius={8} style={{ fontSize: 10, color: "var(--fg-muted)"}}>{publishedAndDrafts}</Box>
          </Row>
          <Row className="mono" gap={8} wrap style={{ color: "var(--fg-muted)", fontSize: 11.5, marginTop: 7 }}>
            <Text tone="success">● github connected</Text>
            <Text tone="dim">·</Text>
            <Box as="span">{totalSummary}</Box>
            {lastSync && (
              <>
                <Text tone="dim">·</Text>
                <Text tone="dim">last sync {timeAgo(lastSync.toISOString())}</Text>
              </>
            )}
          </Row>
        </Box>
        <Button variant="ghost" onClick={() => fetchProjects({ force: true })} disabled={loading}>
          {loading ? "syncing…" : "↻ sync"}
        </Button>
        {/* eslint-disable-next-line no-restricted-syntax -- needs a real DOM ref for click-outside excludeRef (Button isn't forwardRef) */}
        <button ref={newBtnRef} className="btn primary" onClick={() => setNewOpen(o => !o)}>+ New project</button>
      </Row>

      {/* new project — inline; click outside to dismiss (the title is kept for next time) */}
      {newOpen && (
        // eslint-disable-next-line no-restricted-syntax -- click-outside form needs a real DOM ref (Box isn't forwardRef)
        <div ref={newFormRef} style={{
          display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", marginTop: 14,
          background: "var(--bg-panel)", border: "1px solid var(--accent-dim)", borderRadius: 8,
        }}>
          <Text mono size={10} tone="dim" style={{ whiteSpace: "nowrap" }}>+ plan</Text>
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke borderless inline title input (not a Field stack) */}
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: focus the plan-title field when the inline form opens
            autoFocus
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleStartPlanning(); if (e.key === "Escape") setNewOpen(false); }}
            placeholder="project title…"
            className="mono"
            style={{
              flex: 1, minWidth: 0, background: "none", border: "none", outline: "none",
              fontSize: 12, color: "var(--fg)",
            }}
          />
          <Button
            onClick={handleStartPlanning}
            disabled={!titleTrimmed}
            variant="primary"
            style={{ height: 24, fontSize: 10.5, opacity: titleTrimmed ? 1 : 0.4, whiteSpace: "nowrap" }}
          >start planning →</Button>
        </div>
      )}

      {/* Name-collision modal (#2409) — the name is the project's identity, so a would-be duplicate is
          resolved here (open the existing project, or pick a different name) rather than silently
          forking a second hub. */}
      {collision && (
        <Dialog
          title="That name's already taken"
          onDismiss={() => setCollision(null)}
          actions={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  const c = collision;
                  setCollision(null);
                  setNewOpen(false);
                  setTitle("");
                  if (c.published) openExistingPublished(c.published);
                  else if (c.local) openExistingLocal(c.local);
                }}
              >Open the existing project</Button>
              <Button variant="primary" onClick={() => setCollision(null)}>Choose a different name</Button>
            </>
          }
        >
          A project named <Text as="span" mono style={{ color: "var(--fg)" }}>“{collision.title}”</Text> already
          exists — the name IS the project (it names its files, sessions, and GitHub project), so two can't share it.
          Open it, or pick a different name to continue.
        </Dialog>
      )}

      {/* search + sort */}
      <Row gap={12} wrap style={{ marginTop: 16, paddingBottom: 16 }}>
        <Row gap={8} style={{ height: 30, padding: "0 10px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", flex: "0 1 300px", minWidth: 0 }}>
          <Search size={13} style={{ color: "var(--fg-dim)" }} />
          {/* eslint-disable-next-line no-restricted-syntax -- search-in-toolbar inline input (borderless, not a Field stack) */}
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="search projects & blueprints…"
            className="mono"
            style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 11, color: "var(--fg)" }}
          />
        </Row>
        <Row gap={7}>
          <Text mono size={10} tone="dim">sort</Text>
          <Row align="stretch" style={{ background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline sort-segment button (styled via sortBtn helper, not a .btn) */}
            <button className="mono" onClick={() => setSort("recency")} style={sortBtn(sort === "recency")}>recency</button>
            <Box as="span" bg="var(--border-soft)" style={{ width: 1}} />
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline sort-segment button (styled via sortBtn helper, not a .btn) */}
            <button className="mono" onClick={() => setSort("name")} style={sortBtn(sort === "name")}>name</button>
          </Row>
        </Row>
        {q && <Text mono size={10} tone="dim" style={{ marginLeft: "auto" }}>{grandTotal} match{grandTotal !== 1 ? "es" : ""}</Text>}
      </Row>
    </Box>
  );
}
