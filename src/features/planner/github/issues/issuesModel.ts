import { parseProjectV2Items, statusFieldValue, type ProjectV2Node } from "@/features/github/lib/projectV2";
import type { GhLabel } from "@/shared/lib/github/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GhUser  { login: string }

export interface FlatIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
  labels: GhLabel[];
  assignees: GhUser[];
  comments: number;
  milestone: string | null;
  statusName: string | null;   // project Status field value
}

export type StateFilter  = "all" | "open" | "closed";
export type SortKey      = "newest" | "oldest" | "number" | "comments";

export interface Filters {
  search: string;
  state: StateFilter;
  label: string;
  milestone: string;
  sort: SortKey;
}

// ── GraphQL query ─────────────────────────────────────────────────────────────

export const ISSUES_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          id
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
          content {
            __typename
            ... on Issue {
              number title body state updatedAt
              labels(first: 5)    { nodes { name color } }
              assignees(first: 3) { nodes { login } }
              comments            { totalCount }
              milestone           { title }
            }
          }
        }
      }
    }
  }
}`;

// ── Derivations ───────────────────────────────────────────────────────────────

export function parseIssues(node: ProjectV2Node | undefined): FlatIssue[] {
  return parseProjectV2Items<{
    number: number; title: string; body: string;
    state: "OPEN" | "CLOSED"; updatedAt: string;
    labels: { nodes: GhLabel[] };
    assignees: { nodes: GhUser[] };
    comments: { totalCount: number };
    milestone?: { title: string } | null;
  }, FlatIssue>(node, (c, item) => ({
    id: item.id,
    number: c.number,
    title: c.title,
    body: c.body ?? "",
    state: c.state,
    updatedAt: c.updatedAt,
    labels: c.labels.nodes,
    assignees: c.assignees.nodes,
    comments: c.comments.totalCount,
    milestone: c.milestone?.title ?? null,
    statusName: statusFieldValue(item)?.name ?? null,
  }));
}

export function deriveLabels(issues: FlatIssue[]): string[] {
  return [...new Set(issues.flatMap(i => i.labels.map(l => l.name)))].sort();
}

export function deriveMilestones(issues: FlatIssue[]): string[] {
  return [...new Set(issues.map(i => i.milestone).filter((m): m is string => m !== null))].sort();
}

export function applyFilters(issues: FlatIssue[], filters: Filters): FlatIssue[] {
  let list = issues;
  if (filters.state !== "all") {
    list = list.filter(i => i.state === (filters.state === "open" ? "OPEN" : "CLOSED"));
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    list = list.filter(i =>
      i.title.toLowerCase().includes(q) ||
      String(i.number).includes(q) ||
      i.labels.some(l => l.name.toLowerCase().includes(q))
    );
  }
  if (filters.label) {
    list = list.filter(i => i.labels.some(l => l.name === filters.label));
  }
  if (filters.milestone) {
    list = list.filter(i => i.milestone === filters.milestone);
  }
  switch (filters.sort) {
    case "newest":   return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    case "oldest":   return [...list].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    case "number":   return [...list].sort((a, b) => b.number - a.number);
    case "comments": return [...list].sort((a, b) => b.comments - a.comments);
    default:         return list;
  }
}
