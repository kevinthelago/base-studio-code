// The Console host (#4186, epic #3604) — renders the execution surface FROM THE GRAPH. The last of the
// eight, and the only one that is the shell rather than a feature.
//
// THE FALLBACK MATTERS MORE HERE THAN ANYWHERE. Every other graph page is one rail destination away, so a
// bad record costs you that page. This one is mounted by `App.tsx` for the whole session — it stays mounted
// across every navigation so xterm never re-parents — which means a record that will not load is a Console
// that is never there. `GraphPageFallback` gives a re-seed button rather than an empty grid, and the
// records ship in the packaged seed, so `reconcileSeed` restores a `role: "page"` record from the seed on
// every boot regardless of what the store holds (#3723). Between the two, the floor is "re-seed and
// reload", never "reinstall".
//
// LIVE TERMINALS SURVIVE A RE-COMPILE, which is the claim this whole migration rests on. `GraphComponent`
// re-loads when a record's `srcText` changes, so if the page owned the terminals a designer edit would kill
// every running session. It does not: #2378 moved them out. `TerminalHost` sits in `App.tsx` and owns one
// `<TerminalView>` per `paneId`, portaling it into whichever `<TerminalSlot>` claims it. Re-compiling the
// page re-creates slots; the xterm instance and its `pty_data_<paneId>` listener are in a tree the loader
// never touches.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerConsolePlatform } from "./graphPlatform";

// Register at module load — before the workspace ever renders — so the injected modules are in the registry
// when the graph page's compiled `require()` runs. Idempotent.
registerConsolePlatform();

/** `tabIdxOverride` is the TEAR-OFF path (#4200): a detached window renders exactly one tab, and says
 *  which. It forwards through `GraphComponent`'s `props` — the same mechanism the other seven hosts use
 *  for their `pageOverride`. #4186 shipped this host taking no props at all, which left `DetachedWindow`
 *  on the file component while the main window rendered the graph: two copies of the same page on screen
 *  in different windows, kept identical only by the parity guard. The override is a NUMBER here rather
 *  than the `pageOverride` string every other page uses, which is why it did not match the pattern. */
export function ConsoleGraphHost({ tabIdxOverride }: { tabIdxOverride?: number } = {}) {
  return (
    <GraphComponent
      id="consolepage"
      props={tabIdxOverride === undefined ? undefined : { tabIdxOverride }}
      fallback={<GraphPageFallback page="Console" icon="▣" />}
    />
  );
}
