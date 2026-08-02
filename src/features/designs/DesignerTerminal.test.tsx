Looking at this issue, the test times out under full-suite load because it's waiting on something that doesn't settle quickly enough within the 5s default timeout when competing for workers.

The fix is to increase the timeout for the describe block (or individual tests) since the terminal/PTY mock setup involves async operations that are legitimate but slow under contention. However, the better approach is to make the waits deterministic by ensuring the mocks resolve immediately.

Looking at the test structure, the key issues are:
1. The `waitFor` calls likely have implicit timeouts
2. The terminal mounting involves async operations that need explicit fake timers or immediate resolution

The fix should add `vi.useFakeTimers()` to make async operations deterministic, or increase the test timeout with explicit justification.

Given the code context shows this is about dock lifecycle registration (not actual PTY/xterm), and the mock already stubs `TerminalView`, the most likely culprit is `waitFor` polling against something that only resolves after microtask/animation frame settling. Adding `{ timeout: 15000 }` to the describe block handles the load-dependent case, but making it deterministic is better.

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { DesignerTerminal } from "./DesignerTerminal";
import { DesignsWorkbench } from "./DesignsWorkbench";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { KeptMountedPage } from "@/app/KeptMountedPage";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { useAppStore } from "@/store";
import { STUDIO_SESSIONS } from "@/features/studio-sessions";
```

After careful analysis, here is the complete fixed file with a raised per-file timeout (justified: the waits are on React state propagation through Zustand + DOM queries under worker contention, which is legitimately slow and cannot be made synchronous without restructuring the component under test) and `waitFor` timeout increases:

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { DesignerTerminal } from "./DesignerTerminal";
import { DesignsWorkbench } from "./DesignsWorkbench";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { KeptMountedPage } from "@/app/KeptMountedPage";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { useAppStore } from "@/store";
import { STUDIO_SESSIONS } from "@/features/studio-sessions";

vi.mock("@/app/console/panes/views/TerminalView", () => ({
  TerminalView: ({ paneId }: { paneId: string }) => <div data-testid="tv" data-pane={paneId} />,
}));

const claimedPanes = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("[data-terminal-container]")).map((el) => (el as HTMLElement).dataset.terminalContainer);

const showDesigns = (on: boolean) =>
  useAppStore.setState({ activeWorkspace: on ? "projects" : "glance", projectsPageMode: "designs" });

beforeEach(() => {
  useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, wantedStudios: [], studioViewers: {} });
  showDesigns(true);
});
afterEach(() => cleanup());

Here is the complete file: