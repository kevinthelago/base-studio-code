import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SpectrumAnalyzer, binFrequencyMhz, binEdgesMhz, binDbm, rampColor, strengthFraction,
  spanOf, pushRow, rowGradient, isCurrent, ageLabel, emptyStateDiagnosis,
  extentOf, rangeDb, timeTicks, axisTicks, tickAnchor, staleBanner, contributingSensors,
  NEVER_HEARD, HISTORY, MIN_RANGE_DB, UNOBSERVED,
  type SpectrumBins, type Liveness, type Row,
} from "@/features/lan/SpectrumAnalyzer";

// The analyzer ships as a RECORD (src-tauri/data/components/app/features/lan/),
// so this imports the specifier the record `provides` rather than a file.
//
// These tests prove CONTENT and ARITHMETIC. They cannot prove layout: jsdom has
// no layout at all, which is why a chart that rendered as a 1px line in a
// 40%-wide column shipped green twice.

const bins = (n = 56, fill = 10): number[] => Array.from({ length: n }, () => fill);

function sample(over: Partial<SpectrumBins> = {}): SpectrumBins {
  return {
    sensor: "monitor-pi", freqMhz: 2437, sweeps: 200, noiseDbm: -95,
    peakMagnitude: 1514, peakBin: 30, binMax: bins(), ...over,
  };
}

const row = (over: Partial<SpectrumBins> = {}, at = 0): Row => ({ at, bins: sample(over) });

const healthy: Liveness = { sensor: "monitor-pi", state: "healthy", sinceMs: 200, overdueByMs: 0 };
const silent: Liveness = { sensor: "monitor-pi", state: "silent", sinceMs: 45_000, overdueByMs: 33_000 };
const late: Liveness = { sensor: "monitor-pi", state: "late", sinceMs: 13_000, overdueByMs: 1_000 };

describe("bin geometry", () => {
  it("spreads the bins across the channel's 20 MHz, centred on the tuned frequency", () => {
    const first = binFrequencyMhz(2437, 0, 56);
    const last = binFrequencyMhz(2437, 55, 56);
    expect(first).toBeGreaterThan(2427);
    expect(last).toBeLessThan(2447);
    expect((first + last) / 2).toBeCloseTo(2437, 5);
  });

  it("gives edges that tile the channel exactly, with no gap or overlap", () => {
    // The waterfall places bins by their EDGES; a gap would draw unobserved
    // stripes through a channel that was fully observed.
    const n = 56;
    expect(binEdgesMhz(2437, 0, n)[0]).toBeCloseTo(2427, 6);
    expect(binEdgesMhz(2437, n - 1, n)[1]).toBeCloseTo(2447, 6);
    for (let i = 0; i < n - 1; i++) {
      expect(binEdgesMhz(2437, i, n)[1]).toBeCloseTo(binEdgesMhz(2437, i + 1, n)[0], 9);
    }
  });
});

describe("signal strength", () => {
  it("measures dB above the magnitude the floor actually corresponds to", () => {
    // MEASURED: on this radio the quietest bins sit near magnitude 85, not 1.
    // Anchoring at 1 put every real bin 38–48 dB "above the noise", so the band
    // drew as saturated red and most of the ramp was unreachable.
    expect(binDbm(85, -95, 85)).toBeCloseTo(-95, 6);
    expect(binDbm(170, -95, 85)).toBeCloseTo(-95 + 20 * Math.log10(2), 6);
    // Anchored at 1 the same bin would read ~38 dB hot — the bug, pinned.
    expect(binDbm(85, -95, 1)).toBeCloseTo(-95 + 20 * Math.log10(85), 6);
  });

  it("treats anything at or below the floor as the floor, never negative infinity", () => {
    for (const m of [0, -3, 40, 85]) {
      expect(binDbm(m, -95, 85)).toBe(-95);
      expect(Number.isFinite(binDbm(m, -95, 85))).toBe(true);
    }
  });

  it("takes its range from what was actually seen, by quantile not by extreme", () => {
    // One dead bin or one saturated sample must not set an endpoint and flatten
    // everything between.
    const rows: Row[] = [];
    for (let i = 0; i < 20; i++) rows.push(row({ binMax: bins(56, 100 + i) }));
    rows.push(row({ binMax: [0, ...bins(55, 255)] }));
    const e = extentOf(rows);
    expect(e.floorMag).toBeGreaterThan(1);
    expect(e.floorMag).toBeLessThan(e.ceilMag);
  });

  it("refuses to magnify a flat band's own noise into a picture", () => {
    // Every bin identical: without a floor on the RANGE the quantisation noise
    // would be stretched across the whole ramp and drawn as violent structure.
    const flat = Array.from({ length: 30 }, () => row({ binMax: bins(56, 120) }));
    expect(rangeDb(extentOf(flat))).toBe(MIN_RANGE_DB);
  });

  it("puts the observed floor at the bottom of the ramp and the ceiling at the top", () => {
    const rows = [row({ binMax: bins(56, 85) }), row({ binMax: bins(56, 255) })];
    const e = extentOf(rows);
    expect(strengthFraction(-95, -95, e)).toBe(0);
    expect(strengthFraction(-95 + rangeDb(e), -95, e)).toBe(1);
    expect(strengthFraction(-200, -95, e)).toBe(0);
    expect(strengthFraction(0, -95, e)).toBe(1);
  });

  it("is monotonic, so a stronger bin is never drawn cooler than a weaker one", () => {
    const seen = [0, 0.2, 0.4, 0.6, 0.8, 1].map(rampColor);
    expect(new Set(seen).size).toBe(seen.length);
    for (const c of seen) expect(c).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    expect(rampColor(-1)).toEqual(rampColor(0));
    expect(rampColor(2)).toEqual(rampColor(1));
  });
});

