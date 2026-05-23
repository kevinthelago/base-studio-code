import { StatusBar } from "../../components/chrome/StatusBar";
import { useAppStore } from "../../store";
import { GitHubEmpty } from "./Empty";
import { OverviewBody } from "./Overview";
import { ActionsBody } from "./Actions";
import { HooksBody } from "./Hooks";

const REPOS = [
  { n: "acme/payments",    lang: "rust", on: true, pr: 5 },
  { n: "acme/ledger-core", lang: "rust",           pr: 2 },
  { n: "acme/web",         lang: "ts",             pr: 8 },
  { n: "acme/docs",        lang: "md",             pr: 1 },
];

const PAGE_TABS = [
  { k: "overview", label: "Overview", hint: "branches · commits · PRs"        },
  { k: "actions",  label: "Actions",  hint: "workflow files & recent runs"     },
  { k: "hooks",    label: "Hooks",    hint: "pre-commit · pre-push · etc."     },
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

export function GitHubScreen() {
  const { githubConnected, githubActiveTab, setGithubTab } = useAppStore();

  if (!githubConnected) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <GitHubEmpty />
        <StatusBar extra={
          <span className="s" style={{ color: "var(--fg-dim)" }}>
            <i className="off" /> github · not connected
          </span>
        } />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Repo sidebar */}
        <aside style={{
          width: 220, flex: "0 0 220px", background: "var(--bg-panel)",
          borderRight: "1px solid var(--border-soft)", padding: "14px 8px",
          display: "flex", flexDirection: "column", gap: 2, overflow: "auto",
        }}>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em",
            color: "var(--fg-dim)", padding: "2px 12px 8px",
            display: "flex", justifyContent: "space-between",
          }}>
            <span>REPOS</span>
            <span style={{ color: "var(--fg-muted)", cursor: "pointer" }}>+ add</span>
          </div>
          {REPOS.map(r => (
            <div key={r.n} style={{
              padding: "8px 10px 8px 12px", borderRadius: 5,
              background: r.on ? "var(--bg-elev)" : "transparent",
              borderLeft: r.on ? "2px solid var(--accent)" : "2px solid transparent",
              paddingLeft: r.on ? 10 : 12, cursor: "pointer",
            }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 11.5,
                  color: r.on ? "var(--fg)" : "var(--fg-muted)",
                }}>{r.n}</span>
                <span style={{ flex: 1 }} />
                <span className="tag" style={{ fontSize: 9.5 }}>{r.lang}</span>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 4 }}>
                ⊕ {r.pr} PR
              </div>
            </div>
          ))}
        </aside>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* Repo header */}
          <div style={{ padding: "14px 22px 0", display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>
                  acme/payments
                </h2>
                <span className="tag amber">● synced 12s ago</span>
                <span className="tag">private</span>
                <span className="tag">rust</span>
              </div>
              <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
                Stripe + Tipalti adapters, ledger glue, settlement workers.
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select className="input" defaultValue="main" style={{ width: 160 }}>
                <option>main</option>
                <option>feat/tunnel-v2</option>
                <option>fix/retry-loop</option>
                <option>docs/migrate-store</option>
              </select>
              <button className="btn">↻ fetch</button>
              <button className="btn ghost">open on github →</button>
            </div>
          </div>

          <div style={{ height: 14 }} />
          <PageTabs active={githubActiveTab} onSelect={setGithubTab} />
          <section style={{ flex: 1, overflow: "auto", padding: "18px 22px", minWidth: 0 }}>
            {githubActiveTab === "overview" && <OverviewBody />}
            {githubActiveTab === "actions"  && <ActionsBody />}
            {githubActiveTab === "hooks"    && <HooksBody />}
          </section>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
