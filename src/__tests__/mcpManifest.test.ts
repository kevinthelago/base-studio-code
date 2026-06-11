import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BSC_EXTENSION_VERSION,
  parseBscExtension,
  defFromBscManifest,
  resolveBscUrl,
  fetchBscExtension,
  parseInstallDeepLink,
  mergeRemoteCatalog,
  fetchRemoteCatalog,
} from "../lib/extensions/mcpManifest";
import type { CatalogItem } from "../data/extensions";

// ── parseBscExtension ──────────────────────────────────────────────────────────

describe("parseBscExtension", () => {
  it("accepts a minimal valid MCP manifest", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "mcp", name: "My Server" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.name).toBe("My Server");
  });

  it("accepts a minimal valid hook manifest", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "hook", name: "Block PII" });
    expect(r.ok).toBe(true);
  });

  it("accepts full stdio MCP manifest", () => {
    const raw = {
      bscExtension: 1, kind: "mcp", name: "Postgres", by: "mcp-team", icon: "pg",
      desc: "Database queries", transport: "stdio",
      command: "npx", args: "-y @mcp/server-postgres",
      env: [["POSTGRES_URL", ""]],
    };
    const r = parseBscExtension(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.transport).toBe("stdio");
      expect(r.manifest.env).toEqual([["POSTGRES_URL", ""]]);
    }
  });

  it("accepts http transport with url", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "mcp", name: "Sentry", transport: "http", url: "https://mcp.sentry.dev/sse" });
    expect(r.ok).toBe(true);
  });

  it("rejects null / non-object", () => {
    expect(parseBscExtension(null).ok).toBe(false);
    expect(parseBscExtension("string").ok).toBe(false);
    expect(parseBscExtension(42).ok).toBe(false);
  });

  it("rejects missing bscExtension field", () => {
    const r = parseBscExtension({ kind: "mcp", name: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bscExtension/);
  });

  it("rejects future version", () => {
    const r = parseBscExtension({ bscExtension: BSC_EXTENSION_VERSION + 1, kind: "mcp", name: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer than this app/);
  });

  it("rejects unknown kind", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "pipeline", name: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/kind/);
  });

  it("rejects missing name", () => {
    expect(parseBscExtension({ bscExtension: 1, kind: "mcp", name: "" }).ok).toBe(false);
    expect(parseBscExtension({ bscExtension: 1, kind: "mcp" }).ok).toBe(false);
  });

  it("rejects unknown transport", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "mcp", name: "X", transport: "websocket" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/transport/);
  });

  it("rejects malformed env — not an array", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "mcp", name: "X", env: "bad" });
    expect(r.ok).toBe(false);
  });

  it("rejects malformed env — bad entry shape", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "mcp", name: "X", env: [["KEY"]] });
    expect(r.ok).toBe(false);
  });
});

// ── defFromBscManifest ─────────────────────────────────────────────────────────

describe("defFromBscManifest", () => {
  it("produces a disabled, global ExtensionDef", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "mcp", name: "My Server", transport: "stdio", command: "npx", args: "-y my-server" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const def = defFromBscManifest(r.manifest);
    expect(def.enabled).toBe(false);
    expect(def.projects).toEqual([]);
    expect(def.name).toBe("My Server");
    expect(def.kind).toBe("mcp");
    expect(def.transport).toBe("stdio");
    expect(def.command).toBe("npx");
    expect(def.args).toBe("-y my-server");
  });

  it("zeros out env values — never pre-fills secrets", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "mcp", name: "Postgres", env: [["DB_URL", "SHOULD_BE_ERASED"]] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const def = defFromBscManifest(r.manifest);
    expect(def.env).toEqual([["DB_URL", ""]]);
  });

  it("sets env to undefined when manifest has no env", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "mcp", name: "Simple" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const def = defFromBscManifest(r.manifest);
    expect(def.env).toBeUndefined();
  });

  it("maps hook fields correctly", () => {
    const r = parseBscExtension({ bscExtension: 1, kind: "hook", name: "Guard", event: "PreToolUse", matcher: "Write|Edit", hookCommand: "./guard.sh" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const def = defFromBscManifest(r.manifest);
    expect(def.kind).toBe("hook");
    expect(def.event).toBe("PreToolUse");
    expect(def.matcher).toBe("Write|Edit");
    expect(def.hookCommand).toBe("./guard.sh");
  });
});

// ── resolveBscUrl ─────────────────────────────────────────────────────────────

describe("resolveBscUrl", () => {
  it("resolves owner/repo slug to raw.githubusercontent.com", () => {
    const url = resolveBscUrl("alice/my-mcp");
    expect(url).toBe("https://raw.githubusercontent.com/alice/my-mcp/HEAD/bsc-extension.json");
  });

  it("resolves github.com URL to raw.githubusercontent.com", () => {
    const url = resolveBscUrl("https://github.com/alice/my-mcp");
    expect(url).toBe("https://raw.githubusercontent.com/alice/my-mcp/HEAD/bsc-extension.json");
  });

  it("resolves github.com URL with trailing slash", () => {
    const url = resolveBscUrl("https://github.com/alice/my-mcp/");
    expect(url).toBe("https://raw.githubusercontent.com/alice/my-mcp/HEAD/bsc-extension.json");
  });

  it("passes through raw.githubusercontent.com URLs unchanged", () => {
    const raw = "https://raw.githubusercontent.com/alice/my-mcp/main/bsc-extension.json";
    expect(resolveBscUrl(raw)).toBe(raw);
  });

  it("passes through arbitrary HTTPS URLs unchanged", () => {
    const url = "https://example.com/mcp/bsc-extension.json";
    expect(resolveBscUrl(url)).toBe(url);
  });

  it("trims whitespace from input", () => {
    const url = resolveBscUrl("  alice/my-mcp  ");
    expect(url).toBe("https://raw.githubusercontent.com/alice/my-mcp/HEAD/bsc-extension.json");
  });
});

