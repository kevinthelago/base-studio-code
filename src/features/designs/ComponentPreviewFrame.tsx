// ComponentPreviewFrame (#2824) — the Design Studio's live preview. Builds the selected component's REAL
// source with esbuild-wasm and renders it in a sandboxed iframe. This replaces the hand-drawn specimen
// mocks + the real-component fixtures: EVERY component previews by actually building and running it —
// the built-in kit (its verbatim source + dependency closure from the packaged artifact) AND
// user-authored components built on any npm library (d3, three, …), which load from esm.sh in the iframe
// with no install. The app's live styles are injected so built-ins render themed.
import { useEffect, useRef, useState } from "react";
import reactUiArtifact from "@data/components/react-ui.json";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { Code } from "@/shared/ui/data/Code";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { bundleComponent, buildComponentSrcDoc } from "@/shared/lib/preview/componentBundle";
import { collectAppCss } from "@/shared/lib/preview/collectAppCss";
import { compileAnimationsCss, componentAnimations } from "@/shared/ui/kit";
import { componentPreviewFiles, type KitArtifact } from "./lib/componentPreview";
import type { ComponentRecord } from "./lib/model";

// The packaged kit artifact carries each built-in's verbatim `source` + the `runtime` (@/) closure
// (react-ui.json; the builtinKits SEED strips `source`, but this raw import keeps it — same bundle).
const ARTIFACT = reactUiArtifact as unknown as KitArtifact;

type Status = "building" | "ready" | "error";

export function ComponentPreviewFrame({ comp, theme, themeId, themeVars, width, height = 260, onExpand }: {
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
}) {
  const [status, setStatus] = useState<Status>("building");
  const [error, setError] = useState<string>("");
  const [retry, setRetry] = useState(0);
  // Hover/focus reveal for the expand affordance (#2834) — a boolean is cheaper than a CSS :hover class
  // here since the frame is inline-styled and self-contained (works wherever it's mounted).
  const [hint, setHint] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // A stable rebuild key for the component's authored animations (#2870) — so authoring/removing one
  // re-renders the preview (the object identity alone isn't a stable dep).
  const animKey = JSON.stringify(comp.animations ?? []);

  // Rebuild when the selection / theme / retry changes (keyed on stable fields, not the object identity).
  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- reset to the building state on each rebuild */
    setStatus("building");
    setError("");
    /* eslint-enable react-hooks/set-state-in-effect */
    const build = componentPreviewFiles(comp, ARTIFACT);
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
        // The previewed component's authored MOTION (#2870): compile its own animations into the iframe
        // (guaranteed present, not reliant on the global managed <style>), and put its animation classes
        // on #root so the motion actually plays — hover/mount/always all fire. The compiled CSS keeps its
        // `prefers-reduced-motion` guard, so a reduced-motion viewer sees the static component.
        const animDefs = componentAnimations([comp]);
        const animCss = compileAnimationsCss(animDefs);
        const rootClass = animDefs
          .map((d) => `${d.component}-anim-${d.name}`)
          .filter((c) => /^[a-z][a-z0-9-]+$/.test(c))
          .join(" ");
        const injectedCss = collectAppCss() + (themeCss ? `\n:root{${themeCss}}` : "") + (animCss ? `\n${animCss}` : "");
        const srcDoc = buildComponentSrcDoc(js, { injectedCss, theme, rootClass });
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
  }, [comp.id, comp.src, comp.source, comp.srcText, comp.name, animKey, themeId, retry]);

  // Surface runtime errors the iframe posts (an exception during the component's own render).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
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
