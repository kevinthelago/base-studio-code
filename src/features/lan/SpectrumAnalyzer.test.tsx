import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SpectrumAnalyzer, binFrequencyMhz, binHeight, foldChannel, isCurrent, ageLabel,
  NEVER_HEARD, type SpectrumBins, type Liveness,
} from "@/features/lan/SpectrumAnalyzer";

// The analyzer ships as a RECORD (src-tauri/data/components/app/features/lan/),
// so this imports the specifier the record `provides` rather than a file.

const bins = (n = 56, fill = 10): number[] => Array.from({ length: n }, () => fill);

function sample(over: Partial<SpectrumBins> = {}): SpectrumBins {
  return {
    freqMhz: 2437, sweeps: 200, noiseDbm: -95,
    peakMagnitude: 1514, peakBin: 30, binMax: bins(), ...over,
  };
}

const healthy: Liveness = { state: "healthy", sinceMs: 200, overdueByMs: 0 };
const silent: Liveness = { state: "silent", sinceMs: 45_000, overdueByMs: 33_000 };
const late: Liveness = { state: "late", sinceMs: 13_000, overdueByMs: 1_000 };

describe("binFrequencyMhz", () => {
  it("spreads 56 bins across the 20 MHz channel, centred on the tuned frequency", () => {
    const first = binFrequencyMhz(2437, 0, 56);
    const last = binFrequencyMhz(2437, 55, 56);
    expect(first).toBeGreaterThan(2437 - 10);
    expect(last).toBeLessThan(2437 + 10);
    // Symmetric about the centre — an off-by-one in the span would skew it.
    expect((first + last) / 2).toBeCloseTo(2437, 5);
  });
});

describe("binHeight", () => {
  it("scales against the strongest bin and clamps", () => {
    expect(binHeight(50, 100)).toBeCloseTo(0.5);
    expect(binHeight(100, 100)).toBe(1);
    expect(binHeight(500, 100)).toBe(1);
    expect(binHeight(-5, 100)).toBe(0);
  });

  it("does not divide by zero when nothing was heard", () => {
    // A flat-zero window is real: the band genuinely can be quiet.
    expect(binHeight(0, 0)).toBe(0);
    expect(Number.isFinite(binHeight(10, 0))).toBe(true);
  });
});

describe("foldChannel", () => {
  it("keeps two alternating channels visible instead of replacing one with the other", () => {
    // The sensor emits one record per channel per window, so a radio sweeping
    // two channels alternates. A single `latest` would flicker between them and
    // show neither long enough to read.
    let s: SpectrumBins[] = [];
    s = foldChannel(s, sample({ freqMhz: 2437 }));
    s = foldChannel(s, sample({ freqMhz: 2412 }));
    s = foldChannel(s, sample({ freqMhz: 2437, peakMagnitude: 999 }));
    expect(s.map((c) => c.freqMhz)).toEqual([2412, 2437]);
    expect(s.find((c) => c.freqMhz === 2437)?.peakMagnitude).toBe(999);
  });

  it("orders by frequency so a channel does not jump position as it updates", () => {
    let s: SpectrumBins[] = [];
    for (const f of [2462, 2412, 2437]) s = foldChannel(s, sample({ freqMhz: f }));
    expect(s.map((c) => c.freqMhz)).toEqual([2412, 2437, 2462]);
    // And an update to the middle one leaves the order alone.
    s = foldChannel(s, sample({ freqMhz: 2437, sweeps: 1 }));
    expect(s.map((c) => c.freqMhz)).toEqual([2412, 2437, 2462]);
  });
});

describe("isCurrent", () => {
  it("treats ONLY a healthy stream as the air right now", () => {
    // A chart that quietly ages into a lie is the failure this guards.
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
    expect(ageLabel(45_000)).toBe("45s");
    expect(ageLabel(300_000)).toBe("5m");
  });
});

