// Install the repo's git hooks into the COMMON .git/hooks, which every worktree shares.
//
// Explicit, not a postinstall: a hook that refuses operations must be something you chose.
import { copyFileSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: here,
  encoding: "utf8",
}).trim();
const dest = join(common, "hooks");
mkdirSync(dest, { recursive: true });
for (const name of readdirSync(join(here, "hooks"))) {
  copyFileSync(join(here, "hooks", name), join(dest, name));
  chmodSync(join(dest, name), 0o755);
  console.log(`[hooks] installed ${name} → ${dest}`);
}
console.log("[hooks] these govern EVERY worktree — .git/hooks lives in the common dir.");
