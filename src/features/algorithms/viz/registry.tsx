// The pluggable structure-renderer registry (#3176, epic #3171) — the injection point every per-structure
// renderer (#3178–#3185) plugs into WITHOUT editing the player. The player takes a `RendererRegistry`
// (a `Partial<Record<StructureName, StructureRenderer>>`) and dispatches each panel to its structure's
// renderer, or the `fallbackRenderer` when none is registered — so a missing renderer degrades, never
// crashes.
//
// A renderer for structure `S` is a React component over that structure's OWN frame type (`FrameOf<S>`),
// so a `StructureRenderer<"array">` receives an `ArrayFrame`. The registry map is typed per-key, so
// authoring is type-safe: `const registry: RendererRegistry = { array: ArrayView }`.

import type { ComponentType } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import type { FrameOf, StructureFrame, StructureName } from "../lib/trace";

/** A renderer for structure `S` — a React component over that structure's frame type (`FrameOf<S>`).
 *  Defaulting `S` to the whole union yields the erased shape the player dispatches through
 *  (a component over any `StructureFrame`), which the {@link fallbackRenderer} satisfies. */
export type StructureRenderer<S extends StructureName = StructureName> = ComponentType<{ frame: FrameOf<S> }>;

/** The injected map the player consumes — a per-structure renderer for zero or more structures. Each
 *  entry is typed to its own frame (`array` → a renderer over `ArrayFrame`). Equivalent to
 *  `Partial<Record<StructureName, StructureRenderer>>` but key-precise. The renderer issues add entries
 *  here; the player never changes. */
export type RendererRegistry = { [S in StructureName]?: StructureRenderer<S> };

/**
 * Resolve the renderer for a panel's structure — the registered one, else the {@link fallbackRenderer}.
 * The single, guarded cast site: the player looks a renderer up by the panel's OWN `structure`, so the
 * runtime frame always matches the resolved renderer's narrowed frame type even though the map's union
 * value type can't prove it statically.
 */
export function resolveRenderer(registry: RendererRegistry, structure: StructureName): StructureRenderer {
  return (registry[structure] as StructureRenderer | undefined) ?? fallbackRenderer;
}

/**
 * The default renderer for any structure with no registered renderer — prints the structure name + a
 * JSON dump of the frame. Keeps the player useful before the concrete renderers (#3178–#3185) land, and
 * makes an unregistered structure legible instead of a crash.
 */
export const fallbackRenderer: StructureRenderer = ({ frame }: { frame: StructureFrame }) => (
  <Stack gap={4} className="trace-fallback">
    <Eyebrow size={10}>{frame.structure}</Eyebrow>
    <Box as="pre" className="trace-fallback-json mono">
      {JSON.stringify(frame, null, 2)}
    </Box>
  </Stack>
);
