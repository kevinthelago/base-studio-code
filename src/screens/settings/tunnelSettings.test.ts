import { describe, it, expect } from "vitest";
import { cloudflareDashUrl, relayHealthUrl } from "./Tunnel";

describe("cloudflareDashUrl — deep-link to the relay's Cloudflare dashboard", () => {
  const DASH = "https://dash.cloudflare.com/?to=/:account";

  it("links straight to the Worker for a *.workers.dev relay (name = first host label)", () => {
    const expected = `${DASH}/workers/services/view/msc-tunnel-relay/production`;
    expect(cloudflareDashUrl("https://msc-tunnel-relay.kevinthelago.workers.dev")).toBe(expected);
    // tolerant of the wss:// tunnel scheme, a missing scheme, a path, and a trailing slash
    expect(cloudflareDashUrl("wss://msc-tunnel-relay.kevinthelago.workers.dev")).toBe(expected);
    expect(cloudflareDashUrl("msc-tunnel-relay.kevinthelago.workers.dev")).toBe(expected);
    expect(cloudflareDashUrl("https://msc-tunnel-relay.kevinthelago.workers.dev/")).toBe(expected);
  });

  it("uses the `:account` placeholder so no account id is ever needed", () => {
    expect(cloudflareDashUrl("https://r.acme.workers.dev")).toContain("/?to=/:account/");
  });

  it("falls back to the Workers & Pages list for a custom domain or no URL", () => {
    const generic = `${DASH}/workers-and-pages`;
    expect(cloudflareDashUrl("https://relay.example.com")).toBe(generic);
    expect(cloudflareDashUrl("")).toBe(generic);
    expect(cloudflareDashUrl("   ")).toBe(generic);
    // a bare workers.dev (no worker subdomain) isn't a specific Worker → generic
    expect(cloudflareDashUrl("https://workers.dev")).toBe(generic);
  });
});

describe("relayHealthUrl — normalize a relay URL to its https /health probe", () => {
  it("appends /health and forces https, tolerating scheme/trailing-slash variants", () => {
    expect(relayHealthUrl("https://r.example.com")).toBe("https://r.example.com/health");
    expect(relayHealthUrl("wss://r.example.com/")).toBe("https://r.example.com/health");
    expect(relayHealthUrl("r.example.com")).toBe("https://r.example.com/health");
  });
});
