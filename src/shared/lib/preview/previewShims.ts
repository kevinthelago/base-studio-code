// Preview module resolution — dynamic + supply-chain-safe (#3696, request #41).
//
// The Design Studio + planner previews bundle a component/skeleton with esbuild-wasm and mount it in a
// sandboxed iframe. Bare imports are resolved two ways, and ONLY these two — there is no "any other bare →
// esm.sh at large" path, because that is an open supply-chain door (arbitrary CDN code execution):
//
//   1. EXTERNAL — a curated, version-pinned allowlist (`@data/ui/preview-importmap.json`: react, react-dom,
//      three, d3, lucide, …). These are the ONLY specifiers fetched from esm.sh, and the iframe CSP
//      (`PREVIEW_CSP`) confines even a compromised one (no `connect-src`, so it can render but never
//      exfiltrate or escape the sandbox).
//   2. LOCAL SHIM — everything else resolves to a module BUNDLED IN LOCALLY (no network): the two fidelity
//      shims below (`react-native` → real flex-column layout, `react-native-svg` → real SVG DOM), or the
//      UNIVERSAL STUB — a "black-hole" module that safely satisfies ANY import shape from ANY package. So a
//      harvested component NEVER fails with "Failed to resolve module specifier" (dynamic + always works),
//      and the long tail of native/npm packages costs zero CDN surface (safe).
//
// The doctor reads the SAME resolution rule: a bare import is always resolvable now (external or stub), so
// it is never flagged unresolvable.

// ── The universal stub ──────────────────────────────────────────────────────────────────────────────────
// `makeStub(name)` — a "black-hole" value that safely stands in for ANY export of a package the preview
// doesn't implement. No React dependency: a component stub (a Capitalized name) renders its children
// directly; a hook stub (`use[A-Z]`) returns another black-hole (safe to destructure, index, call, or
// coerce to a primitive). Every trap React / a bundler / a style serializer might probe is handled so it
// can never throw. This helper is INLINED into a generated ESM module whose named exports are exactly the
// names the component imports (see `scanStubImports` + `universalStub`) — a real ESM export list, so
// esbuild resolves the named imports directly (a CJS-Proxy module can't: esbuild's interop copies OWN keys,
// which a Proxy can't enumerate, so every named import came back `undefined`).
export const STUB_HELPER = `function makeStub(name) {
  var isHook = typeof name === "string" && /^use[A-Z]/.test(name);
  var target = function () {};
  return new Proxy(target, {
    get: function (t, k) {
      if (k === "__esModule") return true;
      if (k === "then") return undefined;                 // never thenable (await / React.lazy safe)
      if (k === "prototype") return undefined;             // a function component, never a class
      if (k === "$$typeof" || k === "defaultProps" || k === "propTypes" || k === "contextTypes") return undefined;
      if (k === Symbol.toPrimitive) return function (hint) { return hint === "number" ? 0 : ""; };
      if (k === Symbol.iterator) return function () { var i = 0; return { next: function () { return i++ < 8 ? { value: makeStub(""), done: false } : { value: undefined, done: true }; } }; };
      if (k === "displayName") return name || "Stub";
      if (typeof k === "symbol") return undefined;
      if (k in t) return t[k];                             // real function props (name, length, call, …)
      return makeStub(k);                                  // any other property → a fresh stub (classified by ITS name)
    },
    apply: function (t, thisArg, args) {
      if (isHook) return makeStub("");                     // useX() → a black-hole value
      var props = args && args[0];                         // <Comp .../> → render its children
      return props && props.children != null ? props.children : null;
    },
    construct: function () { return {}; },                 // new X() → an empty object (defensive)
  });
}`;

/** Is `name` a legal JS identifier we can emit as `export const <name>`? (Import bindings always are; this
 *  guards against a malformed scan.) */
function isIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** A generated ESM universal-stub module exporting EXACTLY `exportNames` (each a black-hole) plus a default.
 *  A real static export list, so esbuild resolves the component's named imports directly. */
export function universalStub(exportNames: string[]): string {
  const named = Array.from(new Set(exportNames))
    .filter((n) => n !== "default" && isIdent(n))
    .map((n) => `export const ${n} = makeStub(${JSON.stringify(n)});`)
    .join("\n");
  return `${STUB_HELPER}\n${named}\nexport default makeStub("Default");\n`;
}

