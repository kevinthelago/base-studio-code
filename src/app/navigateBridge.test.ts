import { describe, it, expect } from "vitest";
import { applyNavigate, type NavVocab } from "@/app/navigateBridge";
import type { AppStore } from "@/store/types";
import { WORKSPACES } from "@/app/registry";

// A minimal fake store: only the fields + actions applyNavigate touches. Mutating actions write into
// `s` and `read()` returns it fresh — which is the point. Zustand hands out a NEW object per update, so a
// resolver that reads a captured snapshot would report the pre-navigation view; these tests use a live
// getter so that bug can't hide.
function makeVocab(over: Partial<Record<string, unknown>> = {}): NavVocab & { s: Record<string, unknown> } {
  const s: Record<string, unknown> = {
    activeWorkspace: "console",
    projectsPageMode: "projects",
    designsKitId: "",
    designsCompId: null,
    designsPreviewState: "loaded",
    kitTheme: "default",
    kits: [{ id: "react-ui" }, { id: "react-d3" }],
    kitThemes: [{ id: "default" }, { id: "nord" }],
    components: [
      { id: "Heatmap", kitId: "react-d3" },
      { id: "BarChart", kitId: "react-d3" },
      { id: "Card", kitId: "react-ui" },
    ],
    setWorkspace: (v: string) => { s.activeWorkspace = v; },
    setProjectsPageMode: (v: string) => { s.projectsPageMode = v; },
    setKitTheme: (v: string) => { s.kitTheme = v; },
    setDesignsKit: (v: string) => { s.designsKitId = v; s.designsCompId = null; },
    setDesignsComp: (v: string | null) => { s.designsCompId = v; },
    setDesignsPreviewState: (v: string) => { s.designsPreviewState = v; },
    dismissedNotices: [] as string[],
    dismissNotice: (id: string) => { (s.dismissedNotices as string[]).push(id); },
    ...over,
  };
  return {
    s,
    read: () => s as unknown as AppStore,
    workspaces: ["console", "glance", "projects", "automation", "mcp", "github", "logs", "settings"],
    pages: ["projects", "teams", "designs", "algorithms", "sounds"],
  };
}

// The Design Studio "already showing" store — a component navigate folds to it (#3599).
const onStudio = { activeWorkspace: "projects", projectsPageMode: "designs" };