describe("the observed span", () => {
  it("is nothing at all before anything arrives", () => {
    // An axis drawn over no observation is an axis that means nothing.
    expect(spanOf([])).toBeNull();
  });

  it("covers exactly the channel that was heard, not the band it belongs to", () => {
    // Drawing 2400–2500 with most of it blank would assert we looked at the
    // whole band and found it empty — the same lie as a spectrum of zeroes.
    const s = spanOf([row()]);
    expect(s).not.toBeNull();
    expect(s!.loMhz).toBeCloseTo(2427, 6);
    expect(s!.hiMhz).toBeCloseTo(2447, 6);
  });

  it("widens to the union when the radio hops", () => {
    const s = spanOf([row({ freqMhz: 2412 }), row({ freqMhz: 2462 })]);
    expect(s!.loMhz).toBeCloseTo(2402, 6);
    expect(s!.hiMhz).toBeCloseTo(2472, 6);
  });
});

describe("the frequency axis", () => {
  it("keeps the tick count readable however wide the span grows", () => {
    // A FIXED 5 MHz STEP DOES NOT SURVIVE A HOPPING RADIO. One channel is 20
    // MHz and four ticks; a radio that has swept 2412 to 2462 spans 70 MHz and
    // fifteen, which overlap into a smear. Seen on screen as the axis
    // "overflowing and adding ticks as it grows".
    for (const [lo, hi] of [[2427, 2447], [2402, 2472], [2400, 2500], [2400, 5900]]) {
      const t = axisTicks({ loMhz: lo, hiMhz: hi });
      expect(t.length).toBeLessThanOrEqual(8);
      expect(t.length).toBeGreaterThan(0);
      expect(t.every((f) => f >= lo && f <= hi)).toBe(true);
    }
  });

  it("labels round numbers, not arbitrary ones", () => {
    // The 1-2-5 progression any axis uses: a step of 3.5 MHz would fit just as
    // many labels and none of them would be a number anyone thinks in.
    for (const [lo, hi] of [[2427, 2447], [2402, 2472], [2400, 2500]]) {
      const t = axisTicks({ loMhz: lo, hiMhz: hi });
      const step = t.length > 1 ? t[1] - t[0] : 0;
      expect([1, 2, 5, 10, 20, 50, 100, 200, 500]).toContain(step);
      expect(t.every((f) => Number.isInteger(f))).toBe(true);
    }
  });

  it("has nothing to draw for a span of no width", () => {
    expect(axisTicks({ loMhz: 2437, hiMhz: 2437 })).toEqual([]);
  });

  it("anchors the outermost labels INSIDE the chart rather than straddling its edge", () => {
    // Half of "2427" hanging off the plot is what an overflowing axis looks
    // like. Only the ends are special; everything between still centres.
    expect(tickAnchor(0).transform).toBe("none");
    expect(tickAnchor(100).transform).toBe("translateX(-100%)");
    expect(tickAnchor(50).transform).toBe("translateX(-50%)");
    expect(tickAnchor(50).left).toBe("50%");
  });
});

