import { useAppStore } from "../../store";
import { GitHubEmpty } from "./Empty";
import { OverviewBody } from "./Overview";
import { ActionsBody } from "./Actions";
import { GitHubSummary, GitHubPageModeStrip } from "./GitHubSummary";

// (Git hooks moved to the Projects board, where a project+repo maps to a real clone — #265.)
const PAGE_TABS = [
  { k: "overview", label: "Overview", hint: "branches · commits · PRs"    },
  { k: "actions",  label: "Actions",  hint: "workflow files & recent runs" },
] as const;

type TabKey = typeof PAGE_TABS[number]["k"];

function PageTabs({ active, onSelect }: { active: TabKey; onSelect: (k: TabKey) => void }) {
  return (
    <div style={{
      height: 36, flex: "0 0 36px",
      borderBottom: "1px solid var(--border-soft)",
      background: "var(--bg-panel)",
      padding: "0 22px",
      display: "flex", alignItems: "end", gap: 2,
    }}>
      {PAGE_TABS.map(t => {
        const on = t.k === active;
        return (
          <div key={t.k} onClick={() => onSelect(t.k)} style={{
            padding: "0 14px", height: 30,
            display: "flex", alignItems: "center", gap: 8,
            borderTopLeftRadius: 6, borderTopRightRadius: 6,
            background: on ? "var(--bg-canvas)" : "transparent",
            border: "1px solid " + (on ? "var(--border-soft)" : "transparent"),
            borderBottom: "0",
            color: on ? "var(--fg)" : "var(--fg-muted)",
            fontFamily: "var(--mono)", fontSize: 11.5,
            cursor: "pointer",
          }}>
            {t.label}
            {on && <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>· {t.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}

function langTag(lang: string | null): string {
  if (!lang) return "—";
  const map: Record<string, string> = { TypeScript: "ts", JavaScript: "js", Rust: "rs", Python: "py", Go: "go", Java: "java" };
  return map[lang] ?? lang.toLowerCase().slice(0, 4);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function GitHubScreen() {
  const {
    githubConnected, githubPageMode,
    githubActiveTab, setGithubTab,
    githubRepos, activeRepoName, setActiveRepo,
    disconnectGithub,
  } = useAppStore();

  if (!githubConnected) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <GitHubEmpty />
      </div>
    );
  }

  const activeRepo = githubRepos.find(r => r.full_name === activeRepoName) ?? githubRepos[0] ?? null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <GitHubPageModeStrip />

      {/* Summary page */}
      {githubPageMode === "summary" && <GitHubSummary />}

      {/* Repositories view */}
      <div style={{
        display: githubPageMode === "repos" ? "flex" : "none",
        flex: 1, minHeight: 0,
      }}>
        {/* Repo sidebar */}
        <aside style={{
          width: 220, flex: "0 0 220px", background: "var(--bg-panel)",
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
                    maxWidth: 140,
                  }}>{r.full_name}</span>
                  <span style={{ flex: 1 }} />
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

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {activeRepo && (
            <div style={{ padding: "14px 22px 0", display: "flex", alignItems: "flex-start", gap: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>
                    {activeRepo.full_name}
                  </h2>
                  <span className="tag amber">● {timeAgo(activeRepo.pushed_at)}</span>
                  {activeRepo.private && <span className="tag">private</span>}
                  {activeRepo.language && <span className="tag">{activeRepo.language.toLowerCase()}</span>}
                </div>
                <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
                  {activeRepo.description ?? "No description."}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <select className="input" defaultValue={activeRepo.default_branch} style={{ width: 160 }}>
                  <option>{activeRepo.default_branch}</option>
                </select>
                <button className="btn ghost" onClick={() => window.open(`https://github.com/${activeRepo.full_name}`, "_blank")}>
                  open on github →
                </button>
              </div>
            </div>
          )}

          <div style={{ height: 14 }} />
          <PageTabs active={githubActiveTab} onSelect={setGithubTab} />
          <section style={{ flex: 1, overflow: "auto", padding: "18px 22px", minWidth: 0 }}>
            {githubActiveTab === "overview" && <OverviewBody repo={activeRepo} />}
            {githubActiveTab === "actions"  && <ActionsBody repo={activeRepo} />}
          </section>
        </div>
      </div>
    </div>
  );
}