describe("navigateBridge — component (the case #3261 needed a human click for)", () => {
  it("when the Studio is showing, selects the component AND lands its workspace + page (intents, not steps)", () => {
    const v = makeVocab(onStudio);
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap" }, v);
    expect(ack.error).toBeUndefined();
    // The caller asked for a component; it should not have to know where the Studio lives.
    expect(ack.workspace).toBe("projects");
    expect(ack.page).toBe("designs");
    expect(ack.kit).toBe("react-d3");
    expect(ack.component).toBe("Heatmap");
  });

  it("#3599: OFF the Studio, sets the focus but does NOT yank the user off their current page", () => {
    const v = makeVocab({ activeWorkspace: "github", projectsPageMode: "projects" });
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap" }, v);
    expect(ack.error).toBeUndefined();
    // The focus IS set (so the Studio shows it when the user opens it themselves) …
    expect(v.s.designsKitId).toBe("react-d3");
    expect(v.s.designsCompId).toBe("Heatmap");
    // … but the user's current view is UNTOUCHED — no forced navigation.
    expect(v.s.activeWorkspace).toBe("github");
    expect(v.s.projectsPageMode).toBe("projects");
    expect(ack.workspace).toBe("github");
    // #4248: the refusal is STATED. Without this the ack reads as an ordinary success reporting the
    // current view, so a caller with nothing to photograph concludes the navigate failed and forces the
    // view with `navigate page designs` — the escalation that IS the yank.
    expect(ack.declined).toContain("view unchanged");
    expect(ack.declined).toContain("Do not force it");
    expect(ack.declined).toContain("#3599"); // names the rule, so the refusal is checkable
  });

  it("#3599: an EXPLICIT workspace/page request still navigates (a deliberate steer, not a background focus)", () => {
    const v = makeVocab({ activeWorkspace: "github", projectsPageMode: "projects" });
    const ack = applyNavigate({ workspace: "projects", page: "designs", kit: "react-d3", component: "Heatmap" }, v);
    expect(ack.workspace).toBe("projects");
    expect(ack.page).toBe("designs");
    expect(ack.component).toBe("Heatmap");
    expect(ack.declined, "an honoured steer declines nothing").toBeUndefined();
  });

  it("reports the view read back AFTER the mutations, not the request it was handed", () => {
    // The stale-snapshot bug: read the store once up front and the ack reports the PRE-mutation value
    // (an empty component), which would send every following capture at the wrong node — confidently.
    const v = makeVocab(onStudio);
    expect(v.s.designsCompId).toBeNull();
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap" }, v);
    expect(ack.component).toBe("Heatmap");
    expect(v.s.designsCompId).toBe("Heatmap");
  });

  it("sets the kit BEFORE the component (setDesignsKit clears the selection)", () => {
    const v = makeVocab(onStudio);
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap" }, v);
    // If the order flipped, the kit change would null the component and this would be undefined.
    expect(ack.component).toBe("Heatmap");
    expect(v.s.designsCompId).toBe("Heatmap");
  });

  it("resolves a component against the CURRENT kit when none is named", () => {
    const v = makeVocab({ designsKitId: "react-ui" });
    const ack = applyNavigate({ component: "Card" }, v);
    expect(ack.error).toBeUndefined();
    expect(ack.kit).toBe("react-ui");
    expect(ack.component).toBe("Card");
  });

  it("carries a theme through for a themed capture", () => {
    const v = makeVocab();
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap", theme: "nord" }, v);
    expect(ack.theme).toBe("nord");
    expect(ack.component).toBe("Heatmap");
  });

  it("#3717: drives the preview DATA-STATE so a capture targets a specific render", () => {
    const v = makeVocab(onStudio);
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap", state: "loading" }, v);
    expect(ack.error).toBeUndefined();
    expect(ack.state).toBe("loading");
    expect(v.s.designsPreviewState).toBe("loading");
    // The state control and navigate now share ONE store value.
  });

  it("#3717: rejects an unknown state, listing the valid ones (no half-apply)", () => {
    const v = makeVocab(onStudio);
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap", state: "spinning" }, v);
    expect(ack.error).toContain("unknown state 'spinning'");
    expect(ack.error).toContain("loading");
    // Validated BEFORE any mutation — the component focus did not move either.
    expect(v.s.designsPreviewState).toBe("loaded");
    expect(v.s.designsCompId).toBeNull();
  });
});

// The ack used to report the store SELECTION it had just written, so a component the preview refused to
// build acked exactly like one that rendered. The pure half decides only WHETHER a mount is owed; the
// adapter observes the frame (see useNavigateBridge.test.tsx).
describe("navigateBridge — the ack owes a mount only when one is actually coming", () => {
  it("marks the component to await when the Studio is the visible page", () => {
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap" }, makeVocab(onStudio));
    expect(ack.awaitMount).toBe("Heatmap");
  });

  it("marks it on an EXPLICIT steer from off-Studio too — the view really does switch", () => {
    const v = makeVocab({ activeWorkspace: "github", projectsPageMode: "projects" });
    const ack = applyNavigate({ workspace: "projects", page: "designs", kit: "react-d3", component: "Heatmap" }, v);
    expect(ack.awaitMount).toBe("Heatmap");
  });

  it("awaits NOTHING on a #3599 decline — no frame will rebuild, so waiting would only burn the budget", () => {
    const v = makeVocab({ activeWorkspace: "github", projectsPageMode: "projects" });
    const ack = applyNavigate({ kit: "react-d3", component: "Heatmap" }, v);
    expect(ack.declined).toBeDefined();
    expect(ack.awaitMount).toBeUndefined();
  });

  it("awaits nothing for a navigate that names no component", () => {
    expect(applyNavigate({ theme: "nord" }, makeVocab(onStudio)).awaitMount).toBeUndefined();
  });

  it("awaits nothing when the presence gate (#4248) left the view alone", () => {
    const v = makeVocab({ activeWorkspace: "github", projectsPageMode: "projects" });
    const ack = applyNavigate(
      { workspace: "projects", page: "designs", kit: "react-d3", component: "Heatmap" },
      { ...v, humanPresent: () => true },
    );
    expect(ack.declined).toContain("someone is using the app");
    expect(ack.awaitMount).toBeUndefined();
  });
});

