// LiveRegion (#3770, a11y epic #2725) — the app's single pair of ARIA live regions. Visually hidden
// (.sr-only), so only assistive tech sees them. Any surface pushes text via `announce()`
// (announcer.ts) and a screen reader speaks whatever lands here — the app's async status (a worker
// paused, a PR landed) reaching the user's OWN reader (VoiceOver / Narrator / NVDA / Orca), no bespoke
// voice needed. Mounted ONCE, app-level, in App.tsx.
import { useAnnouncer } from "@/shared/lib/a11y/announcer";

const ZWSP = String.fromCharCode(0x200b);
/** A zero-width marker so a repeated announcement still changes the text node (see announcer.ts). */
const mark = (n: number) => ZWSP.repeat(n % 2);

export function LiveRegion() {
  const polite = useAnnouncer((s) => s.polite);
  const assertive = useAnnouncer((s) => s.assertive);
  const politeSeq = useAnnouncer((s) => s.politeSeq);
  const assertiveSeq = useAnnouncer((s) => s.assertiveSeq);
  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{polite}{mark(politeSeq)}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{assertive}{mark(assertiveSeq)}</div>
    </>
  );
}
