import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_STATUSES, STATUS_META, SERVICE_ICONS, FALLBACK_ICON,
  asStatus, serviceIcon, normalizeService, displayName, sortCredentials, summarize,
  parseCredentials, relativeAge, expiryLabel, type Credential,
} from "@/features/credentials/lib/credentials";

const NOW = 1_800_000_000;
const DAY = 86_400;

function cred(over: Partial<Credential> = {}): Credential {
  return { id: "c", status: "ok", hasSecret: true, needsAttention: false, ...over };
}

describe("the status vocabulary", () => {
  it("gives every status a label, a hint and a tone", () => {
    // A status with no meta renders as an unstyled, unexplained pill — which is the one thing this
    // screen must never do, since the status IS the content.
    for (const s of CREDENTIAL_STATUSES) {
      const meta = STATUS_META[s];
      expect(meta, `no meta for ${s}`).toBeDefined();
      expect(meta.label.trim().length).toBeGreaterThan(0);
      expect(meta.hint.trim().length).toBeGreaterThan(0);
      expect(["good", "warn", "bad", "muted"]).toContain(meta.tone);
    }
    // ...and no meta for a status that does not exist, which would be a rename half-applied.
    expect(Object.keys(STATUS_META).sort()).toEqual([...CREDENTIAL_STATUSES].sort());
  });

  it("tones expiring as a warning and unverified as neither", () => {
    // The judgement call, pinned: `expiring` still WORKS, and `unverified` is an absence of evidence
    // rather than bad news. Colouring the latter as a problem makes every new credential look broken.
    expect(STATUS_META.expiring.tone).toBe("warn");
    expect(STATUS_META.unverified.tone).toBe("muted");
    expect(STATUS_META.missing.tone).toBe("bad");
    expect(STATUS_META.ok.tone).toBe("good");
  });

  it("falls an unknown status back to unverified rather than rendering it raw", () => {
    expect(asStatus("ok")).toBe("ok");
    expect(asStatus("something-new")).toBe("unverified");
    expect(asStatus(undefined)).toBe("unverified");
    expect(asStatus(42)).toBe("unverified");
  });
});

describe("service icons", () => {
  it("maps a known service to its glyph", () => {
    expect(serviceIcon("github")).toBe("github");
    expect(serviceIcon("resend")).toBe("mail");
    expect(serviceIcon("salesforce")).toBe("cloud");
    expect(serviceIcon("stripe")).toBe("payments");
    expect(serviceIcon("anthropic")).toBe("model");
  });

  it("normalizes case and punctuation, so a hand-typed service still gets its icon", () => {
    // The service name is typed by a person into `bsc secret set`. Requiring an exact slug would
    // mean a capital letter silently costs the row its icon.
    for (const spelling of ["GitHub", "git-hub", "Git Hub", "GITHUB"]) {
      expect(serviceIcon(spelling), spelling).toBe("github");
    }
    expect(normalizeService("Sales_Force!")).toBe("salesforce");
  });

  it("falls an unmapped or absent service back to a key rather than a blank cell", () => {
    expect(serviceIcon("some-internal-tool")).toBe(FALLBACK_ICON);
    expect(serviceIcon(undefined)).toBe(FALLBACK_ICON);
    expect(serviceIcon("")).toBe(FALLBACK_ICON);
  });

  it("keeps every alias pointing at a glyph the map actually defines", () => {
    // An alias whose target has no renderer is a row with a missing icon, which only shows up when
    // someone happens to add that exact service.
    const glyphs = new Set([...Object.values(SERVICE_ICONS), FALLBACK_ICON]);
    expect(glyphs.size).toBeGreaterThan(1);
    for (const [service, glyph] of Object.entries(SERVICE_ICONS)) {
      expect(glyph, `${service} maps to an empty glyph`).toBeTruthy();
    }
  });
});

describe("display name", () => {
  it("falls back to the id so no row renders nameless", () => {
    expect(displayName(cred({ label: "GitHub — acme" }))).toBe("GitHub — acme");
    expect(displayName(cred({ id: "gh-acme", label: "   " }))).toBe("gh-acme");
    expect(displayName(cred({ id: "gh-acme", label: undefined }))).toBe("gh-acme");
  });
});