describe("navigateBridge — unknown ids are errors, not silent no-ops", () => {
  it("rejects an unknown component and names what the kit does have", () => {
    // Silence here would be the worst outcome: the caller captures the previous view believing it moved.
    const v = makeVocab();
    const ack = applyNavigate({ kit: "react-d3", component: "Nope" }, v);
    expect(ack.error).toContain("unknown component 'Nope'");
    expect(ack.error).toContain("react-d3");
    expect(ack.error).toContain("Heatmap");
  });

  it("marks a component miss RETRYABLE so the adapter re-reads the store once", () => {
    // #navigate-answers-from-a-stale-app-snapshot / request #55: this resolves against the app's HYDRATED
    // copy, which only refreshes while the Design Studio is visible. A component written from a shell
    // while the app shows Console is therefore "unknown" here despite existing in the store. The pure
    // function cannot hydrate — it says the miss is worth a re-read and the adapter does it.
    const v = makeVocab();
    expect(applyNavigate({ kit: "react-d3", component: "Nope" }, v).retryAfterHydrate).toBe(true);
    expect(applyNavigate({ kit: "nope-kit" }, v).retryAfterHydrate).toBe(true);
  });

  it("does NOT mark a miss retryable when re-reading components cannot help", () => {
    // A hydrate refreshes components and kits. Vocabulary that does not come from the store — a bad
    // workspace, page or state — is never fixed by re-reading, so retrying would just cost a store read
    // and report the same error twice.
    const v = makeVocab();
    expect(applyNavigate({ workspace: "nowhere" }, v).retryAfterHydrate).toBeUndefined();
    expect(applyNavigate({ state: "sideways" }, v).retryAfterHydrate).toBeUndefined();
  });

  it("rejects a component in the WRONG kit even though the id exists elsewhere", () => {
    const v = makeVocab();
    const ack = applyNavigate({ kit: "react-ui", component: "Heatmap" }, v);
    expect(ack.error).toContain("unknown component 'Heatmap' in kit 'react-ui'");
  });

  it("tells you to name a kit when there is no current one", () => {
    const v = makeVocab({ designsKitId: "" });
    const ack = applyNavigate({ component: "Heatmap" }, v);
    expect(ack.error).toContain("name a kit");
  });

  it("rejects unknown workspace / page / kit / theme, listing the valid ones", () => {
    const v = makeVocab();
    expect(applyNavigate({ workspace: "nope" }, v).error).toContain("unknown workspace");
    expect(applyNavigate({ page: "nope" }, v).error).toContain("unknown page");
    expect(applyNavigate({ kit: "nope" }, v).error).toContain("unknown kit");
    expect(applyNavigate({ theme: "nope" }, v).error).toContain("unknown theme");
  });

  it("does NOT half-apply: a request with a bad field changes nothing", () => {
    // A half-applied navigation is worse than a refused one — the caller gets an error AND a view that
    // partially moved, so the next capture is wrong in a way nothing reported.
    const v = makeVocab();
    const ack = applyNavigate({ workspace: "glance", theme: "nord", component: "Nope", kit: "react-d3" }, v);
    expect(ack.error).toBeTruthy();
    expect(v.s.activeWorkspace).toBe("console");
    expect(v.s.kitTheme).toBe("default");
    expect(v.s.designsCompId).toBeNull();
  });
});

