// ComponentPreviewFrame (#2824) — the Design Studio's live preview, routed by what the record IS (#3859):
// an app-graph record (the app's own pages/panels, `kitId === base-studio-code`) renders LIVE through the
// runtime loader (real store, real hooks); everything else — third-party, harvested (#3301), or
// user-authored — builds its REAL source with esbuild-wasm and renders it in a sandboxed iframe, loading
// any npm library (d3, three, …) from esm.sh with no install. See {@link ComponentPreviewFrame}'s doc
// comment for the full split.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { Code } from "@/shared/ui/data/Code";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { bundleComponent, buildComponentSrcDoc } from "@/shared/lib/preview/componentBundle";
import { collectAppCss } from "@/shared/lib/preview/collectAppCss";
import { compileAnimationsCss, animClassName, type AnimationDef } from "@/shared/ui/kit";
import { componentPreviewFiles, supportedStates, EMPTY_ARTIFACT, type PreviewState } from "./lib/componentPreview";
import { usePreviewData } from "./usePreviewData";
import { recordPreviewError } from "./lib/componentBridge";
import { registerPreviewFrame, unregisterPreviewFrame } from "./lib/previewRegistry";
import { makeLibraryResolvers } from "./lib/libraryModules";
import { useActiveSoundKit } from "./lib/useActiveSoundKit";
import { resolveComponentAnimations, resolveComposedAnimations, previewAnimDefs, type ComponentRecord } from "./lib/model";
import { BASE_STUDIO_CODE_KIT_ID } from "./lib/seed";
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";

// Page canvas aspect (#3139): a page-like preview renders in a viewport this many × the frame width tall,
// then contain-scales to fit — so the header sits at the top and the whole page shows. ~1.15 keeps a
// desktop-ish canvas without shrinking the page too far in a short thumbnail.
const PAGE_ASPECT = 1.15;

type Status = "building" | "ready" | "error";

/**
 * The Design Studio's live component preview (#2824, split by record kind in #3859).
 *
 * `componentLoader.ts` draws the line: the sandboxed build ISOLATES (a stubbed-React CDN iframe, no `@/`
 * first-party imports, opaque origin), the runtime loader CONNECTS (imports stay external and resolve to
 * the app's OWN running modules — the real store, real hooks, real Tauri IPC). An APP-GRAPH record
 * (`kitId === base-studio-code` — the app's own pages/panels, migrated into the graph by epic #3604) has
 * nothing to read inside an isolating sandbox, so it renders through {@link GraphRecordPreviewFrame} — the
 * SAME path the live app mounts it with (Fleet/Settings/Skills/Security/MCP/GitHub/Automations already do
 * this, #3604). Everything else — third-party, harvested (#3301), or user-authored — is self-contained by
 * construction (bare npm specifiers via the preview import-map) and keeps building+running in
 * {@link SandboxComponentPreviewFrame}, unchanged.
 */
