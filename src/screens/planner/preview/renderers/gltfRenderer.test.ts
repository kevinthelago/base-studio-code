import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRenderer } from '../registry';
import type { RendererHandle } from '../registry';
import type { RenderableChunk } from '../types';

vi.mock('../previewBundle', () => ({
  DEFAULT_IMPORTMAP: { three: 'https://esm.sh/three@0.169.0' },
  bundleSkeleton: vi.fn(),
  buildPreviewSrcDoc: (js: string) => `<html>${js}</html>`,
  bootstrapSource: () => '',
  resolveMemPath: (_i: string, s: string) => s,
  lookupMem: () => null,
}));

import './gltfRenderer';

function makeContainer(): HTMLDivElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

function gltfChunk(payload: { url?: string; base64?: string }): RenderableChunk {
  return { kind: 'gltf', payload, final: true };
}

describe('gltfRenderer (#581 PV-gltf)', () => {
  let container: HTMLDivElement;
  let handle: RendererHandle;

  beforeEach(() => { container = makeContainer(); });
  afterEach(() => {
    handle?.teardown();
    document.body.removeChild(container);
  });

  it('is registered for gltf and scene kinds', () => {
    expect(getRenderer('gltf')).toBeDefined();
    expect(getRenderer('scene')).toBeDefined();
    expect(getRenderer('gltf')).toBe(getRenderer('scene'));
  });

  it('mount appends an iframe with allow-scripts sandbox', () => {
    const renderer = getRenderer('gltf')!;
    handle = renderer.mount(container, gltfChunk({}));
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('runtime_ready posts the pending gltf command to contentWindow', () => {
    const renderer = getRenderer('gltf')!;
    handle = renderer.mount(container, gltfChunk({ url: 'https://example.com/model.glb' }));
    const iframe = container.querySelector('iframe')!;
    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', { value: { postMessage: postMessageSpy }, configurable: true });

    // Simulate runtime_ready.
    window.dispatchEvent(new MessageEvent('message', { data: { __preview: 'runtime_ready' } }));

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ __preview_cmd: 'render_gltf', url: 'https://example.com/model.glb' }),
      '*',
    );
  });

  it('update() posts a new render_gltf command after runtime is ready', () => {
    const renderer = getRenderer('gltf')!;
    handle = renderer.mount(container, gltfChunk({}));
    const iframe = container.querySelector('iframe')!;
    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', { value: { postMessage: postMessageSpy }, configurable: true });

    window.dispatchEvent(new MessageEvent('message', { data: { __preview: 'runtime_ready' } }));
    postMessageSpy.mockClear();

    handle.update(gltfChunk({ base64: 'ABC123' }));
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ __preview_cmd: 'render_gltf', base64: 'ABC123' }),
      '*',
    );
  });

  it('onStatus relays ready and error signals', () => {
    const renderer = getRenderer('gltf')!;
    const statusCb = vi.fn();
    handle = renderer.mount(container, gltfChunk({}));
    handle.onStatus(statusCb);

    window.dispatchEvent(new MessageEvent('message', { data: { __preview: 'ready' } }));
    expect(statusCb).toHaveBeenCalledWith({ status: 'ready' });

    window.dispatchEvent(new MessageEvent('message', { data: { __preview: 'error', message: 'parse fail' } }));
    expect(statusCb).toHaveBeenCalledWith({ status: 'error', message: 'parse fail' });
  });

  it('teardown removes the iframe', () => {
    const renderer = getRenderer('gltf')!;
    handle = renderer.mount(container, gltfChunk({}));
    handle.teardown();
    expect(container.querySelector('iframe')).toBeNull();
  });
});
