import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkerModals } from "./WorkerModals";
import type { LiveWorker } from "@/shared/lib/fleet/fleetLive";
import type { StatusMeta } from "@/shared/data/fleet";

const worker: LiveWorker = {
  id: "t2p0", name: "api-stream", repo: "acme/api", profileLabel: "Build & test",
  profileColor: "var(--accent)", status: "running", issue: "#12", note: "", ownedTotal: 1,
};
const st: StatusMeta = { label: "running", color: "var(--accent)" };

function props(overrides: Partial<React.ComponentProps<typeof WorkerModals>> = {}) {
  return {
    modal: null, setModal: vi.fn(), worker, st, draft: "", setDraft: vi.fn(),
    send: vi.fn(), stop: vi.fn(), agentProfiles: [], profileId: undefined,
    setPaneProfile: vi.fn(), flash: vi.fn(), ...overrides,
  } satisfies React.ComponentProps<typeof WorkerModals>;
}

describe("WorkerModals (#499)", () => {
  it("renders nothing when no modal is open", () => {
    const { container } = render(<WorkerModals {...props()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the stop & remove confirmation when modal='stop'", () => {
    render(<WorkerModals {...props({ modal: "stop" })} />);
    expect(screen.getByText("Stop & remove worker")).toBeInTheDocument();
    expect(screen.getByText(/disables its pane/)).toBeInTheDocument();
  });

  it("renders the steer editor when modal='steer'", () => {
    render(<WorkerModals {...props({ modal: "steer" })} />);
    expect(screen.getByText(/Steer api-stream/)).toBeInTheDocument();
    expect(screen.getByText(/Typed straight into this worker's running session/)).toBeInTheDocument();
  });
});
