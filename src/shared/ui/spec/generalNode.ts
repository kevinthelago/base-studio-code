// The GENERAL node — `{ type, props, children }` over the full primitive registry (#3485, slice 3a of
// the keystone #3484).
//
// The existing `KitNode` union covers 8 hardcoded kinds against ~60 primitives in the manifest. This is
// the open form that replaces it (the 8 are deleted in 3c, once the renderer can render this in 3b).
//
// THE VOCABULARY IS DERIVED, NOT DECLARED. Both the set of valid `type`s and the per-type prop rules
// come from `UI_KIT` (`shared/ui/manifest.ts`), so adding a primitive there makes it authorable here
// with no edit to this file. A hand-maintained mirror would drift, and a contract that drifts from the
// code is worse than no contract — agents author against it.
import { UI_KIT, type PrimitiveName, type PropSpec } from "../manifest";
import type { KitNode } from "./schema";

/** A node addressing any primitive in the manifest. `props` is open; the validator constrains it. */
export interface GeneralNode {
  type: PrimitiveName;
  props?: Record<string, unknown>;
  /**
   * Children — general nodes, the legacy kinds (while both vocabularies coexist, 3c), or plain TEXT.
   *
   * Text is included because the manifest types `children` as `node`, and a `node` slot legitimately
   * holds text — `<Text>hello</Text>` is the commonest node in the tree. An array-only type here would
   * be NARROWER than what the validator accepts, and a type that disagrees with the contract it
   * describes is worse than no type: the compiler would reject trees the runtime happily validates.
   */
  children?: Array<GeneralNode | KitNode> | string | number;
}

/** Every primitive name the manifest defines — the closed `type` vocabulary. */
export const PRIMITIVE_NAMES: readonly string[] = UI_KIT.map((p) => p.name);

const BY_NAME = new Map(UI_KIT.map((p) => [p.name as string, p]));

/**
 * What the validator can and cannot enforce, stated exactly (#3485).
 *
 * `PropSpec.type` is a CLOSED 13-member union with an explicit `values` list for enums, so most props
 * get real enforcement. The two genuine gaps are `array` and `object`, whose element/field shapes the
 * manifest keeps in prose (`description`) rather than as a machine-readable schema — so the container
 * type is checked and its CONTENTS are not.
 *
 * This is published rather than left implicit on purpose: `bsc ui validate` reporting "valid" while
 * silently meaning "the names look right" is a half-truth that gets trusted and then bites. Anything
 * that consumes this contract can read exactly where the guarantees stop.
 */
