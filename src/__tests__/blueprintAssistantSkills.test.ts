import { describe, it, expect } from "vitest";
import {
  isCreateSkillRequest, isAttachSkillRequest, inferSkillKind, authorSkill,
  applyAssistantActions, actionLine, type AssistantAction,
} from "../screens/planner/blueprints/blueprintAssistantCore";
import { mkStageSection } from "../screens/planner/blueprints/blueprintEdit";

describe("assistant skill intent (#636 slice c)", () => {
  it("detects create vs attach intent", () => {
    expect(isCreateSkillRequest("make a skill for our auth conventions")).toBe(true);
    expect(isCreateSkillRequest("attach the auth skill")).toBe(false); // attach, not create
    expect(isAttachSkillRequest("attach the API design skill to the api stage")).toBe(true);
    expect(isCreateSkillRequest("add a security stage")).toBe(false); // not a skill
  });

  it("infers the target section from the request, else the first", () => {
    const secs = [mkStageSection("context"), mkStageSection("permissions"), mkStageSection("api")];
    expect(inferSkillKind("make a skill and attach to permissions", secs)).toBe("permissions");
    expect(inferSkillKind("make a generic skill", secs)).toBe("context"); // first
    expect(inferSkillKind("x", [])).toBeUndefined();
  });
});

describe("authorSkill (#636 slice c)", () => {
  it("parses the model's {name, content}", async () => {
    const out = await authorSkill("auth conventions", async () => '{"name":"Auth Conventions","content":"Use OAuth.\\nRotate tokens."}');
    expect(out).toEqual({ name: "Auth Conventions", content: "Use OAuth.\nRotate tokens." });
  });
  it("extracts JSON from fenced/prose output", async () => {
    const out = await authorSkill("x", async () => "Here:\n```json\n{\"name\":\"S\",\"content\":\"body\"}\n```");
    expect(out).toEqual({ name: "S", content: "body" });
  });
  it("falls back to a stub when output is unusable", async () => {
    const out = await authorSkill("do the thing", async () => "no json here");
    expect(out.name).toBe("New skill");
    expect(out.content).toBe("do the thing");
  });
});

describe("apply skill actions (#636 slice c)", () => {
  it("attach-skill adds the id to the matching section", () => {
    const secs = [mkStageSection("api")];
    const act: AssistantAction = { op: "attach-skill", kind: "api", skillId: "s1", skillName: "API design" };
    const out = applyAssistantActions(secs, [act]);
    expect(out.find((s) => s.key === "api")!.skills).toEqual(["s1"]);
  });
  it("actionLine renders attach + create skill lines", () => {
    expect(actionLine({ op: "attach-skill", kind: "api", skillId: "s1", skillName: "API design" })).toMatchObject({ type: "mod", title: "API design" });
    expect(actionLine({ op: "create-skill", kind: "permissions", name: "Auth", content: "x" })).toMatchObject({ type: "add", title: "Auth" });
  });
});
