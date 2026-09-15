// The app's SETTINGS and the user's LAST NAVIGATION live in session.db's `user_settings`, not in the
// persisted `app-state.json` snapshot (`settings-and-last-navigation-live-in-user-settings`).
//
// FOUR HALVES, because any one alone passes while the feature is broken:
//   - the KEY SET: the renderer's table and Rust's `policy::KEYS` are one list, with one kind per key —
//     a key the renderer writes that Rust refuses would fail every write silently (`bscRun` swallows it);
//   - the ALLOWLIST: none of the keys is persisted any more — a copy left there is a second source that drifts;
//   - the HYDRATE: the stored rows come back into the store at boot, the last workspace included, with
//     ABSENT NEVER BLANKS and a corrupt row ignored;
//   - the WRITE-THROUGH: every later change reaches `bsc session policy` in the exact spelling Rust parses,
//     and NOTHING is written before the boot read — a default written then would overwrite the saved value.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { loadImplementations } from "@scripts/lib/recordStore.mjs";
import { useAppStore } from "@/store";
import { persistedState } from "@/store/persist";
import {
  USER_SETTING_KINDS,
  USER_SETTING_KEYS,
  decodeSetting,
  encodeSetting,
  hydrateUserSettings,
  settingArgs,
  userSettingWrites,
} from "@/store/userSettings";

type BscPayload = { projectKey: unknown; args: string[] };

const records = loadImplementations() as { id: string; code: string }[];
const code = (id: string): string => records.find((r) => r.id === id)?.code ?? "";

const policyCalls = (): string[][] =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd, payload]) => cmd === "bsc" && (payload as BscPayload | undefined)?.args?.[1] === "policy")
    .map(([, payload]) => (payload as BscPayload).args);
const writes = () => policyCalls().filter((a) => a[2] === "--set" || a[2] === "--clear");

/** Answer `bsc session policy --json` with `rows`; every other bsc read stays empty. */
const servePolicy = (rows: Record<string, string> | null) => {
  vi.mocked(invoke).mockImplementation((cmd: string, payload?: unknown) => {
    const args = (payload as BscPayload | undefined)?.args ?? [];
    if (cmd === "bsc" && args[1] === "policy" && args[2] === "--json") return Promise.resolve(JSON.stringify(rows));
    return Promise.resolve(null);
  });
};

