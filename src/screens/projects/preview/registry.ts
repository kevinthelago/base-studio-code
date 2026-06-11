// Renderer registry and handle interfaces for the preview feed consumer (#581).
// Each renderer is keyed by one or more RenderableKinds. The registry is module-level
// so renderers self-register on import; the shell calls getRenderer(kind) to dispatch.

import type { RenderableKind, RenderableChunk, PreviewStatus } from './types';

/**
 * An imperative handle to a mounted renderer surface. The shell holds this ref and
 * calls update() for every arriving chunk — zero React re-renders on the hot path.
 */
export interface RendererHandle {
  /** Deliver a new chunk to the surface imperatively (no React setState). */
  update(chunk: RenderableChunk): void;
  /** Subscribe to renderer-reported status changes (called once after mount). */
  onStatus(cb: (s: PreviewStatus) => void): void;
  /** Remove the surface from the container and clean up all listeners. */
  teardown(): void;
}

/**
 * A pluggable renderer: declares the kind(s) it handles, mounts a surface into a
 * container element, and returns a handle for imperative updates.
 */
export interface PreviewRenderer {
  kind: RenderableKind | RenderableKind[];
  mount(container: HTMLElement, initial: RenderableChunk): RendererHandle;
}

const REGISTRY = new Map<RenderableKind, PreviewRenderer>();

/** Register a renderer for its declared kind(s). Last registration wins (idempotent). */
export function registerRenderer(renderer: PreviewRenderer): void {
  const kinds: RenderableKind[] = Array.isArray(renderer.kind) ? renderer.kind : [renderer.kind];
  for (const k of kinds) REGISTRY.set(k, renderer);
}

/** Look up the renderer for a kind. Returns undefined when none is registered. */
export function getRenderer(kind: RenderableKind): PreviewRenderer | undefined {
  return REGISTRY.get(kind);
}

/** True when a renderer is registered for the given kind. */
export function hasRenderer(kind: RenderableKind): boolean {
  return REGISTRY.has(kind);
}

/** Test helper — reset the registry between cases. */
export function _resetRegistry(): void {
  REGISTRY.clear();
}
