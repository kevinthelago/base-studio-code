// SelfWiredKitRenderer (#2868) — a KitRenderer that supplies its OWN interaction host.
//
// The spec model's interactions are declarative but HOST-DRIVEN: a control's value comes from
// `values[key]` (its `binds`) and its behaviour fires `on[action]` (its `actions`). In a real app the
// host wires both. But in the HOST-LESS contexts — the Design Studio / kit preview, a nested composed
// spec rendered with no app behind it — there is no host, so a previewed toggle renders in its default
// state and does nothing on click. This wrapper is the self-wiring default: it keeps a local
// bind-keyed state so every control exhibits its EXPECTED behavior (toggles toggle, selects select,
// fields type), COMPOSING per bind key so a page → composite → toggle each behave independently, and
// resolves every action so clicks are observable instead of dead.
//
// Use this wherever a spec is previewed without an app host. In a real app, pass explicit bindings to
// KitRenderer directly — this never overrides host wiring, it stands in for its absence.
//
// #3500 — HOW A PREVIEW DECIDES WHAT AN ACTION WRITES. The general vocabulary deliberately refuses to
// infer that `onClick` writes `on`: only the host knows what a click MEANS, so a real app names the
// intent as an action. A preview has no host to ask, and the alternative is dead controls, so it
// adopts one rule — driven by the MANIFEST's declared prop types, never by guessing from prop names:
//
//   the bound prop is `boolean` → the action FLIPS it   (a switch switches)
//   otherwise                   → the action SETS it from the handler's first argument
//                                 (`onChange(next)` on a field)
//
// That rule lives here and ONLY here. It is a stand-in for absent behaviour, not part of the contract;
// nothing outside a preview may rely on it.

import { useMemo, useState } from "react";
import { UI_KIT } from "@/shared/ui/manifest";
import { KitRenderer } from "./KitRenderer";
import { visitNodes, collectActions } from "./specWalk";
import type { GeneralNode } from "./generalNode";

/** Primitive name → its manifest spec, for looking up a bound prop's declared type. */
const SPEC_BY_NAME = new Map(UI_KIT.map((p) => [p.name as string, p]));

/** What a fired action should do to the local preview state. */
interface PreviewWrite {
  /** The bind key it writes. */
  key: string;
  /** Flip the boolean (a switch) vs set it from the handler's first argument (a field). */
  flip: boolean;
}

/**
 * Map each action name in the spec to the local state write it should perform, by pairing a node's
 * `actions` with its `binds` and consulting the manifest for the bound prop's type.
 *
 * A node with no `binds` yields no write — its action is observed only (a Save button has nothing to
 * write). If the same action name appears on several bound nodes, the FIRST wins; a preview showing
 * one of them behaving is strictly better than neither, and a real host would have disambiguated.
 */
function previewWrites(root: GeneralNode): Map<string, PreviewWrite> {
  const writes = new Map<string, PreviewWrite>();
  visitNodes(root, (n) => {
    const binds = Object.entries(n.binds ?? {});
    const actions = Object.values(n.actions ?? {});
    if (!binds.length || !actions.length) return;
    const spec = SPEC_BY_NAME.get(n.type);
    const typeOf = (prop: string) => spec?.props.find((p) => p.name === prop)?.type;
    // Prefer a boolean-typed bind (the switch case); otherwise take the first bind as the value.
    const boolBind = binds.find(([prop]) => typeOf(prop) === "boolean");
    const [prop, key] = boolBind ?? binds[0];
    if (typeof key !== "string" || !key) return;
    for (const action of actions) {
      if (typeof action !== "string" || !action || writes.has(action)) continue;
      writes.set(action, { key, flip: typeOf(prop) === "boolean" });
    }
  });
  return writes;
}

export interface SelfWiredKitRendererProps {
  /** The spec tree to render (typically validated via `validateGeneralNode`). */
  node: GeneralNode;
  /** Seed values for the local bind-keyed state (e.g. a toggle that should start on). Defaults empty
   *  — toggles start off, fields start blank. Read once at mount (a preview seed, not a controlled prop). */
  initial?: Record<string, unknown>;
  /** Observe a fired action — the preview host can flash/log it. Defaults to a no-op, so a nested
   *  control is clickable without an app behind it. */
  onAction?: (action: string) => void;
}

export function SelfWiredKitRenderer({ node, initial, onAction }: SelfWiredKitRendererProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial }));
  // Resolve EVERY action in the spec so no control is dead: the ones paired with a bind also write
  // the local state, the rest are observed. Rebuilt only when the spec or observer changes.
  const on = useMemo(() => {
    const writes = previewWrites(node);
    const map: Record<string, (...args: unknown[]) => void> = {};
    for (const action of collectActions(node)) {
      const write = writes.get(action);
      map[action] = (...args: unknown[]) => {
        if (write) {
          setValues((v) => ({
            ...v,
            [write.key]: write.flip ? !v[write.key] : args[0],
          }));
        }
        onAction?.(action);
      };
    }
    return map;
  }, [node, onAction]);
  return <KitRenderer node={node} values={values} on={on} />;
}
