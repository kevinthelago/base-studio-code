// Sound-kit picker card (#3372) — the blueprint-wide sound-kit pin in the Capabilities author view:
// pinned/unpinned rendering, the packaged-default one-click pin, switching to a stored kit, unpinning,
// and the live resolve status (store hit vs LOUD rejection — never a silent fallback), with the
// store/fetch wire mocked. The sounds twin of UiKitPickerCard.test.tsx.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { webcrypto } from "node:crypto";
import { SoundKitPickerCard } from "./SoundKitPickerCard";
import { packagedSoundKitPin } from "../soundKitPin";
import type { Blueprint, BlueprintSoundKit } from "@/features/planner/stages/blueprints";

if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);

const PACKAGED = packagedSoundKitPin();
const packagedManifest = {
  id: PACKAGED.id, version: PACKAGED.version, sha256: PACKAGED.hash, kind: "sound-kit", source: "packaged",
};

const bp = (soundKit?: BlueprintSoundKit): Blueprint => ({
  id: "bp-x", name: "My blueprint", desc: "", sections: [], ...(soundKit ? { soundKit } : {}),
});

/** Wire the bridge: `sound release list` serves `entries`, `sound release get <ref>` serves a
 *  matching entry (so a pin present in `entries` resolves as a store hit, and one absent misses). */
function wire(entries: (typeof packagedManifest)[]) {
  vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
    const args = (payload as { args?: string[] } | undefined)?.args ?? [];
    if (cmd === "bsc" && args[0] === "sound" && args[1] === "release") {
      if (args[2] === "list") return JSON.stringify(entries);
      if (args[2] === "get") {
        return JSON.stringify(entries.find((e) => `${e.id}@${e.version}` === args[3]) ?? null);
      }
    }
    return null;
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

describe("SoundKitPickerCard (#3372)", () => {
  it("renders a pinned blueprint's ref + hash and resolves it against the store", async () => {
    wire([packagedManifest]);
    render(<SoundKitPickerCard bp={bp(packagedSoundKitPin())} onChange={() => {}} />);
    expect(screen.getByText("bsc/signal@1.0.0")).toBeTruthy();
    expect(screen.getByText(new RegExp(PACKAGED.hash.slice(0, 12)))).toBeTruthy();
    // The packaged kit resolves offline via the store's embedded fallback ⇒ "in store".
    await waitFor(() => expect(screen.getByText("in store ✓")).toBeTruthy());
  });

  it("offers a one-click packaged pin when the blueprint has none", () => {
    wire([]);
    const onChange = vi.fn();
    render(<SoundKitPickerCard bp={bp()} onChange={onChange} />);
    expect(screen.getByText(/doesn't prescribe one/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Pin the packaged kit/));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ soundKit: PACKAGED }));
  });

  it("unpins", () => {
    wire([packagedManifest]);
    const onChange = vi.fn();
    render(<SoundKitPickerCard bp={bp(packagedSoundKitPin())} onChange={onChange} />);
    fireEvent.click(screen.getByText("unpin"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ soundKit: undefined }));
  });

  it("switches to another stored kit, carrying its hash onto the pin", async () => {
    const other = { id: "acme/neon", version: "3.0.0", sha256: "b".repeat(64), kind: "sound-kit", source: "https://gist.github.com/acme/x" };
    wire([packagedManifest, other]);
    const onChange = vi.fn();
    render(<SoundKitPickerCard bp={bp(packagedSoundKitPin())} onChange={onChange} />);
    const chip = await screen.findByText("+ acme/neon@3.0.0");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      soundKit: { id: "acme/neon", version: "3.0.0", hash: other.sha256, source: other.source },
    }));
  });

  it("an UNRESOLVABLE pin surfaces the error inline — never a silent fallback", async () => {
    wire([]); // the store has nothing, and the pin carries no source to fetch from
    render(<SoundKitPickerCard bp={bp({ id: "acme/ghost", version: "1.0.0", hash: "a".repeat(64) })} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/not in the local sound-kit store/)).toBeTruthy());
    // …and it did NOT quietly show a success state.
    expect(screen.queryByText("in store ✓")).toBeNull();
  });

  it("renders no theme row (a sound kit has no token contract to restyle)", async () => {
    wire([packagedManifest]);
    render(<SoundKitPickerCard bp={bp(packagedSoundKitPin())} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("in store ✓")).toBeTruthy());
    expect(screen.queryByText(/Theme/)).toBeNull();
  });
});
