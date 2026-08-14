// Mounted-preview registry (#3437) — which component previews exist RIGHT NOW, so `bsc debug frames`
// can report them.
//
// WHY A REGISTRY AND NOT A QUERY
// `document.querySelectorAll("iframe")` finds the elements but not the two facts that matter when a
// preview misbehaves: was the pan/zoom engine REQUESTED for this frame (the `zoomEngine` prop), and did
// the built srcdoc actually CONTAIN it. Those live in React, are gone by the time the DOM is inspected,
// and their disagreement is exactly the bug class this exists to surface — "the host asked for an engine
// and the builder dropped it" reads identically to "no engine wanted" from the DOM alone.
//
// Deliberately module-level and React-free: the shell's debug channel reads it without a store round-trip
// or a context, and a frame that unmounts removes itself, so the list is never stale.
export interface PreviewFrameEntry {
  /** The component this frame is CURRENTLY showing — or, when `status` is `error`, the one it tried and
   *  failed to show. Registered on every settled outcome, not only on success: a frame that registered
   *  only its successes kept naming the LAST component that built, so `bsc debug frames` reported a mount
   *  that was no longer on screen and `bsc navigate` acked a component it never mounted. */
  component: string;
  /** The live iframe element — the host side of the sandbox boundary. */
  iframe: HTMLIFrameElement;
  /** Did the build SETTLE, and how? `ready` — the srcdoc is mounted and is this component. `error` — the
   *  build was refused or threw, and nothing of this component is on screen. A frame still building is
   *  not registered at all, so "absent" and "settled" are never confused. */
  status: "ready" | "error";
  /** Why the build failed, when `status` is `error`. The same text the frame's overlay shows. */
  error?: string;
  /** Was the pan/zoom engine asked for (the `zoomEngine` prop)? */
  engineRequested: boolean;
  /** Did the built srcdoc actually carry the engine? Diverges from `engineRequested` on a builder bug. */
  engineInSrcdoc: boolean;
}

const FRAMES = new Map<string, PreviewFrameEntry>();

/** Record (or update) one mounted preview. `key` is stable per frame instance, so a rebuild replaces
 *  rather than duplicates its entry. */
export function registerPreviewFrame(key: string, entry: PreviewFrameEntry): void {
  FRAMES.set(key, entry);
}

/** Drop a preview on unmount. Never throws on an unknown key — teardown order is not guaranteed. */
export function unregisterPreviewFrame(key: string): void {
  FRAMES.delete(key);
}

/** Every currently-mounted preview. Entries whose iframe has left the document are filtered out (and
 *  forgotten): a frame torn down without its cleanup running must not be reported as live. */
export function mountedPreviewFrames(): PreviewFrameEntry[] {
  const out: PreviewFrameEntry[] = [];
  for (const [key, entry] of FRAMES) {
    if (entry.iframe.isConnected) out.push(entry);
    else FRAMES.delete(key);
  }
  return out;
}

/** Test seam: forget every registration. */
export function resetPreviewFrames(): void {
  FRAMES.clear();
}
