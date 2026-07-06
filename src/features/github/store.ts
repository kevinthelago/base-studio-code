// GitHub feature store slice (#1309) — connection state, token (+ repo-scoped tokens), user, repos,
// active repo, and the page mode. Extracted from the former grab-bag `github` slice (whose residual
// — app-chrome + tunnel state — is now store/slices/shell.ts). Composed by store/index.ts.
import type { StateCreator } from "zustand";
import type { AppStore, GithubUser, GithubRepo } from "@/store/types";
import type { GithubState, MinimalGhProject } from "@/shared/lib/github/githubState";
import { pushGithubState } from "@/shared/lib/github/githubStateBridge";

export interface GithubSlice {
  githubConnected: boolean;
  githubToken: string;
  // The last-known GitHub board state (#2446): the minimal per-project records from the most recent
  // successful projects fetch + when it landed. Persisted (the fast-paint cache — survives restart
  // and renders as a stale-marked overlay while logged out / pre-refresh) and mirrored into the
  // bsc-project store so the durable copy is `bsc`-reachable. `null` until a fetch ever lands.
  // Deliberately NOT cleared by disconnectGithub — surviving the logged-out state is its point.
  githubState: GithubState | null;
  /** Overwrite the records wholesale (a fresh fetch), stamping `fetchedAt` and mirroring to bsc. */
  setGithubState: (records: MinimalGhProject[]) => void;
  // Repo-scoped GitHub credentials (#158): per-`owner/name` fine-grained token; persisted, never
  // logged. A request targeting that repo uses it instead of the global PAT.
  repoGithubTokens: Record<string, string>;
  setRepoGithubToken: (repo: string, token: string | null) => void;
  githubUser: GithubUser | null;
  githubRepos: GithubRepo[];
  activeRepoName: string;
  githubPageMode: "summary" | "projects" | "repos";
  setGithubPageMode: (v: "summary" | "projects" | "repos") => void;
  setGithubToken: (token: string) => void;
  setGithubUser: (user: GithubUser | null) => void;
  setGithubRepos: (repos: GithubRepo[]) => void;
  setActiveRepo: (name: string) => void;
  setGithubConnected: (connected: boolean) => void;
  disconnectGithub: () => void;
  markGithubTokenInvalid: () => void;
}

export const createGithubSlice: StateCreator<AppStore, [], [], GithubSlice> = (set) => ({
  githubConnected: false,
  githubToken: "",
  githubState: null,
  setGithubState: (records) => {
    const next: GithubState = { records, fetchedAt: Date.now() };
    set({ githubState: next });
    void pushGithubState(next); // mirror the durable copy into the bsc-project store (#2446)
  },
  repoGithubTokens: {},
  setRepoGithubToken: (repo, token) =>
    set((s) => {
      const next = { ...s.repoGithubTokens };
      if (token && token.trim()) next[repo] = token.trim();
      else delete next[repo];
      return { repoGithubTokens: next };
    }),
  githubUser: null,
  githubRepos: [],
  activeRepoName: "",
  githubPageMode: "summary",
  setGithubPageMode: (v) => set({ githubPageMode: v }),
  setGithubToken: (token) => set({ githubToken: token }),
  setGithubUser: (user) => set({ githubUser: user }),
  setGithubRepos: (repos) => set({ githubRepos: repos }),
  setActiveRepo: (name) => set({ activeRepoName: name }),
  setGithubConnected: (connected) => set({ githubConnected: connected }),
  disconnectGithub: () => set({
    githubConnected: false,
    githubToken: "",
    repoGithubTokens: {},
    githubUser: null,
    githubRepos: [],
    activeRepoName: "",
  }),
  // A request returned 401 (token expired/revoked) — flip to disconnected so the UI prompts a
  // reconnect instead of 401-looping; cached user/repos stay for context until reconnect.
  markGithubTokenInvalid: () => set((s) => (s.githubConnected ? { githubConnected: false } : {})),
});
