import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const loadGraph = vi.fn();
vi.mock("./lib/graphBridge", () => ({ loadGraph: () => loadGraph() }));

import { useKnowledgeGraph } from "./useKnowledgeGraph";
import { KNOWLEDGE } from "./lib/knowledge";

describe("useKnowledgeGraph (#2856)", () => {
  beforeEach(() => loadGraph.mockReset());

  it("starts on the packaged seed (instant first paint), and keeps it when the bridge is unreachable", () => {
    loadGraph.mockResolvedValue(null);
    const { result } = renderHook(() => useKnowledgeGraph());
    expect(result.current).toBe(KNOWLEDGE);
  });

  it("swaps to the store's graph when it differs from the seed (a librarian edit shows)", async () => {
    loadGraph.mockResolvedValue({
      implementations: [
        ...KNOWLEDGE.implementations,
        { id: "rust.skiplist", tech: "rust", role: "primitive", name: "SkipList", composes: [], code: "// skip list" },
      ],
    });
    const { result } = renderHook(() => useKnowledgeGraph());
    await waitFor(() => expect(result.current.implementations.some((im) => im.id === "rust.skiplist")).toBe(true));
  });

  it("keeps the seed identity when the store still matches it (no needless swap/re-render)", async () => {
    loadGraph.mockResolvedValue(KNOWLEDGE);
    const { result } = renderHook(() => useKnowledgeGraph());
    await new Promise((r) => setTimeout(r, 0)); // let the immediate poll resolve
    expect(result.current).toBe(KNOWLEDGE); // sig matched the seed → never re-set
  });
});
