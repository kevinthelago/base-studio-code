// html / react-bundle renderer (#581 PV-registry + PV-stream).
//
// Phase 1 (PV-registry): wraps the current srcDoc-swap path — same behavior as
// PlanPreviewPane/PreviewFrame, but routed through the registry. The iframe DOM node
// is persistent; srcdoc is set imperatively (no React re-render on update).
//
// Phase 2 (PV-stream): streaming-capable path kicks in when the payload carries
// `bundleJs` instead of (or in addition to) `srcDoc`. The iframe stays mounted and
// receives chunks via postMessage to a thin resident runtime, enabling zero-reload
// incremental updates. See streamingRuntime.ts for the in-frame protocol.
//
// Payload shapes:
//   { srcDoc: string }                         — full HTML srcdoc (current producer)
//   { bundleJs: string, importmap?: Record }   — streaming path (future producer)

import type { PreviewRenderer, RendererHandle } from '../registry';
import type { RenderableChunk, PreviewStatus } from '../types';
import { registerRenderer } from '../registry';
import { buildStreamingFrameHtml } from '../streamingRuntime';
import { DEFAULT_IMPORTMAP } from '../../previewBundle';

type HtmlPayload =
  | { srcDoc: string; bundleJs?: never }
  | { bundleJs: string; importmap?: Record<string, string>; srcDoc?: never };

function applyHtmlPayload(
  iframe: HTMLIFrameElement,
  streamingReady: boolean,
  payload: HtmlPayload,
): void {
  if (payload.bundleJs != null) {
    // Streaming path: post bundle to resident runtime (no srcdoc swap, no reload).
    iframe.contentWindow?.postMessage(
      { __preview_cmd: 'render_bundle', bundleJs: payload.bundleJs, importmap: payload.importmap ?? DEFAULT_IMPORTMAP },
      '*',
    );
  } else if (payload.srcDoc != null) {
    if (streamingReady) {
      // Runtime is live — deliver as full-document replace inside the frame.
      iframe.contentWindow?.postMessage(
        { __preview_cmd: 'render_srcdoc', html: payload.srcDoc },
        '*',
      );
    } else {
      // Fallback: direct srcdoc assignment (same as legacy PreviewFrame behavior).
      iframe.srcdoc = payload.srcDoc;
    }
  }
}

function createHtmlRenderer(): PreviewRenderer {
  return {
    kind: ['react-bundle', 'html'],

    mount(container: HTMLElement, initial: RenderableChunk): RendererHandle {
      const iframe = document.createElement('iframe');
      iframe.title = 'UI preview';
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.style.cssText = 'flex:1;width:100%;height:100%;border:none;background:var(--bg-canvas,#0d0d0f)';
      container.style.cssText = 'display:flex;flex:1;min-height:0';
      container.appendChild(iframe);

      let statusCb: ((s: PreviewStatus) => void) | undefined;
      let streamingReady = false;
      // Queue a chunk delivered before the runtime has signalled ready.
      let pendingChunk: RenderableChunk | null = null;

      const payload = initial.payload as HtmlPayload;
      const useStreaming = payload.bundleJs != null;

      if (useStreaming) {
        // Bootstrap the persistent streaming runtime.
        iframe.srcdoc = buildStreamingFrameHtml(payload.importmap ?? DEFAULT_IMPORTMAP);
        pendingChunk = initial; // apply once runtime_ready arrives
      } else if (payload.srcDoc != null) {
        iframe.srcdoc = payload.srcDoc;
      }

      function onMsg(e: MessageEvent) {
        const d = e.data as { __preview?: string; message?: unknown } | null;
        if (!d || typeof d !== 'object') return;
        if (d.__preview === 'runtime_ready') {
          streamingReady = true;
          if (pendingChunk) {
            applyHtmlPayload(iframe, true, pendingChunk.payload as HtmlPayload);
            pendingChunk = null;
          }
        } else if (d.__preview === 'ready') {
          statusCb?.({ status: 'ready' });
        } else if (d.__preview === 'error') {
          statusCb?.({ status: 'error', message: String(d.message ?? '') });
        }
      }
      window.addEventListener('message', onMsg);

      const handle: RendererHandle = {
        update(chunk: RenderableChunk) {
          const p = chunk.payload as HtmlPayload;
          if (!streamingReady && p.bundleJs != null) {
            pendingChunk = chunk;
          } else {
            applyHtmlPayload(iframe, streamingReady, p);
          }
        },
        onStatus(cb) { statusCb = cb; },
        teardown() {
          window.removeEventListener('message', onMsg);
          if (container.contains(iframe)) container.removeChild(iframe);
        },
      };
      return handle;
    },
  };
}

export const htmlRenderer = createHtmlRenderer();
registerRenderer(htmlRenderer);
