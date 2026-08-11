// The github feature's PUBLIC API — a re-export only.
//
// The GitHub screen itself is the `githubpage` RECORD, mounted by GitHubGraphHost — which is what
// `lazyWorkspaces` resolves the `GitHubWorkspace` symbol to, in both App.tsx and DetachedWindow.
// The copy that used to live in this file was a dead duplicate: nothing imported it. Its tab table
// and `langTag` helper went with it, since only it used them.
export { GitHubGraphHost } from "./GitHubGraphHost";
