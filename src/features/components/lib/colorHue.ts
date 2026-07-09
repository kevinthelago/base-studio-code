// Colour → OKLCH hue (#2663) — parse a CSS colour to its OKLCH hue in degrees [0,360), or null when
// unparseable. Handles the two forms the design contract's graph-category tokens actually use — hex
// (#rgb / #rrggbb) and oklch(L C H) — enough for designGenBridge to derive the REAL hue set the palette
// generator must avoid (superseding the old fictional even-spacing seed). Not a full CSS colour parser.

/** OKLCH hue (degrees, [0,360)) of a hex or `oklch()` colour string; null if it isn't one of those. */
export function hueOfColor(value: string): number | null {
  const v = value.trim().toLowerCase();
  // oklch(L C H [/ a]) — the hue is the third component; tolerate %/deg suffixes.
  const okl = /^oklch\(\s*[\d.]+%?\s+[\d.]+%?\s+([\d.]+)/.exec(v);
  if (okl) return norm(parseFloat(okl[1]));
  const rgb = hexToRgb(v);
  return rgb ? oklabHue(rgb) : null;
}

function norm(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** #rgb / #rrggbb → [r,g,b] each in [0,1]; null otherwise. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(hex);
  if (!m) return null;
  const h = m[1];
  const to = (s: string) => parseInt(s.length === 1 ? s + s : s, 16) / 255;
  return h.length === 3
    ? [to(h[0]), to(h[1]), to(h[2])]
    : [to(h.slice(0, 2)), to(h.slice(2, 4)), to(h.slice(4, 6))];
}

/** sRGB [0,1]³ → OKLCH hue (deg). Björn Ottosson's canonical sRGB→linear→OKLab matrices; only the a/b
 *  components are needed for the hue (atan2(b, a)). */
function oklabHue([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return norm((Math.atan2(bb, a) * 180) / Math.PI);
}
