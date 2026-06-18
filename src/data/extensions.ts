// Extensions data. EXT_CATALOG is the real first-party MCP / hook catalog the Extensions screen
// browses + the planner's `<mcp_assign>` path installs from (#858). The live extension list,
// health, and call stats come from the store / backend at runtime — not from this file.

export interface CatalogItem {
  name: string;
  by: string;
  icon: string;
  desc: string;
  /** External download/repo link (#858). First-party servers install from source (not npm/PyPI),
   *  so the card surfaces a GitHub link (to `main`) for download + setup. */
  link?: string;
  /** One-line setup hint shown with the download link (clone + build/run). */
  install?: string;
}

export const SCOPE_COPY: Record<string, string> = {
  global: "on every project",
  project: "for the projects you pick",
  console: "for one console only",
};

export const EXT_CATALOG: CatalogItem[] = [
  // First-party MCP servers (#858) — install from source via the download link.
  { name: "Compliance",          by: "kevinthelago", icon: "✓", desc: "Surface compliance findings — GDPR, SOC 2, ISO 27001, HIPAA, PCI DSS — by scanning a project or a git diff, and gate CI on severity thresholds.",
    link: "https://github.com/kevinthelago/compliance-mcp-server",      install: "Downloads to ~/.base-studio-code/mcp/compliance-mcp-server, then builds with `python -m uv sync`." },
  { name: "Complexity Analyzer", by: "kevinthelago", icon: "∿", desc: "Analyze code complexity (cyclomatic, cognitive, hotspots) across a codebase to target refactors.",
    link: "https://github.com/kevinthelago/complexity-analyzer-mcp",     install: "Downloads to ~/.base-studio-code/mcp/complexity-analyzer-mcp. Run `pnpm install && pnpm build` there, then Add." },
  { name: "Dependency Graph",    by: "kevinthelago", icon: "⌥", desc: "Explore a project's dependency graph — query nodes, neighbors, cycles, and stats.",
    link: "https://github.com/kevinthelago/dependency-graph-mcp-server", install: "Downloads to ~/.base-studio-code/mcp/dependency-graph-mcp-server. Run `pnpm install && pnpm build` there, then Add." },
  { name: "Plan Grader",         by: "kevinthelago", icon: "◎", desc: "Grade a generated plan's agent-readiness — score its issues, milestones, and repos against the readiness rubric and surface prioritized fixes (the planner's grading as a tool, #897).",
    link: "https://github.com/kevinthelago/plan-grader-mcp-server",     install: "Downloads to ~/.base-studio-code/mcp/plan-grader-mcp-server, then builds with `python -m uv sync`." },
  // Generic third-party servers (Sentry/Linear/Postgres/Slack/Stripe/Brave/SQLite/Notion) were
  // pruned from the browse list (#870) so the catalog features our first-party servers. Their
  // CATALOG_TEMPLATES (lib/extensions.ts) stay — the planner's `<mcp_assign name="…" />` path
  // still wires a working config for well-known names even though they're no longer browseable.
  { name: "Block PII",    by: "first-party",             icon: "⊘",  desc: "Hook · PreToolUse — scans outbound tool inputs for PII patterns." },
  { name: "Auto-format",  by: "first-party",             icon: "§",  desc: "Hook · PostToolUse — runs project formatter on every Write." },
];