export const VALIDATION_COVERAGE: Readonly<Record<string, "checked" | "container-only">> = {
  string: "checked",
  number: "checked",
  boolean: "checked",
  enum: "checked",
  node: "checked",
  function: "checked",
  color: "checked",
  space: "checked",
  fontSize: "checked",
  tracks: "checked",
  style: "container-only",
  array: "container-only",
  object: "container-only",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A node-ish value: a general node (`type`) or a legacy kind node (`kind`). */
function isNodeLike(v: unknown): boolean {
  return isPlainObject(v) && (typeof v.type === "string" || typeof v.kind === "string");
}

/**
 * Check one prop VALUE against its spec. Returns an error message, or null when acceptable.
 *
 * Note `function`: in a data tree a handler can never be a literal — it is the NAME of an action the
 * host exposes (the `bind`/`action` seam). So requiring a string here is not a weaker check than a type
 * check, it is a stricter and more meaningful one: a serialized function would be nonsense, and an
 * inline arrow would mean the tree had stopped being data.
 */
function checkValue(spec: PropSpec, value: unknown): string | null {
  switch (spec.type) {
    case "string":
      return typeof value === "string" ? null : `expected a string`;
    case "number":
      return typeof value === "number" ? null : `expected a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `expected a boolean`;
    case "enum": {
      const allowed = spec.values ?? [];
      if (allowed.length === 0) return null; // an enum with no declared set constrains nothing
      return allowed.includes(value as string)
        ? null
        : `"${String(value)}" is not one of ${allowed.join(", ")}`;
    }
    case "node":
      // A slot: a child node, a list of them, or plain text.
      if (typeof value === "string" || typeof value === "number") return null;
      if (Array.isArray(value)) return value.every(isNodeLike) ? null : `expected nodes or text`;
      return isNodeLike(value) ? null : `expected a node, a list of nodes, or text`;
    case "function":
      return typeof value === "string"
        ? null
        : `expected an action NAME (a string) — a data tree binds handlers by name, it cannot carry a function`;
    case "color":
      return typeof value === "string" ? null : `expected a color string (token or CSS color)`;
    case "space":
    case "fontSize":
      return typeof value === "number" || typeof value === "string"
        ? null
        : `expected a rung name or a number`;
    case "tracks":
      return typeof value === "number" || typeof value === "string"
        ? null
        : `expected a track count (number) or a template string`;
    case "style":
      return isPlainObject(value) ? null : `expected a style object`;
    case "array":
      // Contents deliberately unchecked — see VALIDATION_COVERAGE.
      return Array.isArray(value) ? null : `expected an array`;
    case "object":
      return isPlainObject(value) ? null : `expected an object`;
    default:
      return null;
  }
}

/**
 * Structurally validate a general node tree against the manifest. Returns a flat list of human-readable
 * errors (empty = valid), in the same shape as {@link validateKitNode} so both vocabularies report
 * identically while they coexist.
 *
 * At every node: `type` present and a real primitive · every required prop present · no prop outside
 * the primitive's declared set (UNLESS it declares `passthrough`, which legitimately accepts arbitrary
 * DOM props) · every present prop's value acceptable for its declared `PropType` · recursion into
 * `children` and into any node-valued prop.
 *
 * @param node - the value to validate (typically parsed from agent-emitted JSON)
 * @param path - dotted path used to locate errors (defaults to "$")
 */
export function validateGeneralNode(node: unknown, path = "$"): string[] {
  const errors: string[] = [];
  walkGeneral(node, path, errors);
  return errors;
}

function walkGeneral(node: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(node)) {
    errors.push(`${path}: expected a node object`);
    return;
  }
  const type = node.type;
  if (typeof type !== "string") {
    errors.push(`${path}: missing string "type"`);
    return;
  }
  const spec = BY_NAME.get(type);
  if (!spec) {
    errors.push(`${path}: unknown primitive "${type}"`);
    return;
  }

  const props = node.props;
  if (props !== undefined && !isPlainObject(props)) {
    errors.push(`${path}.props: expected an object`);
    return;
  }
  // Node-level `children` is SUGAR for the `children` PROP. The manifest models children the way React
  // does — a prop of type `node`, declared REQUIRED on containers (Stack/Row/Card/…) — but writing a
  // tree as `props: { children: [...] }` at every level is miserable. Normalising here means both forms
  // validate identically, and a bare `children` is not misread as "missing required prop".
  const given: Record<string, unknown> = { ...((props ?? {}) as Record<string, unknown>) };
  if (node.children !== undefined) given.children = node.children;
  const byProp = new Map(spec.props.map((p) => [p.name, p]));

  // Unknown props — skipped for a passthrough primitive, which forwards arbitrary DOM props
  // (className/style/data-*/handlers) to its root by design. Flagging those would be a false positive.
  if (!spec.passthrough) {
    for (const key of Object.keys(given)) {
      if (!byProp.has(key)) errors.push(`${path}.props.${key}: unknown prop for "${type}"`);
    }
  }

  for (const p of spec.props) {
    const v = given[p.name];
    if (p.required && v == null) {
      errors.push(`${path}.props.${p.name}: missing required prop for "${type}"`);
      continue;
    }
    if (v == null) continue; // an absent optional prop takes the component's default
    const err = checkValue(p, v);
    if (err) errors.push(`${path}.props.${p.name}: ${err}`);
  }

  // Recurse into every node-valued prop (a slot) — `children` included, since it was normalised above.
  // The error path reports where the value was WRITTEN (`$.children[0]` vs `$.props.children[0]`) so a
  // message points at the author's own source rather than at the normalised form.
  const wroteChildrenAtNodeLevel = node.children !== undefined;
  for (const [name, value] of Object.entries(given)) {
    if (byProp.get(name)?.type !== "node") continue;
    const where = name === "children" && wroteChildrenAtNodeLevel ? `${path}.children` : `${path}.props.${name}`;
    if (Array.isArray(value)) {
      value.forEach((child, i) => {
        if (isNodeLike(child)) walkAny(child, `${where}[${i}]`, errors);
      });
    } else if (isNodeLike(value)) {
      walkAny(value, where, errors);
    }
  }
}

/** Dispatch to the right validator while the general form and the legacy kinds coexist (3c removes this). */
function walkAny(node: unknown, path: string, errors: string[]): void {
  if (isPlainObject(node) && typeof node.kind === "string") return; // a legacy node — validateKitNode owns it
  walkGeneral(node, path, errors);
}
