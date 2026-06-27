import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDraft } from "./useDraft";

interface Item { id: string; name: string; n?: number }

function setup(over: Partial<Parameters<typeof useDraft<Item>>[0]> = {}) {
  const onUpdate = vi.fn();
  const onCreate = vi.fn((_d: Item) => "new-id");
  const items: Item[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }];
  const hook = renderHook(() =>
    useDraft<Item>({ items, newDraft: () => ({ id: "__draft__", name: "" }), onUpdate, onCreate, ...over }),
  );
  return { hook, onUpdate, onCreate, items };
}

describe("useDraft (#1824)", () => {
  it("starts with nothing selected", () => {
    const { hook } = setup();
    expect(hook.result.current.selected).toBeNull();
    expect(hook.result.current.isDraft).toBe(false);
  });

  it("select(id) resolves the live committed item", () => {
    const { hook } = setup();
    act(() => hook.result.current.select("b"));
    expect(hook.result.current.selectedId).toBe("b");
    expect(hook.result.current.selected).toEqual({ id: "b", name: "Bravo" });
    expect(hook.result.current.isDraft).toBe(false);
  });

  it("patch on an existing item writes through to the store (onUpdate)", () => {
    const { hook, onUpdate } = setup();
    act(() => hook.result.current.select("a"));
    act(() => hook.result.current.patch({ name: "Renamed" }));
    expect(onUpdate).toHaveBeenCalledWith("a", { name: "Renamed" });
  });

  it("startDraft opens an in-memory draft; patch merges without touching the store", () => {
    const { hook, onUpdate } = setup();
    act(() => hook.result.current.startDraft());
    expect(hook.result.current.isDraft).toBe(true);
    act(() => hook.result.current.patch({ name: "Draftname" }));
    act(() => hook.result.current.patch({ n: 3 }));
    expect(hook.result.current.selected).toEqual({ id: "__draft__", name: "Draftname", n: 3 });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("commit creates via onCreate, then selects the new id and clears the draft", () => {
    const { hook, onCreate } = setup();
    act(() => hook.result.current.startDraft());
    act(() => hook.result.current.patch({ name: "Made" }));
    act(() => hook.result.current.commit());
    expect(onCreate).toHaveBeenCalledWith({ id: "__draft__", name: "Made" });
    expect(hook.result.current.isDraft).toBe(false);
    expect(hook.result.current.selectedId).toBe("new-id");
  });

  it("select clears an in-flight draft", () => {
    const { hook } = setup();
    act(() => hook.result.current.startDraft());
    act(() => hook.result.current.select("a"));
    expect(hook.result.current.isDraft).toBe(false);
    expect(hook.result.current.selectedId).toBe("a");
  });

  it("close clears selection and draft", () => {
    const { hook } = setup();
    act(() => hook.result.current.select("a"));
    act(() => hook.result.current.close());
    expect(hook.result.current.selected).toBeNull();
    expect(hook.result.current.selectedId).toBeNull();
  });

  it("startDraft is a no-op without a newDraft factory (selection-only mode)", () => {
    const { hook } = setup({ newDraft: undefined });
    act(() => hook.result.current.startDraft());
    expect(hook.result.current.isDraft).toBe(false);
  });
});
