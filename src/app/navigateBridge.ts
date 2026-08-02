// navigateBridge (#3274, epic #3260) — the PURE half of `bsc navigate`: resolve a request into store
// mutations and report the view that landed.
//
// Split from `useNavigateBridge.ts` so the decisions (what a request resolves to, what is an error, what
// the resulting view is) are unit-testable without Tauri or a rendered app. The hook is a thin adapter.
//
// CONTRACT
// - A request is INTENTS, not steps: `component` implies its workspace + page. A caller asking for a
//   component should not need to know which Workspace hosts the Design Studio this week.
// - Unknown ids are ERRORS, not silent no-ops. A capture against a view that never landed is exactly the
//   failure this surface exists to prevent, so "I couldn't" must be louder than "sure".
// - The ack reports what ACTUALLY landed — RE-READ from the store after applying, never echoed from the
//   request and never read off a pre-mutation snapshot (zustand hands out a new object per update, so a
//   captured `getState()` goes stale the moment you set anything). An ack that reports the view you asked
//   for rather than the one you got would defeat the whole surface: the caller would capture confidently
//   against the wrong screen.
import type { AppStore } from "@/store/types";
import type { Workspace } from "@/app/registry";
import { dispatchPage } from "@/app/navigate";

/** The preview DATA-STATES `--state` navigates to (#3717) — the navigable subset of the Design Studio's
 *  state axis (`error` is a render OUTCOME, not something you request). Kept in lockstep with the Rust
 *  `NAV_STATES` in `bsc-navigate`'s CLI. `as const` so the values narrow to a union assignable to the
 *  store's `PreviewState` without a cross-feature type import. */
const NAV_STATES = ["loaded", "empty", "loading"] as const;

/** What `bsc navigate` asks for. Every field optional; absent ⇒ leave it alone. Mirrors Rust `NavRequest`. */
export interface NavRequest {
  workspace?: string;
  page?: string;
  kit?: string;
  component?: string;
  theme?: string;
  state?: string;
}

/** What we send back to Rust. Mirrors Rust `NavAck`. */
export interface NavAck {
  id?: string;
  error?: string;
  /** Set when a `component` intent focused the record but did NOT switch the view (#3599/#4248).
   *
   *  Without it the ack reports the CURRENT view and reads as an ordinary success — so a caller that
   *  asked for a component, saw `workspace: "github"` come back, and had nothing to photograph concluded
   *  the navigate had failed and forced the view with `navigate page designs`. That escalation, fired
   *  every ~7s by the designer loop, IS the yank. Saying "declined, and why" is what makes the refusal
   *  legible instead of looking like a bug to route around. */
  declined?: string;

  workspace?: string;
  page?: string;
  kit?: string;
  component?: string;
  theme?: string;
  state?: string;
}

/** The vocabulary the resolver validates against.
 *
 *  `read` is a LIVE getter, not a snapshot — see the contract note above. Passed in so this module stays
 *  pure and testable with a fake store. */
export interface NavVocab {
  read: () => AppStore;
  workspaces: Workspace[];
  pages: string[];
}

/** The Workspace hosting the Design Studio, and the page within it. Resolved here (not by the caller) so
 *  `bsc navigate component` keeps working if the Studio moves. */
const DESIGNS_WORKSPACE: Workspace = "projects";
const DESIGNS_PAGE = "designs";

/**
 * Apply `req` and return the ack. Never throws for a *bad request* — an unknown id becomes `error`,
 * because the caller needs a reason it can act on, not an exception.
 */
