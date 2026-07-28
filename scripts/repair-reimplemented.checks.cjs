// Unit checks for the repair primitives (#3895). Run: node scripts/repair-reimplemented.checks.cjs
// These are the risky parts — a brace matcher that stops early silently truncates a NEIGHBOURING
// declaration, producing a record that still parses and is quietly wrong. That is the exact failure mode
// this whole repair exists to undo, so the matcher is pinned before it touches a single record.
"use strict";
const assert = require("node:assert");
const { declSpan, aliasFor, addImport } = require("./repair-reimplemented.cjs");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok -", name); };

t("cuts exactly the declaration, leaving its neighbours whole", () => {
  const src = [
    'import { x } from "y";',
    'function Box({ children }) { return <div>{children}</div>; }',
    'export function Keep() { return <Box>hi</Box>; }',
  ].join("\n");
  const span = declSpan(src, "Box");
  const out = src.slice(0, span.start) + src.slice(span.end);
  assert.ok(!out.includes("function Box"), "Box is gone");
  assert.ok(out.includes("export function Keep"), "the neighbour survives intact");
  assert.ok(out.includes("<Box>hi</Box>"), "the USE site is untouched — the import replaces the decl");
});

t("a brace inside a STRING does not end the block early", () => {
  const src = 'function Box() { const s = "}"; return <div>{s}</div>; }\nexport function Keep() { return 1; }';
  const span = declSpan(src, "Box");
  const out = src.slice(0, span.start) + src.slice(span.end);
  assert.ok(out.trim().startsWith("export function Keep"), `truncated early: ${out}`);
});

t("a brace inside a COMMENT does not end the block early", () => {
  const src = 'function Box() { // }\n  return null; }\nexport function Keep() { return 1; }';
  const span = declSpan(src, "Box");
  const out = src.slice(0, span.start) + src.slice(span.end);
  assert.ok(out.trim().startsWith("export function Keep"), `truncated early: ${out}`);
});

t("handles an arrow const and swallows its trailing semicolon", () => {
  const src = "const Box = ({ c }) => { return c; };\nexport function Keep() { return 1; }";
  const span = declSpan(src, "Box");
  const out = src.slice(0, span.start) + src.slice(span.end);
  assert.ok(!out.includes("Box"), `left a fragment: ${out}`);
  assert.ok(!out.trim().startsWith(";"), "the trailing ; went with it");
});

t("never matches a SUBSTRING name", () => {
  const src = "function BoxShadow() { return 1; }";
  assert.strictEqual(declSpan(src, "Box"), null);
});

t("derives the import path from the target node's own src", () => {
  assert.strictEqual(aliasFor("src/shared/ui/data/IconBox.tsx"), "@/shared/ui/data/IconBox");
  assert.strictEqual(aliasFor("src/features/x/Y.ts"), "@/features/x/Y");
  assert.strictEqual(aliasFor("src/shared/ui/layouts"), null, "a DIRECTORY is not a module path");
  assert.strictEqual(aliasFor(""), null);
});

t("adds the import after the last existing one, and is idempotent", () => {
  const src = 'import a from "a";\nimport b from "b";\nexport function K() { return 1; }';
  const out = addImport(src, "Box", "@/shared/ui/layout/Box");
  assert.ok(out.includes('import b from "b";\nimport { Box } from "@/shared/ui/layout/Box";'), out);
  assert.strictEqual(addImport(out, "Box", "@/shared/ui/layout/Box"), out, "second call is a no-op");
});

t("adds the import at the top when the module has none", () => {
  const out = addImport("export function K() { return 1; }", "Box", "@/x/Box");
  assert.ok(out.startsWith('import { Box } from "@/x/Box";\n'), out);
});

console.log(`\n${n} passed`);
