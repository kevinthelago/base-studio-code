/**
 * @vitest-environment jsdom
 *
 * Under `shared/lib/**` the project environment is `node` (pure domain logic); this module needs
 * `HTMLCanvasElement` to exist, so it opts into jsdom the same way `cssColor.test.ts` does.
 */
// Cover for `glgraphrenderer-dispose-never-releases-the-webgl-context`: `dispose()` deleted every GL
// object it allocated but never released the CONTEXT itself. Deleting objects returns GPU memory; it
// does not return the context, and browsers cap live WebGL contexts (Chromium ~16), force-losing the
// OLDEST once a caller passes the cap. A real browser's cap can't be produced on demand, so this
// simulates one: a fake `getContext` that enforces a small cap and force-loses the oldest still-live
// context past it — exactly the observable a leak causes and a correct `dispose()` cannot.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createGraphRenderer } from "./glGraphRenderer";

/** One property per GL constant `glGraphRenderer.ts` reads during construction or `dispose()`. Values
 *  are arbitrary and distinct — nothing here branches on them except the shader/program status checks,
 *  which are hard-coded to succeed below. */
const GL_CONSTANTS = {
  VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
  ARRAY_BUFFER: 5, STATIC_DRAW: 6, DYNAMIC_DRAW: 7, TEXTURE_2D: 8,
  TEXTURE_MIN_FILTER: 9, NEAREST: 10, TEXTURE_MAG_FILTER: 11, TEXTURE_WRAP_S: 12,
  CLAMP_TO_EDGE: 13, TEXTURE_WRAP_T: 14, LINEAR: 15, FLOAT: 16, DEPTH_TEST: 17,
  BLEND: 18, ONE: 19, ONE_MINUS_SRC_ALPHA: 20,
};

/** A fake browser's live-context registry: what a real WebGL implementation tracks to enforce its cap. */
function makeGlEnvironment(cap: number) {
  const registry: { canvas: HTMLCanvasElement; live: boolean }[] = [];
  const forceLost: HTMLCanvasElement[] = [];

  function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
    const entry = { canvas, live: true };
    registry.push(entry);
    // Enforce the cap the same way Chromium does: once creating this context pushes the LIVE count past
    // it, force-lose the oldest context that is still live — never one already released via
    // `loseContext()`, which is the whole point of releasing it.
    const live = registry.filter((e) => e.live);
    if (live.length > cap) {
      const oldest = live[0];
      oldest.live = false;
      forceLost.push(oldest.canvas);
      oldest.canvas.dispatchEvent(new Event("webglcontextlost"));
    }
    const gl = {
      ...GL_CONSTANTS,
      createShader: () => ({}),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      getShaderInfoLog: () => "",
      deleteShader: () => {},
      createProgram: () => ({}),
      attachShader: () => {},
      linkProgram: () => {},
      getProgramParameter: () => true,
      getProgramInfoLog: () => "",
      deleteProgram: () => {},
      createBuffer: () => ({}),
      bindBuffer: () => {},
      bufferData: () => {},
      createTexture: () => ({}),
      bindTexture: () => {},
      texParameteri: () => {},
      createVertexArray: () => ({}),
      bindVertexArray: () => {},
      getUniformLocation: () => ({}),
      enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      vertexAttribDivisor: () => {},
      disable: () => {},
      enable: () => {},
      blendFunc: () => {},
      deleteBuffer: () => {},
      deleteTexture: () => {},
      deleteVertexArray: () => {},
      // The extension the fix reaches for. Only `loseContext()` releases the context in this simulation —
      // deleting GL objects (above) deliberately does NOT touch `entry.live`, mirroring the real API.
      getExtension: (name: string) => {
        if (name !== "WEBGL_lose_context") return null;
        return { loseContext: () => { entry.live = false; } };
      },
    };
    return gl as unknown as WebGL2RenderingContext;
  }

  return { createContext, forceLost };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("glGraphRenderer dispose", () => {
  it("releases the context, so creating more renderers than the cap never force-loses an earlier canvas", () => {
    const CAP = 3;
    const env = makeGlEnvironment(CAP);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      kind: string,
    ) {
      if (kind !== "webgl2") return null;
      return env.createContext(this);
    } as typeof HTMLCanvasElement.prototype.getContext);

    // More create/dispose cycles than the cap. If dispose() only deleted objects, the context would stay
    // live every iteration and by iteration CAP+1 the browser would force-lose the oldest one — even
    // though, from the caller's side, every earlier renderer was already disposed.
    for (let i = 0; i < CAP + 3; i++) {
      const canvas = document.createElement("canvas");
      const renderer = createGraphRenderer(canvas);
      expect(renderer).not.toBeNull();
      renderer?.dispose();
    }

    expect(env.forceLost).toEqual([]);
  });
});
