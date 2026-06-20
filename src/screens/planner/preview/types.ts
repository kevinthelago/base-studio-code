// Core types for the modular streaming preview feed consumer (#581).

/** The set of renderable content kinds the registry dispatches on. */
export type RenderableKind =
  | 'react-bundle'
  | 'html'
  | 'gltf'
  | 'scene'
  | 'image'
  | 'video-frame';

/**
 * A chunk arriving from the preview feed. One-shots are streams of length 1
 * (`final: true`). The `payload` is opaque to the shell; each renderer knows
 * its own payload shape.
 */
export interface RenderableChunk {
  kind: RenderableKind;
  /** Opaque label identifying the producer; chrome-only, never affects routing. */
  source?: string;
  /** Display mode hint, passed to the pane chrome (e.g. "2d" | "3d"). */
  mode?: string;
  /** Monotonically increasing sequence number for ordering. */
  seq?: number;
  /** True when this is the final chunk in the stream. */
  final?: boolean;
  /** Renderer-specific payload (opaque to the shell). */
  payload: unknown;
}

/** Renderer-reported surface status, forwarded to the pane chrome. */
export interface PreviewStatus {
  status: 'building' | 'ready' | 'error';
  message?: string;
}
