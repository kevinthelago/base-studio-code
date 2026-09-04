import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SpectrumAnalyzer, binFrequencyMhz, binHeight, type SpectrumBins,
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

describe("the analyzer window", () => {
  it("NEVER renders an empty chart as a quiet band", () => {
    // No data and a clear channel look identical on a spectrum display, and
    // only one of them is good news. This is the same refusal the posture
    // checker and the liveness watch both make.
    render(<SpectrumAnalyzer data={null} />);
    expect(screen.getByText(/NOT a quiet band/i)).toBeTruthy();
  });

  it("tells the reader what to check before concluding the air is clear", () => {
    render(<SpectrumAnalyzer data={null} />);
    expect(screen.getByText(/multicast group and the keys/i)).toBeTruthy();
  });

  it("shows the evidence behind a spectrum, not just the shape", () => {
    render(<SpectrumAnalyzer data={sample()} />);
    // Sweep count, noise floor and peak all travel with the render: a spectrum
    // from 2 sweeps and one from 2000 are different claims.
    expect(screen.getByText(/200 sweeps/)).toBeTruthy();
    expect(screen.getByText(/noise -95 dBm/)).toBeTruthy();
    expect(screen.getByText(/peak 1514 at bin 30/)).toBeTruthy();
  });

  it("says the bins are peaks and not averages", () => {
    // The sensor keeps per-bin maxima precisely so a brief burst survives
    // aggregation; labelling them as a mean would undo that at the last step.
    render(<SpectrumAnalyzer data={sample()} />);
    expect(screen.getByText(/PEAK across the window \(not a mean\)/)).toBeTruthy();
  });

  it("renders one element per bin", () => {
    const { container } = render(<SpectrumAnalyzer data={sample({ binMax: bins(56, 5) })} />);
    expect(container.querySelectorAll('[title$="MHz — peak 5"]').length).toBe(56);
  });

  it("renders an assistant panel even with nothing to say", () => {
    render(<SpectrumAnalyzer data={sample()} notes={[]} />);
    expect(screen.getByText(/ASSISTANT/)).toBeTruthy();
    expect(screen.getByText(/Nothing to report yet/)).toBeTruthy();
  });

  it("shows assistant notes when there are any", () => {
    render(<SpectrumAnalyzer data={sample()} notes={["2437 MHz is congested.", "Peak at bin 30."]} />);
    expect(screen.getByText(/2437 MHz is congested\./)).toBeTruthy();
    expect(screen.getByText(/Peak at bin 30\./)).toBeTruthy();
  });
});
