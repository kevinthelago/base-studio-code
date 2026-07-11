// componentRuntimeProbe (#2908) — RUN a built component preview in a hidden sandboxed iframe and report
// whether it threw at RUNTIME. The Design Studio's on-visit scan (#2838) only esbuild-BUILT each
// component, so it was blind to components that build clean yet throw when rendered — e.g. a d3-force
// `ForceGraph` whose simulation throws on its timer tick. This runner closes that gap: it mounts the
// bundled module exactly as the live `ComponentPreviewFrame` does (`buildComponentSrcDoc`, sandboxed
// `allow-scripts`), listens for the iframe's `__preview` messages, and resolves ok / errored.
//
// Two subtleties make this actually catch the target class of bug:
//   • CORRELATION — messages are matched by `e.source === iframe.contentWindow`, so concurrent probes (or
//     a live preview frame) never cross-talk. (`buildComponentSrcDoc` carries no id.)
//   • ASYNC THROWS — the iframe posts `ready` right after the module executes, but a d3-force tick / a
//     `useEffect` throw fires LATER. So `ready` does NOT immediately pass: we keep listening for a throw
//     for a short SETTLE window, then pass. A synchronous render throw fires `error` before `ready`.
//
// Non-throwing by contract: a component that can't be PROVEN to throw resolves `{ ok: true }` (no DOM, a
// timeout, or any probe-infra failure ⇒ inconclusive), so the scan never false-badges a healthy
// component. DOM-using (creates an iframe) so it can't run under jsdom — the pure decision logic lives in
// `componentScan.ts` (`buildAndProbe`, unit-tested with a mock runner); this wires the real iframe.
import { buildComponentSrcDoc } from "./componentBundle";

/** A build-clean component's RUNTIME outcome: `ok` (mounted + settled without throwing) or a throw with a
 *  message. The generic result the scan's `RunFn` consumes — canonical here (the probe produces it) so
 *  `shared/` stays feature-agnostic; `features/designs` imports this type for its scan contract. */
export type RuntimeOutcome = { ok: true } | { ok: false; message: string };

/** How long to wait for the iframe to post `ready` before giving up (inconclusive ⇒ ok). Generous so a
 *  component that fetches externals from esm.sh has time to mount over a slow link. */
const READY_TIMEOUT_MS = 6000;
/** After `ready`, keep listening this long for a LATE throw (an async tick / effect) before passing. */
const SETTLE_MS = 700;

/**
 * Does an iframe error message read as a MODULE/NETWORK load failure rather than a component throw? The
 * probe bundle keeps React (and any user library — d3, three) external, loaded from esm.sh at render
 * time. When those can't load (offline, a slow/blocked CDN), the iframe errors before the component ever
 * runs — that's an ENVIRONMENT failure, NOT a defect in the component, so the scan must treat it as
 * inconclusive (ok) rather than falsely badging every component in the kit. A genuine render throw
 * (`x is undefined`, a d3-force tick) does NOT match these, so it still badges. Pure.
 */
export function looksLikeModuleLoadFailure(message: string): boolean {
  return /failed to fetch|dynamically imported module|importing a module script failed|load failed|networkerror|failed to load resource|err_(?:internet|network|connection)/i.test(
    message,
  );
}

/**
 * Render `bundleJs` in a hidden sandboxed iframe and report whether it threw at runtime.
 *
 * @param bundleJs   the built ESM module (from `bundleComponent`) — a self-mounting preview bundle.
 * @param injectedCss app CSS injected into the iframe so the render is faithful (optional).
 * @returns `{ ok: false, message }` only if the component DEMONSTRABLY threw (a sync render error, an
 *          async tick, or an unhandled rejection); `{ ok: true }` otherwise — including no-DOM, timeouts,
 *          and any probe-infrastructure failure (inconclusive, never a false badge).
 */
export function probeComponentRuntime(bundleJs: string, injectedCss = ""): Promise<RuntimeOutcome> {
  // No DOM (jsdom / SSR) — can't run the component; treat as inconclusive rather than badging it.
  if (typeof document === "undefined" || !document.body) return Promise.resolve({ ok: true });

  return new Promise<RuntimeOutcome>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts"); // scripts, but NOT same-origin — same trust as the live preview
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    // Off-screen + inert, but attached (a detached iframe never loads its srcdoc, so scripts wouldn't run).
    iframe.style.cssText =
      "position:fixed;left:-99999px;top:0;width:480px;height:360px;border:0;opacity:0;pointer-events:none";

    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: RuntimeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (settleTimer) clearTimeout(settleTimer);
      window.removeEventListener("message", onMsg);
      iframe.remove();
      resolve(outcome);
    };

    const onMsg = (e: MessageEvent): void => {
      // Correlate strictly by the source window so concurrent probes / a live preview frame don't leak in.
      if (e.source !== iframe.contentWindow) return;
      const data = e.data as { __preview?: unknown; message?: unknown } | null;
      if (!data || typeof data.__preview !== "string") return;
      if (data.__preview === "error") {
        const message = String(data.message ?? "runtime error");
        // A failed external/module load is an environment problem, not a component defect ⇒ inconclusive.
        finish(looksLikeModuleLoadFailure(message) ? { ok: true } : { ok: false, message });
      } else if (data.__preview === "ready") {
        // Mounted without a synchronous throw — but keep listening briefly for a late (async) throw.
        settleTimer = setTimeout(() => finish({ ok: true }), SETTLE_MS);
      }
    };

    // Backstop: never posted `ready` (hung / slow) ⇒ inconclusive, don't badge.
    const hardTimer = setTimeout(() => finish({ ok: true }), READY_TIMEOUT_MS);

    window.addEventListener("message", onMsg);
    try {
      document.body.appendChild(iframe);
      iframe.srcdoc = buildComponentSrcDoc(bundleJs, { injectedCss });
    } catch {
      finish({ ok: true }); // couldn't even mount the probe ⇒ inconclusive
    }
  });
}
