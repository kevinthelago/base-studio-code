// Repo presentation scaffolding (#848): turn a planned project into a discoverable repo —
// GitHub topics (from the stack), a thorough README with CI/version badges, and the standard
// community-health files. Pure + unit-tested; `handlePublish` applies the output (topics via
// the Topics API, files via the Contents API). The app generates strong defaults; a planner
// that authored a richer README is preferred over these at publish.

/** The repo's short name — the segment after the last `/`. */
function shortName(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i >= 0 ? fullName.slice(i + 1) : fullName;
}

// Curated stack-keyword → GitHub-topic-slug map. Matched case-insensitively as whole words
// against the stack section text, so prose like "React 18 + TypeScript, Rust (Tauri)" yields
// `react`, `typescript`, `rust`, `tauri`. Lowercase-hyphenated per the topic-hygiene guide.
const STACK_TOPICS: [RegExp, string][] = [
  [/\breact\b/, "react"], [/\bnext\.?js\b/, "nextjs"], [/\bvue\b/, "vue"], [/\bsvelte\b/, "svelte"],
  [/\bangular\b/, "angular"], [/\btypescript\b/, "typescript"], [/\bjavascript\b/, "javascript"],
  [/\bnode(\.?js)?\b/, "nodejs"], [/\bdeno\b/, "deno"], [/\bbun\b/, "bun"], [/\bvite\b/, "vite"],
  [/\brust\b/, "rust"], [/\btauri\b/, "tauri"], [/\bgo(lang)?\b/, "go"], [/\bpython\b/, "python"],
  [/\bdjango\b/, "django"], [/\bflask\b/, "flask"], [/\bfastapi\b/, "fastapi"], [/\bruby\b/, "ruby"],
  [/\brails\b/, "rails"], [/\bjava\b/, "java"], [/\bspring\b/, "spring-boot"], [/\bkotlin\b/, "kotlin"],
  [/\bswift\b/, "swift"], [/\bc\+\+\b/, "cpp"], [/\bc#\b/, "csharp"], [/\b\.net\b/, "dotnet"],
  [/\bpostgres(ql)?\b/, "postgresql"], [/\bmysql\b/, "mysql"], [/\bsqlite\b/, "sqlite"],
  [/\bmongo(db)?\b/, "mongodb"], [/\bredis\b/, "redis"], [/\bduckdb\b/, "duckdb"],
  [/\bgraphql\b/, "graphql"], [/\bdocker\b/, "docker"], [/\bkubernetes\b|\bk8s\b/, "kubernetes"],
  [/\btailwind\b/, "tailwindcss"], [/\bexpo\b/, "expo"], [/\breact native\b/, "react-native"],
];

/**
 * Derive GitHub repo topics from the stack section text, plus any explicit extras. Whole-word,
 * case-insensitive; deduped; lowercase-hyphenated; capped at GitHub's 20-topic limit. NB: these
 * are GitHub *repo topics*, distinct from the planner's discovery "topics".
 */
export function deriveTopics(stackText: string, extra: string[] = []): string[] {
  const found: string[] = [];
  const text = stackText.toLowerCase();
  for (const [re, topic] of STACK_TOPICS) {
    if (re.test(text)) found.push(topic);
  }
  const clean = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const all = [...found, ...extra.map(clean)].filter(Boolean);
  return [...new Set(all)].slice(0, 20);
}

export interface ReadmeOpts {
  /** `owner/repo`. */
  fullName: string;
  /** Concise repo description (the project goal's first line). */
  description: string;
  /** The stack section text (verbatim, for the Tech stack section). */
  stackText?: string;
  /** Workflow filenames under `.github/workflows/` (e.g. `["ci.yml"]`) → CI status badges. */
  workflows?: string[];
  /** Default branch the badges point at. */
  defaultBranch?: string;
}

/**
 * Build a thorough README with badges. Badges: one CI status badge per workflow file, plus
 * license + last-commit shields. Falls back gracefully — no workflows ⇒ no CI badges.
 */
export function buildReadme(opts: ReadmeOpts): string {
  const { fullName, description, stackText, workflows = [], defaultBranch = "main" } = opts;
  const [owner, repo] = fullName.split("/");
  const name = shortName(fullName);

  const badges: string[] = [];
  for (const wf of workflows) {
    const label = wf.replace(/\.ya?ml$/i, "");
    badges.push(`[![${label}](https://github.com/${owner}/${repo}/actions/workflows/${wf}/badge.svg)](https://github.com/${owner}/${repo}/actions/workflows/${wf})`);
  }
  badges.push(`![License](https://img.shields.io/github/license/${owner}/${repo})`);
  badges.push(`![Last commit](https://img.shields.io/github/last-commit/${owner}/${repo})`);

  const lines = [
    `# ${name}`,
    "",
    badges.join(" "),
    "",
    description || "_A base-studio-code project._",
    "",
    "## Overview",
    "",
    description || "Describe what this project does and who it's for.",
    "",
  ];
  if (stackText && stackText.trim()) {
    lines.push("## Tech stack", "", stackText.trim(), "");
  }
  lines.push(
    "## Getting started",
    "",
    "```bash",
    `git clone https://github.com/${owner}/${repo}.git`,
    `cd ${name}`,
    "# install dependencies and run the project's build/test/dev commands",
    "```",
    "",
    "## Contributing",
    "",
    "See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).",
    "",
    "## License",
    "",
    "See [LICENSE](LICENSE).",
    "",
    "---",
    "",
    "_Scaffolded by base-studio-code._",
  );
  void defaultBranch; // reserved for branch-pinned badges if needed later
  return lines.join("\n");
}

export interface ScaffoldFile {
  /** Repo-relative path. */
  path: string;
  content: string;
}

/**
 * The standard community-health files for a new repo. Static, parameterized by the project
 * name. The app commits any that don't already exist (never clobbers a hand-written file).
 */
export function communityFiles(projectName: string): ScaffoldFile[] {
  const name = projectName.trim() || "this project";
  return [
    {
      path: "CONTRIBUTING.md",
      content: [
        `# Contributing to ${name}`,
        "",
        "Thanks for your interest in contributing!",
        "",
        "## Workflow",
        "",
        "1. Find or open an issue describing the change.",
        "2. Create a branch named `<issue-number>-<short-description>` from `develop`.",
        "3. Make the minimum change to resolve the issue, with tests.",
        "4. Run the full test suite locally; ensure it passes.",
        "5. Open a pull request targeting `develop` and reference the issue (`Closes #N`).",
        "",
        "## Standards",
        "",
        "- Keep pull requests focused — one concern per branch.",
        "- Write tests for new or changed behavior.",
        "- Follow the existing code style and documentation conventions.",
        "",
      ].join("\n"),
    },
    {
      path: "CODE_OF_CONDUCT.md",
      content: [
        "# Code of Conduct",
        "",
        "## Our Pledge",
        "",
        "We as members, contributors, and leaders pledge to make participation in our",
        "community a harassment-free experience for everyone.",
        "",
        "## Our Standards",
        "",
        "Examples of behavior that contributes to a positive environment include showing",
        "empathy and kindness, being respectful of differing opinions, and gracefully",
        "accepting constructive feedback. Harassment and other unacceptable behavior will",
        "not be tolerated.",
        "",
        "## Enforcement",
        "",
        "Instances of abusive or otherwise unacceptable behavior may be reported to the",
        "project maintainers. All complaints will be reviewed and investigated promptly",
        "and fairly.",
        "",
        "This Code of Conduct is adapted from the [Contributor Covenant](https://www.contributor-covenant.org).",
        "",
      ].join("\n"),
    },
    {
      path: "SECURITY.md",
      content: [
        "# Security Policy",
        "",
        "## Reporting a Vulnerability",
        "",
        "Please do not open a public issue for security vulnerabilities. Instead, report",
        "them privately to the project maintainers (e.g. via a GitHub security advisory).",
        "We will acknowledge your report and work on a fix as quickly as possible.",
        "",
      ].join("\n"),
    },
    {
      path: ".github/PULL_REQUEST_TEMPLATE.md",
      content: [
        "## Summary",
        "",
        "<!-- What does this PR change and why? -->",
        "",
        "Closes #",
        "",
        "## Changes",
        "",
        "-",
        "",
        "## Testing",
        "",
        "<!-- How was this verified? -->",
        "",
        "## Checklist",
        "",
        "- [ ] Tests added/updated for the change",
        "- [ ] The full test suite passes locally",
        "- [ ] Documentation updated where relevant",
        "",
      ].join("\n"),
    },
    {
      path: ".github/ISSUE_TEMPLATE/bug_report.md",
      content: [
        "---",
        "name: Bug report",
        "about: Report something that isn't working",
        "labels: bug",
        "---",
        "",
        "## Describe the bug",
        "",
        "## Steps to reproduce",
        "",
        "1.",
        "",
        "## Expected behavior",
        "",
        "## Environment",
        "",
      ].join("\n"),
    },
    {
      path: ".github/ISSUE_TEMPLATE/feature_request.md",
      content: [
        "---",
        "name: Feature request",
        "about: Suggest an idea or enhancement",
        "labels: enhancement",
        "---",
        "",
        "## Problem",
        "",
        "## Proposed solution",
        "",
        "## Alternatives considered",
        "",
      ].join("\n"),
    },
  ];
}