describe("the vocabulary the bridge is handed", () => {
  // `makeVocab` writes the workspace list by hand, and the REAL bridge builds it from WORKSPACES
  // (useNavigateBridge). Nothing connected the two, so every test here could stay green against a
  // list the app no longer has — and `bsc navigate workspace <id>` is answered by the app, not by
  // this file. That is a live CLI verb failing while its unit tests pass, which is the shape this
  // repo keeps getting caught by. Pin the fixture to the registry instead.
  it("matches the real rail registry, so a renamed Workspace cannot pass here and fail in the app", () => {
    expect(makeVocab().workspaces).toEqual(WORKSPACES.map((w) => w.key));
  });

  it("accepts `logs` — the rail destination the Security workspace became", () => {
    const v = makeVocab();
    const ack = applyNavigate({ workspace: "logs" }, v);
    expect(ack.error).toBeUndefined();
    expect(ack.workspace).toBe("logs");
    // …and the key it replaced is genuinely gone, not merely aliased.
    expect(applyNavigate({ workspace: "security" }, v).error).toContain("unknown workspace");
  });
});

describe("navigateBridge — the other verbs", () => {
  it("workspace / page / theme each move only their own field", () => {
    const v = makeVocab();
    expect(applyNavigate({ workspace: "glance" }, v).workspace).toBe("glance");
    expect(v.s.designsCompId).toBeNull();
    expect(applyNavigate({ page: "algorithms" }, v).page).toBe("algorithms");
    expect(applyNavigate({ theme: "nord" }, v).theme).toBe("nord");
  });

  it("an empty request is a READ — it reports the view without changing it", () => {
    const v = makeVocab({ activeWorkspace: "glance", designsKitId: "react-d3", designsCompId: "Heatmap" });
    const ack = applyNavigate({}, v);
    expect(ack).toEqual({
      workspace: "glance",
      page: "projects",
      kit: "react-d3",
      component: "Heatmap",
      theme: "default",
      state: "loaded",
    });
    expect(v.s.activeWorkspace).toBe("glance");
  });

  it("selecting a kit alone clears the component (it belongs to one kit)", () => {
    const v = makeVocab({ designsKitId: "react-d3", designsCompId: "Heatmap" });
    const ack = applyNavigate({ kit: "react-ui" }, v);
    expect(ack.kit).toBe("react-ui");
    expect(ack.component).toBeUndefined();
  });
});

