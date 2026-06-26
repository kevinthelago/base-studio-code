import { describe, it, expect } from "vitest";
import { moveInArray } from "./arrayMove";

describe("moveInArray", () => {
  it("moves an element forward", () => {
    expect(moveInArray(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });
  it("moves an element backward", () => {
    expect(moveInArray(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });
  it("is a no-op (copy) for from===to or out-of-range", () => {
    expect(moveInArray(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveInArray(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});
