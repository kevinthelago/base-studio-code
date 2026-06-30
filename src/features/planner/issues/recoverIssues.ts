// GitHub → plan.db recovery (#plan-db). The mirror of the publish flow: where publish maps each
// PlanIssue to a GitHub issue (body = acceptance/owns/dependsOn, `stream:<id>` label, hidden ref
// marker), recovery inverts it — reconstructing PlanIssue[] from a repo's issues so a lost or
// machine-switched plan.db can be rehydrated from the durable GitHub store.
//
// Pure (no React/Tauri) so the reverse-parse is unit-testable and round-trips against
// renderIssueBody. The orchestration (gh fetch + plan_upsert_issue) lives in Planning.tsx.

import { parseRefMarker, type PlanIssue, type PlanIssueStatus } from "./planIssues";

/** The subset of a GitHub REST issue object recovery reads (`GET repos/{repo}/issues`). */
export interface GitHubIssueLike {
  number: number;
  title: string;
  body?: string | null;
  /** "open" | "closed". */
  state?: string;
  labels?: Array<{ name?: string } | string>;
  /** Present ⇒ this row is a pull request, not an issue (the /issues endpoint returns both). */
  pull_request?: unknown;
}

/**
 * Reverse of {@link renderIssueBody}: pull the prose body + acceptance/owns/dependsOn back out of a
 * published issue body. Tolerant of formatting drift — unknown sections are ignored, the `---`
 * footer and the hidden ref marker are stripped, and a bare body with no sections still recovers.
 */
function parseIssueBody(raw: string): Pick<PlanIssue, "body" | "acceptance" | "owns" | "dependsOn"> {
  const text = (raw ?? "").replace(/<!--\s*bsc:ref=[^>]*-->/g, "").trim();
  const acceptance: string[] = [];
  const owns: string[] = [];
  const dependsOn: string[] = [];
  const prose: string[] = [];
  let section: "body" | "acceptance" | "owns" | "depends" | "other" = "body";

  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      const t = heading[1].toLowerCase();
      section = t.startsWith("acceptance") ? "acceptance"
        : t.startsWith("owns") ? "owns"
        : t.startsWith("depends") ? "depends"
        : "other";
      continue;
    }
    // The auto-gen footer ends the meaningful content.
    if (line === "---" || line.startsWith("_Auto-generated")) { section = "other"; continue; }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (section === "acceptance" && bullet) {
      acceptance.push(bullet[1].replace(/^\[[ xX]\]\s*/, "").trim()); // drop the checkbox
    } else if (section === "owns" && bullet) {
      owns.push(bullet[1].replace(/`/g, "").trim());                  // drop the code ticks
    } else if (section === "depends" && bullet) {
      dependsOn.push(bullet[1].trim());
    } else if (section === "body") {
      prose.push(lineRaw);
    }
  }

  const body = prose.join("\n").trim();
  return {
    body: body || undefined,
    acceptance: acceptance.filter(Boolean),
    owns: owns.filter(Boolean),
    dependsOn: dependsOn.filter(Boolean),
  };
}

/**
 * Reconstruct one {@link PlanIssue} from a GitHub issue. Ref comes from the hidden marker (falling
 * back to `#<number>` so it stays addressable); stream from the `stream:<id>` label;
 * acceptance/owns/dependsOn from the body. GitHub is only open/closed, so a
 * closed issue maps to `verified` (merged + CI green at close) and an open one to `open` — the
 * director can refine an open issue via its linked PR + CI later (the same live-verify signal).
 */
export function recoverIssue(gh: GitHubIssueLike, repoFullName: string): PlanIssue {
  const labelNames = (gh.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name ?? ""))
    .filter(Boolean);
  const streamLabel = labelNames.find((n) => n.startsWith("stream:"));
  const stream = streamLabel ? streamLabel.slice("stream:".length) || undefined : undefined;
  const labels = labelNames.filter((n) => !n.startsWith("stream:"));

  const rawBody = gh.body ?? "";
  const ref = parseRefMarker(rawBody) ?? `#${gh.number}`;
  const status: PlanIssueStatus = gh.state === "closed" ? "verified" : "open";

  return {
    ref,
    title: (gh.title ?? "").trim(),
    stream,
    labels,
    repo: repoFullName,
    status,
    ...parseIssueBody(rawBody),
  };
}

/**
 * Recover every PlanIssue from a repo's GitHub issues. Pull requests (the /issues endpoint returns
 * them too) and titleless rows are dropped.
 */
export function recoverIssues(ghIssues: GitHubIssueLike[], repoFullName: string): PlanIssue[] {
  return (ghIssues ?? [])
    .filter((g) => g && !g.pull_request && (g.title ?? "").trim())
    .map((g) => recoverIssue(g, repoFullName));
}