export function ComponentPreviewFrame(props: {
  comp: ComponentRecord;
  /** The selected theme's light/dark surface (its `base`). */
  theme: "dark" | "light";
  /** The selected theme's id — the rebuild key (a same-`base` theme switch still retints). */
  themeId: string;
  /** The selected theme's semantic-token overrides, injected as `:root{…}` so the preview retints. */
  themeVars: Record<string, string>;
  width: number | string;
  /** Frame height. Default 260 (the inspector thumbnail); the expanded try-on surface passes larger. */
  height?: number | string;
  /** When set, the thumbnail becomes a clickable affordance: hovering/focusing surfaces an "expand"
   *  cue and activating it calls this — the Design Studio promotes the thumbnail to the full-canvas
   *  theme try-on (#2834). Omit for the already-expanded surface (no self-expand). */
  onExpand?: () => void;
  /** A kit animation to PLAY on the vehicle beyond what the component binds (#2942) — the Animations
   *  try-on: the studio passes the motion selected in the AnimationsMenu so it plays live here. Sandboxed
   *  preview only — an app-graph record has no kit-animation binding concept. */
  extraAnimation?: AnimationDef | null;
  /** The data-state to preview (#3135): `loaded` (demo), `empty` (no data), or `loading` (skeleton).
   *  Sandboxed preview only. */
  previewState?: PreviewState;
  /** Render a COMPONENT at natural size and let tall content scroll vertically instead of scaling it to
   *  fit (#3190) — the expanded try-on. Sandboxed preview only. */
  scrollY?: boolean;
  /** Run the in-iframe pan/zoom ENGINE (#3190 crisp pass). Sandboxed preview only — a live-hosted app page
   *  is regular DOM, not a composited iframe texture, so it has no engine to request. */
  zoomEngine?: { initial?: number };
  /** Receives the engine's +/−/fit control API (or `null` on teardown). Never called for an app-graph
   *  record (no engine); the host's buttons already `?.`-guard a `null` api. */
  registerZoomApi?: (api: { zoomIn: () => void; zoomOut: () => void; fit: () => void } | null) => void;
  /** Enable Alt-hold inspect (#3596). Sandboxed preview only — the fiber-walk inspect layer is injected
   *  into the iframe srcdoc; a live-hosted page has no such layer. */
  onNavigate?: (name: string) => void;
  /** #3308: mark THIS frame as the app's `"preview"` shot target. Supported by BOTH paths — it publishes
   *  the frame's on-screen rect, independent of how the content inside is rendered. */
  shotTarget?: boolean;
}) {
  if (props.comp.kitId === BASE_STUDIO_CODE_KIT_ID) {
    return (
      <GraphRecordPreviewFrame
        comp={props.comp}
        themeId={props.themeId}
        width={props.width}
        height={props.height}
        onExpand={props.onExpand}
        shotTarget={props.shotTarget}
      />
    );
  }
  return <SandboxComponentPreviewFrame {...props} />;
}

/**
 * Live host for an APP-GRAPH record (#3859) — renders the REAL component through the runtime loader
 * (`GraphComponent`): real store, real hooks, real Tauri IPC. This is the deliberate opposite of
 * {@link SandboxComponentPreviewFrame} below — no esbuild-in-iframe build, no import map, no isolation —
 * so it CAN mutate real app state (the accepted trade-off; the issue's "Open question" chose live-hosting
 * over a deep-link stub because the alternative reintroduces a second render path). No zoom engine, no
 * data-state switcher, no kit-animation try-on, no Alt-hold inspect: those are iframe-sandbox concepts
 * with no live-DOM equivalent here — the page itself owns its own interaction, exactly as it does in the
 * real app. Not registered in `previewRegistry` (#3437, `bsc debug frames`) — that registry's entry shape
 * is iframe-shaped (`engineRequested`/`engineInSrcdoc`), and there is no sandbox boundary here to report.
 */