// ── react-native → real DOM layout ──────────────────────────────────────────────────────────────────────
// A local shim so harvested React Native components lay out correctly (RN's default box is a flex COLUMN,
// unlike a DOM block) with StyleSheet/Platform/Animated present. No react-native-web CDN dependency.
const REACT_NATIVE_SHIM = `import { createElement as h } from "react";
const flatten = (s) => Array.isArray(s) ? Object.assign({}, ...s.flat(Infinity).filter(Boolean)) : (s || {});
const VIEW_BASE = { display: "flex", flexDirection: "column", position: "relative", boxSizing: "border-box", minWidth: 0, minHeight: 0 };
const box = (tag, base) => (props = {}) => {
  const { style, children, onPress, onLayout, ...rest } = props;
  const p = { ...rest, style: { ...base, ...flatten(style) } };
  if (onPress) { p.onClick = onPress; p.style.cursor = "pointer"; }
  return h(tag, p, children);
};
export const View = box("div", VIEW_BASE);
export const SafeAreaView = box("div", VIEW_BASE);
export const ScrollView = box("div", { ...VIEW_BASE, overflow: "auto" });
export const KeyboardAvoidingView = box("div", VIEW_BASE);
export const ImageBackground = box("div", VIEW_BASE);
export const Text = box("span", { boxSizing: "border-box" });
export const Pressable = box("div", { ...VIEW_BASE, cursor: "pointer" });
export const TouchableOpacity = Pressable;
export const TouchableHighlight = Pressable;
export const TouchableWithoutFeedback = Pressable;
export const ActivityIndicator = (props = {}) => h("div", { style: { width: 20, height: 20, borderRadius: 999, border: "2px solid currentColor", borderTopColor: "transparent", display: "inline-block", ...flatten(props.style) } });
export const TextInput = (props = {}) => {
  const { style, onChangeText, multiline, ...rest } = props;
  return h(multiline ? "textarea" : "input", { ...rest, style: flatten(style), onChange: onChangeText ? (e) => onChangeText(e.target.value) : undefined });
};
export const Image = (props = {}) => {
  const s = props.source;
  const src = (s && (s.uri || s.default)) || (typeof s === "string" ? s : "");
  return h("img", { src, style: flatten(props.style), alt: "" });
};
export const FlatList = (props = {}) => {
  const data = props.data || [];
  const render = props.renderItem || (() => null);
  return h("div", { style: { display: "flex", flexDirection: props.horizontal ? "row" : "column", overflow: "auto", ...flatten(props.style) } },
    data.map((item, index) => h("div", { key: props.keyExtractor ? props.keyExtractor(item, index) : index }, render({ item, index }))));
};
export const SectionList = FlatList;
export const Modal = (props = {}) => (props.visible === false ? null : h("div", { style: { position: "fixed", inset: 0, ...flatten(props.style) } }, props.children));
export const Switch = (props = {}) => h("input", { type: "checkbox", checked: !!props.value, onChange: props.onValueChange ? (e) => props.onValueChange(e.target.checked) : undefined });
export const Button = (props = {}) => h("button", { onClick: props.onPress, style: flatten(props.style) }, props.title);
export const RefreshControl = () => null;
export const StatusBar = () => null;
export const StyleSheet = { create: (s) => s, flatten, hairlineWidth: 1, absoluteFill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }, absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }, compose: (a, b) => [a, b] };
export const Platform = { OS: "web", select: (o) => (o && ("web" in o ? o.web : o.default)), Version: 0, isPad: false, isTV: false };
export const Dimensions = { get: () => ({ width: typeof window !== "undefined" ? window.innerWidth : 375, height: typeof window !== "undefined" ? window.innerHeight : 812, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove: () => {} }) };
export const Alert = { alert: () => {}, prompt: () => {} };
export const Keyboard = { dismiss: () => {}, addListener: () => ({ remove: () => {} }), removeAllListeners: () => {} };
export const PanResponder = { create: () => ({ panHandlers: {} }) };
export const Linking = { openURL: () => Promise.resolve(), canOpenURL: () => Promise.resolve(true), addEventListener: () => ({ remove: () => {} }), getInitialURL: () => Promise.resolve(null) };
export const AppState = { currentState: "active", addEventListener: () => ({ remove: () => {} }) };
export const BackHandler = { addEventListener: () => ({ remove: () => {} }), removeEventListener: () => {} };
const anim = () => ({ start: (cb) => cb && cb({ finished: true }), stop: () => {}, reset: () => {} });
export const Animated = { View, Text, ScrollView, Image, FlatList, Value: function (v) { return { setValue: () => {}, interpolate: () => 0, addListener: () => "0", removeListener: () => {}, _value: v }; }, ValueXY: function () { return { setValue: () => {}, getLayout: () => ({}), getTranslateTransform: () => [] }; }, timing: anim, spring: anim, decay: anim, parallel: anim, sequence: anim, stagger: anim, loop: anim, createAnimatedComponent: (c) => c, event: () => () => {} };
export const Easing = new Proxy({}, { get: () => () => 0 });
export const useColorScheme = () => "dark";
export const useWindowDimensions = () => Dimensions.get();
export default { View, Text, ScrollView, Pressable, TouchableOpacity, TextInput, Image, FlatList, SectionList, ActivityIndicator, SafeAreaView, Modal, Switch, Button, StyleSheet, Platform, Dimensions, Alert, Keyboard, PanResponder, Animated, Easing, Linking, AppState };
`;

