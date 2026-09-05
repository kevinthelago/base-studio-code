import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { LiveSpectrumAnalyzer, type SpectrumBins, type Liveness } from "@/features/lan";

// The subscription half, driven through the REAL component rather than the hook
// in isolation: what matters is that a datagram arriving in Rust reaches the
// pixels, and a hook test that stops at the state would not see a component
// that forgot to pass it on.

type Handler<T> = (e: { payload: T }) => void;

const handlers = new Map<string, Handler<unknown>>();
const unlisten = vi.fn();

beforeEach(() => {
  handlers.clear();
  unlisten.mockClear();
  vi.mocked(listen).mockImplementation((event: string, cb: unknown) => {
    handlers.set(event, cb as Handler<unknown>);
    return Promise.resolve(unlisten);
  });
});

function emit<T>(event: string, payload: T) {
  const h = handlers.get(event);
  if (!h) throw new Error(`nothing is listening on ${event} — the component did not subscribe`);
  act(() => h({ payload } as { payload: unknown }));
}

const bins = (fill: number): number[] => Array.from({ length: 56 }, () => fill);

function record(over: Partial<SpectrumBins> = {}): SpectrumBins {
  return {
    freqMhz: 2437, sweeps: 3328, noiseDbm: -95,
    peakMagnitude: 2551, peakBin: 21, binMax: bins(10), receivedAtMs: 1000, ...over,
  };
}

describe("the analyzer wired to the live stream", () => {
  it("subscribes to both events — the spectrum AND the liveness", () => {
    // Liveness is not optional decoration. Without it a window that opens after
    // the sensor died renders the empty state forever with no way to say why,
    // and a window that opens after the last transition would read as healthy.
    render(<LiveSpectrumAnalyzer />);
    expect(handlers.has("lan://spectrum")).toBe(true);
    expect(handlers.has("lan://liveness")).toBe(true);
  });

  it("starts on the empty state and NOT on a quiet band", () => {
    render(<LiveSpectrumAnalyzer />);
    expect(screen.getByText(/NOT a quiet band/i)).toBeTruthy();
  });

  it("renders a record that arrives from the backend", () => {
    render(<LiveSpectrumAnalyzer />);
    emit<Liveness>("lan://liveness", { state: "healthy", sinceMs: 0, overdueByMs: 0 });
    emit<SpectrumBins>("lan://spectrum", record());
    expect(screen.getByText(/2427–2447 MHz observed/)).toBeTruthy();
    expect(screen.queryByText(/NOT a quiet band/i)).toBeNull();
  });

  it("widens the axis when the radio hops rather than showing two separate charts", () => {
    // One graph across everything observed — the hop is visible as the span
    // growing, and each row still covers only where the radio actually was.
    render(<LiveSpectrumAnalyzer />);
    emit<Liveness>("lan://liveness", { state: "healthy", sinceMs: 0, overdueByMs: 0 });
    emit<SpectrumBins>("lan://spectrum", record({ freqMhz: 2412 }));
    expect(screen.getByText(/2402–2422 MHz observed/)).toBeTruthy();
    emit<SpectrumBins>("lan://spectrum", record({ freqMhz: 2462 }));
    expect(screen.getByText(/2402–2472 MHz observed/)).toBeTruthy();
  });

  it("accumulates a window per record, so duration is vertical extent", () => {
    render(<LiveSpectrumAnalyzer />);
    emit<Liveness>("lan://liveness", { state: "healthy", sinceMs: 0, overdueByMs: 0 });
    for (let i = 0; i < 4; i++) {
      emit<SpectrumBins>("lan://spectrum", record({ receivedAtMs: 1000 + i }));
    }
    expect(screen.getByText(/4 window\(s\)/)).toBeTruthy();
  });

  it("marks the last sweep as stale when the sensor goes silent", () => {
    // The whole point of carrying liveness across: the chart must stop
    // claiming to be the air right now the moment it stops being it.
    render(<LiveSpectrumAnalyzer />);
    emit<Liveness>("lan://liveness", { state: "healthy", sinceMs: 0, overdueByMs: 0 });
    emit<SpectrumBins>("lan://spectrum", record());
    expect(screen.queryByText(/not the air now/)).toBeNull();

    emit<Liveness>("lan://liveness", { state: "silent", sinceMs: 40_000, overdueByMs: 30_000 });
    expect(screen.getByText(/SENSOR SILENT for 40s/)).toBeTruthy();
    // And the history is still there — it is the most recent truth available.
    expect(screen.getByText(/2427–2447 MHz observed/)).toBeTruthy();
  });

  it("stops listening when the window goes away", () => {
    // A detached window is opened and closed repeatedly by `bsc lan analyzer`,
    // and a listener per open would accumulate for the life of the app.
    const { unmount } = render(<LiveSpectrumAnalyzer />);
    unmount();
    // The unlisten handles are resolved from promises, so let them settle.
    return Promise.resolve().then(() => {
      expect(unlisten).toHaveBeenCalledTimes(2);
    });
  });
});
