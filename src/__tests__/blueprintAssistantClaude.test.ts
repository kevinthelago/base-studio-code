import { describe, it, expect, vi } from "vitest";
import { explainActions, proseFor, type AssistantAction } from "../screens/projects/blueprintAssistantCore";

describe("explainActions (#624)", () => {
  const actions: AssistantAction[] = [
    { op: "add", kind: "api" },
    { op: "remove", kind: "cicd" },
  ];

  it("returns the model's sentence, passing a prompt that names the actions + blueprint", async () => {
    const complete = vi.fn(async (_p: { system: string; user: string }) => "Adds a contract-tested API stage and drops CI/CD for a leaner arc.");
    const out = await explainActions(actions, "Web app", complete);
    expect(out).toBe("Adds a contract-tested API stage and drops CI/CD for a leaner arc.");
    const prompt = complete.mock.calls[0]![0];
    expect(prompt.system).toMatch(/ONE short sentence/);
    expect(prompt.user).toMatch(/Web app/);
    expect(prompt.user).toMatch(/add api/);
    expect(prompt.user).toMatch(/remove cicd/);
  });

  it("falls back to the heuristic prose when the model returns empty", async () => {
    const out = await explainActions(actions, "X", async () => "   ");
    expect(out).toBe(proseFor(actions));
  });

  it("no actions ⇒ guidance prose, without calling the model", async () => {
    const complete = vi.fn(async () => "should not be called");
    const out = await explainActions([], "X", complete);
    expect(out).toBe(proseFor([]));
    expect(complete).not.toHaveBeenCalled();
  });
});
