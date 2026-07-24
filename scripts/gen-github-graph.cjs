// One-off generator (#3650) — author the GitHub page + its composed views AS GRAPH SOURCE by transcribing
// the live .tsx into graph records, with the import rewrites the runtime loader needs. Bigger than the
// automations/security cases: a nested summary/ folder (relative depths vary) → an EXPLICIT sibling map,
// plus feature-lib rewrites for ./ and ../ forms. Mirrors scripts/gen-{automations,security}-graph.cjs.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../src/features/github");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/github");
fs.mkdirSync(OUT, { recursive: true });

// sibling component id map — every relative import of a sibling → its @/components/<id> graph record.
const SIB = {
  "./Empty": "github-empty",
  "./GitHubSummary": "github-summary",
  "./Pulse": "github-pulse",
  "./BranchGraph": "github-branch-graph",
  "./summary/ActivityHeatmap": "github-activity-heatmap",
  "./summary/CIHealthCard": "github-ci-health",
  "./summary/ContributorsCard": "github-contributors",
  "./summary/CrossRepoActivity": "github-cross-repo-activity",
  "./summary/GitHubPageModeStrip": "github-page-mode-strip",
  "./summary/LanguageMix": "github-language-mix",
  "./summary/OpenPRsCard": "github-open-prs",
  "./summary/ReposGrid": "github-repos-grid",
};

function rewrite(code) {
  let c = code;
  for (const [rel, id] of Object.entries(SIB)) {
    c = c.split(`from "${rel}"`).join(`from "@/components/${id}"`);
  }
  // feature-internal libs/hooks (./ from top-level, ../ from nested summary/) → absolute registered specifiers.
  c = c
    .replace(/from "\.\.?\/lib\//g, 'from "@/features/github/lib/')
    .replace(/from "\.\.?\/heatFill"/g, 'from "@/features/github/heatFill"')
    .replace(/from "\.\/useGithubSummary"/g, 'from "@/features/github/useGithubSummary"');
  return c;
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#3650, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the github lib/hook surface + planner board via the github\n` +
  `// graph-platform, and the sibling views as @/components/* graph records). Behaviour runs here.\n`;

function src(file, what) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  code = code.replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, ""); // defensive CSS strip (none expected)
  return HEADER(what) + rewrite(code);
}

const records = [
  { id: "githubpage", name: "GitHubWorkspace", role: "page", file: "index.tsx", what: "GitHub workspace (#413)" },
  { id: "github-empty", name: "GitHubEmpty", role: "component", file: "Empty.tsx", what: "GitHub → not-connected empty state" },
  { id: "github-summary", name: "GitHubSummary", role: "component", file: "GitHubSummary.tsx", what: "GitHub → Summary tab (all-repos analytics)" },
  { id: "github-pulse", name: "GitHubPulse", role: "component", file: "Pulse.tsx", what: "GitHub → per-repo Pulse dashboard" },
  { id: "github-branch-graph", name: "GitHubBranchGraph", role: "component", file: "BranchGraph.tsx", what: "GitHub → branch graph" },
  { id: "github-activity-heatmap", name: "GitHubActivityHeatmap", role: "component", file: "summary/ActivityHeatmap.tsx", what: "GitHub → activity heatmap card" },
  { id: "github-ci-health", name: "GitHubCIHealth", role: "component", file: "summary/CIHealthCard.tsx", what: "GitHub → CI health card" },
  { id: "github-contributors", name: "GitHubContributors", role: "component", file: "summary/ContributorsCard.tsx", what: "GitHub → contributors card" },
  { id: "github-cross-repo-activity", name: "GitHubCrossRepoActivity", role: "component", file: "summary/CrossRepoActivity.tsx", what: "GitHub → cross-repo activity card" },
  { id: "github-page-mode-strip", name: "GitHubPageModeStrip", role: "component", file: "summary/GitHubPageModeStrip.tsx", what: "GitHub → page-mode strip" },
  { id: "github-language-mix", name: "GitHubLanguageMix", role: "component", file: "summary/LanguageMix.tsx", what: "GitHub → language mix card" },
  { id: "github-open-prs", name: "GitHubOpenPRs", role: "component", file: "summary/OpenPRsCard.tsx", what: "GitHub → open PRs card" },
  { id: "github-repos-grid", name: "GitHubReposGrid", role: "component", file: "summary/ReposGrid.tsx", what: "GitHub → repos grid card" },
];

for (const r of records) {
  const rec = { id: r.id, name: r.name, kitId: "base-studio-code", role: r.role, group: "features/github", srcText: src(r.file, r.what) };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${r.id}.json  (${rec.srcText.length} chars)`);
}

for (const r of records) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${r.id}.json`), "utf8"));
  const rel = j.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) console.log(`  WARN ${r.id}: leftover relative import(s): ${rel.join(", ")}`);
}