let uninstall: (() => void) | null = null;
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe("the key set is one list in Rust and in the renderer", () => {
  const POLICY = code("bsc-session--policy.rs");

  it("reads the real Rust record, so the comparisons below cannot be vacuous", () => {
    expect(POLICY).toMatch(/pub const APP_SETTINGS: &\[&str\]/);
    expect(POLICY).toMatch(/pub const KEYS: &\[\(&str, Kind\)\]/);
  });

  it("names exactly the keys Rust's APP_SETTINGS names", () => {
    const block = POLICY.slice(POLICY.indexOf("pub const APP_SETTINGS"), POLICY.indexOf("];", POLICY.indexOf("pub const APP_SETTINGS")));
    const rust = [...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
    expect(rust).toHaveLength(33);
    expect([...USER_SETTING_KEYS].sort()).toEqual(rust);
  });

  it("gives every key the kind Rust checks it against", () => {
    const rustKind: Record<string, string> = {};
    for (const m of POLICY.matchAll(/\("([A-Za-z]+)", Kind::(Flag|Text|List|Number|Object)\)/g)) rustKind[m[1]] = m[2].toLowerCase();
    for (const key of USER_SETTING_KEYS) {
      expect(rustKind[key], `${key}'s kind in policy::KEYS`).toBe(USER_SETTING_KINDS[key]);
    }
  });
});

describe("the persisted snapshot no longer carries them", () => {
  it("leaves every moved key out of persistedState, and keeps the rest", () => {
    const snap = persistedState(useAppStore.getState());
    for (const key of USER_SETTING_KEYS) expect(key in snap, `${key} is persisted again`).toBe(false);
    // Surgical, not over-broad: the launch's eight and the per-pane launch facts are still persisted.
    for (const key of ["bypassPermissions", "defaultModel", "paneCwds", "paneRoles", "kitDispatches"]) {
      expect(key in snap, `${key} should still be persisted`).toBe(true);
    }
  });

  it("is hydrated at boot, beside the launch settings", () => {
    const boot = code("app--use-app-boot.ts");
    expect(boot).toMatch(/import \{ hydrateUserSettings \} from "@\/store\/userSettings"/);
    expect(boot).toMatch(/void hydrateUserSettings\(useAppStore\)/);
  });
});

describe("a setting is encoded in the spelling Rust parses", () => {
  it("writes flags as true/false, numbers as numbers and objects as JSON", () => {
    expect(encodeSetting("ttsEnabled", true)).toEqual({ key: "ttsEnabled", value: "true" });
    expect(encodeSetting("terminalFontSize", 15)).toEqual({ key: "terminalFontSize", value: "15" });
    expect(encodeSetting("activePageTab", { glance: "network" })).toEqual({ key: "activePageTab", value: '{"glance":"network"}' });
    expect(encodeSetting("activeWorkspace", "teams")).toEqual({ key: "activeWorkspace", value: "teams" });
  });

  it("CLEARS an empty text, because the store has no empty row and a skipped clear would come back", () => {
    expect(encodeSetting("ttsVoice", "")).toEqual({ key: "ttsVoice", clear: true });
    expect(settingArgs({ key: "ttsVoice", clear: true })).toEqual(["session", "policy", "--clear", "ttsVoice", "--by", "app"]);
  });

  it("refuses to write a value that is not of its kind", () => {
    expect(encodeSetting("ttsEnabled", "yes")).toBeNull();
    expect(encodeSetting("terminalFontSize", Number.NaN)).toBeNull();
    expect(encodeSetting("keybindings", [])).toBeNull();
    expect(encodeSetting("accent", 3)).toBeNull();
  });

  it("reads a corrupt row as absent rather than as a default", () => {
    expect(decodeSetting("ttsEnabled", "TRUE")).toBeNull();
    expect(decodeSetting("terminalFontSize", "")).toBeNull();
    expect(decodeSetting("terminalFontSize", "big")).toBeNull();
    expect(decodeSetting("keybindings", "[]")).toBeNull();
    expect(decodeSetting("accent", "")).toBeNull();
    expect(decodeSetting("ttsRate", "1.25")).toEqual({ value: 1.25 });
  });

  it("writes only what changed — an object rebuilt with the same contents is not a change", () => {
    const prev = { activePageTab: { glance: "network" }, terminalFontSize: 14 };
    expect(userSettingWrites(prev, { activePageTab: { glance: "network" }, terminalFontSize: 14 })).toEqual([]);
    expect(userSettingWrites(prev, { activePageTab: { glance: "fleet" }, terminalFontSize: 14 })).toEqual([
      { key: "activePageTab", value: '{"glance":"fleet"}' },
    ]);
  });
});

describe("the boot read restores what session.db holds", () => {
  it("takes every stored setting and the last navigation over the store's defaults", async () => {
    useAppStore.setState({ terminalFontSize: 13, ttsEnabled: false, activeWorkspace: "console", activePageTab: {} } as never);
    servePolicy({
      terminalFontSize: "17", ttsEnabled: "true", activeWorkspace: "teams",
      activePageTab: '{"teams":"core"}', bypassPermissions: "true",
    });
    uninstall = await hydrateUserSettings(useAppStore, 0);
    const s = useAppStore.getState() as unknown as Record<string, unknown>;
    expect(s.terminalFontSize).toBe(17);
    expect(s.ttsEnabled).toBe(true);
    expect(s.activeWorkspace, "a launch reopens where the user left off").toBe("teams");
    expect(s.activePageTab).toEqual({ teams: "core" });
  });

  it("ABSENT NEVER BLANKS, and a corrupt row changes nothing", async () => {
    useAppStore.setState({ terminalFontSize: 13, accent: "amber", keybindings: { a: "b" } } as never);
    servePolicy({ terminalFontSize: "big", keybindings: "[1]" });
    uninstall = await hydrateUserSettings(useAppStore, 0);
    const s = useAppStore.getState() as unknown as Record<string, unknown>;
    expect(s.terminalFontSize).toBe(13);
    expect(s.accent).toBe("amber");
    expect(s.keybindings).toEqual({ a: "b" });
  });

  it("sends a stored workspace that no longer exists where the persisted one used to go", async () => {
    servePolicy({ activeWorkspace: "github" });
    uninstall = await hydrateUserSettings(useAppStore, 0);
    const s = useAppStore.getState() as unknown as Record<string, unknown>;
    expect(s.activeWorkspace).toBe("settings");
    expect(s.settingsSection).toBe("github");
  });

  it("reads the store with one spawn, not one per setting", async () => {
    servePolicy({ terminalFontSize: "15" });
    uninstall = await hydrateUserSettings(useAppStore, 0);
    expect(policyCalls()).toEqual([["session", "policy", "--json"]]);
  });
});

describe("every later change is written through", () => {
  it("writes NOTHING before the boot read, so a default can never overwrite the saved value", async () => {
    useAppStore.setState({ terminalFontSize: 21, activeWorkspace: "glance" } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(writes()).toEqual([]);
  });

  it("records each change after the boot read in the exact argv, through whichever setter made it", async () => {
    // A known baseline first: the store is shared across tests, and a value already equal to the one set
    // below is not a change and rightly writes nothing.
    useAppStore.setState({ terminalFontSize: 13, activeWorkspace: "console", activePageTab: {}, ttsVoice: "nova" } as never);
    servePolicy({});
    uninstall = await hydrateUserSettings(useAppStore, 0);
    useAppStore.getState().setTerminalFontSize(16);
    useAppStore.setState({ activeWorkspace: "teams", activePageTab: { teams: "core" }, ttsVoice: "" } as never);
    await vi.waitFor(() => expect(writes()).toHaveLength(4));
    expect(writes()).toEqual(expect.arrayContaining([
      ["session", "policy", "--set", "terminalFontSize", "16", "--by", "app"],
      ["session", "policy", "--set", "activeWorkspace", "teams", "--by", "app"],
      ["session", "policy", "--set", "activePageTab", '{"teams":"core"}', "--by", "app"],
      // An emptied text is a CLEAR back to the default, never a skipped write.
      ["session", "policy", "--clear", "ttsVoice", "--by", "app"],
    ]));
  });

  it("does not echo the boot read back into the store it came from", async () => {
    servePolicy({ terminalFontSize: "19", activeWorkspace: "teams" });
    uninstall = await hydrateUserSettings(useAppStore, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(writes()).toEqual([]);
  });

  it("coalesces a burst on one key into one write of the final value", async () => {
    vi.useFakeTimers();
    try {
      servePolicy({});
      uninstall = await hydrateUserSettings(useAppStore, 250);
      for (const z of [0.5, 0.6, 0.7]) useAppStore.setState({ teamsZoom: { core: z } } as never);
      expect(writes()).toEqual([]);
      await vi.advanceTimersByTimeAsync(300);
      expect(writes()).toEqual([["session", "policy", "--set", "teamsZoom", '{"core":0.7}', "--by", "app"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
