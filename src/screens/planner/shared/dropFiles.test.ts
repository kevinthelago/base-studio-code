import { describe, it, expect } from "vitest";
import { collectEntry, collectDroppedEntries, type FsEntryLike } from "./dropFiles";

// Minimal fakes for the FileSystemEntry tree (no real DataTransfer needed).
function fileEntry(name: string): FsEntryLike {
  return {
    isFile: true, isDirectory: false, name,
    file: (ok) => ok(new File([`content of ${name}`], name)),
  };
}
function dirEntry(name: string, children: FsEntryLike[]): FsEntryLike {
  return {
    isFile: false, isDirectory: true, name,
    createReader: () => {
      // Yield all children in the first batch, then an empty batch (the exhausted signal).
      let done = false;
      return {
        readEntries: (ok) => { ok(done ? [] : children); done = true; },
      };
    },
  };
}

describe("dropFiles — folder traversal (#831)", () => {
  it("collects a single dropped file", async () => {
    const out = await collectEntry(fileEntry("hero.png"));
    expect(out.map((d) => d.path)).toEqual(["hero.png"]);
  });

  it("walks a dropped folder recursively, preserving relative paths", async () => {
    const tree = dirEntry("design", [
      fileEntry("logo.svg"),
      dirEntry("icons", [fileEntry("home.svg"), fileEntry("settings.svg")]),
    ]);
    const out = await collectEntry(tree);
    expect(out.map((d) => d.path).sort()).toEqual([
      "design/icons/home.svg",
      "design/icons/settings.svg",
      "design/logo.svg",
    ]);
    // the File objects come through intact
    expect(out.every((d) => d.file instanceof File)).toBe(true);
  });

  it("flattens multiple dropped entries (files + folders)", async () => {
    const out = await collectDroppedEntries([
      fileEntry("spec.md"),
      dirEntry("ui", [fileEntry("Card.tsx")]),
    ]);
    expect(out.map((d) => d.path).sort()).toEqual(["spec.md", "ui/Card.tsx"]);
  });

  it("ignores an entry that is neither file nor directory", async () => {
    const out = await collectEntry({ isFile: false, isDirectory: false, name: "weird" });
    expect(out).toEqual([]);
  });
});
