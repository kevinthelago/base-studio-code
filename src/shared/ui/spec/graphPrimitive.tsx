// Graph-first primitive resolution for the declarative-spec renderer (ui-registry-resolves-from-the-graph).
//
// WHY THIS IS NOT IN `registry.tsx`. That file is the render-map: a `Record<PrimitiveName, Component>`
// whose whole value is that a missing or stale row is a COMPILE error, which is what keeps the manifest
// and the map in lock-step. Resolution needs the store and the runtime loader, and pulling those into the
// map would both widen a leaf module's dependency graph and put the exhaustiveness check behind a runtime
// lookup. So the map stays pure and static, and the graph is consulted HERE — at the render seam, the one
// place that actually mounts a primitive.
//
// The order is graph-first with a code fallback, matching `routeImport`: a record that `provides` the
// primitive's module specifier wins over the bundled component, and the bundled component is what renders
// while that record compiles or if it fails. `GraphComponent` already owns compile / last-good / error
// boundary, so this is a thin adapter over it, not a second loader.
import { type ComponentType } from "react";
import { useAppStore } from "@/store";
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { componentFor } from "@/shared/ui/registry";
import { UI_KIT, type PrimitiveName } from "@/shared/ui/manifest";

// Heterogeneous prop shapes — a render-map is intentionally prop-agnostic (mirrors registry.tsx).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

/** Primitive name → the `@/…` specifier it is exported from. The manifest ALREADY carries this as
 *  `importPath`, and a record's `provides` is the same string — so the name→record join needs no new
 *  hand-maintained table, which is the thing that would have rotted. */
const SPEC_BY_NAME = new Map<string, string>(UI_KIT.map((p) => [p.name as string, p.importPath]));

/** Wrapper components, keyed by record id. MEMOISED because identity is load-bearing: a fresh component
 *  function each render is a different type to React, which unmounts and remounts the whole subtree on
 *  every parent render — losing focus, scroll and state. Keying on the id (not the source) is deliberate:
 *  `GraphComponent` subscribes to that id's `srcText` itself, so an edit still recompiles in place while
 *  the identity stays put. */
const wrappers = new Map<string, AnyComponent>();

function wrapperFor(id: string, name: string, Static: AnyComponent): AnyComponent {
  // Keyed on record + PRIMITIVE, not the record alone. One record can serve several primitives (see
  // `primitiveFor`), and an id-keyed cache would hand the second one the wrapper built for the first.
  const key = `${id}#${name}`;
  const cached = wrappers.get(key);
  if (cached) return cached;
  function GraphPrimitive(props: Record<string, unknown>) {
    // `fallback` covers BOTH the async gap and every failure path — while the record compiles, and if it
    // fails to compile or throws while rendering. A primitive that renders nothing is worse than one that
    // renders the bundled version: a blank is indistinguishable from "the data said render nothing".
    return <GraphComponent id={id} exportName={name} props={props} fallback={<Static {...props} />} />;
  }
  GraphPrimitive.displayName = `GraphPrimitive(${id}:${name})`;
  wrappers.set(key, GraphPrimitive);
  return GraphPrimitive;
}

/**
 * Resolve a primitive name to the component the renderer should mount.
 *
 * Graph-backed when a packaged record `provides` its specifier; the bundled component otherwise — which
 * covers the 24 manifest primitives with no record today, including `Slot`, which will never have one
 * (the renderer resolves it itself: it is a hole the host fills, not a component).
 *
 * A record provides a MODULE, so the primitive NAME is passed on as the export to mount. 14 of the 69
 * primitives share 3 specifiers — `@/shared/ui/controls/Field` alone exports TextField, TextArea and
 * SelectField — and joining on the specifier alone collapsed all of them onto whichever component the
 * loader picked first, which is how a password field rendered as a `<select>`. The manifest's `importPath`
 * plus the primitive's own name is the full join; neither half is enough.
 *
 * Reads a store SNAPSHOT rather than subscribing, because the caller (`renderNode`) is a plain recursive
 * function, not a component, so it cannot hold a hook. The consequence is bounded and known: a record
 * ADDED while a tree is already mounted is picked up on the next render of that tree, not immediately.
 * Edits to an already-resolved record are live, since `GraphComponent` subscribes to its own source.
 */
export function primitiveFor(name: PrimitiveName): AnyComponent | undefined {
  const Static = componentFor(name);
  const spec = SPEC_BY_NAME.get(name);
  if (!spec || !Static) return Static;
  const record = useAppStore.getState().components.find((c) => c.provides === spec);
  return record ? wrapperFor(record.id, name, Static) : Static;
}

/** Test seam — the wrapper cache is module-global by design (identity must outlive a render). */
export function __resetPrimitiveCache(): void {
  wrappers.clear();
}
