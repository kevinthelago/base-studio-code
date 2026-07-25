import { useState, useEffect, useRef } from "react";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { Button } from "@/shared/ui/controls/Button";
import { Chip } from "@/shared/ui/data/Chip";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { projectRepoCwd } from "@/shared/lib/core/projectPaths";
import { TabBar, type TabItem } from "@/shared/ui/layouts/TabBar";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { useReopenProject } from "./ReopenProjectModal";
import type { LocalProjectLite } from "./drafts";

export interface ActiveProjectInfo {
  id: string;
  number: number;
  name: string;
  repo: string;
  repos: string[];
  description: string;
}

// The project header lives on the GitHub page (#498/#499): the published board
// sub-tabs (board · roadmap · issues · insights), a back-to-portfolio link, and a
// "plan →" jump to the planning session on the Projects page.
type GithubTab = "board" | "roadmap" | "issues" | "insights";
const GITHUB_BOARD_TABS: TabItem[] = [
  { id: "board",    label: "Board",    hint: "kanban · per column" },
  { id: "roadmap",  label: "Roadmap",  hint: "milestones over time" },
  { id: "issues",   label: "Issues",   hint: "flat list · filter & sort" },
  { id: "insights", label: "Insights", hint: "velocity · burndown" },
];

interface ProjectsHeaderProps {
  project: ActiveProjectInfo;
}

