// glTF / scene renderer (#581 PV-gltf).
//
// Mounts a persistent iframe that runs three.js (loaded from esm.sh via import-map)
// and receives glTF data via postMessage. The iframe stays mounted between updates;
// each render_gltf command replaces the previous model without reloading the runtime.
//
// Payload shape: { url?: string; base64?: string }
//   url    — a URL the iframe can fetch (same-origin or CORS-enabled).
//   base64 — raw glTF JSON or binary GLB, base64-encoded.
//            The iframe constructs a data URI: data:model/gltf+json;base64,<base64>.

import type { PreviewRenderer, RendererHandle } from '../registry';
import type { RenderableChunk, PreviewStatus } from '../types';
import { registerRenderer } from '../registry';
import { buildGltfRuntimeHtml } from '../streamingRuntime';

type GltfPayload = { url?: string; base64?: string };

function createGltfRenderer(): PreviewRenderer {
  return {
    kind: ['gltf', 'scene'],

    mount(container: HTMLElement, initial: RenderableChunk): RendererHandle {
      const iframe = document.createElement('iframe');
      iframe.title = 'glTF preview';
      // allow-scripts: run three.js; no host access.
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.style.cssText = 'flex:1;width:100%;height:100%;border:none;background:#0d0d0f';
      container.style.cssText = 'display:flex;flex:1;min-height:0';
      container.appendChild(iframe);

      let statusCb: ((s: PreviewStatus) => void) | undefined;
      let runtimeReady = false;
      let pendingChunk: RenderableChunk | null = null;

      // Bootstrap the three.js runtime.
      iframe.srcdoc = buildGltfRuntimeHtml();

      function sendGltf(payload: GltfPayload) {
        iframe.contentWindow?.postMessage(
          { __preview_cmd: 'render_gltf', url: payload.url, base64: payload.base64 },
          '*',
        );
      }

      function onMsg(e: MessageEvent) {
        const d = e.data as { __preview?: string; message?: unknown } | null;
        if (!d || typeof d !== 'object') return;
        if (d.__preview === 'runtime_ready') {
          runtimeReady = true;
          if (pendingChunk) {
            sendGltf(pendingChunk.payload as GltfPayload);
            pendingChunk = null;
          }
        } else if (d.__preview === 'ready') {
          statusCb?.({ status: 'ready' });
        } else if (d.__preview === 'error') {
          statusCb?.({ status: 'error', message: String(d.message ?? '') });
        }
      }
      window.addEventListener('message', onMsg);

      // Apply initial chunk once runtime is ready.
      const initPayload = initial.payload as GltfPayload;
      if (initPayload.url || initPayload.base64) {
        if (runtimeReady) {
          sendGltf(initPayload);
        } else {
          pendingChunk = initial;
        }
      }

      const handle: RendererHandle = {
        update(chunk: RenderableChunk) {
          const p = chunk.payload as GltfPayload;
          if (!runtimeReady) {
            pendingChunk = chunk;
          } else {
            sendGltf(p);
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

export const gltfRenderer = createGltfRenderer();
registerRenderer(gltfRenderer);