describe("the presence gate (#4248)", () => {
  const present = { humanPresent: () => true };
  const away = { humanPresent: () => false };

  /** THE bug. #3599 honoured an explicit `--page` as "a deliberate steer", but the designer's background
   *  loop is made of explicit commands — it fired exactly this every ~7s to route around the component
   *  refusal, pulling the user off Algorithms/Sounds/Teams while they worked. */
  it("refuses a bare `page` steer while a human is using the app", () => {
    const v = { ...makeVocab({ activeWorkspace: "projects", projectsPageMode: "algorithms" }), ...present };
    const ack = applyNavigate({ page: "designs" }, v);
    expect(v.s.projectsPageMode).toBe("algorithms"); // untouched
    expect(ack.declined).toContain("someone is using the app");
  });

  it("refuses a workspace steer too", () => {
    const v = { ...makeVocab({ activeWorkspace: "console" }), ...present };
    applyNavigate({ workspace: "projects", page: "designs" }, v);
    expect(v.s.activeWorkspace).toBe("console");
  });

  /** The case the steering exists for (#3260/#3263): nobody is there, so nothing is being taken. */
  it("steers normally when nobody is present", () => {
    const v = { ...makeVocab({ activeWorkspace: "console" }), ...away };
    const ack = applyNavigate({ workspace: "projects", page: "designs" }, v);
    expect(v.s.activeWorkspace).toBe("projects");
    expect(ack.declined).toBeUndefined();
  });

  it("--force is the human-driven escape hatch", () => {
    const v = { ...makeVocab({ activeWorkspace: "console" }), ...present };
    const ack = applyNavigate({ workspace: "projects", page: "designs", force: true }, v);
    expect(v.s.activeWorkspace).toBe("projects");
    expect(ack.declined).toBeUndefined();
  });

  /** Refusing the VIEW must not refuse the WORK: the focus lands so the Studio shows the right component
   *  the moment the user opens it — the same shape #3599 chose. */
  it("still sets the focus it was asked for", () => {
    const v = { ...makeVocab({ activeWorkspace: "github" }), ...present };
    applyNavigate({ workspace: "projects", kit: "react-d3", component: "Heatmap" }, v);
    expect(v.s.designsKitId).toBe("react-d3");
    expect(v.s.designsCompId).toBe("Heatmap");
    expect(v.s.activeWorkspace).toBe("github");
  });

  /** Omitting the probe must behave exactly as before this landed — an absent signal cannot silently
   *  disable a gate, nor silently enable one. */
  it("defaults to unattended when no probe is supplied", () => {
    const v = makeVocab({ activeWorkspace: "console" });
    applyNavigate({ workspace: "projects", page: "designs" }, v);
    expect(v.s.activeWorkspace).toBe("projects");
  });

  it("a non-steering request is unaffected by presence", () => {
    const v = { ...makeVocab({ activeWorkspace: "console" }), ...present };
    const ack = applyNavigate({ theme: "nord" }, v);
    expect(ack.declined).toBeUndefined();
    expect(v.s.kitTheme).toBe("nord");
  });
});


// #54 — a session driving the app from a shell could SEE a banner in a capture and had no way to clear
// it: every banner hides through its own local React state. `dismiss` is the affordance a human already
// had, reachable from the CLI.
describe("navigateBridge — dismissing an app notice", () => {
  it("clears a named notice and reports what it cleared", () => {
    const v = makeVocab(onStudio);
    const ack = applyNavigate({ dismiss: "seed-drift" }, v);
    expect(ack.error).toBeUndefined();
    expect(ack.dismissed).toEqual(["seed-drift"]);
    expect(v.s.dismissedNotices).toContain("seed-drift");
  });

  it("REFUSES a decision-bearing notice, and mutates nothing", () => {
    // "restore or discard?" — hiding it removes the only place the answer can be given.
    const v = makeVocab(onStudio);
    const ack = applyNavigate({ dismiss: "session-recovery" }, v);
    expect(ack.error).toContain("asks a question");
    expect(v.s.dismissedNotices ?? []).toEqual([]);
  });

  it("`all` sweeps the ordinary notices and leaves the question standing", () => {
    const v = makeVocab(onStudio);
    const ack = applyNavigate({ dismiss: "all" }, v);
    expect(ack.dismissed).toContain("seed-drift");
    expect(ack.dismissed).not.toContain("session-recovery");
  });

  it("refuses an unknown id BEFORE mutating anything, like every other validation", () => {
    // A half-applied navigation that also refused a dismissal would leave the caller guessing which
    // half happened — so this is validated with the rest, ahead of the commit.
    const v = makeVocab(onStudio);
    const ack = applyNavigate({ dismiss: "not-a-banner", theme: "nord" }, v);
    expect(ack.error).toContain("unknown notice");
    expect(v.s.kitTheme, "the theme must NOT have been applied").not.toBe("nord");
  });

  it("reports nothing when no dismissal was asked for", () => {
    expect(applyNavigate({ theme: "nord" }, makeVocab(onStudio)).dismissed).toBeUndefined();
  });
});