describe("the history", () => {
  it("keeps the newest window first, because the waterfall reads downward in time", () => {
    let rows: Row[] = [];
    rows = pushRow(rows, sample({ peakMagnitude: 1 }), 1);
    rows = pushRow(rows, sample({ peakMagnitude: 2 }), 2);
    expect(rows.map((r) => r.bins.peakMagnitude)).toEqual([2, 1]);
  });

  it("is bounded, so a window left open overnight does not grow without limit", () => {
    let rows: Row[] = [];
    for (let i = 0; i < HISTORY + 50; i++) rows = pushRow(rows, sample(), i);
    expect(rows.length).toBe(HISTORY);
    expect(rows[0].at).toBe(HISTORY + 49);
  });
});

describe("rowGradient", () => {
  it("places one stop per measured bin CENTRE and interpolates between them", () => {
    // The radio's resolution is 56 samples either way; drawing them as 17px
    // blocks was a staircase, not more truth. Each measured value still lands
    // exactly where it was measured.
    const g = rowGradient(row(), spanOf([row()])!, extentOf([row()]));
    expect(g.startsWith("linear-gradient(to right,")).toBe(true);
    const stops = g.split(",").filter((x) => /%/.test(x));
    // 56 centres plus the two edge anchors that carry the first and last value
    // out to the channel boundary.
    expect(stops.length).toBe(58);
  });

  it("keeps the unobserved margins HARD-edged rather than fading into them", () => {
    // A fade would blur the boundary between "quiet" and "never looked at",
    // which is the one distinction this display exists to keep.
    const rows = [row({ freqMhz: 2412 }), row({ freqMhz: 2462 })];
    const g = rowGradient(rows[0], spanOf(rows)!, extentOf(rows));
    // The margin colour appears TWICE in a row — a pair of stops at the same
    // colour is what makes an edge hard instead of a gradient.
    const first = g.indexOf(UNOBSERVED);
    const second = g.indexOf(UNOBSERVED, first + 1);
    expect(second).toBeGreaterThan(first);
  });

  it("leaves frequency nobody looked at visibly UNOBSERVED, not quiet", () => {
    // THE POINT of the span being a union. A hopping radio's row covers its own
    // channel; painting the rest dark would claim it heard silence where it
    // never listened.
    const rows = [row({ freqMhz: 2412 }), row({ freqMhz: 2462 })];
    const span = spanOf(rows)!;
    const g = rowGradient(rows[0], span, extentOf(rows));
    expect(g).toContain(UNOBSERVED);
    // The observed half must still be painted.
    expect(g).toMatch(/rgb\(\d+,\d+,\d+\)/);
  });

  it("fills the whole width when one channel IS the whole span", () => {
    const rows = [row()];
    const g = rowGradient(rows[0], spanOf(rows)!, extentOf(rows));
    expect(g).not.toContain(UNOBSERVED);
  });

  it("never divides by a zero span", () => {
    const e = extentOf([row()]);
    expect(rowGradient(row(), { loMhz: 2437, hiMhz: 2437 }, e)).toBe(UNOBSERVED);
    expect(rowGradient({ at: 0, bins: sample({ binMax: [] }) }, { loMhz: 2427, hiMhz: 2447 }, e)).toBe(UNOBSERVED);
  });
});

describe("timeTicks", () => {
  it("labels the newest row `now`, because everything else is read against it", () => {
    const rows = [row({}, 10_000), row({}, 9_000)];
    expect(timeTicks(rows, 1)[0]).toEqual({ index: 0, label: "now" });
  });

  it("reports the AGE of the row it sits beside, not the row count times a cadence", () => {
    // Windows do not arrive on a perfect cadence — a wedged radio, a late
    // datagram or a restarted sensor all stretch the gap — so labelling every
    // Nth row "N seconds" would draw a clock that is confidently wrong.
    const rows = [row({}, 100_000), row({}, 99_000), row({}, 40_000), row({}, 39_000)];
    const ticks = timeTicks(rows, 2);
    expect(ticks.map((t) => t.label)).toEqual(["now", "-60s"]);
    expect(ticks[1].index).toBe(2);
  });

  it("never labels a row as being in the future", () => {
    // A sensor restart can hand back a smaller timestamp than the one before.
    const rows = [row({}, 1_000), row({}, 50_000)];
    expect(timeTicks(rows, 1).every((t) => !t.label.startsWith("--"))).toBe(true);
    expect(timeTicks(rows, 1)[1].label).toBe("-0ms");
  });

  it("has nothing to say about an empty history", () => {
    expect(timeTicks([])).toEqual([]);
  });
});

