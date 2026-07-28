#!/usr/bin/env node
// Repair `reimplemented-component` records (#3895, guard from #3892).
//
// A record declares `function Box(...)` locally while a `Box` node already exists in the same graph, so
// the preview compiles the STUB and the node looks correct while composing nothing real. The fix per
// occurrence: delete the local declaration and add the real import, derived from the TARGET NODE'S OWN
// `src` (`src/shared/ui/data/IconBox.tsx` → `@/shared/ui/data/IconBox`) — never a guessed path.
//
// Deletion is BRACE-MATCHED, not regex-sliced: it walks from the declaration's opening `{` and tracks
// string / template / comment context so a `{` inside a JSX string or a `//` comment cannot end the block
// early. A regex would silently truncate a neighbouring declaration, which is the failure this whole issue
// is about — a change that still parses and is quietly wrong.
//
// READ-ONLY by default: prints what it would do. `--write` applies. Never invents a target: a name with no
// node, or a node whose `src` is not a module path, is REPORTED and skipped.
"use strict";

/** Walk from `openIdx` (the index of `{`) to its matching `}`; -1 if unbalanced. */
function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  let mode = null; // "'" | '"' | "`" | "//" | "/*"
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "//") {
      if (c === "\n") mode = null;
    } else if (mode === "/*") {
      if (c === "*" && next === "/") { mode = null; i++; }
    } else if (mode) {
      // inside a string/template
      if (c === "\\") i++;
      else if (c === mode) mode = null;
    } else if (c === "/" && next === "/") { mode = "//"; i++; }
    else if (c === "/" && next === "*") { mode = "/*"; i++; }
    else if (c === "'" || c === '"' || c === "`") mode = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** The span of a top-level `function <name>` / `const <name> =` declaration, or null. */
function declSpan(src, name) {
  const re = new RegExp(`(?:^|\\n)((?:export\\s+)?(?:function|const)\\s+${name}\\b)`, "g");
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
    const open = src.indexOf("{", start);
    if (open < 0) continue;
    const end = matchBrace(src, open);
    if (end < 0) continue;
    // A `const X = (…) => {…}` may be followed by `;`
    const after = src[end + 1] === ";" ? end + 2 : end + 1;
    return { start, end: after };
  }
  return null;
}

/** `src/shared/ui/data/IconBox.tsx` → `@/shared/ui/data/IconBox`. Null when not a module path. */
function aliasFor(src) {
  if (!src || !/^src\/.+\.(tsx|ts|jsx|js)$/.test(src)) return null;
  return "@/" + src.replace(/^src\//, "").replace(/\.(tsx|ts|jsx|js)$/, "");
}

/** Insert `import { name } from "spec";` after the last existing import (or at the top). */
function addImport(src, name, spec) {
  if (new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(src)) return src; // already there
  const line = `import { ${name} } from "${spec}";`;
  const imports = [...src.matchAll(/^import\s.*?;\s*$/gm)];
  if (imports.length === 0) return `${line}\n${src}`;
  const last = imports[imports.length - 1];
  const at = last.index + last[0].length;
  return src.slice(0, at) + "\n" + line + src.slice(at);
}

module.exports = { matchBrace, declSpan, aliasFor, addImport };