describe("ordering", () => {
  it("leads with what is broken and tails with what is fine", () => {
    const list = [
      cred({ id: "a", status: "ok" }),
      cred({ id: "b", status: "expiring" }),
      cred({ id: "c", status: "missing" }),
      cred({ id: "d", status: "unverified" }),
      cred({ id: "e", status: "failing" }),
      cred({ id: "f", status: "expired" }),
    ];
    expect(sortCredentials(list).map((c) => c.status)).toEqual([
      "missing", "expired", "failing", "expiring", "unverified", "ok",
    ]);
  });

  it("breaks a status tie by display name", () => {
    const list = [cred({ id: "z", label: "Zulu" }), cred({ id: "a", label: "Alpha" })];
    expect(sortCredentials(list).map((c) => c.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the array it is given", () => {
    // The caller's array is React state; an in-place sort mutates the identity that re-render
    // comparison depends on.
    const list = [cred({ id: "a", status: "ok" }), cred({ id: "b", status: "missing" })];
    const before = list.map((c) => c.id);
    sortCredentials(list);
    expect(list.map((c) => c.id)).toEqual(before);
  });
});

describe("summary", () => {
  it("counts the total, the attention set, and each status", () => {
    const list = [
      cred({ id: "a", status: "ok" }),
      cred({ id: "b", status: "missing", needsAttention: true }),
      cred({ id: "c", status: "failing", needsAttention: true }),
    ];
    const s = summarize(list);
    expect(s.total).toBe(3);
    expect(s.attention).toBe(2);
    expect(s.byStatus.ok).toBe(1);
    expect(s.byStatus.missing).toBe(1);
    expect(s.byStatus.expired).toBe(0);
  });

  it("takes attention from the backend rather than re-deriving it", () => {
    // The backend owns `needsAttention`. If the screen recomputed it from `status`, the two could
    // disagree — and the whole point of this screen is that it reports the store's own verdict.
    const s = summarize([cred({ status: "ok", needsAttention: true })]);
    expect(s.attention).toBe(1);
  });

  it("reports zeroes for an empty list rather than undefined", () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.attention).toBe(0);
    for (const status of CREDENTIAL_STATUSES) expect(s.byStatus[status]).toBe(0);
  });
});

describe("parsing `bsc secret list`", () => {
  it("reads a well-formed list", () => {
    const rows = parseCredentials(JSON.stringify([
      { id: "gh", service: "github", label: "GitHub", status: "ok", hasSecret: true, needsAttention: false },
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "gh", service: "github", status: "ok", hasSecret: true });
  });

  it("survives garbage rather than white-screening the page", () => {
    // A screen whose whole job is reporting state must not report nothing because the payload was
    // unexpected. Every one of these yields an empty list, not a throw.
    for (const bad of ["", "not json", "null", "42", '"a string"', "{}", '{"id":"x"}']) {
      expect(() => parseCredentials(bad)).not.toThrow();
      expect(parseCredentials(bad), bad).toEqual([]);
    }
  });

  it("drops rows with no usable id and keeps their neighbours", () => {
    const rows = parseCredentials(JSON.stringify([
      { service: "github" }, null, "string", { id: "", service: "x" }, { id: "keep", status: "ok" },
    ]));
    expect(rows.map((r) => r.id)).toEqual(["keep"]);
  });

  it("coerces the flags so a missing one is never truthy-by-accident", () => {
    // `hasSecret` absent must read as false, not undefined — a row rendering "has a secret" because
    // the field was missing would invert the exact fact the screen exists to show.
    const rows = parseCredentials(JSON.stringify([{ id: "x", status: "unknown-thing" }]));
    expect(rows[0].hasSecret).toBe(false);
    expect(rows[0].needsAttention).toBe(false);
    expect(rows[0].status).toBe("unverified");
  });
});

describe("time formatting", () => {
  it("renders a relative age, and `never` when nothing has used it", () => {
    expect(relativeAge(undefined, NOW)).toBe("never");
    expect(relativeAge(NOW - 30, NOW)).toBe("just now");
    expect(relativeAge(NOW - 5 * 60, NOW)).toBe("5m ago");
    expect(relativeAge(NOW - 3 * 3600, NOW)).toBe("3h ago");
    expect(relativeAge(NOW - 4 * DAY, NOW)).toBe("4d ago");
  });

  it("clamps a future timestamp to `just now` rather than showing a negative age", () => {
    // Clock skew between the machine that stamped and the one rendering is real; "-2m ago" is not
    // a thing a user should ever be shown.
    expect(relativeAge(NOW + 600, NOW)).toBe("just now");
  });

  it("labels an expiry as a countdown, and a past one as expired", () => {
    expect(expiryLabel(undefined, NOW)).toBeNull();
    expect(expiryLabel(NOW + 3 * DAY, NOW)).toBe("expires in 3d");
    expect(expiryLabel(NOW + 5 * 3600, NOW)).toBe("expires in 5h");
    expect(expiryLabel(NOW + 60, NOW)).toBe("expires within the hour");
    expect(expiryLabel(NOW, NOW)).toBe("expired");
    expect(expiryLabel(NOW - DAY, NOW)).toBe("expired");
  });
});
