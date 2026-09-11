// The eight per-machine SESSION SETTINGS reach session.db, where the launch resolver reads them over
// what `app-state.json` says (frontend-state-5-secrets-and-policy-leave-app-state).
//
// This is a MIGRATION, not a removal: every setter still updates its store field and the persist
// allowlist still carries all eight, so nothing regresses for a user who has set one. What these tests
// pin is the Rust side — the exact `bsc session policy` argv, because a call-site that merely "calls
// bsc" would pass while writing the wrong key or the wrong spelling of a boolean.
//
// NO CREDENTIAL APPEARS ANYWHERE IN THIS FILE. The secrets half of the slice was measured and filed
// separately (frontend-state-5a-secrets-leave-app-state); presence is the only thing that may ever be
// asserted about one, and none of these eight settings is one.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";

type BscPayload = { projectKey: unknown; args: string[] };

const policyCalls = (): BscPayload[] =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd, payload]) => cmd === "bsc" && (payload as BscPayload | undefined)?.args?.[1] === "policy")
    .map(([, payload]) => payload as BscPayload);

/** The argv a `--set` write should produce, minus the trailing `--by app`. */
const setArgs = (key: string, value: string) => ["session", "policy", "--set", key, value, "--by", "app"];

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockResolvedValue(null);
});

describe("a session setting is recorded where Rust reads it", () => {
  it("records each of the six flag settings as the exact spelling Rust parses", async () => {
    const s = useAppStore.getState();
    s.setBypassPermissions(true);
    s.setSandboxConsoles(true);
    s.setInjectionHardGate(true);
    s.setRestrictToBscIssues(false);
    s.setAutoResumeClaude(true);
    await vi.waitFor(() => expect(policyCalls()).toHaveLength(5));
    expect(policyCalls().map((c) => c.args)).toEqual([
      setArgs("bypassPermissions", "true"),
      setArgs("sandboxConsoles", "true"),
      setArgs("injectionHardGate", "true"),
      setArgs("restrictToBscIssues", "false"),
      setArgs("autoResumeClaude", "true"),
    ]);
    // A flag is stored as `true`/`false`, never as `1`/`0` or `True` — `policy::as_flag` refuses
    // anything else and would read the row as ABSENT, silently restoring the default.
    for (const call of policyCalls()) expect(["true", "false"]).toContain(call.args[4]);
  });

  it("still updates the store field, so the UI is unchanged by the migration", () => {
    useAppStore.getState().setBypassPermissions(true);
    expect(useAppStore.getState().bypassPermissions).toBe(true);
    useAppStore.getState().setRestrictToBscIssues(false);
    expect(useAppStore.getState().restrictToBscIssues).toBe(false);
  });

  it("records the harness and the default model as text", async () => {
    useAppStore.getState().setFleetHarness("bsc-agent");
    useAppStore.getState().setDefaultModel("opus-4.5" as never);
    await vi.waitFor(() => expect(policyCalls()).toHaveLength(2));
    expect(policyCalls().map((c) => c.args)).toEqual([
      setArgs("fleetHarness", "bsc-agent"),
      setArgs("defaultModel", "opus-4.5"),
    ]);
    expect(useAppStore.getState().fleetHarness).toBe("bsc-agent");
    expect(useAppStore.getState().defaultModel).toBe("opus-4.5");
  });

  it("records the WHOLE deny list on an add and on a remove, not the one command that changed", async () => {
    useAppStore.setState({ deniedCommands: [] } as never);
    const s = useAppStore.getState();
    s.addDeniedCommand("rm -rf /");
    s.addDeniedCommand("curl");
    s.removeDeniedCommand("curl");
    await vi.waitFor(() => expect(policyCalls()).toHaveLength(3));
    // A JSON array, because the setting IS a list: Rust parses it with serde and a bare command string
    // is refused. The value is the resulting list each time — the store holds state, not a diff.
    expect(policyCalls().map((c) => c.args)).toEqual([
      setArgs("deniedCommands", '["rm -rf /"]'),
      setArgs("deniedCommands", '["rm -rf /","curl"]'),
      setArgs("deniedCommands", '["rm -rf /"]'),
    ]);
    expect(useAppStore.getState().deniedCommands).toEqual(["rm -rf /"]);
  });

  it("records nothing when an add is a no-op, so the store is not rewritten for free", async () => {
    useAppStore.setState({ deniedCommands: ["curl"] } as never);
    useAppStore.getState().addDeniedCommand("curl"); // already there
    useAppStore.getState().addDeniedCommand("   "); // blank
    await new Promise((r) => setTimeout(r, 0));
    expect(policyCalls()).toHaveLength(0);
  });

  it("records a wholesale setDeniedCommands as one list write", async () => {
    useAppStore.getState().setDeniedCommands(["a", "b"]);
    await vi.waitFor(() => expect(policyCalls()).toHaveLength(1));
    expect(policyCalls()[0].args).toEqual(setArgs("deniedCommands", '["a","b"]'));
  });
});

