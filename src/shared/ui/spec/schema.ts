// The spec-first UI SDK (#1852 Phase 2) — the typed `KitNode` union an AI emits as data plus a
// data-driven validator. A KitNode is a declarative, style/theme-independent description of UI: the
// agent writes the tree ONCE and `KitRenderer` renders it through the active kit's primitives, so
// switching style/theme never touches the spec. The contract lives ONCE in `@data/ui/kit-nodes.json`
// (also served + enforced by `bsc ui`); the TS union below is the typed face of that same file, and
// `nodeKindsMatchContract` (schema.test.ts) guards the two never drift.

import CONTRACT from "@data/ui/kit-nodes.json";

/** The node contract (kinds → allowed/required fields, enums, children-bearing) — the single source
 *  of truth, shared byte-for-byte with the `bsc ui` CLI. */
export const NODE_CONTRACT = CONTRACT as KitContract;

export interface KitNodeSpec {
  doc: string;
  fields: string[];
  required: string[];
  children: boolean;
  enums?: Record<string, string[]>;
}
export interface KitContract {
  version: number;
  note: string;
  nodes: Record<string, KitNodeSpec>;
}

/** Every node kind the contract defines. */
export type NodeKind = keyof typeof CONTRACT.nodes;

// ── The typed KitNode union — the agent's contract, the typed face of kit-nodes.json ────────────

export interface CardNode {
  kind: "card";
  /** Border accent, e.g. "var(--accent)". */
  tone?: string;
  title?: string;
  hint?: string;
  /** A fully-composed head node (wins over `title`). */
  header?: HeaderNode;
  children: KitNode[];
}
export interface HeaderNode {
  kind: "header";
  title: string;
  hint?: string;
}
export interface FieldNode {
  kind: "field";
  control: "text" | "password" | "select";
  label: string;
  hint?: string;
  /** Host state key this control's value reads from / writes to. */
  bind?: string;
  /** A select's choices. */
  options?: string[];
  /** Native input type override for a text control (e.g. "email"). */
  inputType?: string;
  placeholder?: string;
}
export interface ButtonNode {
  kind: "button";
  label: string;
  variant?: "default" | "primary" | "ghost";
  danger?: boolean;
  /** Host callback fired on click. */
  action?: string;
}
export interface RowNode {
  kind: "row";
  label?: string;
  children: KitNode[];
}
export interface ToggleNode {
  kind: "toggle";
  /** Host state key the on/off reads from / writes to. */
  bind: string;
  label?: string;
}
export interface TagNode {
  kind: "tag";
  label: string;
  tone?: "neutral" | "accent" | "success" | "info" | "danger";
}
export interface TextNode {
  kind: "text";
  text: string;
  tone?: string;
  size?: string | number;
}

export type KitNode =
  | CardNode
  | HeaderNode
  | FieldNode
  | ButtonNode
  | RowNode
  | ToggleNode
  | TagNode
  | TextNode;

// ── Validation — data-driven from NODE_CONTRACT, mirroring `bsc ui validate` exactly ────────────

function isNode(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Structurally validate a KitNode tree against the contract. Returns a flat list of human-readable
 * errors (empty = valid). Checks, at every node: `kind` is present + known · every required field
 * present · no field outside the kind's allowed set · enum fields hold an allowed value · a
 * children-bearing kind's `children` (when present) is an array — and recurses into any nested node
 * (`header`) or array-of-nodes (`children`). This is the EXACT contract `bsc ui validate` enforces
 * (crates/bsc-ui), so a spec that passes here passes there.
 *
 * @param node - the value to validate (typically parsed from agent-emitted JSON)
 * @param path - dotted path used to locate errors (defaults to "$")
 */
export function validateKitNode(node: unknown, path = "$"): string[] {
  const errors: string[] = [];
  walk(node, path, errors);
  return errors;
}

function walk(node: unknown, path: string, errors: string[]): void {
  if (!isNode(node)) {
    errors.push(`${path}: expected a node object`);
    return;
  }
  const kind = node.kind;
  if (typeof kind !== "string") {
    errors.push(`${path}: missing string "kind"`);
    return;
  }
  const spec = NODE_CONTRACT.nodes[kind];
  if (!spec) {
    errors.push(`${path}: unknown kind "${kind}"`);
    return;
  }
  const allowed = new Set([...spec.fields, "kind"]);
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) errors.push(`${path}: unknown field "${key}" for kind "${kind}"`);
  }
  for (const req of spec.required) {
    if (node[req] == null) errors.push(`${path}: missing required field "${req}" for kind "${kind}"`);
  }
  for (const [field, values] of Object.entries(spec.enums ?? {})) {
    const v = node[field];
    if (v != null && !values.includes(v as string)) {
      errors.push(`${path}.${field}: "${String(v)}" not one of ${values.join(", ")}`);
    }
  }
  // Recurse nested nodes: any field value that is itself a node, or an array of nodes.
  for (const [field, value] of Object.entries(node)) {
    if (field === "kind") continue;
    if (Array.isArray(value)) {
      value.forEach((child, i) => {
        if (isNode(child) && "kind" in child) walk(child, `${path}.${field}[${i}]`, errors);
      });
    } else if (isNode(value) && "kind" in value) {
      walk(value, `${path}.${field}`, errors);
    }
  }
}
