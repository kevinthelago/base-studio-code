// KitRenderer (#1852 Phase 2) — renders a declarative node tree through the shared UI primitives,
// wiring each node's `binds` (host state a control reads) and `actions` (host callbacks it fires) to
// the values/handlers the host passes in. The agent authors the spec as data; the host owns the
// wiring — the agent never writes an onChange or an onClick. Switching the underlying kit/theme later
// is a renderer change here, never a change to the spec the agent emitted.
//
// #3500 — there is no per-node branch left. The renderer used to carry a hand-written `switch` over 8
// hardcoded kinds, so the authorable vocabulary was whatever this file happened to implement; a new
// primitive meant editing the union, the contract, the validator AND this switch. Now a node names a
// REAL component and everything is resolved from the manifest: adding a primitive makes it authorable
// with no edit here at all.

import { Fragment, type ComponentType, type ReactNode } from "react";
import { Text } from "@/shared/ui/typography/Text";
import { componentFor } from "@/shared/ui/registry";
import { UI_KIT } from "@/shared/ui/manifest";
import type { GeneralNode } from "./generalNode";

/** Primitive name → its manifest spec, for looking up a prop's declared TYPE at render time. */
const SPEC_BY_NAME = new Map(UI_KIT.map((p) => [p.name as string, p]));

/** A node-ish value — matching what the validator will descend into, so anything that validates renders. */
function isNodeLike(v: unknown): boolean {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).type === "string"
  );
}

/** Render a slot value: a list of nodes, a single node, or plain text — mirroring what the validator
 *  accepts for a `node`-typed prop. */
function renderSlot(value: unknown, ctx: KitBindings, key: string): ReactNode {
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      isNodeLike(v) ? renderNode(v as GeneralNode, ctx, `${key}[${i}]`) : (v as ReactNode),
    );
  }
  if (isNodeLike(value)) return renderNode(value as GeneralNode, ctx, key);
  return value as ReactNode;
}

/**
 * Render a node by resolving its `type` through the registry (#3494) — no per-primitive branch.
 *
 * Props pass through except where the manifest declares their TYPE, which is how the renderer knows
 * what to do without guessing from names:
 * - `function` ⇒ the value is an ACTION NAME (the 3a contract), resolved against `ctx.on`. A data tree
 *   never carries a function, so this is the ONLY way a handler can arrive.
 * - `node` ⇒ a slot, rendered recursively.
 *
 * An unresolvable `type` renders a VISIBLE error rather than null: a silent blank in a data-driven UI
 * is indistinguishable from "the data said render nothing", which is precisely the failure this whole
 * migration must not introduce. It does not throw — that would white-screen a production surface over
 * one bad node.
 */
function renderNode(node: GeneralNode, ctx: KitBindings, key: string): ReactNode {
  // `Slot` (#3504) is the ONE structural node the renderer resolves itself, because it is not a
  // component: it is a hole the host fills. Everything else resolves through the registry, and this
  // is deliberately not the start of a per-type switch — a slot has no rendering of its own to pick.
  // An unfilled name falls through to the `Slot` component, which states the problem visibly rather
  // than rendering nothing (a blank panel is indistinguishable from an intentionally empty layout).
  if (node.type === "Slot") {
    const name = String(node.props?.name ?? "");
    const filled = ctx.slots?.[name];
    if (filled !== undefined) return <Fragment key={key}>{filled}</Fragment>;
  }
  const Comp = componentFor(node.type);
  if (!Comp) {
    return (
      <Text key={key} tone="danger" size="sm">
        {`[unknown primitive "${node.type}" — not in the UI registry]`}
      </Text>
    );
  }
  const spec = SPEC_BY_NAME.get(node.type);
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.props ?? {})) {
    const declared = spec?.props.find((p) => p.name === name);
    if (declared?.type === "function") {
      // The value is an action name; bind it to the host callback. An unknown name becomes a no-op
      // rather than a crash — the same tolerance the legacy `button` branch always had.
      // Arguments are FORWARDED: a handler like `TextField.onChange(next)` carries the new value, and
      // dropping it would make every text/select field in a data-driven UI unwritable.
      const action = typeof value === "string" ? value : "";
      props[name] = (...args: unknown[]) => ctx.on?.[action]?.(...args);
      continue;
    }
    if (declared?.type === "node") {
      props[name] = renderSlot(value, ctx, `${key}.${name}`);
      continue;
    }
    props[name] = value;
  }

  // `binds` (#3500): read host state INTO a prop — the mirror of `actions`, state in / behaviour out.
  // Writes are NOT derived here: that would mean knowing `on` pairs with `onClick`, a pairing the
  // manifest does not declare, so the host names its intent as an action instead.
  for (const [propName, stateKey] of Object.entries(node.binds ?? {})) {
    props[propName] = ctx.values?.[stateKey];
  }

  // `actions` (#3496). Applied AFTER the declared-prop pass so it wins on a conflict: it is the more
  // explicit statement, and letting the implicit path override an explicit one would be surprising
  // precisely when an author is trying to be unambiguous. This is also the ONLY way to bind a handler
  // on a `passthrough` primitive (e.g. `Button.onClick`), whose handlers are undeclared.
  for (const [propName, actionName] of Object.entries(node.actions ?? {})) {
    props[propName] = (...args: unknown[]) => ctx.on?.[actionName]?.(...args);
  }

  // Node-level `children` is sugar for the `children` prop (the 3a normalisation) — resolved here too,
  // so a tree that validates renders.
  const children =
    node.children !== undefined ? renderSlot(node.children, ctx, `${key}.children`) : props.children;
  delete props.children;
  const C = Comp as ComponentType<Record<string, unknown>>;
  return (
    <C key={key} {...props}>
      {children as ReactNode}
    </C>
  );
}

/** The host-supplied wiring a rendered spec binds to. */
export interface KitBindings {
  /** Current host state, keyed by a node's `binds` values. */
  values?: Record<string, unknown>;
  /** Host-supplied React, keyed by a `Slot` node's `name` (#3504) — the seam for the parts of a page a
   *  spec cannot express (a feature component owning hooks, queries or app state). The spec says
   *  where; this says what. */
  slots?: Record<string, ReactNode>;
  /** Host callbacks, keyed by an action name (a node's `actions` map, or a `function`-typed prop whose
   *  value is the name). Called with whatever the underlying handler was called with — a click event
   *  for `onClick`, the new value for `onChange` — so a host can write a field back. */
  on?: Record<string, (...args: unknown[]) => void>;
}

export interface KitRendererProps extends KitBindings {
  /** The spec tree to render (typically the agent's emitted JSON, validated before rendering). */
  node: GeneralNode;
}

/** Render a node tree. `values`/`on` wire the spec's `binds`/`actions` to host state and behaviour. */
export function KitRenderer({ node, values, on, slots }: KitRendererProps) {
  return <>{renderNode(node, { values, on, slots }, "$")}</>;
}
