// The thin probe the reference-transaction hook calls. Decision lives in guard-policy.mjs.
import { judgeRefUpdate, refusalMessage } from "./guard-policy.mjs";

const ref = process.env.BSC_GUARD_REF ?? "";
const { allow } = judgeRefUpdate({
  ref,
  viaPromote: process.env.BSC_PROMOTE === "1",
  cwd: process.env.BSC_GUARD_CWD,
  repoRoot: process.env.BSC_GUARD_ROOT,
});
if (!allow) {
  console.error(refusalMessage(ref));
  process.exit(1);
}
