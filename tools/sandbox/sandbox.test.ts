// Guard for tools/sandbox — the isolation prototypes.
//
// These scripts are run by hand on a Linux host, so nothing in the app exercises them and a
// syntax error would sit undetected until the day someone actually needs them (which is the day
// the isolation model is being changed, i.e. the worst possible time). `bash -n` over each one
// mirrors what `full_bsc_rc_is_syntactically_valid_bash` does for the generated bsc-env.sh.
//
// The rm -rf assertion is the one that matters most: both scripts delete their fixture root, so
// an edit that left ROOT unset or unanchored would delete something else entirely.
//
// Plan: phase-2-kernel-isolation-replaces-the-hook-floor (slice 1)
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_SCRIPTS = ["namespace-escape.sh", "cgroup-caps.sh"];
const ALL_FILES = [...SHELL_SCRIPTS, "webkit-probe.c", "webkit-probe.html", "README.md"];

const read = (f: string) => readFileSync(join(HERE, f), "utf8");

describe("tools/sandbox prototypes", () => {
  it.each(ALL_FILES)("%s is present", (f) => {
    expect(existsSync(join(HERE, f))).toBe(true);
  });

  it.each(SHELL_SCRIPTS)("%s parses as bash", (f) => {
    // Throws with the parse error attached if bash rejects it.
    expect(() => execFileSync("bash", ["-n", join(HERE, f)], { stdio: "pipe" })).not.toThrow();
  });

  // Both scripts rm -rf their fixture root. Anchor it or risk deleting a real directory.
  it.each(SHELL_SCRIPTS)("%s confines rm -rf to a $HOME-anchored ROOT", (f) => {
    const src = read(f);
    const root = src.match(/^ROOT="([^"]+)"/m);
    expect(root, `${f} must declare ROOT="..." at line start`).not.toBeNull();
    expect(root![1].startsWith("$HOME/"), `ROOT must be under $HOME, got ${root![1]}`).toBe(true);

    for (const m of src.matchAll(/rm\s+-rf\s+(\S+)/g)) {
      expect(m[1], `${f}: every rm -rf must target "$ROOT", found ${m[1]}`).toBe('"$ROOT"');
    }
  });

  it("namespace-escape reproduces the escape before claiming it is closed", () => {
    // A run where T2 passes but T1 never leaked proves only that the fixture is broken, so the
    // verdict must gate on T1 having actually reproduced.
    const src = read("namespace-escape.sh");
    expect(src).toContain("T1 DID NOT REPRODUCE");
  });

  it("cgroup-caps reads the hog script from inside the namespace, not from the host", () => {
    // Regression for the false pass found in Phase 0: passing a host path made the run die with
    // ENOENT (correct isolation) which was then miscounted as the memory cap firing.
    const src = read("cgroup-caps.sh");
    expect(src).toContain("capped_sandbox 128M 64 python3 /repo/hog.py 512");
    expect(src).not.toMatch(/capped_sandbox[^\n]*\$ROOT\/agent-a\/hog\.py/);
  });

  it("the webkit probe does not claim to detect hardware acceleration", () => {
    // WebKit spoofs the renderer string (Apple Inc. / Apple GPU on Linux). A field named
    // hardware_accelerated derived from it was wrong in Phase 0 and must not come back.
    const html = read("webkit-probe.html");
    expect(html).not.toContain("hardware_accelerated");
    expect(html).toContain("renderer_reported");
  });

  it("the webkit probe issues a real instanced draw, not an API existence check", () => {
    const html = read("webkit-probe.html");
    expect(html).toContain("drawArraysInstanced");
    expect(html).toContain("instanced_draw_ran");
  });
});
