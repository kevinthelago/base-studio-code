import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerRenderer, getRenderer, hasRenderer, _resetRegistry,
} from '../../screens/planner/preview/registry';
import type { PreviewRenderer } from '../../screens/planner/preview/registry';
import type { RenderableKind, RenderableChunk } from '../../screens/planner/preview/types';

function makeRenderer(kinds: RenderableKind | RenderableKind[]): PreviewRenderer {
  return {
    kind: kinds,
    mount: () => ({
      update: () => {},
      onStatus: () => {},
      teardown: () => {},
    }),
  };
}

describe('renderer registry (#581 PV-registry)', () => {
  beforeEach(() => _resetRegistry());

  it('returns undefined for an unregistered kind', () => {
    expect(getRenderer('react-bundle')).toBeUndefined();
    expect(hasRenderer('html')).toBe(false);
  });

  it('routes react-bundle chunks to the registered renderer', () => {
    const r = makeRenderer('react-bundle');
    registerRenderer(r);
    expect(getRenderer('react-bundle')).toBe(r);
    expect(hasRenderer('react-bundle')).toBe(true);
  });

  it('registers a renderer for multiple kinds in one call', () => {
    const r = makeRenderer(['gltf', 'scene']);
    registerRenderer(r);
    expect(getRenderer('gltf')).toBe(r);
    expect(getRenderer('scene')).toBe(r);
  });

  it('last registration wins (idempotent override)', () => {
    const first = makeRenderer('html');
    const second = makeRenderer('html');
    registerRenderer(first);
    registerRenderer(second);
    expect(getRenderer('html')).toBe(second);
  });

  it('image and video-frame are independent slots', () => {
    const imgR = makeRenderer('image');
    const vidR = makeRenderer('video-frame');
    registerRenderer(imgR);
    registerRenderer(vidR);
    expect(getRenderer('image')).toBe(imgR);
    expect(getRenderer('video-frame')).toBe(vidR);
  });

  it('routing by kind selects the correct renderer for each kind', () => {
    const htmlR = makeRenderer(['html', 'react-bundle']);
    const gltfR = makeRenderer('gltf');
    const imgR  = makeRenderer('image');
    registerRenderer(htmlR);
    registerRenderer(gltfR);
    registerRenderer(imgR);

    const kinds: { kind: RenderableKind; expected: PreviewRenderer }[] = [
      { kind: 'html', expected: htmlR },
      { kind: 'react-bundle', expected: htmlR },
      { kind: 'gltf', expected: gltfR },
      { kind: 'image', expected: imgR },
    ];
    for (const { kind, expected } of kinds) {
      const chunk: RenderableChunk = { kind, payload: {} };
      expect(getRenderer(chunk.kind)).toBe(expected);
    }
  });
});
