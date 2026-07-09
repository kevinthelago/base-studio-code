import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { emitTokensContractCss, flattenTokens, type StyleDescriptor } from "./styleContract";

// #2567: `tokens-contract.css` is GENERATED from `style-descriptor.json` (the design-system SoT).
// This is the generator + the drift guard: `UPDATE_KITS=1 npx vitest run styleContract.gen`
// (re)writes the CSS from the descriptor; CI asserts it stays in sync, so the contract can't silently
// drift from the descriptor (and thus from what `bsc ui tokens` will report). Read via fs (not a JSON
// import) so the test doesn't depend on resolveJsonModule; normalise CRLF → LF for cross-platform.
const DESCRIPTOR_FILE = join(process.cwd(), "src-tauri/data/ui/style-descriptor.json");
const CSS_FILE = join(process.cwd(), "src-tauri/data/ui/tokens-contract.css");
const descriptor = JSON.parse(readFileSync(DESCRIPTOR_FILE, "utf8")) as StyleDescriptor;
const css = emitTokensContractCss(descriptor);

describe("tokens-contract.css ↔ style-descriptor.json (#2567)", () => {
  it("is generated verbatim from the style descriptor (UPDATE_KITS=1 to regenerate)", () => {
    if (process.env.UPDATE_KITS) writeFileSync(CSS_FILE, css);
    expect(existsSync(CSS_FILE), "tokens-contract.css missing — run `UPDATE_KITS=1 npx vitest run styleContract.gen`").toBe(true);
    expect(readFileSync(CSS_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(css);
  });

  it("declares EVERY descriptor token as a `--name:` line (the Rust contract parser's precondition)", () => {
    // crates/bsc-ui lib.rs:207 parses trimmed lines starting with `--` up to `:` — every token the
    // descriptor defines (and every theme override references) must appear as such a declaration.
    const declared = new Set(
      css.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("--")).map((l) => l.split(":")[0].trim()),
    );
    for (const t of flattenTokens(descriptor)) {
      expect(declared.has(t.name), `${t.name} must be declared in the emitted contract`).toBe(true);
    }
    // spot-check the semantic set the Rust test asserts by name
    expect(declared.has("--card-bg") && declared.has("--chip-border")).toBe(true);
  });

  it("flattens base + component + per-variant tokens in order, with rung-2 addressing intact", () => {
    const flat = flattenTokens(descriptor);
    expect(flat.filter((t) => t.family === "base")).toHaveLength(descriptor.base.length);
    // btn's `primary` variant tokens carry component + variant + key so `component btn set-token bg
    // --variant primary` resolves to `--btn-primary-bg`.
    const p = flat.find((t) => t.name === "--btn-primary-bg")!;
    expect(p).toMatchObject({ component: "btn", variant: "primary", key: "bg" });
    // base tokens carry no component/variant/key.
    const accent = flat.find((t) => t.name === "--accent")!;
    expect(accent.family).toBe("base");
    expect(accent.component).toBeUndefined();
    // domain / categorical tokens (#2607) flatten with family = the group, a key, and NO component —
    // they're contract vocabulary a kit consumes, not a component surface.
    const err = flat.find((t) => t.name === "--graph-health-error");
    expect(err).toMatchObject({ family: "graph-health", key: "error" });
    expect(err?.component).toBeUndefined();
  });
});
