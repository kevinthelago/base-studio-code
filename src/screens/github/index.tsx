import { useAppStore } from "../../store";
import { useDragResize } from "../../hooks/useDragResize";
import { TabBar, type TabItem } from "../../components/chrome/TabBar";
import { usePageTabs } from "../../hooks/usePageTabs";
import { GitHubEmpty } from "./Empty";
import { GitHubSummary } from "./GitHubSummary";
import { ProjectsSummary } from "../projects/ProjectsSummary";
import { ProjectOverview } from "../projects/ProjectOverview";
import { ProjectBoard } from "../projects/ProjectBoard";
import { Roadmap } from "../projects/Roadmap";
import { Issues } from "../projects/Issues";
import { Insights } from "../projects/Insights";
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

export function GitHubScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  const {
    githubConnected,
    githubRepos, activeRepoName, setActiveRepo,
    disconnectGithub,
    githubBoardOpen, githubBoardTab,
    githubTab, setGithubTab,
  } = useAppStore();

  // Drag-resizable repo sidebar (mirrors the Knowledge Store / planning splitters).
  const sidebar = useDragResize({ initial: 220, min: 160, max: 460, axis: "x" });
  // Store-controlled active tab so other screens can deep-link to it (#499).
  const { tabs: ghTabs, activeId, select, reorder, tearOff } =
    usePageTabs("github", GITHUB_TABS, { activeId: githubTab, setActive: setGithubTab });
  const mode = sectionOverride ?? activeId;

  if (!githubConnected) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <GitHubEmpty />
      </div>
    );
  }

  // A project's board drills in over the whole GitHub page (#498): opening it from
  // the portfolio takes over until "← portfolio" (closeGithubBoard) returns to the
  // tabbed view. Each board view renders its own project header + sub-tabs.
  if (githubBoardOpen && !sectionOverride) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {githubBoardTab === "overview" && <ProjectOverview />}
        {githubBoardTab === "board"    && <ProjectBoard />}
        {githubBoardTab === "roadmap"  && <Roadmap />}
        {githubBoardTab === "issues"   && <Issues />}
        {githubBoardTab === "insights" && <Insights />}
      </div>
    );
  }

  const activeRepo = githubRepos.find(r => r.full_name === activeRepoName) ?? githubRepos[0] ?? null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {!sectionOverride && (
        <TabBar tabs={ghTabs} activeId={activeId} onSelect={select} onReorder={reorder} onTearOff={tearOff} />
      )}

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
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em",
            color: "var(--fg-dim)", padding: "2px 12px 8px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span>REPOS</span>
            <span
              style={{ color: "var(--fg-muted)", cursor: "pointer", fontSize: 9.5 }}
              onClick={disconnectGithub}
              title="Disconnect GitHub"
            >
              disconnect
            </span>
          </div>
          {githubRepos.length === 0 && (
            <div style={{
              padding: "12px", fontFamily: "var(--mono)", fontSize: 11,
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
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 11,
                    color: on ? "var(--fg)" : "var(--fg-muted)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    flex: 1, minWidth: 0,
                  }}>{r.full_name}</span>
                  <span className="tag" style={{ fontSize: 9.5 }}>{langTag(r.language)}</span>
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 4, display: "flex", gap: 8 }}>
                  <span>⊕ {r.open_issues_count}</span>
                  {r.private && <span className="tag" style={{ fontSize: 9 }}>private</span>}
                </div>
              </div>
            );
          })}
        </aside>

        <div className="resize-x" {...sidebar.handleProps} title="Drag to resize" />

        {/* The repo's pulse — replaces the old Overview/Actions tabs. */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <Pulse repo={activeRepo} />
        </div>
      </div>
    </div>
  );
}
