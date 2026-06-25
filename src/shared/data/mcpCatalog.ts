// MCP server catalog. MCP_CATALOG is the first-party MCP server catalog the MCP screen browses
// and the planner's `<mcp_assign>` path installs from (#858). The live server list, health, and
// call stats come from the store / backend at runtime — not from this file.

/** A browseable catalog entry (shared shape for MCP servers + hooks). */
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
  /** Built-in/always-available server (#1196) — ships compiled in the app bundle (a native sidecar),
   *  so it has NO download/build step and is exposed to the planner by default. The MCP screen shows
   *  it as built-in instead of a download card. */
  builtIn?: boolean;
}

/** Scope copy shared by the MCP + Hooks scope pickers. */
export const SCOPE_COPY: Record<string, string> = {
  global: "on every project",
  project: "for the projects you pick",
  console: "for one console only",
};

export const MCP_CATALOG: CatalogItem[] = [
  // First-party MCP servers (#858) — install from source via the download link.
  { name: "Compliance",          by: "base-studio-code", icon: "✓", desc: "The live source of truth for compliance standards — regulation (GDPR, CCPA/CPRA), accessibility (WCAG 2.2 AA), security (SOC 2), and user-protection rules — so the planner bakes the right, citable requirements into every plan, scoped by the project's regions and data types. User-updatable without an app release (#1005). Built in — no download, build, or Docker.",
    builtIn: true },
  { name: "Complexity Analyzer", by: "kevinthelago", icon: "∿", desc: "Analyze code complexity (cyclomatic, cognitive, hotspots) across a codebase to target refactors.",
    link: "https://github.com/kevinthelago/complexity-analyzer-mcp",     install: "Downloads to ~/.base-studio-code/mcp/complexity-analyzer-mcp. Run `pnpm install && pnpm build` there, then Add." },
  { name: "Dependency Graph",    by: "kevinthelago", icon: "⌥", desc: "Explore a project's dependency graph — query nodes, neighbors, cycles, and stats.",
    link: "https://github.com/kevinthelago/dependency-graph-mcp-server", install: "Downloads to ~/.base-studio-code/mcp/dependency-graph-mcp-server. Run `pnpm install && pnpm build` there, then Add." },
  { name: "Plan Grader",         by: "kevinthelago", icon: "◎", desc: "Grade a generated plan's agent-readiness — score its issues, milestones, and repos against the readiness rubric and surface prioritized fixes (the planner's grading as a tool, #897).",
    link: "https://github.com/kevinthelago/plan-grader-mcp-server",     install: "Downloads to ~/.base-studio-code/mcp/plan-grader-mcp-server, then builds with `python -m uv sync`." },
  { name: "Research",            by: "base-studio-code", icon: "⌕", desc: "Search and retrieve scientific literature — arXiv, Semantic Scholar, PubMed/PMC, Crossref — with native PDF full-text extraction and citation-grounded semantic search, so the planner can ground plans and skills in real sources (#1056). Built in — no download, build, or Docker (#1196).",
    builtIn: true },
  // Generic third-party servers (Sentry/Linear/Postgres/Slack/Stripe/Brave/SQLite/Notion) were
  // pruned from the browse list (#870) so the catalog features our first-party servers. Their
  // templates (lib/mcpServers.ts) stay — the planner's `<mcp_assign name="…" />` path still wires
  // a working config for well-known names even though they're no longer browseable.
];
