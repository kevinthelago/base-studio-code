// README generation (#848 / #1710): turn whatever plan content exists at publish into a thorough,
// badge-topped README. Pure + unit-tested; `handlePublish` applies the output (a planner that
// authored a richer README is preferred over this at publish). Stack-aware Getting-started commands
// come from the shared matcher in `stackTopics.ts`.

import { gettingStartedCmds } from "./stackTopics";

/** The repo's short name — the segment after the last `/`. */
function shortName(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i >= 0 ? fullName.slice(i + 1) : fullName;
}

/** A planned feature, reduced to what the README renders. */
export interface ReadmeFeature {
  name: string;
  behavior?: string;
}

export interface ReadmeOpts {
  /** `owner/repo`. */
  fullName: string;
  /** Concise repo description / tagline (the project goal's first line). */
  description: string;
  /** The full goal prose → the Overview section (falls back to `description`). */
  goal?: string;
  /** The scope section text → a Scope section (omitted when absent). */
  scope?: string;
  /** The architecture section text → an Architecture section (omitted when absent). */
  architecture?: string;
  /** The planned features → a bulleted Features section (omitted when empty). */
  features?: ReadmeFeature[];
  /** The stack section text (verbatim, for the Tech stack section). */
  stackText?: string;
  /** Workflow filenames under `.github/workflows/` (e.g. `["ci.yml"]`) → CI status badges. */
  workflows?: string[];
  /** Default branch the badges point at. */
  defaultBranch?: string;
}

/**
 * Build a thorough README with badges, driven by whatever plan content is available at publish.
 * Sections render only when their input is present (graceful fallbacks), in this order: Overview
 * (full goal), Scope, Features, Tech stack, Architecture, Getting started, Contributing, License.
 * Badges: one CI status badge per workflow file, plus license + last-commit shields.
 */
export function buildReadme(opts: ReadmeOpts): string {
  const { fullName, description, goal, scope, architecture, features = [], stackText, workflows = [], defaultBranch = "main" } = opts;
  const [owner, repo] = fullName.split("/");
  const name = shortName(fullName);
  const clean = (s?: string) => (s ?? "").trim();

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
    clean(goal) || description || "Describe what this project does and who it's for.",
    "",
  ];

  if (clean(scope)) {
    lines.push("## Scope", "", clean(scope), "");
  }

  const feats = features.filter((f) => f && f.name && f.name.trim());
  if (feats.length) {
    lines.push("## Features", "");
    for (const f of feats) {
      const b = clean(f.behavior);
      lines.push(b ? `- **${f.name.trim()}** — ${b}` : `- **${f.name.trim()}**`);
    }
    lines.push("");
  }

  if (clean(stackText)) {
    lines.push("## Tech stack", "", clean(stackText), "");
  }

  if (clean(architecture)) {
    lines.push("## Architecture", "", clean(architecture), "");
  }

  lines.push(
    "## Getting started",
    "",
    "```bash",
    `git clone https://github.com/${owner}/${repo}.git`,
    `cd ${name}`,
    ...gettingStartedCmds(clean(stackText)),
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