export function applyNavigate(req: NavRequest, vocab: NavVocab): NavAck {
  const { read, workspaces, pages } = vocab;
  const s = read();
  // #3599: was the Design Studio ALREADY on screen before this navigate? A designer follow-along focus
  // (`bsc navigate component`, fired before each `bsc shot preview`) must not YANK the user off whatever
  // page they're on — so the component intent below only folds to the Studio when it's already showing.
  const wasShowingStudio = s.activeWorkspace === DESIGNS_WORKSPACE && s.projectsPageMode === DESIGNS_PAGE;

  // ── Validate EVERYTHING before mutating anything ──────────────────────────────────────────────
  // A half-applied navigation is worse than a refused one: the caller gets an error AND a view that
  // partially moved, so the next capture is wrong in a way nothing reported. Validate, then commit.
  if (req.workspace !== undefined && !workspaces.includes(req.workspace as Workspace)) {
    return { error: `unknown workspace '${req.workspace}' — one of: ${workspaces.join(", ")}` };
  }
  if (req.page !== undefined && !pages.includes(req.page)) {
    return { error: `unknown page '${req.page}' — one of: ${pages.join(", ")}` };
  }
  if (req.kit !== undefined && !s.kits.some((k) => k.id === req.kit)) {
    return { error: `unknown kit '${req.kit}' — one of: ${s.kits.map((k) => k.id).join(", ")}` };
  }
  if (req.theme !== undefined && !s.kitThemes.some((t) => t.id === req.theme)) {
    return { error: `unknown theme '${req.theme}' — one of: ${s.kitThemes.map((t) => t.id).join(", ")}` };
  }
  if (req.state !== undefined && !(NAV_STATES as readonly string[]).includes(req.state)) {
    return { error: `unknown state '${req.state}' — one of: ${NAV_STATES.join(", ")}` };
  }
  // A component is only meaningful inside a kit: resolve against the requested kit, else the current one.
  // Naming a component without a kit is ambiguous the moment two kits share a component name.
  let comp: { id: string; kitId: string } | undefined;
  if (req.component !== undefined) {
    const kitId = req.kit ?? s.designsKitId ?? "";
    comp = s.components.find((c) => c.id === req.component && c.kitId === kitId);
    if (!comp) {
      const inKit = s.components.filter((c) => c.kitId === kitId).map((c) => c.id);
      return {
        error: kitId
          ? `unknown component '${req.component}' in kit '${kitId}'` +
            (inKit.length ? ` — one of: ${inKit.join(", ")}` : " (the kit has no components)")
          : `unknown component '${req.component}' — name a kit: bsc navigate component <kit> ${req.component}`,
      };
    }
  }

  // ── Commit ────────────────────────────────────────────────────────────────────────────────────
  if (req.theme !== undefined) s.setKitTheme(req.theme);
  // The preview DATA-STATE the Studio renders (#3717) — drives the same store value the state control
  // sets, so a `--state` navigate captures the intended render. Validated above, so the cast is sound.
  if (req.state !== undefined) s.setDesignsPreviewState(req.state as (typeof NAV_STATES)[number]);
  if (req.workspace !== undefined) s.setWorkspace(req.workspace as Workspace);
  // Dispatch the page through the SAME per-workspace mechanism the UI uses (#3602) instead of hard-coding
  // one workspace's setter. The page vocab is still PROJECT_MODES (validated above), so for the projects
  // workspace this is exactly the old `setProjectsPageMode`; a page with no target workspace defaults to
  // the Studio's (projects), preserving today's behavior.
  if (req.page !== undefined) dispatchPage(s, (req.workspace as Workspace) ?? DESIGNS_WORKSPACE, req.page);

  // `component` implies its workspace + page — the intent is "show me this", not "set a field". But
  // (#3599) a designer follow-along must not steal the user's current page: only SWITCH to the Studio
  // when it's already showing, or when the request EXPLICITLY asked for a workspace/page (a deliberate
  // steer, not a background focus). Off-Studio, we still set the focus so it's there when the user opens
  // the Studio themselves — their current view is untouched.
  let declined: string | undefined;
  if (comp) {
    if (wasShowingStudio || req.workspace !== undefined || req.page !== undefined) {
      s.setWorkspace(DESIGNS_WORKSPACE);
      s.setProjectsPageMode(DESIGNS_PAGE as AppStore["projectsPageMode"]);
    } else {
      // The #3599 refusal, stated (#4248). It is deliberate, so it must not read as a failure.
      declined =
        "focus set, view unchanged: the Design Studio is not the visible page and a background " +
        "follow-along does not steal the user's view (#3599). Nothing is on screen to capture. Do not " +
        "force it with `navigate page` while someone is working.";
    }
    // setDesignsKit CLEARS the component (a component belongs to one kit), so the kit must come first.
    s.setDesignsKit(comp.kitId);
    s.setDesignsComp(comp.id);
  } else if (req.kit !== undefined) {
    s.setDesignsKit(req.kit);
  }

  return landed(read, declined);
}

/** Read the resulting view back OUT of the store — a FRESH read, never the pre-mutation snapshot. */
function landed(read: () => AppStore, declined?: string): NavAck {
  const s = read();
  return {
    workspace: s.activeWorkspace,
    page: s.projectsPageMode,
    kit: s.designsKitId || undefined,
    component: s.designsCompId ?? undefined,
    theme: s.kitTheme || undefined,
    state: s.designsPreviewState || undefined,
    declined,
  };
}