describe("the store hydrates the settings Rust holds", () => {
  /** Answer `bsc session policy --json` with `rows`; every other bsc read stays empty. */
  const servePolicy = (rows: Record<string, string> | null) => {
    vi.mocked(invoke).mockImplementation((cmd: string, payload?: unknown) => {
      const args = (payload as BscPayload | undefined)?.args ?? [];
      if (cmd === "bsc" && args[1] === "policy") return Promise.resolve(JSON.stringify(rows));
      return Promise.resolve(null);
    });
  };

  it("takes every stored setting over the store's own value", async () => {
    useAppStore.setState({
      bypassPermissions: false, sandboxConsoles: false, injectionHardGate: false,
      restrictToBscIssues: true, autoResumeClaude: false,
      fleetHarness: "claude", defaultModel: "sonnet-4.5", deniedCommands: [],
    } as never);
    servePolicy({
      bypassPermissions: "true", sandboxConsoles: "true", injectionHardGate: "true",
      restrictToBscIssues: "false", autoResumeClaude: "true",
      fleetHarness: "bsc-agent", defaultModel: "opus-4.5", deniedCommands: '["rm -rf /"]',
    });
    await useAppStore.getState().hydratePolicy();
    const s = useAppStore.getState();
    expect(s.bypassPermissions).toBe(true);
    expect(s.sandboxConsoles).toBe(true);
    expect(s.injectionHardGate).toBe(true);
    expect(s.restrictToBscIssues).toBe(false);
    expect(s.autoResumeClaude).toBe(true);
    expect(s.fleetHarness).toBe("bsc-agent");
    expect(s.defaultModel).toBe("opus-4.5");
    expect(s.deniedCommands).toEqual(["rm -rf /"]);
  });

  it("ABSENT NEVER BLANKS — a key the store does not hold keeps what app-state restored", async () => {
    useAppStore.setState({ bypassPermissions: true, defaultModel: "opus-4.5", deniedCommands: ["curl"] } as never);
    servePolicy({ bypassPermissions: "false" }); // the only stored setting
    await useAppStore.getState().hydratePolicy();
    const s = useAppStore.getState();
    expect(s.bypassPermissions, "the stored one wins").toBe(false);
    expect(s.defaultModel, "unstored, so the persisted value stands").toBe("opus-4.5");
    expect(s.deniedCommands).toEqual(["curl"]);
  });

  it("an empty store, an unreachable bridge and a corrupt row all leave every setting alone", async () => {
    const pristine = { bypassPermissions: true, restrictToBscIssues: false, defaultModel: "opus-4.5", deniedCommands: ["curl"] };
    for (const rows of [{}, null, { bypassPermissions: "TRUE", deniedCommands: "rm -rf" }] as (Record<string, string> | null)[]) {
      useAppStore.setState(pristine as never);
      servePolicy(rows);
      await useAppStore.getState().hydratePolicy();
      const s = useAppStore.getState();
      expect(s.bypassPermissions, `rows=${JSON.stringify(rows)}`).toBe(true);
      expect(s.restrictToBscIssues).toBe(false);
      expect(s.defaultModel).toBe("opus-4.5");
      expect(s.deniedCommands).toEqual(["curl"]);
    }
  });

  it("reads the store with one spawn, not one per setting", async () => {
    servePolicy({ bypassPermissions: "true" });
    await useAppStore.getState().hydratePolicy();
    expect(policyCalls()).toHaveLength(1);
    expect(policyCalls()[0].args).toEqual(["session", "policy", "--json"]);
  });
});
