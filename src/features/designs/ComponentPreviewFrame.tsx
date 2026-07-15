// ComponentPreviewFrame (#2824) — the Design Studio's live preview. Builds the selected component's REAL
// source with esbuild-wasm and renders it in a sandboxed iframe. This replaces the hand-drawn specimen
// mocks + the real-component fixtures: EVERY component previews by actually building and running it —
// the built-in kit (its verbatim source + dependency closure from the packaged artifact) AND
// user-authored components built on any npm library (d3, three, …), which load from esm.sh in the iframe
// with no install. The app's live styles are injected so built-ins render themed.
import { useEffect, useMemo, useRef, useState } from "react";
import reactUiArtifact from "@data/components/react-ui.json";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { Code } from "@/shared/ui/data/Code";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { bundleComponent, buildComponentSrcDoc } from "@/shared/lib/preview/componentBundle";
import { collectAppCss } from "@/shared/lib/preview/collectAppCss";
import { compileAnimationsCss, type AnimationDef } from "@/shared/ui/kit";
import { componentPreviewFiles, type KitArtifact } from "./lib/componentPreview";
import { resolveComponentAnimations, previewAnimDefs, type ComponentRecord } from "./lib/model";

// The packaged kit artifact carries each built-in's verbatim `source` + the `runtime` (@/) closure
// (react-ui.json; the builtinKits SEED strips `source`, but this raw import keeps it — same bundle).
const ARTIFACT = reactUiArtifact as unknown as KitArtifact;

type Status = "building" | "ready" | "error";

export function ComponentPreviewFrame({ comp, theme, themeId, themeVars, width, height = 260, onExpand, extraAnimation }: {
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
}) {
  const [status, setStatus] = useState<Status>("building");
  const [error, setError] = useState<string>("");
  const [retry, setRetry] = useState(0);
  // Hover/focus reveal for the expand affordance (#2834) — a boolean is cheaper than a CSS :hover class
  // here since the frame is inline-styled and self-contained (works wherever it's mounted).
  const [hint, setHint] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
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
  // The motion actually played. A try-on ISOLATES the clicked animation — the preview plays ONLY it,
  // so clicking each animation in the menu previews THAT one. Without a try-on the component's full
  // bound motion plays. (Before #3075 the try-on appended to the full bound set, so every click
  // compiled the SAME set and the preview never changed — "always the same one".)
  const animDefs = useMemo(
    () => previewAnimDefs(boundDefs, extraAnimation),
    [boundDefs, extraAnimation],
  );
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

  // Rebuild when the selection / theme / retry changes (keyed on stable fields, not the object identity).
  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- reset to the building state on each rebuild */
    setStatus("building");
    setError("");
    /* eslint-enable react-hooks/set-state-in-effect */
    const build = componentPreviewFiles(comp, ARTIFACT, siblings);
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
        // App styles (tokens + component CSS) + the selected theme's semantic-token overrides on :root.
        const themeCss = Object.entries(themeVars).map(([k, v]) => `${k}:${v}`).join(";");
        // The previewed component's bound kit MOTION (#2942): compile the kit animations it plays into
        // the iframe (guaranteed present, not reliant on the global managed <style>), and put their
        // `.<kit>-anim-<name>` classes on #root so the motion actually plays — hover/mount/always all
        // fire. The compiled CSS keeps its `prefers-reduced-motion` guard, so a reduced-motion viewer
        // sees the static component.
        const animCss = compileAnimationsCss(animDefs);
        const rootClass = animDefs
          .map((d) => `${d.kit}-anim-${d.name}`)
          .filter((c) => /^[a-z][a-z0-9-]+$/.test(c))
          .join(" ");
        const injectedCss = collectAppCss() + (themeCss ? `\n:root{${themeCss}}` : "") + (animCss ? `\n${animCss}` : "");
        const srcDoc = buildComponentSrcDoc(js, { injectedCss, theme, rootClass, exitSelectors });
        if (iframeRef.current) iframeRef.current.srcdoc = srcDoc;
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild keyed on the stable identity fields
  }, [comp.id, comp.src, comp.source, comp.srcText, comp.name, siblingsKey, animKey, exitKey, themeId, retry]);

  // Surface runtime errors the iframe posts (an exception during the component's own render). Match ONLY
  // this frame's own iframe by source window (#2908) — the on-visit scan now runs its own hidden probe
  // iframes concurrently, and without this filter their errors would leak into (and falsely fail) this
  // live preview.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data && e.data.__preview === "error") {
        setStatus("error");
        setError(String(e.data.message));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <Box style={{ position: "relative", width, maxWidth: "100%", height, display: "flex", transition: "width .25s ease" }}>
      <iframe
        ref={iframeRef}
        title={`${comp.name} preview`}
        sandbox="allow-scripts"
        style={{
          flex: 1, width: "100%", height: "100%", border: "1px solid var(--border-soft)", borderRadius: 8,
          background: "var(--bg-canvas, var(--bg))", opacity: status === "ready" ? 1 : 0.35, transition: "opacity .2s",
        }}
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
    </Box>
  );
}
