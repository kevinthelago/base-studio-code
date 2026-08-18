// The notice registry (#54) — the list `AppBanners` renders from and `bsc navigate dismiss` validates
// against. Its whole value is that those two cannot drift, so the drift is what these tests pin.
import { describe, it, expect } from "vitest";
import { NOTICES, isNotice, blanketDismissable, refuseDismissal } from "@/app/chrome/banners";

/** `AppBanners` as it SHIPS. It used to be read off `../AppBanners.tsx` with `readFileSync`; the module
 *  is a record now, so the file is gone and the packaged record is the thing that actually mounts. The
 *  assertion is unchanged — only where the truth is read from. */
const appBannersSource = (): string => {
  const seeds = import.meta.glob<{ default: { provides?: string; srcText?: string } }>(
    "@data/components/app/**/*.json",
    { eager: true },
  );
  const rec = Object.values(seeds).map((m) => m.default).find((r) => r?.provides === "@/app/AppBanners");
  return rec?.srcText ?? "";
};

describe("the notice registry", () => {
  it("names every banner the stack renders, and nothing it does not", () => {
    // The registry is only trustworthy if it tracks the component that actually mounts them — a banner
    // added to `AppBanners` without an id here is silently un-dismissable, which is the exact gap this
    // work closed. Read the real SOURCE rather than restating the list.
    const src = appBannersSource();
    expect(src, "the packaged AppBanners record was not found").not.toBe("");
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
