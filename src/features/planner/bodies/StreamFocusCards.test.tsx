// StreamFocusCards (#2189) — the focused stream as a collapsible-card stack (persona/kickoff/scope/
// model & flow). Persona + Kickoff default open; the persona pairing is always shown (Worker default
// when unassigned); the picker + model/flow segs drive the handlers.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StreamFocusCards } from "./StreamFocusCards";
import type { Agent } from "../pane/projectPane.types";
import type { Persona } from "@/features/personas";
import { useAppStore } from "@/store";

const WORKER: Persona = {
  id: "persona-worker", name: "Worker", role: "worker", builtin: true, skills: [],
  blurb: "Executes one issue, opens a PR.", startPrompt: "",
};
const DOC: Persona = {
  id: "persona-documentor", name: "Documentor", role: "reviewer", builtin: true,
  blurb: "Writes docs, no code.", startPrompt: "You are the documentor.",
  skills: ["sk-1"], model: "claude-sonnet-4-6",
};

const flow = { autonomy: "continuous", push: "auto-PR", gate: "soft" };
const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: "api", name: "@api", role: "worker", status: "idle", repo: "acme/api",
    owns: ["src/api/**"], issues: ["#12"], preset: "Autonomous", perm: {}, flow, ctx: 0,
    kickoff: "You are the api work stream…", scope: "owns src/api/**",
    ...over,
  } as unknown as Agent);

describe("StreamFocusCards (#2189)", () => {
  beforeEach(() => {
    useAppStore.setState({ personas: [WORKER, DOC], skills: [{ id: "sk-1", name: "Doc style guide" }] as never });
  });

  it("opens Persona + Kickoff by default and shows the assigned persona identity", () => {
    render(<StreamFocusCards a={agent({ persona: "persona-documentor" })} onPersona={() => {}} />);
    // header names the persona
    expect(screen.getByText("Documentor")).toBeInTheDocument();
    // persona card open → blurb + resolved skill name
    expect(screen.getByText("Writes docs, no code.")).toBeInTheDocument();
    expect(screen.getByText("Doc style guide")).toBeInTheDocument();
    // kickoff card open → the launch prompt is visible
    expect(screen.getByText(/You are the api work stream/)).toBeInTheDocument();
  });

  it("shows 'Worker (default)' when the stream has no persona assigned", () => {
    render(<StreamFocusCards a={agent({ persona: undefined })} onPersona={() => {}} />);
    expect(screen.getByText("Worker (default)")).toBeInTheDocument();
  });

  it("tags an authored kickoff and shows the authored-script note", () => {
    render(<StreamFocusCards a={agent({ authoredPrompt: "prompts/api-kickoff.md" })} />);
    expect(screen.getByText("authored")).toBeInTheDocument();
    expect(screen.getByText(/authored kickoff script/)).toBeInTheDocument();
  });

  it("tags a generated kickoff", () => {
    render(<StreamFocusCards a={agent()} />);
    expect(screen.getByText("generated")).toBeInTheDocument();
  });

  it("fires onPersona when the picker changes", () => {
    const onPersona = vi.fn();
    render(<StreamFocusCards a={agent()} onPersona={onPersona} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "persona-documentor" } });
    expect(onPersona).toHaveBeenCalledWith("api", "persona-documentor");
  });

  it("keeps Scope collapsed until its header is clicked", () => {
    render(<StreamFocusCards a={agent()} />);
    expect(screen.queryByText("src/api/**")).toBeNull();
    fireEvent.click(screen.getByText("Scope"));
    expect(screen.getByText("src/api/**")).toBeInTheDocument();
  });

  it("drives onModel and onFlow from the Model & flow segmented controls", () => {
    const onModel = vi.fn(), onFlow = vi.fn();
    render(<StreamFocusCards a={agent()} onModel={onModel} onFlow={onFlow} />);
    fireEvent.click(screen.getByText("Model & flow"));
    fireEvent.click(screen.getByText("sonnet"));
    expect(onModel).toHaveBeenCalled();
    fireEvent.click(screen.getByText("checkpoint"));
    expect(onFlow).toHaveBeenCalledWith("api", expect.objectContaining({ autonomy: "checkpoint" }));
  });
});
