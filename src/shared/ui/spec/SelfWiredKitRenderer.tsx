// SelfWiredKitRenderer (#2868) — a KitRenderer that supplies its OWN interaction host.
//
// The spec model's interactions are declarative but HOST-DRIVEN: a `toggle`/`field`'s value comes
// from `values[bind]` and writes back through `onBind`; a `button`'s click fires `on[action]`. In a
// real app the host wires those. But in the HOST-LESS contexts — the Design Studio / kit preview, a
// nested composed spec rendered with no app behind it — there's no host, so a nested toggle renders
// in its default state and does nothing on click. This wrapper is the self-wiring default: it keeps a
// local `bind`-keyed state so every control exhibits its EXPECTED behavior (toggles toggle, selects
// select, fields type), COMPOSING per bind key so a page → composite → toggle each behave
// independently, and resolves every button `action` so clicks are observable instead of dead.
//
// Use this wherever a spec is previewed without an app host. In a real app, pass explicit bindings to
// KitRenderer directly — this never overrides host wiring, it stands in for its absence.

import { useCallback, useMemo, useState } from "react";
import { KitRenderer } from "./KitRenderer";
import { collectActions } from "./specWalk";
import type { KitNode } from "./schema";

export interface SelfWiredKitRendererProps {
  /** The spec tree to render (typically validated via `validateKitNode`). */
  node: KitNode;
  /** Seed values for the local bind-keyed state (e.g. a toggle that should start on). Defaults empty
   *  — toggles start off, fields start blank. Read once at mount (a preview seed, not a controlled prop). */
  initial?: Record<string, unknown>;
  /** Observe a fired button `action` — the preview host can flash/log it. Defaults to a no-op, so a
   *  nested button is clickable without an app behind it. */
  onAction?: (action: string) => void;
}

export function SelfWiredKitRenderer({ node, initial, onAction }: SelfWiredKitRendererProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial }));
  const onBind = useCallback((bind: string, value: unknown) => {
    setValues((v) => ({ ...v, [bind]: value }));
  }, []);
  // Resolve every button `action` in the spec to a handler so a nested button click is observed
  // (defaults to a no-op) rather than dead. Rebuilt only when the spec or observer changes.
  const on = useMemo(() => {
    const map: Record<string, () => void> = {};
    for (const action of collectActions(node)) map[action] = () => onAction?.(action);
    return map;
  }, [node, onAction]);
  return <KitRenderer node={node} values={values} onBind={onBind} on={on} />;
}
