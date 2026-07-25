// The ACTIVE sound-kit selection for the Design Studio (#3412) — the React edge that turns the current
// project's blueprint `soundKit` pin into the {@link SoundKitSelection} the library resolvers run under.
//
// Which blueprint's pin? The one the work is under: the ACTIVE PROJECT's blueprint (`projectBlueprintId`)
// when a project is open, else the blueprint being AUTHORED (`activeBlueprintId`) — so the Design Studio
// previews a kit the same way whether you reached it from a project or from the blueprint library.
//
// Resolution is async (a store read across the `bsc` bridge), so the selection starts at the packaged
// default and settles once the artifact lands. That start state is deliberate: it matches the pre-#3412
// behavior for the one frame before the pin resolves, rather than blanking every sound import.
import { useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { log } from "@/shared/lib/core/log";
import { DEFAULT_SOUND_KIT, type SoundKitSelection } from "./libraryModules";
import { selectSoundKit } from "./soundKitSelection";

/**
 * The active blueprint's resolved sound-kit selection (#3412). Re-resolves when the pinned ref changes;
 * an unresolvable pin is logged LOUDLY here (once per ref) and returned as the `unresolved` arm, which
 * makes every `@bsc/sounds/…` fail to resolve rather than quietly playing the starter kit.
 */
export function useActiveSoundKit(): SoundKitSelection {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projectBlueprintId = useAppStore((s) => s.projectBlueprintId);
  const activeBlueprintId = useAppStore((s) => s.activeBlueprintId);
  const blueprints = useAppStore((s) => s.blueprints);

  const blueprintId = (activeProjectId ? projectBlueprintId[activeProjectId] : "") || activeBlueprintId;
  const pin = blueprints.find((b) => b.id === blueprintId)?.soundKit;
  // Key on the REF (not the object) so an unrelated blueprint edit doesn't re-read the store.
  const ref = pin ? `${pin.id}@${pin.version}` : "";

  // The resolved selection is stored WITH the ref it was resolved for, so no state has to be reset when the
  // pin changes or is removed — the read below simply stops matching. That keeps the effect free of a
  // synchronous setState (which would cascade a render on every unpinned mount).
  const [resolved, setResolved] = useState<{ ref: string; sel: SoundKitSelection } | null>(null);

  useEffect(() => {
    if (!pin) return;
    let cancelled = false;
    void selectSoundKit(pin).then((next) => {
      if (cancelled) return;
      if (next.kind === "unresolved") log.error(`Design Studio sound kit: ${next.error}`);
      setResolved({ ref, sel: next });
    });
    return () => { cancelled = true; };
    // `pin` is derived from `ref` — keyed on the ref so a re-read happens only when the PIN itself changes,
    // not on every unrelated blueprint edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  // No pin ⇒ the packaged default. A pin whose resolution hasn't landed yet ⇒ also the default, for the one
  // frame before it settles (matching pre-#3412 behavior rather than blanking every sound import).
  return ref && resolved?.ref === ref ? resolved.sel : DEFAULT_SOUND_KIT;
}