function GraphRecordPreviewFrame({ comp, themeId, width, height = 260, onExpand, shotTarget }: {
  comp: ComponentRecord;
  themeId: string;
  width: number | string;
  height?: number | string;
  onExpand?: () => void;
  shotTarget?: boolean;
}) {
  const [hint, setHint] = useState(false);
  // Measure the frame so a page-like record can render at a natural viewport canvas and scale-to-fit
  // (#3139) — mirrors the sandboxed frame's `canvas` memo. Safe to CSS-scale host-side here (unlike the
  // iframe path, #3190): this is plain DOM, not a composited texture.
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setFrame({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pageLike = comp.role === "page" || comp.role === "layout";
  const canvas = useMemo(() => {
    if (!pageLike || frame.w === 0 || frame.h === 0) return null;
    const naturalW = frame.w;
    const naturalH = Math.max(frame.h, Math.round(naturalW * PAGE_ASPECT));
    const scale = Math.min(1, frame.w / naturalW, frame.h / naturalH);
    return { naturalW, naturalH, scale };
  }, [pageLike, frame.w, frame.h]);

  // #3308: shot-target rect publishing — identical to the sandboxed frame's (DOM-position based, not
  // iframe-content based, so it needs no sandbox-specific handling).
  useEffect(() => {
    if (!shotTarget) return;
    const el = frameRef.current;
    if (!el) return;
    const publish = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      void safeInvoke("set_shot_target_rect", {
        target: "preview",
        rect: { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), w: Math.ceil(r.width), h: Math.ceil(r.height) },
      }, undefined);
    };
    publish();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", publish);
      void safeInvoke("set_shot_target_rect", { target: "preview", rect: null }, undefined);
    };
  }, [shotTarget]);

  const chrome: CSSProperties = {
    border: "1px solid var(--border-soft)", borderRadius: 8,
    background: "var(--bg-canvas, var(--bg))", overflow: "hidden",
  };
  const hostStyle: CSSProperties = canvas
    ? {
        ...chrome, position: "absolute", top: 0,
        left: Math.round((frame.w - canvas.naturalW * canvas.scale) / 2),
        width: canvas.naturalW, height: canvas.naturalH,
        transform: `scale(${canvas.scale})`, transformOrigin: "top left",
      }
    : { ...chrome, position: "relative", flex: 1, width: "100%", height: "100%" };
  return (
    // eslint-disable-next-line no-restricted-syntax -- measured mount: mirrors the sandboxed frame (#3139)
    <div ref={frameRef} style={{ position: "relative", width, maxWidth: "100%", height, display: "flex", overflow: "hidden", transition: "width .25s ease" }}>
      <Box style={hostStyle}>
        <GraphComponent
          id={comp.id}
          themeId={themeId}
          fallback={
            <Box style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <StatusDot color="var(--accent)" size={7} pulse />
              <Text mono size="xxs" tone="muted">preview unavailable</Text>
            </Box>
          }
        />
      </Box>
      {onExpand && (
        <Box
          as="button"
          onClick={onExpand}
          onMouseEnter={() => setHint(true)}
          onMouseLeave={() => setHint(false)}
          onFocus={() => setHint(true)}
          onBlur={() => setHint(false)}
          aria-label={`Expand ${comp.name} preview — try it across themes`}
          title="Click to expand — preview this component across themes"
          style={{
            position: "absolute", inset: 0, zIndex: 2, cursor: "pointer", padding: 0, borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
            border: hint ? "1px solid var(--accent)" : "1px solid transparent",
            background: hint ? "color-mix(in srgb, var(--bg-canvas, var(--bg)) 52%, transparent)" : "transparent",
            transition: "background .15s ease, border-color .15s ease",
          }}
        >
          <Box style={{
            display: "flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 999,
            border: "1px solid var(--border)", background: "var(--bg-elev, var(--bg-soft))",
            boxShadow: "var(--shadow-md)", pointerEvents: "none",
            opacity: hint ? 1 : 0, transform: hint ? "translateY(0)" : "translateY(5px)",
            transition: "opacity .15s ease, transform .15s ease",
          }}>
            <Text as="span" size={12} weight={600}>⤢ Expand</Text>
            <Text as="span" size={11} tone="muted">try themes</Text>
          </Box>
        </Box>
      )}
    </div>
  );
}

/**
 * The sandboxed build-and-iframe preview (#2824) — builds a component's REAL source with esbuild-wasm and
 * renders it in a sandboxed iframe: the built-in kit + user-authored components built on any npm library
 * (d3, three, …), which load from esm.sh in the iframe with no install. The app's live styles are injected
 * so built-ins render themed. Used for every record EXCEPT an app-graph one (#3859) — see
 * {@link ComponentPreviewFrame}'s routing.
 */
