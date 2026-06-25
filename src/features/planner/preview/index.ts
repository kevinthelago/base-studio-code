// Preview feed consumer module (#581). Public surface for the renderer registry and
// types. Renderer side-effects are imported in stageScreens.tsx (the mount point);
// this file provides re-exports for external consumers and tests.

export { PreviewPaneShell } from './PreviewPaneShell';
export type { RenderableKind, RenderableChunk, PreviewStatus } from './types';
export { registerRenderer, getRenderer, hasRenderer, _resetRegistry } from './registry';
export type { PreviewRenderer, RendererHandle } from './registry';
