// Shared ProjectV2 (GitHub Projects) GraphQL response parsing (#1529). The planner/github screens
// (Issues, ProjectBoard, Insights) each fetch a `projectsV2` node and walk its fields + items the
// same way: read the Status single-select options, then iterate items, skip non-Issue content, and
// map each issue into a screen-specific row. This factors that walk; each screen supplies its own
// `mapIssue`.

/** A ProjectV2 item field-value node — we only read single-select (Status) values. */
export interface ProjectV2FieldValue {
  name?: string;
  optionId?: string;
  field?: { name: string };
}

/** A ProjectV2 item. `content` is the underlying Issue/PR/draft, typed loosely so each screen
 *  narrows it via its own `mapIssue` (it always carries `__typename`). */
export interface ProjectV2Item {
  id: string;
  fieldValues: { nodes: ProjectV2FieldValue[] };
  content?: ({ __typename?: string } & Record<string, unknown>) | null;
}

/** A single-select option — the Status column values. */
export interface ProjectV2StatusOption {
  id: string;
  name: string;
  color: string;
}

interface ProjectV2Field {
  id?: string;
  name?: string;
  options?: ProjectV2StatusOption[];
}

/** The `node` of a `projectsV2` GraphQL response (the `data.node` returned by `github_graphql`). */
export interface ProjectV2Node {
  fields?: { nodes: ProjectV2Field[] };
  items: { nodes: ProjectV2Item[] };
}

/** The Status single-select field's options in board order (`[]` when there's no Status field). */
export function parseProjectV2Fields(node: ProjectV2Node | undefined): ProjectV2StatusOption[] {
  const statusField = node?.fields?.nodes?.find((f) => f.name === "Status" && f.options);
  return statusField?.options ?? [];
}

/** An item's Status field-value (its single-select `name` + `optionId`), if any. */
export function statusFieldValue(item: ProjectV2Item): ProjectV2FieldValue | undefined {
  return item.fieldValues.nodes.find((fv) => fv.field?.name === "Status");
}

/**
 * Walk a ProjectV2 node's items, keep only `Issue` content, and map each surviving item via
 * `mapIssue` — which receives the narrowed issue content (type `C`, supplied by the caller) plus
 * the raw item (for `item.id` and `item.fieldValues`).
 */
export function parseProjectV2Items<C, T>(
  node: ProjectV2Node | undefined,
  mapIssue: (content: C, item: ProjectV2Item) => T,
): T[] {
  if (!node?.items?.nodes) return [];
  const out: T[] = [];
  for (const item of node.items.nodes) {
    const content = item.content;
    if (!content || content.__typename !== "Issue") continue;
    out.push(mapIssue(content as unknown as C, item));
  }
  return out;
}
