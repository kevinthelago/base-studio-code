// Repo presentation scaffolding (#848 / #1710): turn a planned project into a discoverable repo —
// GitHub topics (from the stack), a thorough README with CI/version badges, and the standard
// community-health files. `handlePublish` applies the output (topics via the Topics API, files via
// the Contents API). This module owns the community-health files and re-exports the README builder
// (`repoReadme.ts`) and the stack matcher (`stackTopics.ts`) so the public surface is one import.

export { deriveTopics, gettingStartedCmds, STACK_TOPICS } from "./stackTopics";
export { buildReadme, type ReadmeFeature, type ReadmeOpts } from "./repoReadme";

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
