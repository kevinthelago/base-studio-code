// image / video-frame renderer (#581 PV-canvas).
//
// Blits the newest chunk to a persistent <canvas> element in the container. No iframe
// needed — images are safe host-side. Each update() call draws over the previous frame;
// the canvas stays mounted across updates with zero re-renders.
//
// Payload shape: { dataUrl: string; width?: number; height?: number }
//   dataUrl — a data: URI (JPEG, PNG, WebP, etc.) or an object URL.
//   width / height — optional natural dimensions hint; canvas auto-sizes to the image.

import type { PreviewRenderer, RendererHandle } from '../registry';
import type { RenderableChunk, PreviewStatus } from '../types';
import { registerRenderer } from '../registry';

type CanvasPayload = { dataUrl: string; width?: number; height?: number };

function createCanvasRenderer(): PreviewRenderer {
  return {
    kind: ['image', 'video-frame'],

    mount(container: HTMLElement, initial: RenderableChunk): RendererHandle {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:#0d0d0f';
      container.style.cssText = 'display:flex;flex:1;min-height:0';
      container.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      let statusCb: ((s: PreviewStatus) => void) | undefined;

      function blit(chunk: RenderableChunk) {
        const p = chunk.payload as CanvasPayload | null;
        if (!p?.dataUrl || !ctx) return;
        const img = new Image();
        img.onload = () => {
          canvas.width = p.width ?? img.naturalWidth;
          canvas.height = p.height ?? img.naturalHeight;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          statusCb?.({ status: 'ready' });
        };
        img.onerror = () => {
          statusCb?.({ status: 'error', message: `failed to load image: ${p.dataUrl.slice(0, 60)}` });
        };
        img.src = p.dataUrl;
      }

      blit(initial);

      const handle: RendererHandle = {
        update: blit,
        onStatus(cb) { statusCb = cb; },
        teardown() {
          if (container.contains(canvas)) container.removeChild(canvas);
        },
      };
      return handle;
    },
  };
}

export const canvasRenderer = createCanvasRenderer();
registerRenderer(canvasRenderer);
