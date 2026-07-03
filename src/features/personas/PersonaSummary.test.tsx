// PersonaSummary (#2186) — surfaces a stream's assigned-persona identity (blurb · model · skills ·
// start prompt) so it isn't invisible behind the picker's dropdown label.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PersonaSummary } from "./PersonaSummary";
import type { Persona } from "./lib/persona";
import { useAppStore } from "@/store";

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: "persona-documentor", name: "Documentor", role: "reviewer",
  blurb: "Reads the code and writes docs.", startPrompt: "You are the documentor.",
  skills: [], builtin: true, ...over,
});

describe("PersonaSummary (#2186)", () => {
  beforeEach(() => {
    useAppStore.setState({ skills: [] });
  });

  it("shows the blurb and the start-prompt preview", () => {
    render(<PersonaSummary persona={persona()} />);
    expect(screen.getByText("Reads the code and writes docs.")).toBeInTheDocument();
    expect(screen.getByText("You are the documentor.")).toBeInTheDocument();
  });

  it("resolves attached skill ids to their library names, falling back to the raw id", () => {
    useAppStore.setState({ skills: [{ id: "sk-1", name: "Release checklist" }] as never });
    render(<PersonaSummary persona={persona({ skills: ["sk-1", "sk-missing"] })} />);
    expect(screen.getByText("Release checklist")).toBeInTheDocument();
    // An unknown id doesn't vanish — it renders raw so a stale reference is visible.
    expect(screen.getByText("sk-missing")).toBeInTheDocument();
    expect(screen.getByText(/skills · 2/)).toBeInTheDocument();
  });

  it("shows 'session default' with no model set, and the model id otherwise", () => {
    const { rerender } = render(<PersonaSummary persona={persona()} />);
    expect(screen.getByText("session default")).toBeInTheDocument();
    rerender(<PersonaSummary persona={persona({ model: "claude-opus-4-8" })} />);
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
  });

  it("notes the role fallback when the persona has no start prompt", () => {
    render(<PersonaSummary persona={persona({ startPrompt: "" })} />);
    expect(screen.getByText(/falls back to the reviewer role/)).toBeInTheDocument();
  });

  it("shows 'none attached' when the persona has no skills", () => {
    render(<PersonaSummary persona={persona()} />);
    expect(screen.getByText("none attached")).toBeInTheDocument();
  });
});
