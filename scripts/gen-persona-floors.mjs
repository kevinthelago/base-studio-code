// Stamp each packaged persona's permission FLOOR onto its own JSON (epic `the-persona-is-the-whole-agent`).
//
// A persona used to REFERENCE a role, and the capability that role carried lived in two other places:
// the access tiers + write scope in `data/permissions/role-capabilities.json`, and the restricted
// command surface as a TS const (`RESTRICTED_ROLE_COMMANDS` in `shared/lib/session/roleModel`). This
// script folds both onto the persona, which is the record the store actually writes — and therefore
// the only place a write-time clamp can live.
//
// It is a ONE-WAY generator, run once per source change and committed. It is not wired into the gate:
// `personaFloorParity.test.ts` is what keeps the generated floors honest against both sources, so a
// drift is a RED TEST rather than a silent regeneration. Re-run with:
//
//   node scripts/gen-persona-floors.mjs            # write
//   node scripts/gen-persona-floors.mjs --check    # exit 1 on any drift, write nothing
//
// Deliberately NOT derived at runtime: having `roleModel` import the persona library to resolve a floor
// would close an import cycle (persona.ts already imports `SessionRole` from sessionRoles). Parity by
// test, not by import, until slice 2 deletes role-capabilities.json outright.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERSONA_DIR = join(ROOT, "src-tauri/data/personas");
const CAPS = join(ROOT, "src-tauri/data/permissions/role-capabilities.json");
const ROLE_MODEL = join(ROOT, ".bsc-records/shared/lib/session/roleModel.tsx");

const check = process.argv.includes("--check");

/** The five access tiers, in the order the role gate reasons about them (#219). */
const AXES = ["github", "git", "code", "net", "ui"];

/** Drop `//` line comments and block comments — see the call site for why this is load-bearing. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The restricted command surface per role, read out of `RESTRICTED_ROLE_COMMANDS`.
 *
 * Parsed from the module rather than duplicated here, because a hand-copied second list is exactly the
 * drift this epic exists to end — and the parse is checked by the parity test, so a shape change that
 * defeats it fails loudly instead of silently yielding an empty surface.
 */
function restrictedCommands() {
  const src = readFileSync(ROLE_MODEL, "utf8");
  const start = src.indexOf("const RESTRICTED_ROLE_COMMANDS");
  if (start < 0) throw new Error("RESTRICTED_ROLE_COMMANDS not found — did roleModel move?");
  // The object literal ends at the first line that is exactly `};` at column 0.
  const end = src.indexOf("\n};", start);
  if (end < 0) throw new Error("RESTRICTED_ROLE_COMMANDS literal is unterminated");
  // STRIP COMMENTS FIRST. These literals are heavily annotated, and the entries are quoted strings —
  // so a `// … "seeing is not reaching" …` comment parses as a command and lands in a real permission
  // surface. The first run of this script put exactly that, plus "make a new one", into the
  // architect's allow-list. A permission surface assembled by regex must never see prose.
  const body = stripComments(src.slice(start, end));

  // Resolve the one spread the literal uses, so a role's surface is complete rather than truncated.
  const loopMatch = stripComments(src).match(/const LOOP_PARTICIPANT_COMMANDS[^=]*=\s*\[([^\]]*)\]/);
  const loop = loopMatch ? [...loopMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  if (!loop.length) throw new Error("LOOP_PARTICIPANT_COMMANDS resolved empty — the spread would silently truncate a surface");

  const out = {};
  // Each entry is `role: [ ... ],` or `"sound-designer": [ ... ],` — capture the role and its array body.
  for (const m of body.matchAll(/(?:^|\n)\s{2}(?:"([a-z-]+)"|([a-z-]+))\s*:\s*\[([\s\S]*?)\n?\s*\],/g)) {
    const role = m[1] ?? m[2];
    const inner = m[3];
    const cmds = [];
    // Walk the array in source order so a spread lands where it was written.
    for (const tok of inner.matchAll(/"([^"]+)"|\.\.\.([A-Z_]+)/g)) {
      if (tok[1] !== undefined) cmds.push(tok[1]);
      else if (tok[2] === "LOOP_PARTICIPANT_COMMANDS") cmds.push(...loop);
      else throw new Error(`unresolved spread ...${tok[2]} in RESTRICTED_ROLE_COMMANDS.${role}`);
    }
    out[role] = cmds;
  }
  if (!Object.keys(out).length) throw new Error("parsed zero restricted surfaces — the literal's shape changed");
  return out;
}

/** The floor a role carries, assembled from both sources. Absent lists are omitted, never emitted empty. */
function floorFor(role, caps, restricted) {
  const row = caps.roleDefaults[role];
  if (!row) throw new Error(`persona references role '${role}', which role-capabilities.json does not define`);
  const floor = {};
  for (const axis of AXES) floor[axis] = row[axis];
  if (row.writeGlobs?.length) floor.writeGlobs = [...row.writeGlobs];
  if (row.harvestRoots?.length) floor.harvestRoots = [...row.harvestRoots];
  // The confined store-CLI surface. Its PRESENCE is what `isRestrictedRole` means today, so an empty
  // array and an absent one are NOT the same thing and the difference must survive the round trip.
  if (restricted[role]) floor.allow = [...restricted[role]];
  return floor;
}

const caps = JSON.parse(readFileSync(CAPS, "utf8"));
const restricted = restrictedCommands();

const drift = [];
let written = 0;

for (const file of readdirSync(PERSONA_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(PERSONA_DIR, file);
  const raw = readFileSync(path, "utf8");
  const persona = JSON.parse(raw);
  const floor = floorFor(persona.role, caps, restricted);

  if (JSON.stringify(persona.floor) === JSON.stringify(floor)) continue;

  if (check) {
    drift.push(`${file}: floor differs from its role row`);
    continue;
  }

  // Insert `floor` right after `role`, so the record reads identity → capability → behaviour rather
  // than burying the floor under the prose.
  const next = {};
  for (const [k, v] of Object.entries(persona)) {
    if (k === "floor") continue;
    next[k] = v;
    if (k === "role") next.floor = floor;
  }
  if (!next.floor) next.floor = floor; // a persona with no `role` key still gets one, at the end

  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  written++;
}

if (check && drift.length) {
  console.error("gen-persona-floors --check FAILED:\n  " + drift.join("\n  "));
  process.exit(1);
}
console.log(check ? "gen-persona-floors: no drift" : `gen-persona-floors: ${written} persona floor(s) written`);
