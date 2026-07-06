// UI-kit picker card (#2465) — the blueprint-wide kit pin in the Capabilities author view:
// pinned/unpinned rendering, the packaged-default one-click pin, switching to a stored kit, and
// the live resolve status (store hit vs loud rejection), with the store/fetch wire mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { webcrypto } from "node:crypto";
import { UiKitPickerCard } from "./UiKitPickerCard";
import { packagedUiKitPin } from "../uiKitPin";
import type { Blueprint, BlueprintUiKit } from "@/features/planner/stages/blueprints";

if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);

const PACKAGED = packagedUiKitPin();
const packagedManifest = {
  id: PACKAGED.id, version: PACKAGED.version, sha256: PACKAGED.hash, kind: "component-kit", source: "packaged",
};

const bp = (uiKit?: BlueprintUiKit): Blueprint => ({
  id: "bp-x", name: "My blueprint", desc: "", sections: [], ...(uiKit ? { uiKit } : {}),
});

/** Wire the bridge: `ui kit list` serves `entries`, `ui kit get <ref>` serves a matching entry. */
function wire(entries: (typeof packagedManifest)[]) {
  vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
    const args = (payload as { args?: string[] } | undefined)?.args ?? [];
    if (cmd === "bsc" && args[0] === "ui" && args[1] === "kit") {
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

describe("UiKitPickerCard (#2465)", () => {
  it("renders a pinned blueprint's ref + hash and resolves it against the store", async () => {
    wire([packagedManifest]);
    render(<UiKitPickerCard bp={bp(packagedUiKitPin())} onChange={() => {}} />);
    expect(screen.getByText("bsc/react-ui@1.0.0")).toBeTruthy();
    expect(screen.getByText(`sha256 ${PACKAGED.hash.slice(0, 12)}…`)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("in store ✓")).toBeTruthy());
    // Cached ⇒ no gist fetch.
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "github_request")).toBe(false);
  });

  it("unpinned: offers the packaged default; the one-click pin emits it via onChange", () => {
    wire([packagedManifest]);
    const onChange = vi.fn();
    render(<UiKitPickerCard bp={bp()} onChange={onChange} />);
    expect(screen.getByText(/No kit pinned/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Pin the packaged kit/));
    expect((onChange.mock.calls[0][0] as Blueprint).uiKit).toEqual(packagedUiKitPin());
  });

  it("unpin emits the blueprint without a uiKit", async () => {
    wire([packagedManifest]);
    const onChange = vi.fn();
    render(<UiKitPickerCard bp={bp(packagedUiKitPin())} onChange={onChange} />);
    fireEvent.click(screen.getByText("unpin"));
    const next = onChange.mock.calls[0][0] as Blueprint;
    expect(next.uiKit).toBeUndefined();
  });

  it("lists OTHER stored component kits and pins one on click (hash from the store manifest)", async () => {
    const other = { id: "acme/neon", version: "2.0.0", sha256: "f".repeat(64), kind: "component-kit" as const, source: "https://gist.github.com/acme/0123456789abcdef" };
    wire([packagedManifest, other]);
    const onChange = vi.fn();
    render(<UiKitPickerCard bp={bp(packagedUiKitPin())} onChange={onChange} />);
    const chip = await screen.findByText("+ acme/neon@2.0.0");
    fireEvent.click(chip);
    expect((onChange.mock.calls[0][0] as Blueprint).uiKit).toEqual({
      id: "acme/neon", version: "2.0.0", hash: "f".repeat(64), source: other.source,
    });
  });

  it("a pin that cannot resolve (missing + no source) surfaces the loud error inline", async () => {
    wire([packagedManifest]);
    render(<UiKitPickerCard bp={bp({ id: "acme/ghost", version: "1.0.0", hash: "a".repeat(64) })} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no source to fetch it from/)).toBeTruthy());
  });
});
