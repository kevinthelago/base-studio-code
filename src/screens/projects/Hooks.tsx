// Project git hooks (#265) — moved here from the GitHub screen (which had no project
// context to resolve a clone). On the Projects board there's a concrete clone per repo
// (`projects/<project>/<repo>`), so these are the repo's REAL hooks, read via the Rust
// `read_git_hooks` command (honors core.hooksPath / .githooks).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { projectRepoCwd } from "../../lib/projectPaths";
import { ProjectsHeader, useActiveProjectInfo } from "./ProjectsHeader";

interface GitHook {
  name: string;
  active: boolean;
  source: string;
  preview: string;
}

const HOOK_DESC: Record<string, string> = {
  "pre-commit": "Runs before a commit is created; a non-zero exit blocks it.",
  "prepare-commit-msg": "Edits the default message before the commit editor opens.",
  "commit-msg": "Validates / normalizes the commit message.",
  "post-commit": "Runs after a commit is created.",
  "pre-rebase": "Runs before a rebase begins.",
  "post-checkout": "Runs after a checkout / branch switch.",
  "post-merge": "Runs after a successful merge or pull.",
  "pre-push": "Runs before refs are pushed to a remote.",
  "post-rewrite": "Runs after commits are rewritten (rebase, amend).",
};

function RepoHooks({ repo, cwd }: { repo: string; cwd: string }) {
  const [hooks, setHooks] = useState<GitHook[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<GitHook[]>("read_git_hooks", { repoPath: cwd })
      .then((h) => { if (!cancelled) setHooks(h); })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [cwd]);

  const activeCount = hooks?.filter((h) => h.active).length ?? 0;
  const notCloned = hooks !== null && hooks.length === 0;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{repo}</h3>
        {hooks && !notCloned && (
          <span className={"tag " + (activeCount > 0 ? "green" : "")}>{activeCount} active</span>
        )}
        <div style={{ flex: 1 }} />
        <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{cwd}</span>
      </div>

      {err && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}>{err}</div>
      )}
      {hooks === null && !err && <div className="hint">reading hooks…</div>}
      {notCloned && (
        <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
          Not cloned in this project (no <code>.git</code> at the path above). Launch a session for
          this repo to clone it.
        </div>
      )}

      {hooks && !notCloned && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-soft)" }}>
          {hooks.map((h, i) => (
            <div key={h.name} style={{
              display: "grid", gridTemplateColumns: "150px 1fr 70px", gap: 12, alignItems: "center",
              padding: "10px 14px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)", fontSize: 11.5,
              opacity: h.active ? 1 : 0.55,
            }}>
              <span style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>{h.name}</span>
              <span style={{ color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {h.active && h.preview
                  ? <code style={{ fontFamily: "var(--mono)", fontSize: 10.5 }}>{h.preview}</code>
                  : (HOOK_DESC[h.name] ?? "")}
              </span>
              <span style={{ justifySelf: "end" }}>
                {h.active
                  ? <span className="tag green" style={{ fontSize: 9.5 }}>● active</span>
                  : <span className="tag" style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>—</span>}
              </span>
            </div>
          ))}
          <div style={{ padding: "8px 14px", background: "var(--bg-panel)" }}>
            <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
              source: {hooks[0]?.source ?? ".git/hooks"} · read-only
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function HooksView() {
  const activeProjectName = useAppStore((s) => s.activeProjectName);
  const activeProjectRepos = useAppStore((s) => s.activeProjectRepos);
  const bscBaseDir = useAppStore((s) => s.bscBaseDir);
  const project = useActiveProjectInfo();

  return (
    <>
    <ProjectsHeader project={project} />
    <section style={{ flex: 1, overflow: "auto", padding: "18px 22px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>Git hooks</h2>
        <span className="hint">the real hooks installed in each of this project's repo clones</span>
      </div>

      {activeProjectRepos.length === 0 ? (
        <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "8px 0" }}>
          This project has no repos.
        </div>
      ) : (
        activeProjectRepos.map((repo) => (
          <RepoHooks key={repo} repo={repo} cwd={projectRepoCwd(bscBaseDir, activeProjectName, repo)} />
        ))
      )}
    </section>
    </>
  );
}
