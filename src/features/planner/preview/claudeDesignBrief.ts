// Claude Design brief (#634). Once the UI stage has defined its screens, the planner
// hands the user a kickoff prompt to paste into Claude Design: it asks for polished,
// drop-in components for each screen and tells the user to export them back into the
// file-intake stage, where the planner routes them to the UI repo. Pure + testable.

export interface DesignBriefOpts { projectName?: string; stack?: string }

/** Build the Claude Design kickoff prompt for a set of declared screens. */
export function buildClaudeDesignBrief(screens: string[], opts: DesignBriefOpts = {}): string {
  const list = screens.length
    ? screens.map((s) => `- **${s}**`).join("\n")
    : "- (no screens defined yet — define them in the UI stage first)";
  const project = opts.projectName ? ` for ${opts.projectName}` : "";
  const stackLine = opts.stack ? `\nTarget stack: **${opts.stack}** — build components that fit it.` : "";
  return `# Design brief${project}

Design these screens as polished, production-ready UI components:

${list}
${stackLine}

## Guidelines
- A clean, modern aesthetic — consistent spacing, a clear type scale, and reusable color tokens.
- Cover each screen's states: **default, empty, loading, error**.
- Build each screen as a **self-contained component (one file per screen)** so it can drop straight into the codebase.
- Note the responsive behavior and the key interactions for each screen.

## When you're done
Export each screen's code/assets and **drag them into the planner's "Drop files" stage** — the planner will route them into the UI repo for you.`;
}
