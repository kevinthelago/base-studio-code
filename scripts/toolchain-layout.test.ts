// Unit tests for the pure toolchain path/layout builders (#1277, slice 2). These cover the layout
// math the extraction step in `stage-sidecar.mjs` relies on — the archive-internal `gh` path, the
// externalBin-style staged name, the PortableGit extraction dir, and the 7z SFX flags — without
// touching the network/fs or running the stager's top-level side effects.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ghArchiveMember,
  ghBinaryName,
  ghStagedName,
  portableGitDir,
  scratchArchiveName,
  sevenZipSfxArgs,
} from "./toolchain-layout.mjs";

describe("toolchain-layout: gh archive member", () => {
  it("points at bin/gh.exe inside the versioned top dir on Windows", () => {
    expect(ghArchiveMember("2.62.0", "windows", "amd64")).toBe(
      "gh_2.62.0_windows_amd64/bin/gh.exe",
    );
    expect(ghArchiveMember("2.62.0", "windows", "arm64")).toBe(
      "gh_2.62.0_windows_arm64/bin/gh.exe",
    );
  });

  it("points at bin/gh (no .exe) inside the versioned top dir on mac/linux", () => {
    expect(ghArchiveMember("2.62.0", "macOS", "arm64")).toBe(
      "gh_2.62.0_macOS_arm64/bin/gh",
    );
    expect(ghArchiveMember("2.62.0", "linux", "amd64")).toBe(
      "gh_2.62.0_linux_amd64/bin/gh",
    );
  });
});

describe("toolchain-layout: gh binary name", () => {
  it("is gh.exe only for the windows asset OS", () => {
    expect(ghBinaryName("windows")).toBe("gh.exe");
    expect(ghBinaryName("macOS")).toBe("gh");
    expect(ghBinaryName("linux")).toBe("gh");
  });
});

describe("toolchain-layout: gh staged name (Tauri externalBin convention)", () => {
  it("appends .exe for a windows triple and nothing otherwise", () => {
    expect(ghStagedName("x86_64-pc-windows-msvc")).toBe("gh-x86_64-pc-windows-msvc.exe");
    expect(ghStagedName("aarch64-pc-windows-msvc")).toBe("gh-aarch64-pc-windows-msvc.exe");
    expect(ghStagedName("x86_64-apple-darwin")).toBe("gh-x86_64-apple-darwin");
    expect(ghStagedName("x86_64-unknown-linux-gnu")).toBe("gh-x86_64-unknown-linux-gnu");
  });
});

describe("toolchain-layout: PortableGit dir", () => {
  it("nests portable-git under the out dir (what env.rs resolves beside the exe)", () => {
    expect(portableGitDir("src-tauri/binaries")).toBe(join("src-tauri/binaries", "portable-git"));
  });
});

describe("toolchain-layout: 7z SFX args", () => {
  it("uses -o<dir> (no space) plus -y for silent extraction", () => {
    expect(sevenZipSfxArgs("C:/out/portable-git")).toEqual(["-oC:/out/portable-git", "-y"]);
  });
});

describe("toolchain-layout: scratch archive name", () => {
  it("is a dot-prefixed, tool+triple-scoped transient name", () => {
    expect(scratchArchiveName("gh", "x86_64-pc-windows-msvc", "zip")).toBe(
      ".gh-x86_64-pc-windows-msvc.zip",
    );
    expect(scratchArchiveName("portable-git", "x86_64-pc-windows-msvc", "7z.exe")).toBe(
      ".portable-git-x86_64-pc-windows-msvc.7z.exe",
    );
  });
});