// ── react-native-svg → real SVG DOM ─────────────────────────────────────────────────────────────────────
// RN-svg component names map 1:1 to SVG elements, and React already accepts RN-svg's camelCase attributes
// (strokeWidth, strokeLinecap, …) on SVG elements — so a component's shapes actually draw in the preview.
const REACT_NATIVE_SVG_SHIM = `import { createElement as h } from "react";
const svg = (tag) => (props = {}) => { const { children, ...rest } = props; return h(tag, rest, children); };
export const Svg = svg("svg");
export const Circle = svg("circle");
export const Rect = svg("rect");
export const Path = svg("path");
export const Line = svg("line");
export const Polyline = svg("polyline");
export const Polygon = svg("polygon");
export const Ellipse = svg("ellipse");
export const G = svg("g");
export const Defs = svg("defs");
export const Stop = svg("stop");
export const LinearGradient = svg("linearGradient");
export const RadialGradient = svg("radialGradient");
export const ClipPath = svg("clipPath");
export const Mask = svg("mask");
export const Pattern = svg("pattern");
export const Use = svg("use");
export const Symbol = svg("symbol");
export const TSpan = svg("tspan");
export const TextPath = svg("textPath");
export const Text = svg("text");
export const Image = svg("image");
export const ForeignObject = svg("foreignObject");
export const Marker = svg("marker");
export default Svg;
`;

/** Bare specifiers that get a DEDICATED fidelity shim (real layout / real SVG) instead of the universal
 *  stub. Everything else bare (that isn't a curated external) falls through to `UNIVERSAL_STUB`. */
export const DEDICATED_SHIMS: Record<string, string> = {
  "react-native": REACT_NATIVE_SHIM,
  "react-native-svg": REACT_NATIVE_SVG_SHIM,
};

/** The esbuild namespace a locally-shimmed bare import is loaded from. */
export const PREVIEW_SHIM_NAMESPACE = "preview-shim";

/**
 * Scan `files` for the NAMED bindings each universal-stubbed package is imported with — so a generated stub
 * can export exactly those names. A specifier is universal-stubbed when it's bare (not relative / `@/` /
 * `@bsc/`), NOT a curated external, and NOT a dedicated shim (those have static exports, no scan needed).
 * Pure; over-collection is harmless (an extra export never hurts). Returns spec → the union of its imported
 * names across all files.
 */
export function scanStubImports(files: Record<string, string>, isExternal: (spec: string) => boolean): Map<string, string[]> {
  const importRe = /import\s+([^;'"]*?)\s+from\s*['"]([^'"]+)['"]/g;
  const acc = new Map<string, Set<string>>();
  for (const src of Object.values(files)) {
    importRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src))) {
      const [, clause, spec] = m;
      if (/^[./]/.test(spec) || spec.startsWith("@/") || spec.startsWith("@bsc/")) continue; // relative / first-party / library
      if (isExternal(spec) || spec in DEDICATED_SHIMS) continue;                              // real resolution, not a stub
      const set = acc.get(spec) ?? new Set<string>();
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces) {
        for (const part of braces[1].split(",")) {
          const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
          if (name) set.add(name);
        }
      }
      acc.set(spec, set);
    }
  }
  return new Map(Array.from(acc, ([spec, set]) => [spec, Array.from(set)]));
}

/** The local module source a bare specifier resolves to when it is NOT a curated external — its dedicated
 *  fidelity shim, else a universal stub exporting the `exportNames` the component imports it with. Bundled
 *  in (no network), so resolution can never fail. */
export function shimModuleFor(spec: string, exportNames: string[] = []): string {
  return DEDICATED_SHIMS[spec] ?? universalStub(exportNames);
}

// ── The preview iframe CSP ───────────────────────────────────────────────────────────────────────────────
/**
 * Content-Security-Policy for the preview iframe (embedded as a `<meta http-equiv>` in the srcdoc, on TOP of
 * `sandbox="allow-scripts"`). The sandbox already blocks same-origin access (a compromised dependency can't
 * read the host app); this CLOSES THE EXFILTRATION + EXECUTION channels:
 *   - `connect-src 'none'`  — no fetch / XHR / WebSocket / sendBeacon: a compromised esm.sh dependency can
 *     render but can never phone home with anything it sees.
 *   - `script-src 'unsafe-inline' https://esm.sh` — runs the inlined bundle + our shims, and the curated
 *     esm.sh externals, and NOTHING else (no `data:` scripts, no other host).
 *   - `default-src 'none'` — every other fetch class (frames, workers, manifest, media) is denied.
 * Images/fonts allow `data:`/`https:` so previews still show art. All local stubs are bundled (not `data:`
 * URLs), which is what lets `script-src` stay this tight.
 */
export const PREVIEW_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' https://esm.sh; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: https:; " +
  "font-src data: https://esm.sh; " +
  "connect-src 'none'";

/** The `<meta http-equiv>` CSP tag for a preview srcdoc `<head>`. */
export function previewCspMeta(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}" />`;
}