// ── fetchBscExtension ─────────────────────────────────────────────────────────

describe("fetchBscExtension", () => {
  const validManifest = { bscExtension: 1, kind: "mcp", name: "Test Server" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fetches and parses a valid manifest", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(validManifest),
    } as unknown as Response);

    const r = await fetchBscExtension("alice/test-mcp");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.name).toBe("Test Server");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/alice/test-mcp/HEAD/bsc-extension.json",
    );
  });

  it("returns error on HTTP failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const r = await fetchBscExtension("alice/missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/404/);
  });

  it("returns error on network exception", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await fetchBscExtension("https://example.com/mcp/bsc-extension.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/network error/);
  });

  it("returns error on invalid JSON", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, text: async () => "not json" } as unknown as Response);
    const r = await fetchBscExtension("alice/bad");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/);
  });

  it("rejects non-HTTPS URLs", async () => {
    const r = await fetchBscExtension("http://insecure.example.com/bsc-extension.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/HTTPS/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── parseInstallDeepLink ───────────────────────────────────────────────────────

describe("parseInstallDeepLink", () => {
  it("parses a url= deep link", () => {
    const r = parseInstallDeepLink("bsc://install-extension?url=https%3A%2F%2Fexample.com%2Fbsc-extension.json");
    expect(r).not.toBeNull();
    expect(r?.fetchUrl).toBe("https://example.com/bsc-extension.json");
  });

  it("parses a repo= deep link and resolves to raw URL", () => {
    const r = parseInstallDeepLink("bsc://install-extension?repo=alice%2Fmy-mcp");
    expect(r).not.toBeNull();
    expect(r?.fetchUrl).toBe("https://raw.githubusercontent.com/alice/my-mcp/HEAD/bsc-extension.json");
  });

  it("returns null for non-bsc protocol", () => {
    expect(parseInstallDeepLink("https://example.com/install")).toBeNull();
  });

  it("returns null for different bsc path", () => {
    expect(parseInstallDeepLink("bsc://other-action?url=https://x.com")).toBeNull();
  });

  it("returns null for missing url and repo params", () => {
    expect(parseInstallDeepLink("bsc://install-extension")).toBeNull();
  });

  it("returns null for invalid href", () => {
    expect(parseInstallDeepLink("not a url")).toBeNull();
  });
});

// ── mergeRemoteCatalog ─────────────────────────────────────────────────────────

describe("mergeRemoteCatalog", () => {
  const local: CatalogItem[] = [
    { name: "Postgres", by: "@modelcontextprotocol", icon: "pg", desc: "Postgres queries" },
    { name: "Slack",    by: "@modelcontextprotocol", icon: "#",  desc: "Slack integration" },
  ];

  it("appends remote items not present in local", () => {
    const remote: CatalogItem[] = [
      { name: "NewTool", by: "someone", icon: "N", desc: "A new tool" },
    ];
    const merged = mergeRemoteCatalog(remote, local);
    expect(merged).toHaveLength(3);
    expect(merged.map(c => c.name)).toContain("NewTool");
  });

  it("local wins when names collide — remote item is dropped", () => {
    const remote: CatalogItem[] = [
      { name: "Postgres", by: "impostor", icon: "X", desc: "Fake postgres" },
    ];
    const merged = mergeRemoteCatalog(remote, local);
    expect(merged).toHaveLength(2);
    const pg = merged.find(c => c.name === "Postgres");
    expect(pg?.by).toBe("@modelcontextprotocol"); // local item kept
  });

  it("handles empty remote", () => {
    const merged = mergeRemoteCatalog([], local);
    expect(merged).toEqual(local);
  });

  it("handles empty local", () => {
    const remote: CatalogItem[] = [
      { name: "Tool", by: "x", icon: "T", desc: "desc" },
    ];
    const merged = mergeRemoteCatalog(remote, []);
    expect(merged).toEqual(remote);
  });

  it("does not mutate local array", () => {
    const localCopy = [...local];
    mergeRemoteCatalog([{ name: "Extra", by: "x", icon: "E", desc: "e" }], local);
    expect(local).toEqual(localCopy);
  });
});

// ── fetchRemoteCatalog ─────────────────────────────────────────────────────────

describe("fetchRemoteCatalog", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fetches and returns valid catalog items", async () => {
    const items = [
      { name: "MyTool", by: "me", icon: "M", desc: "A tool" },
      { name: "OtherTool", by: "them", icon: "O", desc: "Another" },
    ];
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => items } as unknown as Response);
    const result = await fetchRemoteCatalog("https://catalog.example.com/catalog.json");
    expect(result).toEqual(items);
  });

  it("silently drops malformed entries", async () => {
    const items = [
      { name: "Good", by: "me", icon: "G", desc: "ok" },
      { name: 123, by: "bad" }, // invalid
      null,
    ];
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => items } as unknown as Response);
    const result = await fetchRemoteCatalog("https://catalog.example.com/catalog.json");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Good");
  });

  it("returns empty array on non-HTTPS URL", async () => {
    const result = await fetchRemoteCatalog("http://insecure.example.com/catalog.json");
    expect(result).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns empty array on HTTP failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const result = await fetchRemoteCatalog("https://catalog.example.com/catalog.json");
    expect(result).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));
    const result = await fetchRemoteCatalog("https://catalog.example.com/catalog.json");
    expect(result).toEqual([]);
  });

  it("returns empty array when response is not an array", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) } as unknown as Response);
    const result = await fetchRemoteCatalog("https://catalog.example.com/catalog.json");
    expect(result).toEqual([]);
  });
});
