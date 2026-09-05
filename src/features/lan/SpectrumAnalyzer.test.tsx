import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SpectrumAnalyzer, binFrequencyMhz, binEdgesMhz, binDbm, rampColor, strengthFraction,
  spanOf, pushRow, rowGradient, isCurrent, ageLabel, emptyStateDiagnosis,
  NEVER_HEARD, HISTORY, RAMP_DB, UNOBSERVED,
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
    freqMhz: 2437, sweeps: 200, noiseDbm: -95,
    peakMagnitude: 1514, peakBin: 30, binMax: bins(), ...over,
  };
}

const row = (over: Partial<SpectrumBins> = {}, at = 0): Row => ({ at, bins: sample(over) });

const healthy: Liveness = { state: "healthy", sinceMs: 200, overdueByMs: 0 };
const silent: Liveness = { state: "silent", sinceMs: 45_000, overdueByMs: 33_000 };
const late: Liveness = { state: "late", sinceMs: 13_000, overdueByMs: 1_000 };

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
  it("reads a bin as decibels ABOVE the reported noise floor", () => {
    // ath9k gives a magnitude and a floor, not a calibrated power, so the
    // estimate is anchored to the floor the sensor actually reported.
    expect(binDbm(1, -95)).toBeCloseTo(-95, 6);
    expect(binDbm(10, -95)).toBeCloseTo(-75, 6);
    expect(binDbm(255, -95)).toBeCloseTo(-95 + 20 * Math.log10(255), 6);
  });

  it("treats a zero magnitude as the floor, not as negative infinity", () => {
    expect(Number.isFinite(binDbm(0, -95))).toBe(true);
    expect(binDbm(0, -95)).toBe(-95);
    expect(binDbm(-3, -95)).toBe(-95);
  });

  it("spends the ramp on strength that is actually representable", () => {
    // A byte of magnitude is 20*log10(255) ≈ 48 dB. A wider ramp would squash
    // every real signal into the bottom of the scale.
    expect(RAMP_DB).toBeGreaterThanOrEqual(40);
    expect(RAMP_DB).toBeLessThanOrEqual(60);
    expect(strengthFraction(-95, -95)).toBe(0);
    expect(strengthFraction(-95 + RAMP_DB, -95)).toBe(1);
    expect(strengthFraction(-200, -95)).toBe(0);
    expect(strengthFraction(0, -95)).toBe(1);
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
  it("paints one hard-edged block per bin", () => {
    const g = rowGradient(row(), spanOf([row()])!);
    expect(g.startsWith("linear-gradient(to right,")).toBe(true);
    // Two stops per bin — the pair is what makes an edge hard instead of a fade.
    const stops = g.split(",").filter((s) => /%/.test(s));
    expect(stops.length).toBeGreaterThanOrEqual(56 * 2);
  });

  it("leaves frequency nobody looked at visibly UNOBSERVED, not quiet", () => {
    // THE POINT of the span being a union. A hopping radio's row covers its own
    // channel; painting the rest dark would claim it heard silence where it
    // never listened.
    const rows = [row({ freqMhz: 2412 }), row({ freqMhz: 2462 })];
    const span = spanOf(rows)!;
    const g = rowGradient(rows[0], span);
    expect(g).toContain(UNOBSERVED);
    // The observed half must still be painted.
    expect(g).toMatch(/rgb\(\d+,\d+,\d+\)/);
  });

  it("fills the whole width when one channel IS the whole span", () => {
    const rows = [row()];
    const g = rowGradient(rows[0], spanOf(rows)!);
    expect(g).not.toContain(UNOBSERVED);
  });

  it("never divides by a zero span", () => {
    expect(rowGradient(row(), { loMhz: 2437, hiMhz: 2437 })).toBe(UNOBSERVED);
    expect(rowGradient({ at: 0, bins: sample({ binMax: [] }) }, { loMhz: 2427, hiMhz: 2447 })).toBe(UNOBSERVED);
  });
});

describe("isCurrent", () => {
  it("treats ONLY a healthy stream as the air right now", () => {
    expect(isCurrent(healthy)).toBe(true);
    expect(isCurrent(late)).toBe(false);
    expect(isCurrent(silent)).toBe(false);
    expect(isCurrent(NEVER_HEARD)).toBe(false);
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

describe("the analyzer window", () => {
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
    expect(screen.getByText(/per-bin PEAK across each window \(not a mean\)/)).toBeTruthy();
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

  it("shows assistant notes when there are any", () => {
    render(
      <SpectrumAnalyzer rows={[row()]} liveness={healthy} notes={["2437 MHz is congested."]} />,
    );
    expect(screen.getByText(/2437 MHz is congested\./)).toBeTruthy();
  });
});