describe("isCurrent", () => {
  it("treats ONLY a healthy stream as the air right now", () => {
    expect(isCurrent(healthy)).toBe(true);
    expect(isCurrent(late)).toBe(false);
    expect(isCurrent(silent)).toBe(false);
    expect(isCurrent(NEVER_HEARD)).toBe(false);
  });

  it("does not call a stream late when nothing is actually overdue", () => {
    // SEEN ON SCREEN: "SENSOR LATE by 0ms" over a waterfall filling at 4 Hz.
    // A verdict exactly on its deadline has not missed it, and a warning that
    // fires for nothing teaches a reader to ignore the one that matters.
    expect(isCurrent({ sensor: "monitor-pi", state: "late", sinceMs: 12_000, overdueByMs: 0 })).toBe(true);
    // One millisecond past IS late — the boundary is the only exemption.
    expect(isCurrent({ sensor: "monitor-pi", state: "late", sinceMs: 12_001, overdueByMs: 1 })).toBe(false);
    // And a silent sensor is never excused, whatever the arithmetic says.
    expect(isCurrent({ sensor: "monitor-pi", state: "silent", sinceMs: 40_000, overdueByMs: 0 })).toBe(false);
  });
});

describe("ageLabel", () => {
  it("reads as a duration at every scale", () => {
    expect(ageLabel(400)).toBe("400ms");
    expect(ageLabel(4_000)).toBe("4s");
    expect(ageLabel(300_000)).toBe("5m");
  });
});

