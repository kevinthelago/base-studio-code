// Regenerate src/features/tunnel/lib/storePayloads.fixtures.json from the real store_state builders.
// A thin wrapper so `npm run fixtures:store` sets UPDATE_STORE_FIXTURES cross-platform (Windows npm
// runs scripts via cmd.exe, where the bash `VAR=1 cmd` form fails, and the repo carries no cross-env).
import { spawnSync } from "node:child_process";

const r = spawnSync(
  "npx",
  ["vitest", "run", "src/features/tunnel/lib/storePayloads.fixtures.test.ts"],
  { stdio: "inherit", shell: true, env: { ...process.env, UPDATE_STORE_FIXTURES: "1" } },
);
process.exit(r.status ?? 1);
