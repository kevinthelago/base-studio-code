// The PLATFORM-MODULES manifest (#3897) — `src-tauri/data/ui/platform-modules.json`, the set of import
// specifiers the runtime registry resolves, emitted as data both doctors read.
//
// WHY IT IS GENERATED FROM THE REGISTRY, not scanned from source. The registrations run through LOOPS
// (`for (const [spec, mod] of Object.entries(PLATFORM))`, and each feature platform registers `./X` +
// `@/features/<f>/…/X` pairs from a map), so a static scan for `registerAppModule("…")` literals would
// miss most of them. Calling the real registration functions and reading `registeredSpecifiers()` back is
// exact by construction and cannot drift from what the app actually registers.
//
// WHY IT EXISTS. The doctor's buildability check resolves `@/…` against the packaged artifact and sibling
// node `src` paths only. A record that honestly imports a REGISTERED platform module
// (`@/features/security/lib/badgeTone`) matched neither, so it read as `no-implementation` — which is how
// #3895's faithful `security-profiles` moved `securitypage` into that finding while the runtime mounted it
// fine. Worse, it pressures the next author to STUB the import to make the finding go away, which is
// exactly the corruption #3892 exists to catch.
//
// Regenerate with `UPDATE_KITS=1 npx vitest run src/features/designs/lib/platformModules.gen.test.ts`
// (same switch the packaged-kit artifacts use).
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "@data/ui/platform-modules.json";
import { registerPlatformModules } from "@/app/runtime/appModules";
import { registerAutomationsPlatform } from "@/features/automations/graphPlatform";
import { registerGithubPlatform } from "@/features/github/graphPlatform";
import { registerMcpPlatform } from "@/features/mcp/graphPlatform";
import { registerSecurityPlatform } from "@/features/security/graphPlatform";
import { registerSkillsPlatform } from "@/features/skills/graphPlatform";
import { registerGlancePlatform } from "@/features/glance/graphPlatform";
import { registerSoundsPlatform } from "@/features/sounds/graphPlatform";
import { registerAlgorithmsPlatform } from "@/features/algorithms/graphPlatform";
import { registerPlanningPlatform } from "@/features/planner/session/graphPlatform";
import { registerConsolePlatform } from "@/app/console/graphPlatform";
import { registerFleetPlatform } from "@/features/planner/fleet/graphPlatform";
import { registerProjectsPlatform } from "@/features/planner/list/graphPlatform";
import { registerPanePlatform } from "@/features/planner/pane/graphPlatform";
import { registeredSpecifiers } from "@/shared/lib/runtime/moduleRegistry";

const FILE = resolve(__dirname, "../../../../src-tauri/data/ui/platform-modules.json");

/** Every specifier the app registers — the shell's platform set plus every feature's own.
 *
 *  Deliberately does NOT reset the registry first. Each `register*Platform()` is latched by a module-level
 *  `done` flag, and some of them have already fired during this file's import graph — so resetting would
 *  WIPE their registrations and leave the re-call a no-op, silently emitting a manifest missing whole
 *  features (security vanished exactly this way on the first run). Reading the accumulated registry after
 *  calling every registrar gives the union, which is the contract: everything in the registry IS a
 *  registered platform module. */
function currentSpecifiers(): string[] {
  registerPlatformModules();
  registerAutomationsPlatform();
  registerGithubPlatform();
  registerMcpPlatform();
  registerSecurityPlatform();
  registerSkillsPlatform();
  registerGlancePlatform();
  registerSoundsPlatform();
  registerAlgorithmsPlatform();
  registerPlanningPlatform();
  registerConsolePlatform();
  registerFleetPlatform();
  registerProjectsPlatform();
  registerPanePlatform();
  return registeredSpecifiers();
}

describe("platform-modules.json (#3897)", () => {
  it("stays in sync with what the app actually registers (UPDATE_KITS=1 to regenerate)", () => {
    const specs = currentSpecifiers();
    if (process.env.UPDATE_KITS) {
      writeFileSync(FILE, JSON.stringify(specs, null, 2) + "\n");
    }
    const onDisk = JSON.parse(readFileSync(FILE, "utf8")) as string[];
    expect(onDisk).toEqual(specs);
    expect(onDisk).toEqual(manifest); // …and the bundled import matches the file
  });

  it("is non-vacuous and covers the modules the doctor was blind to", () => {
    // The guard against a manifest that regenerates to `[]` and silently makes every check pass.
    expect(manifest.length).toBeGreaterThan(60);
    // The two that put `securitypage` into no-implementation (#3895) — the reason this file exists.
    expect(manifest).toContain("@/features/security/lib/badgeTone");
    expect(manifest).toContain("@/features/security/lib/appSession");
    // …and the platform basics a graph page always needs.
    expect(manifest).toContain("react");
    expect(manifest).toContain("@/store");
  });
});
