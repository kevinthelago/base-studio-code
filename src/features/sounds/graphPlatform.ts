// The sounds feature's graph-platform surface (#4215, epic #3604) — the modules a graph-loaded Sounds
// imports but does NOT redraw: the pure sound domain (descriptors, the kit graph, the kit catalogue, the
// synth) and the kit hook. Registered HERE, inside the feature, because the shell must not reach a
// feature's internals (#1545). The sounds host calls this at module load, before the graph page loads.
//
// The split is the usual one at a smaller scale: the graph carries the LAYOUT (rail, inspector, kit
// canvas), and everything that makes a noise or derives a graph stays code.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as SoundDescriptor from "./lib/soundDescriptor";
import * as SoundGraph from "./lib/soundGraph";
import * as SoundKits from "./lib/soundKits";
import * as Synth from "./lib/synth";
import * as UseSoundKits from "./useSoundKits";

let done = false;

/** Register the Sounds page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerSoundsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/sounds/lib/soundDescriptor", SoundDescriptor);
  registerAppModule("@/features/sounds/lib/soundGraph", SoundGraph);
  registerAppModule("@/features/sounds/lib/soundKits", SoundKits);
  registerAppModule("@/features/sounds/lib/synth", Synth);
  registerAppModule("@/features/sounds/useSoundKits", UseSoundKits);
}