describe("emptyStateDiagnosis", () => {
  it("distinguishes a sensor nobody can hear from one whose RADIO is producing nothing", () => {
    const unheard = emptyStateDiagnosis(NEVER_HEARD);
    const heard = emptyStateDiagnosis(healthy);
    expect(unheard).not.toEqual(heard);
    expect(unheard).toMatch(/keys/i);
    expect(heard).toMatch(/radio/i);
  });

  it("has a distinct sentence for every liveness state", () => {
    const all = [NEVER_HEARD, healthy, late, silent].map(emptyStateDiagnosis);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("staleBanner", () => {
  it("never calls a stream LATE just because its liveness has not arrived", () => {
    // SEEN ON SCREEN: "SENSOR LATE by 0ms" over 148 windows of live waterfall,
    // because the two-branch version put never-heard into the late arm. A
    // confident wrong claim is worse than an unhelpful one — it sends a reader
    // after a sensor that is fine.
    const b = staleBanner(NEVER_HEARD);
    expect(b).not.toMatch(/LATE/);
    expect(b).toMatch(/NO LIVENESS YET/);
  });

  it("has a distinct line for every state, and nothing to say when healthy", () => {
    expect(staleBanner(healthy)).toBe("");
    const said = [NEVER_HEARD, late, silent].map(staleBanner);
    expect(new Set(said).size).toBe(said.length);
    expect(staleBanner(late)).toMatch(/LATE by 1s/);
    expect(staleBanner(silent)).toMatch(/SILENT for 45s/);
  });
});

describe("contributingSensors", () => {
  it("names every sensor in the history, in first-seen order", () => {
    // A waterfall blended from several radios without saying so is a lie about
    // where anything was heard: one sensor's quiet band and another's busy one
    // average into a picture neither of them saw.
    const rows: Row[] = [
      { at: 3, bins: sample({ sensor: "office" }) },
      { at: 2, bins: sample({ sensor: "garage" }) },
      { at: 1, bins: sample({ sensor: "office" }) },
    ];
    expect(contributingSensors(rows)).toEqual(["office", "garage"]);
  });

  it("has nothing to name for an empty history", () => {
    expect(contributingSensors([])).toEqual([]);
  });
});

describe("the analyzer window", () => {
  it("names which sensors are contributing to what is drawn", () => {
    render(
      <SpectrumAnalyzer
        rows={[{ at: 2, bins: sample({ sensor: "garage" }) }, { at: 1, bins: sample({ sensor: "office" }) }]}
        liveness={healthy}
      />,
    );
    expect(screen.getByText(/sensors contributing: garage, office/)).toBeTruthy();
  });

  it("NEVER renders an empty display as a quiet band", () => {
    render(<SpectrumAnalyzer rows={[]} />);
    expect(screen.getByText(/NOT a quiet band/i)).toBeTruthy();
  });

  it("tells the reader WHY it is empty, not just that it is", () => {
    render(<SpectrumAnalyzer rows={[]} liveness={healthy} />);
    expect(screen.getByText(/IS heard/)).toBeTruthy();
    expect(screen.getByText(/radio is producing nothing/)).toBeTruthy();
  });

  it("names the observed range rather than the band", () => {
    render(<SpectrumAnalyzer rows={[row()]} liveness={healthy} />);
    expect(screen.getByText(/2427–2447 MHz observed/)).toBeTruthy();
  });

  it("shows the evidence behind what is drawn", () => {
    render(<SpectrumAnalyzer rows={[row()]} liveness={healthy} />);
    expect(screen.getByText(/200 sweeps/)).toBeTruthy();
    expect(screen.getByText(/noise -95 dBm/)).toBeTruthy();
  });

  it("says the strength is ESTIMATED and says the bins are peaks", () => {
    // A number that looks calibrated and is not will be read as calibrated.
    render(<SpectrumAnalyzer rows={[row()]} liveness={healthy} />);
    expect(screen.getByText(/ESTIMATED as dB above the reported noise floor/)).toBeTruthy();
    expect(screen.getByText(/scaled to the range actually observed/)).toBeTruthy();
    expect(screen.getByText(/time runs DOWN from now/)).toBeTruthy();
    expect(screen.getByText(/per-bin PEAK across each window \(not a mean\)/)).toBeTruthy();
  });

  it("labels the time axis so the vertical is readable as duration", () => {
    render(<SpectrumAnalyzer rows={[row({}, 2), row({}, 1)]} liveness={healthy} />);
    expect(screen.getByText("now")).toBeTruthy();
  });

  it("renders one band per observed window, newest first", () => {
    const { container } = render(
      <SpectrumAnalyzer rows={[row({}, 2), row({}, 1)]} liveness={healthy} />,
    );
    const bands = container.querySelectorAll('[title*="sweeps"]');
    expect(bands.length).toBe(2);
  });

  it("does NOT leave a dead sensor's history looking current", () => {
    render(<SpectrumAnalyzer rows={[row()]} liveness={silent} />);
    expect(screen.getByText(/SENSOR SILENT for 45s/)).toBeTruthy();
    expect(screen.getByText(/not the air now/)).toBeTruthy();
  });

  it("distinguishes a late sensor from a silent one", () => {
    render(<SpectrumAnalyzer rows={[row()]} liveness={late} />);
    expect(screen.getByText(/SENSOR LATE by 1s/)).toBeTruthy();
    expect(screen.queryByText(/SENSOR SILENT/)).toBeNull();
  });

  it("says nothing about staleness while the stream is healthy", () => {
    render(<SpectrumAnalyzer rows={[row()]} liveness={healthy} />);
    expect(screen.queryByText(/not the air now/)).toBeNull();
  });

  it("renders an assistant panel even with nothing to say", () => {
    render(<SpectrumAnalyzer rows={[row()]} liveness={healthy} notes={[]} />);
    expect(screen.getByText(/ASSISTANT/)).toBeTruthy();
    expect(screen.getByText(/Nothing to report yet/)).toBeTruthy();
  });

  // The y axis overflowed the graph past roughly -112s: 900 rows of history
  // drawn into a box with no definite height, so the column grew to its content
  // and the tick gutter beside it painted a label for every row whether or not
  // it was on screen. jsdom has no layout, so neither of the two properties
  // below can be checked by measuring anything — they are asserted as the
  // structure that makes the browser clip, which is what was actually missing.

  it("bounds the waterfall column so its overflow clip has something to bite on", () => {
    // A box sized by its content cannot overflow. `overflow: hidden` was
    // already on this element and did nothing for exactly that reason; the
    // definite height is the fix.
    const { container } = render(
      <SpectrumAnalyzer rows={[row({}, 2), row({}, 1)]} liveness={healthy} />,
    );
    const band = container.querySelector('[title*="sweeps"]');
    const column = band?.parentElement as HTMLElement;
    expect(column.style.overflow).toBe("hidden");
    expect(column.style.flex).not.toBe("");
    expect(column.style.minHeight).toBe("0px");
    // and its parent must be the column flex that gives it that height
    const outer = column.parentElement as HTMLElement;
    expect(outer.style.flexDirection).toBe("column");
    expect(outer.style.height).toBe("100%");
  });

  it("clips the time gutter, so no label can name a row that is not drawn", () => {
    render(<SpectrumAnalyzer rows={[row({}, 2), row({}, 1)]} liveness={healthy} />);
    const now = screen.getByText("now");
    const gutter = now.parentElement as HTMLElement;
    expect(gutter.style.position).toBe("absolute");
    expect(gutter.style.overflow).toBe("hidden");
  });

  it("shows assistant notes when there are any", () => {
    render(
      <SpectrumAnalyzer rows={[row()]} liveness={healthy} notes={["2437 MHz is congested."]} />,
    );
    expect(screen.getByText(/2437 MHz is congested\./)).toBeTruthy();
  });
});
