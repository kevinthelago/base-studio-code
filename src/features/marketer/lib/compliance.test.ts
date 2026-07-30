import { describe, it, expect } from "vitest";
import { complianceViolations, canApprove } from "./compliance";
import { newContentItem, type ContentItem } from "./campaign";

function email(over: Partial<ContentItem> = {}): ContentItem {
  return {
    ...newContentItem({ campaignId: "c1", channel: "Resend", channelKind: "email", body: "Hello!" }, "i1", 1000),
    ...over,
  };
}

function social(over: Partial<ContentItem> = {}): ContentItem {
  return {
    ...newContentItem({ campaignId: "c1", channel: "Bluesky", channelKind: "social", body: "gm" }, "i1", 1000),
    ...over,
  };
}

describe("email compliance", () => {
  it("flags a missing unsubscribe link and missing sender identity", () => {
    const v = complianceViolations(email({ body: "Buy now!" }));
    expect(v.map((x) => x.code)).toEqual(expect.arrayContaining(["missing-unsubscribe", "missing-sender-identity"]));
  });

  it("passes with an unsubscribe link + sender identity + no PII", () => {
    const item = email({ body: "Buy now! Unsubscribe here: /u", senderIdentity: "Acme Inc, 1 Main St" });
    expect(complianceViolations(item)).toEqual([]);
    expect(canApprove(item)).toBe(true);
  });
});

describe("social compliance", () => {
  it("flags a post over the channel character limit", () => {
    const v = complianceViolations(social({ body: "x".repeat(400) }));
    expect(v.map((x) => x.code)).toContain("over-length");
  });

  it("passes a short post", () => {
    expect(canApprove(social({ body: "gm frens" }))).toBe(true);
  });
});

describe("content PII check", () => {
  it("flags an SSN-shaped number in the body", () => {
    const v = complianceViolations(social({ body: "SSN: 123-45-6789" }));
    expect(v.map((x) => x.code)).toContain("possible-pii");
  });

  it("does not flag ordinary short numbers", () => {
    const v = complianceViolations(social({ body: "50% off through July 4" }));
    expect(v.map((x) => x.code)).not.toContain("possible-pii");
  });
});

describe("canApprove", () => {
  it("is false while any violation exists (#3150: cannot reach approved)", () => {
    expect(canApprove(email({ body: "no unsubscribe here" }))).toBe(false);
  });
});
