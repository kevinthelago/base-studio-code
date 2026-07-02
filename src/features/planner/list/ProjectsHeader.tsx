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
import { TabBar, type TabItem } from "@/app/chrome/TabBar";
import { usePageTabs } from "@/shared/hooks/usePageTabs";

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
                    style={{
                      padding: "1px 6px", borderRadius: 3,
                      background: "var(--bg-elev)", border: "1px solid var(--border)",
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
            style={{
              padding: "1px 8px", borderRadius: 3,
              background: "var(--bg-elev)", border: "1px solid var(--border)",
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
                    style={{
                      padding: "1px 6px", borderRadius: 3,
                      background: "var(--bg-elev)", border: "1px solid var(--border)",
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
    setProjectsView, setPlanningContext, setPlanningSession, projectKeyAlias,
    setWorkspace, githubBoardTab, setGithubBoardTab, closeGithubBoard,
  } = useAppStore();
  const { tabs: boardTabs, activeId: boardActive, select: boardSelect, reorder: boardReorder, tearOff: boardTearOff } =
    usePageTabs("github-board", GITHUB_BOARD_TABS,
      { activeId: githubBoardTab, setActive: (id) => setGithubBoardTab(id as GithubTab) });

  function handlePlan() {
    setPlanningContext(
      `I want to flesh out an existing GitHub Project #${project.number} called "${project.name}"${project.repo ? ` in ${project.repo}` : ""}. Help me define a clear goal, scope, tech stack, phases with milestones, and key risks. Then we'll publish milestones and tracking issues.`,
      project.repo,
    );
    // Resolve the session key through the node-id alias set at publish (#1741): a project minted
    // with a stable id lives under that id on disk, so reopening it from the board keys to
    // `projectKeyAlias[project.id]`. Grandfathered/title-keyed projects have no alias, so the
    // fallback keeps their existing title-keyed behavior. The node id stays in activeProjectId.
    setPlanningSession(projectKeyAlias[project.id] ?? project.name);
    // Planning lives on the Projects page; from the GitHub board, jump there.
    setWorkspace("projects");
    setProjectsView("planning");
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
              <Box as="span" className="mono" style={{
                padding: "1px 6px", borderRadius: 3,
                fontSize: 9.5, color: "var(--info)",
                background: "color-mix(in oklch, var(--info), transparent 88%)",
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
    </>
  );
}
