/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but it genuinely needs a DOM.
 * A per-file docblock beats the project's environment, so the requirement is stated where a reader
 * meets it. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  coerceShellKind,
  loadShellKind,
  saveShellKind,
  DEFAULT_SHELL,
} from "@/shared/lib/core/shellConfig";

describe("coerceShellKind", () => {
  it("accepts known shell kinds", () => {
    for (const k of ["auto", "bash", "powershell", "cmd"]) {
      expect(coerceShellKind(k)).toBe(k);
    }
  });
  it("falls back to the default for unknown / null / undefined", () => {
    expect(coerceShellKind("fish")).toBe(DEFAULT_SHELL);
    expect(coerceShellKind(null)).toBe(DEFAULT_SHELL);
    expect(coerceShellKind(undefined)).toBe(DEFAULT_SHELL);
  });
});

describe("shell persistence", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear?.();
  });

  it("round-trips the selected shell", () => {
    expect(loadShellKind()).toBe(DEFAULT_SHELL);
    saveShellKind("powershell");
    expect(loadShellKind()).toBe("powershell");
  });

  it("coerces a corrupt persisted shell value back to the default", () => {
    globalThis.localStorage?.setItem("bsc.diagnostics.shell.v1", "not-a-shell");
    expect(loadShellKind()).toBe(DEFAULT_SHELL);
  });
});
