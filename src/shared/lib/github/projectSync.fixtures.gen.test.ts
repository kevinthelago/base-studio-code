// The board ADOPT-OR-CREATE decision, captured from the live TypeScript so Rust can be proved to
// match it.
//
// ## Why this one matters more than a tidy-up
//
// `crates/bsc-publish::ensure_project_board` resolves the board TWO ways — a recorded id, else create
// — and never looks for an existing same-title board. That is the bug #444 fixed on the frontend path:
// "creation used to fire blindly and mint a *second* board on every re-sync of a same-titled project."
// So the two publish paths disagree today, and this fixture is what lets the correct rule move to the
// side that publishes.
//
// The corpus is deliberately heavy on the TITLE MATCHER, because that is where a port drifts: the
// shared matcher (#380) trims and lowercases, treats a BLANK title as matching nothing, and takes the
// FIRST match. Each of those is a separate case here; a corpus of ordinary distinct titles passes a
// port that gets any of them wrong.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/github/projectSync.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectByTitle, ensureGithubProject } from "@/shared/lib/github/projectSync";

const FIXTURE = join(process.cwd(), "src/shared/lib/github/projectSync.fixtures.json");

type Board = { id: string; number: number; url: string; title: string };
const B = (id: string, title: string, number = 1): Board => ({ id, number, url: `https://x/${id}`, title });

const BOARDS: { label: string; boards: Board[]; title: string }[] = [
  { label: "no boards", boards: [], title: "Studio Code" },
  { label: "exact match", boards: [B("p1", "Studio Code")], title: "Studio Code" },
  { label: "case-insensitive", boards: [B("p1", "STUDIO code")], title: "studio CODE" },
  { label: "surrounding whitespace on both sides", boards: [B("p1", "  Studio Code  ")], title: "\tStudio Code\n" },
  // INNER whitespace is NOT normalised — only the ends are trimmed.
  { label: "inner whitespace is not collapsed", boards: [B("p1", "Studio  Code")], title: "Studio Code" },
  { label: "no match", boards: [B("p1", "Other")], title: "Studio Code" },
  // FIRST match wins, and the corpus must contain two matches to prove it.
  { label: "two matches — the first wins", boards: [B("p1", "Studio Code"), B("p2", "studio code")], title: "Studio Code" },
  // A BLANK target matches NOTHING, even against a blank-titled board — a sentinel, not a normal value.
  { label: "blank title matches nothing", boards: [B("p1", ""), B("p2", "Studio Code")], title: "" },
  { label: "whitespace-only title matches nothing", boards: [B("p1", "   ")], title: "   " },
];

/** A scripted GraphQL executor: the decision is unit-testable precisely because it is injected. */
function gqlFor(owner: { id?: string; boards?: Board[] } | null, created?: Board | null) {
  return async (query: string) => {
    if (query.includes("createProjectV2")) {
      return created ? { createProjectV2: { projectV2: { id: created.id, number: created.number, url: created.url } } } : {};
    }
    return owner ? { repositoryOwner: { id: owner.id, projectsV2: { nodes: owner.boards ?? [] } } } : {};
  };
}

const ENSURE: { label: string; activeProjectId: string | null; owner: { id?: string; boards?: Board[] } | null; created?: Board | null; title: string }[] = [
  { label: "already linked short-circuits before any query", activeProjectId: "existing-id", owner: null, title: "Studio Code" },
  { label: "adopts a same-title board", activeProjectId: null, owner: { id: "o1", boards: [B("p9", "Studio Code", 7)] }, title: "Studio Code" },
  { label: "adopts case-insensitively", activeProjectId: null, owner: { id: "o1", boards: [B("p9", "studio CODE", 7)] }, title: "Studio Code" },
  { label: "creates when the owner has no boards", activeProjectId: null, owner: { id: "o1", boards: [] }, created: B("new1", "Studio Code", 3), title: "Studio Code" },
  { label: "creates when no title matches", activeProjectId: null, owner: { id: "o1", boards: [B("p9", "Other", 7)] }, created: B("new2", "Studio Code", 4), title: "Studio Code" },
  // An EMPTY activeProjectId is falsy, so it is NOT a linked board — the sentinel a port reads wrongly.
  { label: "an empty linked id is not linked", activeProjectId: "", owner: { id: "o1", boards: [B("p9", "Studio Code", 7)] }, title: "Studio Code" },
];

const THROWS: { label: string; owner: { id?: string; boards?: Board[] } | null; created?: Board | null }[] = [
  { label: "unresolvable owner", owner: { boards: [] } },
  { label: "creation returns nothing", owner: { id: "o1", boards: [] }, created: null },
];

async function build() {
  return {
    note: "GENERATED from the live TypeScript — see projectSync.fixtures.gen.test.ts",
    findByTitle: BOARDS.map(({ label, boards, title }) => ({
      label,
      boards,
      title,
      // WHOLE BOARD, not just its id — a matcher that finds the right one and returns the wrong
      // fields passes an id-only comparison.
      found: findProjectByTitle(boards, title) ?? null,
    })),
    ensure: await Promise.all(
      ENSURE.map(async ({ label, activeProjectId, owner, created, title }) => ({
        label,
        activeProjectId,
        // THE INPUTS, recorded rather than left to be inferred from the result. Reconstructing the
        // owner's boards from the expected outcome is circular — it makes the case-insensitive case
        // assert nothing about case, because the reconstruction uses the target title.
        title,
        ownerBoards: owner?.boards ?? null,
        result: await ensureGithubProject(gqlFor(owner ?? null, created ?? null), {
          activeProjectId,
          ownerLogin: "acme",
          title,
        }),
      })),
    ),
    throws: await Promise.all(
      THROWS.map(async ({ label, owner, created }) => {
        let message: string | null = null;
        try {
          await ensureGithubProject(gqlFor(owner, created ?? null), { activeProjectId: null, ownerLogin: "acme", title: "Studio Code" });
        } catch (e) {
          message = (e as Error).message;
        }
        return { label, message };
      }),
    ),
  };
}

describe("the board adopt-or-create decision is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", async () => {
    const text = JSON.stringify(await build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  /** All three actions must occur, or a port can hardcode one. */
  it("exercises linked, adopted and created", async () => {
    const actions = new Set((await build()).ensure.map((e) => e.result.action));
    expect([...actions].sort()).toEqual(["adopted", "created", "linked"]);
  });

  /** The three matcher rules a port drifts on, each shown to change the answer. */
  it("pins trimming, case-folding, first-match and the blank sentinel", async () => {
    const f = (await build()).findByTitle;
    const by = (l: string) => f.find((x) => x.label === l)!;
    expect(by("case-insensitive").found?.id).toBe("p1");
    expect(by("surrounding whitespace on both sides").found?.id).toBe("p1");
    expect(by("inner whitespace is not collapsed").found).toBeNull();
    expect(by("two matches — the first wins").found?.id).toBe("p1");
    expect(by("blank title matches nothing").found).toBeNull();
    expect(by("whitespace-only title matches nothing").found).toBeNull();
  });

  /** An empty linked id is falsy — it must NOT short-circuit as "linked". */
  it("treats an empty linked id as not linked", async () => {
    const e = (await build()).ensure.find((x) => x.label === "an empty linked id is not linked")!;
    expect(e.result.action).toBe("adopted");
  });

  /** Both failure paths throw, and the messages are part of the contract. */
  it("records the two throws", async () => {
    const t = (await build()).throws;
    expect(t.every((x) => x.message)).toBe(true);
  });
});
