import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRenderer } from '../../screens/planner/preview/registry';
import type { RendererHandle } from '../../screens/planner/preview/registry';
import type { RenderableChunk } from '../../screens/planner/preview/types';

// Import renderer — side-effect registers it in the module-level registry.
import '../../screens/planner/preview/renderers/htmlRenderer';

// previewBundle is used by streamingRuntime; mock it so no esm.sh or wasm loads.
vi.mock('../../screens/planner/preview/previewBundle', () => ({
  DEFAULT_IMPORTMAP: { react: 'https://esm.sh/react@18.3.1' },
  bundleSkeleton: vi.fn().mockResolvedValue('BUNDLE_JS'),
  buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
  bootstrapSource: (entry: string) => `import Screen from "./${entry}";`,
  resolveMemPath: (_i: string, s: string) => s,
  lookupMem: () => null,
}));

function makeContainer(): HTMLDivElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

function srcDocChunk(srcDoc: string): RenderableChunk {
  return { kind: 'react-bundle', payload: { srcDoc }, final: true };
}

describe('htmlRenderer (#581 PV-registry + PV-stream)', () => {
  let container: HTMLDivElement;
  let handle: RendererHandle;

  beforeEach(() => {
    container = makeContainer();
  });

  afterEach(() => {
    handle?.teardown();
    if (document.body.contains(container)) document.body.removeChild(container);
  });

  it('is registered for react-bundle and html kinds', () => {
    expect(getRenderer('react-bundle')).toBeDefined();
    expect(getRenderer('html')).toBeDefined();
  });

  it('mount appends a sandboxed iframe to the container', () => {
    const renderer = getRenderer('react-bundle')!;
    handle = renderer.mount(container, srcDocChunk('<html><body>HI</body></html>'));
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('mount sets the initial srcDoc on the iframe', () => {
    const renderer = getRenderer('react-bundle')!;
    handle = renderer.mount(container, srcDocChunk('<html><body>INIT</body></html>'));
    const iframe = container.querySelector('iframe')!;
    expect(iframe.srcdoc).toContain('INIT');
  });

  it('update() mutates the iframe srcdoc WITHOUT causing a React re-render', () => {
    const renderer = getRenderer('react-bundle')!;
    handle = renderer.mount(container, srcDocChunk('<html><body>A</body></html>'));
    const iframe = container.querySelector('iframe')!;
    const iframeBefore = iframe; // same DOM node

    handle.update(srcDocChunk('<html><body>B</body></html>'));

    // The iframe is the SAME DOM element (not remounted).
    expect(container.querySelector('iframe')).toBe(iframeBefore);
    expect(iframe.srcdoc).toContain('B');
  });

  it('rapid update() calls mutate the surface but keep one iframe in the DOM', () => {
    const renderer = getRenderer('react-bundle')!;
    handle = renderer.mount(container, srcDocChunk('<html>0</html>'));
    for (let n = 1; n <= 50; n++) {
      handle.update(srcDocChunk(`<html>${n}</html>`));
    }
    const iframes = container.querySelectorAll('iframe');
    expect(iframes.length).toBe(1);
    expect(iframes[0].srcdoc).toContain('50');
  });

  it('onStatus relays __preview:ready messages from the iframe', () => {
    const renderer = getRenderer('react-bundle')!;
    const statusCb = vi.fn();
    handle = renderer.mount(container, srcDocChunk('<html></html>'));
    handle.onStatus(statusCb);

    window.dispatchEvent(new MessageEvent('message', { data: { __preview: 'ready' } }));
    expect(statusCb).toHaveBeenCalledWith({ status: 'ready' });
  });

  it('onStatus relays __preview:error messages from the iframe', () => {
    const renderer = getRenderer('react-bundle')!;
    const statusCb = vi.fn();
    handle = renderer.mount(container, srcDocChunk('<html></html>'));
    handle.onStatus(statusCb);

    window.dispatchEvent(new MessageEvent('message', { data: { __preview: 'error', message: 'boom' } }));
    expect(statusCb).toHaveBeenCalledWith({ status: 'error', message: 'boom' });
  });

  it('teardown removes the iframe from the container', () => {
    const renderer = getRenderer('react-bundle')!;
    handle = renderer.mount(container, srcDocChunk('<html></html>'));
    handle.teardown();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('teardown removes the message listener (no more status callbacks)', () => {
    const renderer = getRenderer('react-bundle')!;
    const statusCb = vi.fn();
    handle = renderer.mount(container, srcDocChunk('<html></html>'));
    handle.onStatus(statusCb);
    handle.teardown();
    // After teardown, handle is cleaned up — set to satisfy afterEach guard.
    handle = { update: () => {}, onStatus: () => {}, teardown: () => {} };

    window.dispatchEvent(new MessageEvent('message', { data: { __preview: 'ready' } }));
    expect(statusCb).not.toHaveBeenCalled();
  });

  it('streaming path: update with bundleJs posts to contentWindow', () => {
    const renderer = getRenderer('react-bundle')!;
    handle = renderer.mount(container, { kind: 'react-bundle', payload: { bundleJs: 'const x=1' }, final: true });
    const iframe = container.querySelector('iframe')!;

    // Simulate runtime_ready so the renderer flushes the pending initial chunk.
    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', { value: { postMessage: postMessageSpy }, configurable: true });
    window.dispatchEvent(new MessageEvent('message', { data: { __preview: 'runtime_ready' } }));

    // Now send a streaming update.
    handle.update({ kind: 'react-bundle', payload: { bundleJs: 'const y=2' }, final: true });
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ __preview_cmd: 'render_bundle', bundleJs: 'const y=2' }),
      '*',
    );
  });
});
