import { describe, it, expect, beforeEach } from "vitest";
import { useAnnouncer, announce } from "./announcer";

describe("announcer (#3770)", () => {
  beforeEach(() => useAnnouncer.setState({ polite: "", assertive: "", politeSeq: 0, assertiveSeq: 0 }));

  it("announces politely by default, bumping only politeSeq", () => {
    announce("worker api-stream paused");
    const s = useAnnouncer.getState();
    expect(s.polite).toBe("worker api-stream paused");
    expect(s.assertive).toBe("");
    expect(s.politeSeq).toBe(1);
    expect(s.assertiveSeq).toBe(0);
  });

  it("announces assertively when asked — bumping only assertiveSeq, never re-firing the polite region", () => {
    announce("something polite");
    announce("a chain failed", { assertive: true });
    const s = useAnnouncer.getState();
    expect(s.assertive).toBe("a chain failed");
    expect(s.assertiveSeq).toBe(1);
    expect(s.politeSeq).toBe(1); // untouched by the assertive announce
  });

  it("bumps the seq even on a repeated string, so a screen reader re-announces it", () => {
    announce("saved");
    announce("saved");
    expect(useAnnouncer.getState().politeSeq).toBe(2);
  });
});
