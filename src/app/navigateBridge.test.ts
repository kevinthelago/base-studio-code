import { describe, it, expect } from "vitest";
import { applyNavigate, type NavVocab } from "./navigateBridge";
import type { AppStore } from "@/store/types";

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
    ...over,
  };
  return {
    s,
    read: () => s as unknown as AppStore,
    workspaces: ["console", "glance", "projects", "skills", "automation", "mcp", "github", "security", "settings"],
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

describe("navigateBridge — unknown ids are errors, not silent no-ops", () => {
  it("rejects an unknown component and names what the kit does have", () => {
    // Silence here would be the worst outcome: the caller captures the previous view believing it moved.
    const v = makeVocab();
    const ack = applyNavigate({ kit: "react-d3", component: "Nope" }, v);
    expect(ack.error).toContain("unknown component 'Nope'");
    expect(ack.error).toContain("react-d3");
    expect(ack.error).toContain("Heatmap");
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
