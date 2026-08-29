// The drop path, tested as a BYTE STREAM rather than as opaque strings.
//
// `pendingPtyData.test.ts` pushed `"a"`, `"b"`, `"c"` and asserted on the joined result, so it could see
// that a chunk went missing and could not see that the *stream* had been corrupted — which is the only
// thing that actually mattered. Every assertion here is written against a stream of text INTERLEAVED
// WITH ESCAPE SEQUENCES, because that is what a PTY emits and what the old buffer silently broke.
import { describe, it, expect } from "vitest";
import {
  isAlreadyReplayed,
  dispositionWhileHidden,
  UnrecordedPtyText,
  TRUNCATION_NOTICE,
} from "@/app/console/lib/terminalHandoff";

/** A state-setting sequence, then text — the shape whose FIRST half is what must never be lost. */
const DECAWM_OFF = "\x1b[?7l";
const SCROLL_REGION = "\x1b[1;24r";

describe("dispositionWhileHidden", () => {
  it("drops a RECORDED batch — the disk already holds it, verbatim and uncapped", () => {
    expect(dispositionWhileHidden({ data: DECAWM_OFF + "hello", upto: 512 })).toBe("drop");
  });

  it("holds an UNRECORDED batch — nothing else has a copy", () => {
    // `upto: null` is a session whose recording failed to open, or a notice the emitter generated
    // itself. A reveal cannot give either one back.
    expect(dispositionWhileHidden({ data: "\r\nsession ended\r\n", upto: null })).toBe("hold");
  });

  it("drops at offset 0 — a falsy offset is still an offset", () => {
    // `upto: 0` is a real recorded position (the very start of a stream). A truthiness check here
    // would hold the first batch of every session and start the buffer this design deletes.
    expect(dispositionWhileHidden({ data: "first", upto: 0 })).toBe("drop");
  });
});

describe("isAlreadyReplayed", () => {
  it("drops a batch the reveal has already covered", () => {
    expect(isAlreadyReplayed(400, 512)).toBe(true);
    expect(isAlreadyReplayed(512, 512)).toBe(true); // the boundary itself is inclusive: `text` ends AT it
  });

  it("keeps a batch past the reveal", () => {
    expect(isAlreadyReplayed(513, 512)).toBe(false);
  });

  it("never treats an UNRECORDED batch as a duplicate", () => {
    // No reveal can have replayed something that was never written down, so this must be written
    // however far the mark has advanced — including the cage-death notice, which arrives last.
    expect(isAlreadyReplayed(null, 999_999)).toBe(false);
  });

  it("writes everything before any reveal has happened", () => {
    // -1 rather than 0 is the initial mark for exactly this reason: offset 0 is replayable content.
    expect(isAlreadyReplayed(0, -1)).toBe(false);
  });
});

describe("UnrecordedPtyText — bounded WITHOUT dropping from the front", () => {
  it("returns what it was given, in order, when it fits", () => {
    const b = new UnrecordedPtyText(1024);
    b.push(DECAWM_OFF);
    b.push("one");
    b.push("two");
    expect(b.flush()).toBe(DECAWM_OFF + "onetwo");
  });

  it("is empty and silent when nothing was held", () => {
    const b = new UnrecordedPtyText(1024);
    expect(b.pending()).toBe(false);
    expect(b.flush()).toBe("");
  });

  // ── THE REGRESSION, stated as a byte stream ──
  //
  // The old buffer did `this.chunks.shift()` — dropping the OLDEST. Fed a state-setting sequence
  // followed by more output than the cap, it silently produced a stream that no longer contained the
  // state sequence, and everything xterm drew afterwards inherited the wrong state. That is the bug,
  // and it is invisible to any assertion that only counts bytes.
  it("never emits a stream whose leading state sequence was silently removed", () => {
    const cap = 64;
    const b = new UnrecordedPtyText(cap);
    b.push(SCROLL_REGION + DECAWM_OFF); // the state the rest of the stream depends on
    b.push("x".repeat(cap)); // …and enough after it to blow the cap

    const out = b.flush();

    // The old behaviour: `out` would begin with "xxxx…", the two sequences gone, and NOTHING would say
    // so. Either the state survives, or the output admits it does not — never a quiet third option.
    const stateSurvived = out.includes(SCROLL_REGION) && out.includes(DECAWM_OFF);
    expect(stateSurvived || out.startsWith(TRUNCATION_NOTICE)).toBe(true);
    // And here it is the second: a reset that redefines the state, not an inherited wrong one.
    expect(out.startsWith("\x1bc")).toBe(true);
  });

  it("says so when it truncated, even if nothing is left to write", () => {
    const b = new UnrecordedPtyText(8);
    b.push("y".repeat(8));
    b.push("z".repeat(8)); // overflows: the first push is discarded whole
    expect(b.pending()).toBe(true);
    expect(b.flush()).toBe(TRUNCATION_NOTICE + "z".repeat(8));
  });

  it("keeps the RECENT tail, not a stale prefix", () => {
    // Which end to keep is a real choice. A prefix would be non-corrupting too, but it leaves the user
    // staring at output from before the gap while the live stream resumes after it — the gap lands in
    // the middle, unannounced. Keeping the tail behind a reset puts the gap where it can be labelled.
    const b = new UnrecordedPtyText(16);
    b.push("old".repeat(5)); // 15 bytes
    b.push("NEWEST");
    expect(b.flush()).toBe(TRUNCATION_NOTICE + "NEWEST");
  });

  it("clears the truncation flag on flush, so one gap is reported once", () => {
    const b = new UnrecordedPtyText(8);
    b.push("a".repeat(8));
    b.push("b");
    b.flush();
    b.push("c");
    expect(b.flush()).toBe("c");
  });

  it("ignores an empty push rather than counting it as content", () => {
    const b = new UnrecordedPtyText(8);
    b.push("");
    expect(b.pending()).toBe(false);
  });
});
