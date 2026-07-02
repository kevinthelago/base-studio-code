import { useAppStore } from "@/store";
import { Chip } from "@/shared/ui/data/Chip";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { type TabItem } from "@/app/chrome/TabBar";
import { Screen } from "@/app/chrome/Screen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { GitHubEmpty } from "./Empty";
import { GitHubSummary } from "./GitHubSummary";
import { ProjectsSummary } from "@/features/planner/list/ProjectsSummary";
import { ProjectBoard } from "@/features/planner/github/ProjectBoard";
import { Roadmap } from "@/features/planner/github/Roadmap";
import { Issues } from "@/features/planner/github/Issues";
import { Insights } from "@/features/planner/github/Insights";
import { Pulse } from "./Pulse";

const GITHUB_TABS: TabItem[] = [
  { id: "summary", label: "Summary", hint: "all repos · analytics" },
  { id: "projects", label: "Projects", hint: "portfolio · analytics" },
  { id: "repos", label: "Repositories", hint: "progress · changes · CI" },
];

function langTag(lang: string | null): string {
  if (!lang) return "—";
  const map: Record<string, string> = { TypeScript: "ts", JavaScript: "js", Rust: "rs", Python: "py", Go: "go", Java: "java" };
  return map[lang] ?? lang.toLowerCase().slice(0, 4);
}

export function GitHubWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  const {
    githubConnected,
    githubRepos, activeRepoName, setActiveRepo,
    disconnectGithub,
    githubBoardOpen, githubBoardTab,
    githubTab, setGithubTab,
  } = useAppStore();

  // Drag-resizable repo sidebar (mirrors the planning splitters).
  const sidebar = useDragResize({ initial: 220, min: 160, max: 460, axis: "x" });
  // Store-controlled active tab so other screens can deep-link to it (#499).
  const { tabs: ghTabs, activeId, select, reorder, tearOff } =
    usePageTabs("github", GITHUB_TABS, { activeId: githubTab, setActive: setGithubTab });
  const mode = pageOverride ?? activeId;

  if (!githubConnected) {
    return (
      <Stack style={{ flex: 1, minHeight: 0 }}>
        <GitHubEmpty />
      </Stack>
    );
  }

  // A project's board drills in over the whole GitHub page (#498): opening it from
  // the portfolio takes over until "← portfolio" (closeGithubBoard) returns to the
  // tabbed view. Each board view renders its own project header + sub-tabs.
  if (githubBoardOpen && !pageOverride) {
    return (
      <Stack style={{ flex: 1, minHeight: 0 }}>
        {githubBoardTab === "board"    && <ProjectBoard />}
        {githubBoardTab === "roadmap"  && <Roadmap />}
        {githubBoardTab === "issues"   && <Issues />}
        {githubBoardTab === "insights" && <Insights />}
      </Stack>
    );
  }

  const activeRepo = githubRepos.find(r => r.full_name === activeRepoName) ?? githubRepos[0] ?? null;

  return (
    <Screen
      tabs={ghTabs}
      active={mode}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      pageOverride={pageOverride}
    >

      {/* Summary page */}
      {mode === "summary" && <GitHubSummary />}

      {/* Projects portfolio analytics (#421). Opening a project drills into its
          board, handled by the short-circuit above (#498). */}
      {mode === "projects" && <ProjectsSummary />}

      {/* Repositories view — repo picker + the per-repo Pulse dashboard (progress,
          changes, CI, contributors) with the branch graph folded in (#413). */}
      <div style={{
        display: mode === "repos" ? "flex" : "none",
        flex: 1, minHeight: 0,
      }}>
        {/* Repo sidebar */}
        <aside style={{
          width: sidebar.size, flex: `0 0 ${sidebar.size}px`, background: "var(--bg-panel)",
          borderRight: "1px solid var(--border-soft)", padding: "14px 8px",
          display: "flex", flexDirection: "column", gap: 2, overflow: "auto",
        }}>
          <Row className="mono" justify="between" style={{
            fontSize: 10, letterSpacing: ".08em",
            color: "var(--fg-dim)", padding: "2px 12px 8px",
          }}>
            <span>REPOS</span>
            <span
              style={{ color: "var(--fg-muted)", cursor: "pointer", fontSize: 9.5 }}
              onClick={disconnectGithub}
              title="Disconnect GitHub"
            >
              disconnect
            </span>
          </Row>
          {githubRepos.length === 0 && (
            <div className="mono" style={{
              padding: "12px", fontSize: 11,
              color: "var(--fg-dim)", textAlign: "center",
            }}>
              No repositories found
            </div>
          )}
          {githubRepos.map(r => {
            const on = r.full_name === (activeRepo?.full_name ?? "");
            return (
              <div
                key={r.full_name}
                onClick={() => setActiveRepo(r.full_name)}
                style={{
                  padding: "8px 10px 8px 12px", borderRadius: 5,
                  background: on ? "var(--bg-elev)" : "transparent",
                  borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
                  paddingLeft: on ? 10 : 12, cursor: "pointer",
                }}
              >
                <Row align="baseline" gap={6}>
                  <span className="mono" style={{
                    fontSize: 11,
                    color: on ? "var(--fg)" : "var(--fg-muted)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    flex: 1, minWidth: 0,
                  }}>{r.full_name}</span>
                  <Chip style={{ fontSize: 9.5 }}>{langTag(r.language)}</Chip>
                </Row>
                <Row className="mono" gap={8} align="stretch" style={{ fontSize: 9.5, color: "var(--fg-dim)", marginTop: 4 }}>
                  <span>⊕ {r.open_issues_count}</span>
                  {r.private && <Chip style={{ fontSize: 9 }}>private</Chip>}
                </Row>
              </div>
            );
          })}
        </aside>

        <div className="resize-x" {...sidebar.handleProps} title="Drag to resize" />

        {/* The repo's pulse — replaces the old Overview/Actions tabs. */}
        <Stack style={{ flex: 1, minWidth: 0 }}>
          <Pulse repo={activeRepo} />
        </Stack>
      </div>
    </Screen>
  );
}
