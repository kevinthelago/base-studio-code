// The reopen flow end-to-end (#2409): derivation opens directly; a mismatch raises the modal whose
// "link" performs the one-time move (relink_project_hub + rekeyProjectData) and whose "start fresh"
// proceeds under the name key. This is the regression surface for the bug history the collapse
// retires (a published project reopened from the board must resolve to the RIGHT hub).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useReopenProject } from "./ReopenProjectModal";
import type { LocalProjectLite } from "./drafts";

const open = vi.fn();

function Wrap({ locals, title }: { locals: LocalProjectLite[]; title: string }) {
  const reopen = useReopenProject<{ tag: string }>(open);
  return (
    <>
      <button onClick={() => reopen.begin({ tag: "T" }, title, locals)}>go</button>
      {reopen.modal}
    </>
  );
}

const lp = (over: Partial<LocalProjectLite> & { key: string }): LocalProjectLite => ({
  title: over.key, hasPlan: true, updatedAt: 0, published: false, ...over,
});

describe("useReopenProject (#2409)", () => {
  beforeEach(() => {
    open.mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("opens DIRECTLY under the derived key when the hub exists (no modal, no lookup)", () => {
    render(<Wrap title="Video Game" locals={[lp({ key: "video-game", title: "Video Game" })]} />);
    fireEvent.click(screen.getByText("go"));
    expect(open).toHaveBeenCalledWith({ tag: "T" }, "video-game");
    expect(screen.queryByText(/No local copy/)).toBeNull();
  });

  it("mismatch → modal; 'link selected' relinks the legacy hub onto the name key, rekeys the store, then opens", async () => {
    useAppStore.setState({ planStages: { Video_Game: { goal: "g" } } });
    render(<Wrap title="Video Game" locals={[lp({ key: "Video_Game", title: "Video Game" })]} />);
    fireEvent.click(screen.getByText("go"));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText(/No local copy of/)).toBeTruthy();

    // The legacy title-keyed hub is the pre-selected candidate — link it.
    fireEvent.click(screen.getByText("link selected"));
    await waitFor(() => expect(open).toHaveBeenCalledWith({ tag: "T" }, "video-game"));
    // The one-time on-disk move…
    expect(invoke).toHaveBeenCalledWith("relink_project_hub", { oldKey: "Video_Game", newKey: "video-game" });
    // …and the store half: the per-project entry moved onto the name key.
    expect(useAppStore.getState().planStages["video-game"]).toEqual({ goal: "g" });
    expect(useAppStore.getState().planStages["Video_Game"]).toBeUndefined();
  });

  it("mismatch → 'start fresh' opens under the derived key without touching disk", () => {
    render(<Wrap title="Video Game" locals={[lp({ key: "unrelated", title: "Other" })]} />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByText("start fresh"));
    expect(open).toHaveBeenCalledWith({ tag: "T" }, "video-game");
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "relink_project_hub")).toBe(false);
  });

  it("a failed relink keeps the modal up and surfaces the error (hub may be open in a console)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("directory in use"));
    render(<Wrap title="Video Game" locals={[lp({ key: "Video_Game", title: "Video Game" })]} />);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByText("link selected"));
    await waitFor(() => expect(screen.getByText(/directory in use/)).toBeTruthy());
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText(/No local copy of/)).toBeTruthy(); // still up — retryable
  });
});