function RepoResolverStrip({ project }: { project: ActiveProjectInfo }) {
  const { projectLocalRepos, bscBaseDir } = useAppStore();
  const clonedNames = projectLocalRepos[project.id] ?? [];
  const [cloning, setCloning]     = useState<Set<string>>(new Set());
  const [cloneErrors, setCloneErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded]   = useState(false);
  const cloningRef = useRef<Set<string>>(new Set());

  const multi = project.repos.length > 1;

  // Auto-clone every linked repo into the app-managed directory on first view.
  useEffect(() => {
    if (!project.id) return;
    const currentCloned = new Set(useAppStore.getState().projectLocalRepos[project.id] ?? []);
    const unresolved = project.repos.filter(
      r => !currentCloned.has(r) && !cloningRef.current.has(r)
    );
    for (const fullName of unresolved) {
      cloningRef.current.add(fullName);
      setCloning(s => new Set([...s, fullName]));
      invoke<string>("clone_repo", { project: project.name, fullName })
        .then(() => {
          useAppStore.getState().addProjectRepo(project.id, fullName);
        })
        .catch(e => setCloneErrors(prev => ({ ...prev, [fullName]: String(e) })))
        .finally(() => {
          cloningRef.current.delete(fullName);
          setCloning(s => { const n = new Set(s); n.delete(fullName); return n; });
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function handleClone(fullName: string) {
    setCloning((s) => new Set([...s, fullName]));
    setCloneErrors((e) => { const n = { ...e }; delete n[fullName]; return n; });
    try {
      await invoke<string>("clone_repo", { project: project.name, fullName });
      useAppStore.getState().addProjectRepo(project.id, fullName);
    } catch (e) {
      setCloneErrors((prev) => ({ ...prev, [fullName]: String(e) }));
    } finally {
      setCloning((s) => { const n = new Set(s); n.delete(fullName); return n; });
    }
  }

  if (project.repos.length === 0) return null;

  const resolvedCount  = project.repos.filter(r => clonedNames.includes(r)).length;
  const failedRepos    = project.repos.filter(r => !!cloneErrors[r] && !cloning.has(r));

  return (
    <Box className="mono" style={{
      padding: "5px 24px 0",
      fontSize: 10.5,
    }}>
      {/* Summary row — always visible */}
      <Row gap={10}>
        <Text tone="dim">repos</Text>

        {multi ? (
          // eslint-disable-next-line no-restricted-syntax -- bespoke borderless disclosure toggle (not a .btn-family button)
          <button
            onClick={() => setExpanded(e => !e)}
            className="mono"
            style={{
              background: "none", border: "none", padding: 0, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 10.5, color: "var(--fg-muted)",
            }}
          >
            <Box as="span" style={{
              display: "inline-block", fontSize: 8, color: "var(--fg-dim)",
              transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s",
            }}>▼</Box>
            <Box as="span">
              {project.repos.length} repositories
              {resolvedCount > 0 && (
                <Text tone="success"> · {resolvedCount} cloned</Text>
              )}
              {cloning.size > 0 && (
                <Text tone="accent"> · cloning…</Text>
              )}
            </Box>
          </button>
        ) : (
          (() => {
            const fullName  = project.repos[0];
            const isCloned  = clonedNames.includes(fullName);
            const isCloning = cloning.has(fullName);
            const err       = cloneErrors[fullName];
            const localPath = projectRepoCwd(bscBaseDir, project.name, fullName, !!project.id);
            return (
              <Row gap={5}>
                <Text tone="muted">{fullName}</Text>
                {isCloned ? (
                  <Text tone="success" size={10} title={localPath}>
                    ● {fullName.split("/")[1]}
                  </Text>
                ) : isCloning ? (
                  <Text tone="accent">cloning…</Text>
                ) : (
                  <Box as="span"
                    onClick={() => handleClone(fullName)}
                    pad={[1, 6]} bg="var(--bg-elev)" border radius={3} style={{
                      color: err ? "var(--danger)" : "var(--fg-muted)",
                      cursor: "pointer", fontSize: 10,
                    }}
                  >{err ? "retry clone" : "clone →"}</Box>
                )}
              </Row>
            );
          })()
        )}

        {failedRepos.length > 0 && (
          <Box as="span"
            onClick={() => failedRepos.forEach(r => handleClone(r))}
            className="mono"
            pad={[1, 8]} bg="var(--bg-elev)" border radius={3} style={{
              color: "var(--danger)", cursor: "pointer", fontSize: 10,
            }}
          >retry failed →</Box>
        )}
      </Row>

      {/* Expanded repo list — multi only */}
      {multi && expanded && (
        <Stack gap={5} style={{
          marginTop: 6, paddingLeft: 16,
          borderLeft: "2px solid var(--border-soft)",
        }}>
          {project.repos.map((fullName) => {
            const isCloned  = clonedNames.includes(fullName);
            const isCloning = cloning.has(fullName);
            const err       = cloneErrors[fullName];
            const localPath = projectRepoCwd(bscBaseDir, project.name, fullName, !!project.id);
            return (
              <Row key={fullName} gap={8}>
                <Text tone="muted">{fullName}</Text>
                {isCloned ? (
                  <Text tone="success" size={10} title={localPath}>
                    ● {fullName.split("/")[1]}
                  </Text>
                ) : isCloning ? (
                  <Text tone="accent">cloning…</Text>
                ) : (
                  <Box as="span"
                    onClick={() => handleClone(fullName)}
                    pad={[1, 6]} bg="var(--bg-elev)" border radius={3} style={{
                      color: err ? "var(--danger)" : "var(--fg-muted)",
                      cursor: "pointer", fontSize: 10,
                    }}
                  >{err ? "retry clone" : "clone →"}</Box>
                )}
              </Row>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}

export function ProjectsHeader({ project }: ProjectsHeaderProps) {
  const {
    setProjectsView, navigate, setPlanningContext, setPlanningSession,
    githubBoardTab, setGithubBoardTab, closeGithubBoard,
  } = useAppStore();
  const { tabs: boardTabs, activeId: boardActive, select: boardSelect, reorder: boardReorder, tearOff: boardTearOff } =
    usePageTabs("github-board", GITHUB_BOARD_TABS,
      { activeId: githubBoardTab, setActive: (id) => setGithubBoardTab(id as GithubTab) });

  // Enter the planning session under a settled key (#2409): the key DERIVES from the project's
  // name (`projectSlug`), never from a node-id alias — recovery is derivation, not lookup. The
  // node id stays in activeProjectId for API calls only.
  const reopen = useReopenProject<ActiveProjectInfo>((proj, key) => {
    setPlanningContext(
      `I want to flesh out an existing GitHub Project #${proj.number} called "${proj.name}"${proj.repo ? ` in ${proj.repo}` : ""}. Help me define a clear goal, scope, tech stack, phases with milestones, and key risks. Then we'll publish milestones and tracking issues.`,
      proj.repo,
    );
    setPlanningSession(key);
    // Planning lives on the Projects page; from the GitHub board, jump there — and onto the `projects`
    // page MODE, else the planning view is hidden behind whatever mode (designs/teams/…) was active
    // (#3598). One `navigate` sets the workspace + page together so the mode can't be forgotten (#3602).
    navigate({ workspace: "projects", page: "projects" });
    setProjectsView("planning");
  });

  async function handlePlan() {
    // Scan the on-disk hubs so the reopen flow can derive (or, on a mismatch, link) the project's
    // local hub (#2409). A failed scan degrades to "no candidates" → open under the derived key.
    const locals = await invoke<LocalProjectLite[]>("list_local_projects").catch(() => [] as LocalProjectLite[]);
    reopen.begin(project, project.name, Array.isArray(locals) ? locals : []);
  }

  return (
    <>
      <Row align="start" gap={14} style={{ padding: "14px 24px 0 12px" }}>
        <Box style={{ flex: 1 }}>
          <Row gap={10}>
            <BackButton variant="icon" onClick={closeGithubBoard} aria-label="Back to portfolio" />
            <Text mono size={10} tone="dim">#{project.number}</Text>
            <Text as="h2" mono size={18} weight={600} style={{ margin: 0 }}>{project.name}</Text>
            {project.repo && <Chip>{project.repo}</Chip>}
            {project.number > 0 && (
              <Box as="span" className="mono" pad={[1, 6]} bg="color-mix(in oklch, var(--info), transparent 88%)" radius={3} style={{
                fontSize: 9.5, color: "var(--info)",
                border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
              }}>⎇ synced w/ {project.repo}/projects/{project.number}</Box>
            )}
          </Row>
          {project.description && (
            <Text as="div" tone="muted" size={12} style={{ marginTop: 4 }}>{project.description}</Text>
          )}
        </Box>
        <Row gap={8}>
          <Button
            variant="primary"
            className="mono"
            onClick={handlePlan}
            style={{ fontSize: 11 }}
          >⌘ plan →</Button>
        </Row>
      </Row>

      <RepoResolverStrip project={project} />

      <Box style={{ marginTop: 8 }}>
        <TabBar
          tabs={boardTabs}
          activeId={boardActive}
          onSelect={boardSelect}
          onReorder={boardReorder}
          onTearOff={boardTearOff}
        />
      </Box>

      {/* Reopen-mismatch modal (#2409): link an existing local hub onto the name key, or start fresh. */}
      {reopen.modal}
    </>
  );
}