function SandboxComponentPreviewFrame({ comp, theme, themeId, themeVars, width, height = 260, onExpand, extraAnimation, previewState = "loaded", scrollY, zoomEngine, registerZoomApi, onNavigate, shotTarget }: {
  comp: ComponentRecord;
  /** The selected theme's light/dark surface (its `base`). */
  theme: "dark" | "light";
  /** The selected theme's id — the rebuild key (a same-`base` theme switch still retints). */
  themeId: string;
  /** The selected theme's semantic-token overrides, injected as `:root{…}` so the preview retints. */
  themeVars: Record<string, string>;
  width: number | string;
  /** Frame height. Default 260 (the inspector thumbnail); the expanded try-on surface passes larger. */
  height?: number | string;
  /** When set, the thumbnail becomes a clickable affordance: hovering/focusing surfaces an "expand"
   *  cue and activating it calls this — the Design Studio promotes the thumbnail to the full-canvas
   *  theme try-on (#2834). Omit for the already-expanded surface (no self-expand). */
  onExpand?: () => void;
  /** A kit animation to PLAY on the vehicle beyond what the component binds (#2942) — the Animations
   *  try-on: the studio passes the motion selected in the AnimationsMenu so it plays live here. */
  extraAnimation?: AnimationDef | null;
  /** The data-state to preview (#3135): `loaded` (demo), `empty` (no data), or `loading` (skeleton).
   *  Drives how the bootstrap samples props. Default `loaded`. */
  previewState?: PreviewState;
  /** Render a COMPONENT at natural size and let tall content scroll vertically instead of scaling it to
   *  fit (#3190) — the expanded try-on. Ignored for pages (they scale parent-side). Omit for thumbnails. */
  scrollY?: boolean;
  /** Run the in-iframe pan/zoom ENGINE (#3190 crisp pass) — a CRISP DOM-transform zoom (vs the blurry
   *  host CSS scale). `initial` is a centered zoom applied on load. The engine owns pan + zoom entirely:
   *  an iframe is a composited texture, so scaling it host-side blurs (a981b8b8). Omit for thumbnails. */
  zoomEngine?: { initial?: number };
  /** Receives the engine's +/−/fit control API (or `null` on teardown) so the host can wire its zoom
   *  buttons — the engine lives in the iframe, so the buttons post `__cmd` messages to it (#3190). */
  registerZoomApi?: (api: { zoomIn: () => void; zoomOut: () => void; fit: () => void } | null) => void;
  /** Enable Alt-hold inspect (#3596): while Alt is held the preview rings the child component under the
   *  cursor and calls this with its NAME on click. Only the EXPANDED try-on passes it (its `composes`
   *  become the navigable set); omit for thumbnails, which stay plain interactable previews. */
  onNavigate?: (name: string) => void;
  /** #3308: mark THIS frame as the app's `"preview"` shot target — the inspector's lead preview passes it
   *  so `bsc shot preview` crops the webview to just this component (the designer's ground truth). Only
   *  ONE mounted frame should set it. */
  shotTarget?: boolean;
}) {
  const [status, setStatus] = useState<Status>("building");
  const [error, setError] = useState<string>("");
  const [retry, setRetry] = useState(0);
  // Hover/focus reveal for the expand affordance (#2834) — a boolean is cheaper than a CSS :hover class
  // here since the frame is inline-styled and self-contained (works wherever it's mounted).
  const [hint, setHint] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // A stable id for THIS frame instance in the #3437 preview registry — so a rebuild replaces its
  // entry rather than duplicating it, and unmount removes exactly its own.
  const frameKey = useRef(`pv-${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => () => unregisterPreviewFrame(frameKey), [frameKey]);
  // #3190: the forwarded-gesture handlers + the last screen position of an in-flight forwarded drag, held
  // in refs so the message listener stays subscribed across renders (the callbacks' identity may churn).
  // Measure the frame so page-like components can render at a natural viewport canvas and scale-to-fit
  // (#3139) — a full-viewport page squeezed into the raw frame overflows/clips; scaling shows the whole
  // thing. Only pages/layouts scale; a component keeps its 1:1, centered mount.
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setFrame({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pageLike = comp.role === "page" || comp.role === "layout";
  // The page canvas + scale-to-fit ratio (#3139): render at the frame WIDTH (the selected sm/md/auto
  // breakpoint = the page's authored layout width) × a taller viewport canvas, then contain-scale so the
  // whole page shows. `null` for non-pages (they render 1:1) or before the frame is measured — AND under
  // `zoomEngine` (#3551): the in-iframe pan/zoom engine owns ALL scaling, so this pre-#3190 parent
  // CSS-scale must NOT also apply (a page in the expanded try-on was scaled twice, and the second
  // transform fought the engine → the drag couldn't pan). The engine's iframe then fills the frame 1:1.
  const hasZoomEngine = !!zoomEngine;
  const canvas = useMemo(() => {
    if (!pageLike || hasZoomEngine || frame.w === 0 || frame.h === 0) return null;
    const naturalW = frame.w;
    const naturalH = Math.max(frame.h, Math.round(naturalW * PAGE_ASPECT));
    const scale = Math.min(1, frame.w / naturalW, frame.h / naturalH);
    return { naturalW, naturalH, scale };
  }, [pageLike, hasZoomEngine, frame.w, frame.h]);
  // The kit-scoped animation defs this component BINDS (#2942) — the kit owns the keyframes, the
  // component references them by name. A derived key so authoring/removing a binding OR editing the
  // kit's motion re-renders the preview (the object identity alone isn't a stable dep).
  const kits = useAppStore((s) => s.kits);
  const boundDefs = useMemo(() => resolveComponentAnimations(comp, kits), [comp, kits]);
  // The other components in this component's kit — its SIBLINGS (#3112). A user-kit component may import
  // and compose a sibling; `componentPreviewFiles` vendors the ones it imports into the build. A derived
  // content key (like `animKey`) so editing a sibling's source rebuilds the preview.
  const allComponents = useAppStore((s) => s.components);
  const siblings = useMemo(
    () => allComponents.filter((c) => c.kitId === comp.kitId && c.id !== comp.id),
    [allComponents, comp.kitId, comp.id],
  );
  const siblingsKey = useMemo(
    () => siblings.map((c) => `${c.src} ${c.source ?? c.srcText ?? ""}`).join(" "),
    [siblings],
  );
  // The ACTIVE motion of each sibling this component COMPOSES (#3130). Now that a user-kit component
  // vendors + renders its imports for real (#3112), pair each import with its active animation — else the
  // composed pieces (a chart's ChartFrame / Axis / …) render statically. The top's own defs are appended
  // AFTER (see `animDefs`) so a top-level root-scoped animation still wins `#root`.
  const composedDefs = useMemo(
    () => resolveComposedAnimations(comp, allComponents, kits),
    [comp, allComponents, kits],
  );
  // The motion actually played. A try-on ISOLATES the clicked animation — the preview plays ONLY it,
  // so clicking each animation in the menu previews THAT one. Without a try-on the component's full
  // bound motion plays. (Before #3075 the try-on appended to the full bound set, so every click
  // compiled the SAME set and the preview never changed — "always the same one".) #3130: the composed
  // imports' active motion is unioned in FIRST (deduped, excluding what the top binds), the top's own
  // LAST — so a top-level root-scoped animation wins `#root` (no regression) while composed defs fill in.
  const animDefs = useMemo(() => {
    const own = previewAnimDefs(boundDefs, extraAnimation);
    const ownKeys = new Set(own.map((d) => `${d.kit}:${d.name}`));
    return [...composedDefs.filter((d) => !ownKeys.has(`${d.kit}:${d.name}`)), ...own];
  }, [composedDefs, boundDefs, extraAnimation]);
  const animKey = JSON.stringify(animDefs);
  // #3057: the selectors of the exit-triggered animations this component binds — the exit-runtime shim
  // (injected into the preview iframe) watches for a leaving element matching one of these and flips the
  // `[data-bsc-exit]` marker so the dormant exit rule plays. Exit defs WITHOUT a selector are skipped:
  // the preview `#root` itself never leaves, so a root-scoped exit rule has nothing to observe. A derived
  // string key (not object identity) so a change to the exit set re-triggers the rebuild effect.
  const exitSelectors = useMemo(
    () => Array.from(new Set(animDefs.filter((d) => d.trigger === "exit" && d.selector).map((d) => d.selector!))),
    [animDefs],
  );
  const exitKey = exitSelectors.join("|");

  // #3556: the selected theme's `:root` token overrides, as a standalone stylesheet string. Kept OUT of the
  // build effect's `injectedCss` so a theme change never rebuilds the iframe — it is applied LIVE via a
  // `{ __bsc_theme }` postMessage (below), preserving the pan/zoom engine's view across a theme switch.
  const themeCss = useMemo(() => {
    const vars = Object.entries(themeVars).map(([k, v]) => `${k}:${v}`).join(";");
    return vars ? `:root{${vars}}` : "";
  }, [themeVars]);

  // Studio network (#2940): a bound librarian algorithm's generated dataset for this component's preview
  // props (`{ prop: JS-source literal }`), or `{}`. Resolves async (sandbox run); the reference is stable
  // (a shared EMPTY until it lands) so it rebuilds the preview exactly once when the data arrives.
  const previewData = usePreviewData(comp);

  // The library resolver this preview vendors `@bsc/…` imports through. Its SOUND arm follows the active
  // blueprint's `soundKit` pin (#3412), so a component importing `@bsc/sounds/click` plays the kit its
  // project actually adopted — and an unresolvable pin makes that import fail loudly rather than silently
  // sounding like the packaged starter kit.
  const soundKit = useActiveSoundKit();
  const libResolver = useMemo(() => makeLibraryResolvers(soundKit).libraryModuleResolver, [soundKit]);
  // #3567: build ONCE with every supported state's props embedded, so a state change is a live re-render
  // (postMessage below), not an esbuild rebuild + reload + "building" flash — the same live-apply pattern
  // as the theme (#3556). The scan keeps its per-state single builds (not passed `liveStates`).
  const liveStates = useMemo(() => supportedStates(comp), [comp]);
  const liveStatesKey = liveStates.join(",");

  // Rebuild when the selection / theme / retry / resolved preview-data changes (keyed on stable fields).
  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- reset to the building state on each rebuild */
    setStatus("building");
    setError("");
    /* eslint-enable react-hooks/set-state-in-effect */
    const build = componentPreviewFiles(comp, EMPTY_ARTIFACT, siblings, libResolver, previewState, previewData, liveStates);
    if (!build) {
      setStatus("error");
      setError(
        `"${comp.name}" has no implementation source yet — its stored source is only a usage snippet, ` +
          `not a runnable module. Add a self-contained component (imports only libraries; exports the ` +
          `component) via the designer session or the Source tab to preview it.`,
      );
      return;
    }
    (async () => {
      try {
        const js = await bundleComponent(build.files, build.entry);
        if (cancelled) return;
        // The previewed component's bound kit MOTION (#2942): compile the kit animations it plays into
        // the iframe (guaranteed present, not reliant on the global managed <style>), and put their
        // `.<kit>-anim-<name>` classes on #root so the motion actually plays — hover/mount/always all
        // fire. The compiled CSS keeps its `prefers-reduced-motion` guard, so a reduced-motion viewer
        // sees the static component.
        const animCss = compileAnimationsCss(animDefs);
        // #3163: derive the class hook via `animClassName` so a component-namespaced composed animation
        // (`.<kit>-<component>-anim-<name>`) matches the same-namespaced keyframes the compiler emits.
        const rootClass = animDefs
          .map((d) => animClassName(d))
          .filter((c) => /^[a-z][a-z0-9-]+$/.test(c))
          .join(" ");
        // #3556: theme vars are NO LONGER folded in here (they go in a dedicated `<style id="__bsc_theme">`
        // via `themeCss`, applied live) — only the app CSS + this component's animation CSS.
        const injectedCss = collectAppCss() + (animCss ? `\n${animCss}` : "");
        // #3141: pages/layouts are scaled parent-side (the canvas above); a component that overflows the
        // frame gets the in-iframe scale-to-fit shim instead so it shows whole rather than clipping.
        // #3190: a scrollable component renders at natural size (no fit-shim) and scrolls tall content;
        // otherwise a non-page mount scales-to-fit (#3141). Pages always scale parent-side (#3139).
        // #3190 crisp pass: the in-iframe zoom ENGINE owns pan/zoom (and overflow, via pan), so it
        // suppresses the scroll mode + the gesture-forwarding. Otherwise: scrollable → natural size + scroll,
        // else a non-page mount scales-to-fit (#3141); pages always scale parent-side (#3139).
        const doScroll = !!scrollY && !pageLike && !zoomEngine;
        const srcDoc = buildComponentSrcDoc(js, {
          injectedCss, themeCss, theme, rootClass, exitSelectors,
          fitContent: !pageLike && !doScroll, scrollY: doScroll,
          zoomEngine: zoomEngine ? {} : undefined,
          // #3596: the expanded try-on (which passes onNavigate) gets the Alt-hold inspect layer, keyed
          // to THIS component's composed children — the names the fiber-walk navigates to.
          inspect: onNavigate ? comp.composes : undefined,
        });
        if (iframeRef.current) iframeRef.current.srcdoc = srcDoc;
        // #3437: publish what this frame IS, for `bsc debug frames`. Recorded here because the pair that
        // matters — the engine was REQUESTED vs it actually reached the srcdoc — is only knowable at the
        // build, and their disagreement is invisible from the DOM afterwards.
        if (iframeRef.current) {
          registerPreviewFrame(frameKey, {
            component: comp.id,
            iframe: iframeRef.current,
            engineRequested: !!zoomEngine,
            engineInSrcdoc: srcDoc.includes("__cmd"),
          });
        }
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // #3556: `themeId`/`themeCss`/`theme` are NOT deps — a theme change must NOT rebuild (it would reset the
    // pan/zoom engine); applied live below. #3567: `previewState` is NOT a dep either — a state change must
    // NOT rebuild (it flashes "building"); applied live below. The initial build reads the current theme +
    // state fresh; `liveStatesKey` rebuilds only when the component gains/loses a supported state.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild keyed on the stable identity fields
  }, [comp.id, comp.src, comp.source, comp.srcText, comp.name, pageLike, siblingsKey, animKey, exitKey, liveStatesKey, scrollY, hasZoomEngine, retry, previewData, libResolver, !!onNavigate]);

  // #3556: apply a theme change LIVE to the mounted iframe (data-theme base + the `__bsc_theme` token
  // overrides) via postMessage — no rebuild, so the in-iframe pan/zoom view survives a theme switch. Keyed
  // on `themeId` (the stable theme identity); the initial build already baked the current theme in.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ __bsc_theme: { base: theme, css: themeCss } }, "*");
  }, [themeId, theme, themeCss]);

  // #3567: apply a STATE change LIVE — post `{ __state }` to the mounted iframe, which re-renders the
  // component with that state's embedded props. No esbuild, no reload, no "building" flash. The initial
  // build already mounted the current state.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ __state: previewState }, "*");
  }, [previewState]);

  // #3190 crisp pass: hand the host the engine's +/−/fit controls. The engine lives in the iframe, so each
  // call posts a `__cmd` message to it; re-registered whenever the iframe rebuilds (`retry`/comp switch).
  useEffect(() => {
    if (!zoomEngine || !registerZoomApi) return;
    const cmd = (c: string) => iframeRef.current?.contentWindow?.postMessage({ __cmd: c }, "*");
    registerZoomApi({ zoomIn: () => cmd("zoomIn"), zoomOut: () => cmd("zoomOut"), fit: () => cmd("fit") });
    return () => registerZoomApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-register on iframe rebuild
  }, [!!zoomEngine, registerZoomApi, comp.id, retry]);

  // Surface runtime errors the iframe posts (an exception during the component's own render). Match ONLY
  // this frame's own iframe by source window (#2908) — the on-visit scan now runs its own hidden probe
  // iframes concurrently, and without this filter their errors would leak into (and falsely fail) this
  // live preview. #3165: ALSO persist the throw to the durable preview-error log (`bsc ui preview-error`)
  // so it's tail-able from a session's shell (`bsc ui preview-errors`) — the status itself is transient
  // React state. Keyed on `comp.id` so the fire-and-forget attributes the error to the CURRENT component.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d) return;
      // Per-frame messages — match THIS iframe's window so a concurrent scan probe's message doesn't
      // leak into (and falsely fail / mis-navigate) this live preview (#2908).
      if (e.source !== iframeRef.current?.contentWindow) return;
      // #3596: Alt-hold inspect navigated to a child — route it to the host (the graph selects that node).
      if (d.__navigate && onNavigate) { onNavigate(String(d.__navigate)); return; }
      if (!d.__preview) return;
      if (d.__preview === "error") {
        const message = String(d.message);
        setStatus("error");
        setError(message);
        void recordPreviewError(comp.id, message);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [comp.id, onNavigate]);

  // #3308: when this is the designated shot target (the inspector's lead preview), keep its on-screen rect
  // registered with the backend so `bsc shot preview` crops the webview to JUST this component (the
  // designer's ground truth), not the whole app. Best-effort (safeInvoke swallows); the ResizeObserver's
  // initial callback publishes the first real rect once laid out; cleared on unmount so a stale rect never
  // mis-crops a later shot. getBoundingClientRect is CSS px from the viewport top-left — the crop's frame.
  useEffect(() => {
    if (!shotTarget) return;
    const el = frameRef.current;
    if (!el) return;
    const publish = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return; // not laid out yet — the RO will re-fire with a real size
      void safeInvoke("set_shot_target_rect", {
        target: "preview",
        rect: { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), w: Math.ceil(r.width), h: Math.ceil(r.height) },
      }, undefined);
    };
    publish();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", publish);
      void safeInvoke("set_shot_target_rect", { target: "preview", rect: null }, undefined);
    };
  }, [shotTarget]);

  // #3139: a page-like preview renders at its natural viewport canvas + is contain-scaled (absolute,
  // top-anchored, centered); a component renders 1:1, filling the frame. Common chrome either way.
  const chrome: CSSProperties = {
    border: "1px solid var(--border-soft)", borderRadius: 8,
    background: "var(--bg-canvas, var(--bg))", opacity: status === "ready" ? 1 : 0.35, transition: "opacity .2s",
  };
  const iframeStyle: CSSProperties = canvas
    ? {
        ...chrome, position: "absolute", top: 0,
        left: Math.round((frame.w - canvas.naturalW * canvas.scale) / 2),
        width: canvas.naturalW, height: canvas.naturalH,
        transform: `scale(${canvas.scale})`, transformOrigin: "top left",
      }
    : { ...chrome, flex: 1, width: "100%", height: "100%" };
  return (
    // eslint-disable-next-line no-restricted-syntax -- measured mount: ResizeObserver reads this frame's px size to scale a page-like preview (#3139)
    <div ref={frameRef} style={{ position: "relative", width, maxWidth: "100%", height, display: "flex", overflow: "hidden", transition: "width .25s ease" }}>
      <iframe
        ref={iframeRef}
        title={`${comp.name} preview`}
        sandbox="allow-scripts"
        style={iframeStyle}
      />
      {status === "building" && (
        <Box style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, pointerEvents: "none" }}>
          <StatusDot color="var(--accent)" size={7} pulse />
          <Text mono size="xxs" tone="muted">building…</Text>
        </Box>
      )}
      {status === "error" && (
        <Box style={{ position: "absolute", inset: 0, zIndex: 3, padding: 12, overflow: "auto", background: "var(--bg-elev, var(--bg-soft))", borderRadius: 8, border: "1px solid color-mix(in srgb, var(--danger) 40%, var(--border))" }}>
          <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <StatusDot color="var(--danger)" size={7} />
            <Text mono size="xxs" tone="danger" style={{ textTransform: "uppercase", letterSpacing: ".05em" }}>Preview failed to build</Text>
            <Box style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>↻ retry</Button>
          </Box>
          <Code maxHeight={180} wrap>{error}</Code>
        </Box>
      )}
      {/* Expand affordance (#2834): the whole thumbnail is a button that opens the full-canvas theme
          try-on. A transparent overlay (below the z:3 error card, so its ↻ retry stays clickable) that
          on hover/focus dims the frame and floats a "⤢ Expand" pill so it clearly reads as clickable. */}
      {onExpand && (
        <Box
          as="button"
          onClick={onExpand}
          onMouseEnter={() => setHint(true)}
          onMouseLeave={() => setHint(false)}
          onFocus={() => setHint(true)}
          onBlur={() => setHint(false)}
          aria-label={`Expand ${comp.name} preview — try it across themes`}
          title="Click to expand — preview this component across themes"
          style={{
            position: "absolute", inset: 0, zIndex: 2, cursor: "pointer", padding: 0, borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
            border: hint ? "1px solid var(--accent)" : "1px solid transparent",
            background: hint ? "color-mix(in srgb, var(--bg-canvas, var(--bg)) 52%, transparent)" : "transparent",
            transition: "background .15s ease, border-color .15s ease",
          }}
        >
          <Box style={{
            display: "flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 999,
            border: "1px solid var(--border)", background: "var(--bg-elev, var(--bg-soft))",
            boxShadow: "var(--shadow-md)", pointerEvents: "none",
            opacity: hint ? 1 : 0, transform: hint ? "translateY(0)" : "translateY(5px)",
            transition: "opacity .15s ease, transform .15s ease",
          }}>
            <Text as="span" size={12} weight={600}>⤢ Expand</Text>
            <Text as="span" size={11} tone="muted">try themes</Text>
          </Box>
        </Box>
      )}
    </div>
  );
}