describe("the analyzer window", () => {
  it("NEVER renders an empty chart as a quiet band", () => {
    // No data and a clear channel look identical on a spectrum display, and
    // only one of them is good news. This is the same refusal the posture
    // checker and the liveness watch both make.
    render(<SpectrumAnalyzer channels={[]} />);
    expect(screen.getByText(/NOT a quiet band/i)).toBeTruthy();
  });

  it("tells the reader what to check before concluding the air is clear", () => {
    render(<SpectrumAnalyzer channels={[]} />);
    expect(screen.getByText(/multicast group and the keys/i)).toBeTruthy();
  });

  it("shows the evidence behind a spectrum, not just the shape", () => {
    render(<SpectrumAnalyzer channels={[sample()]} liveness={healthy} />);
    // Sweep count, noise floor and peak all travel with the render: a spectrum
    // from 2 sweeps and one from 2000 are different claims.
    expect(screen.getByText(/200 sweeps/)).toBeTruthy();
    expect(screen.getByText(/noise -95 dBm/)).toBeTruthy();
    expect(screen.getByText(/peak 1514 at bin 30/)).toBeTruthy();
  });

  it("says the bins are peaks and not averages", () => {
    // The sensor keeps per-bin maxima precisely so a brief burst survives
    // aggregation; labelling them as a mean would undo that at the last step.
    render(<SpectrumAnalyzer channels={[sample()]} liveness={healthy} />);
    expect(screen.getByText(/PEAK across the window \(not a mean\)/)).toBeTruthy();
  });

  it("renders one element per bin", () => {
    const { container } = render(
      <SpectrumAnalyzer channels={[sample({ binMax: bins(56, 5) })]} liveness={healthy} />,
    );
    expect(container.querySelectorAll('[title$="MHz — peak 5"]').length).toBe(56);
  });

  it("renders one chart per channel when two are being heard", () => {
    render(
      <SpectrumAnalyzer
        channels={[sample({ freqMhz: 2412 }), sample({ freqMhz: 2437 })]}
        liveness={healthy}
      />,
    );
    expect(screen.getByText(/2412 MHz ·/)).toBeTruthy();
    expect(screen.getByText(/2437 MHz ·/)).toBeTruthy();
  });

  it("does NOT leave a dead sensor's last sweep on screen looking current", () => {
    // The failure this exists for: a display that simply stops updating is
    // indistinguishable from a quiet band, and the last sweep silently becomes
    // a claim about the air right now.
    render(<SpectrumAnalyzer channels={[sample()]} liveness={silent} />);
    expect(screen.getByText(/SENSOR SILENT for 45s/)).toBeTruthy();
    expect(screen.getByText(/LAST sweep, not the air now/)).toBeTruthy();
    // The data is still shown — it is the most recent truth there is.
    expect(screen.getByText(/200 sweeps/)).toBeTruthy();
  });

  it("distinguishes a late sensor from a silent one", () => {
    render(<SpectrumAnalyzer channels={[sample()]} liveness={late} />);
    expect(screen.getByText(/SENSOR LATE by 1s/)).toBeTruthy();
    expect(screen.queryByText(/SENSOR SILENT/)).toBeNull();
  });

  it("says nothing about staleness while the stream is healthy", () => {
    render(<SpectrumAnalyzer channels={[sample()]} liveness={healthy} />);
    expect(screen.queryByText(/LAST sweep/)).toBeNull();
  });

  it("renders an assistant panel even with nothing to say", () => {
    render(<SpectrumAnalyzer channels={[sample()]} liveness={healthy} notes={[]} />);
    expect(screen.getByText(/ASSISTANT/)).toBeTruthy();
    expect(screen.getByText(/Nothing to report yet/)).toBeTruthy();
  });

  it("shows assistant notes when there are any", () => {
    render(
      <SpectrumAnalyzer
        channels={[sample()]}
        liveness={healthy}
        notes={["2437 MHz is congested.", "Peak at bin 30."]}
      />,
    );
    expect(screen.getByText(/2437 MHz is congested\./)).toBeTruthy();
    expect(screen.getByText(/Peak at bin 30\./)).toBeTruthy();
  });
});
