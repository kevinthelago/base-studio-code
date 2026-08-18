// The notice registry (#54) — the list `AppBanners` renders from and `bsc navigate dismiss` validates
// against. Its whole value is that those two cannot drift, so the drift is what these tests pin.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NOTICES, isNotice, blanketDismissable, refuseDismissal } from "@/app/chrome/banners";

describe("the notice registry", () => {
  it("names every banner the stack renders, and nothing it does not", () => {
    // The registry is only trustworthy if it tracks the component that actually mounts them — a banner
    // added to `AppBanners` without an id here is silently un-dismissable, which is the exact gap this
    // work closed. Read the real file rather than restating the list.
    const src = readFileSync(resolve(__dirname, "../AppBanners.tsx"), "utf8");
    const gated = Array.from(src.matchAll(/show\("([a-z-]+)"\)\s*&&/g), (m) => m[1]).sort();
    expect(gated).toEqual(NOTICES.map((n) => n.id).sort());
  });

  it("knows its own ids", () => {
    expect(isNotice("seed-drift")).toBe(true);
    expect(isNotice("nope")).toBe(false);
  });
});

describe("refuseDismissal — a question is not dismissable", () => {
  it("REFUSES the session-recovery prompt, and says why rather than just no", () => {
    // Hiding "restore or discard?" does not answer it — it removes the only place the answer can be
    // given, and leaves those sessions unrestored with nothing on screen to say so.
    const why = refuseDismissal("session-recovery");
    expect(why).toContain("asks a question");
    expect(why).toContain("Act on it in the app");
  });

  it("allows an ordinary notice", () => {
    expect(refuseDismissal("seed-drift")).toBeNull();
  });

  it("names the alternatives for an unknown id, rather than a bare rejection", () => {
    const why = refuseDismissal("not-a-banner") ?? "";
    expect(why).toContain("unknown notice");
    expect(why).toContain("seed-drift"); // the list, so a typo is self-correcting
  });
});

describe("blanketDismissable — what `all` covers", () => {
  it("excludes every decision-bearing notice and includes the rest", () => {
    const all = blanketDismissable();
    expect(all).not.toContain("session-recovery");
    expect(all).toContain("seed-drift");
    // Stated as a property, not a count: a notice added later is covered without editing this test,
    // but a DECISION one added later is still excluded.
    for (const n of NOTICES) expect(all.includes(n.id)).toBe(!n.decision);
  });
});
