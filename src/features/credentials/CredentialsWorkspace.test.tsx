import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CredentialsWorkspace } from "@/features/credentials/CredentialsWorkspace";
import { glyphFor } from "@/features/credentials/serviceGlyphs";
import { SERVICE_ICONS, FALLBACK_ICON, serviceIcon } from "@/features/credentials/lib/credentials";
import { bsc } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";

// SPREAD THE REAL MODULE, replacing only `bsc`. A whole-module factory used to be enough and stopped
// being so the moment this screen gained page tabs: `usePageTabs` reads the app store, `src/store/index.ts`
// imports OTHER things from this same module, and a factory returning `{ bsc }` alone makes every one of
// them undefined — which surfaces as a zustand middleware error from store/index.ts:211 naming nothing
// about this file. See `mocking-the-bsc-module-whole-breaks-the-store`.
vi.mock("@/shared/lib/core/bsc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/core/bsc")>()),
  bsc: vi.fn(),
}));

const NOW = 1_800_000_000;
const DAY = 86_400;

/** One row as `bsc secret list` emits it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "github-acme", service: "github", label: "GitHub — acme", kind: "oauth",
    // CATEGORISED so the row lands on the tab the screen opens on. Everything below this line is
    // about rows, statuses and ordering rather than about the axis; leaving them uncategorised would
    // file every fixture in the LAST tab and make a dozen assertions fail for a reason none of them
    // is testing. The axis itself is exercised in "the category tabs", with its own fixtures.
    category: "financial",
    status: "ok", hasSecret: true, needsAttention: false, lastVerifiedAt: NOW - 3600,
    ...over,
  };
}

function answerWith(rows: unknown[]) {
  vi.mocked(bsc).mockResolvedValue(JSON.stringify(rows));
}

/** Click a page tab by its label. The strip renders a `.tab` box whose `title` is `label — hint`. */
function selectTab(container: HTMLElement, label: string) {
  const tab = container.querySelector<HTMLElement>(`.tab[title^="${label}"]`);
  expect(tab, `no tab labelled ${label}`).toBeTruthy();
  // `fireEvent`, not `tab.click()`. A raw DOM click updates state outside React's batching and every
  // selection warns "not wrapped in act(...)" — which is noise that trains the reader to ignore the
  // one real act warning that matters.
  fireEvent.click(tab!);
}

beforeEach(() => {
  vi.mocked(bsc).mockReset();
  vi.setSystemTime(NOW * 1000);
  // The active tab is PERSISTED app state keyed by page, so a test that switches tabs would otherwise
  // decide which tab the next one opens on — an order-dependent suite that passes alone and fails in
  // a full run.
  useAppStore.getState().setActivePageTab("credentials", "financial");
});

describe("CredentialsWorkspace", () => {
  it("reads the GLOBAL credential store — no project key", async () => {
    // A GitHub token is not owned by whichever project happens to be open. Passing a project key
    // would scope the read to that project's stores and return nothing.
    answerWith([row()]);
    render(<CredentialsWorkspace />);
    await waitFor(() => expect(bsc).toHaveBeenCalled());
    expect(bsc).toHaveBeenCalledWith(null, ["secret", "list"]);
  });

  it("renders one row per credential, named and with its status as TEXT", async () => {
    // The status has to be readable, not merely coloured — colour alone would leave the entire
    // content of this screen invisible to anyone who cannot distinguish the tones.
    answerWith([
      row({ id: "gh", label: "GitHub — acme", status: "ok" }),
      row({ id: "sf", label: "Salesforce", service: "salesforce", status: "expired", needsAttention: true }),
    ]);
    render(<CredentialsWorkspace />);
    expect(await screen.findByText("GitHub — acme")).toBeInTheDocument();
    expect(screen.getByText("Salesforce")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("leads with the broken credential, whatever order the store returned them in", async () => {
    answerWith([
      row({ id: "fine", label: "Fine", status: "ok" }),
      row({ id: "broken", label: "Broken", status: "missing", hasSecret: false, needsAttention: true }),
    ]);
    const { container } = render(<CredentialsWorkspace />);
    await screen.findByText("Broken");
    const names = Array.from(container.querySelectorAll(".cred-name")).map((n) => n.textContent);
    expect(names).toEqual(["Broken", "Fine"]);
  });

  it("counts what needs attention in the header", async () => {
    answerWith([
      row({ id: "a", status: "ok" }),
      row({ id: "b", status: "failing", needsAttention: true }),
      row({ id: "c", status: "expired", needsAttention: true }),
    ]);
    render(<CredentialsWorkspace />);
    expect(await screen.findByText("2 of 3 need attention")).toBeInTheDocument();
  });

  it("says how many there are when nothing is wrong, rather than an alarming zero", async () => {
    answerWith([row({ id: "a", status: "ok" })]);
    render(<CredentialsWorkspace />);
    expect(await screen.findByText("1 credential")).toBeInTheDocument();
  });

  it("shows WHY a credential is failing, not just that it is", async () => {
    // A red pill with no reason makes the user go and reproduce the failure to find out what it was.
    answerWith([row({ id: "gh", status: "failing", needsAttention: true, lastError: "401 invalid_grant" })]);
    render(<CredentialsWorkspace />);
    expect(await screen.findByText("401 invalid_grant")).toBeInTheDocument();
  });

  it("renders a credential with no keychain entry as missing", async () => {
    // The store/keychain disagreement — the one this screen exists to surface.
    answerWith([row({ id: "gh", status: "missing", hasSecret: false, needsAttention: true })]);
    render(<CredentialsWorkspace />);
    expect(await screen.findByText("No secret")).toBeInTheDocument();
    expect(screen.getByText(/keychain holds no value/i)).toBeInTheDocument();
  });

  it("shows an empty state with the command that fixes it, not a bare blank", async () => {
    answerWith([]);
    render(<CredentialsWorkspace />);
    expect(await screen.findByText("No credentials registered")).toBeInTheDocument();
    expect(screen.getByText(/bsc secret set/)).toBeInTheDocument();
  });

  it("surfaces a store read failure instead of showing it as an empty store", async () => {
    // "The store could not be read" and "the store is empty" are opposite facts. Collapsing the
    // first into the second would have this screen report all-clear precisely when it cannot know.
    vi.mocked(bsc).mockRejectedValue(new Error("bsc binary not found"));
    render(<CredentialsWorkspace />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be read");
    expect(screen.getByText("bsc binary not found")).toBeInTheDocument();
    expect(screen.queryByText("No credentials registered")).not.toBeInTheDocument();
  });

  it("never renders a secret value, even if the backend somehow sent one", async () => {
    // Defence in depth: `bsc secret` has no verb that returns a value and `Credential` has no field
    // that could hold one, but the screen is the last place a leak would become visible.
    answerWith([row({ id: "gh", token: "ghp_SUPERSECRET", value: "hunter2" })]);
    const { container } = render(<CredentialsWorkspace />);
    await screen.findByText("GitHub — acme");
    expect(container.textContent).not.toContain("ghp_SUPERSECRET");
    expect(container.textContent).not.toContain("hunter2");
  });

  it("shows an expiry countdown alongside the last check", async () => {
    answerWith([row({ id: "gh", status: "expiring", needsAttention: true, expiresAt: NOW + 3 * DAY })]);
    const { container } = render(<CredentialsWorkspace />);
    await screen.findByText("Expiring");
    expect(container.querySelector(".cred-details")?.textContent).toContain("expires in 3d");
    expect(container.querySelector(".cred-details")?.textContent).toContain("checked 1h ago");
  });

  it("renders a row whose record carries nothing but an id and a status", async () => {
    // Every field but `id` is optional — this is a verbatim-JSON store with no schema migration, so
    // a record written before a field existed still has to render. Such a record has no category
    // either, so it is on the unsorted tab: the pre-category record and the pre-category STATE are
    // the same case.
    answerWith([{ id: "bare", status: "unverified", hasSecret: true, needsAttention: false }]);
    const { container } = render(<CredentialsWorkspace />);
    await waitFor(() => expect(container.querySelector(".tab")).toBeTruthy());
    selectTab(container, "Unsorted");
    expect(await screen.findByText("bare")).toBeInTheDocument();
    expect(container.querySelector(".cred-glyph")).toBeTruthy();
  });
});

describe("the category tabs", () => {
  it("renders one tab per category, in order, with the unsorted queue last", async () => {
    answerWith([row()]);
    const { container } = render(<CredentialsWorkspace />);
    await waitFor(() => expect(container.querySelectorAll(".tab").length).toBeGreaterThan(0));
    const labels = Array.from(container.querySelectorAll(".tab")).map((t) => t.textContent?.trim());
    expect(labels.some((l) => l?.startsWith("Financial"))).toBe(true);
    expect(labels.some((l) => l?.startsWith("Social"))).toBe(true);
    expect(labels.some((l) => l?.startsWith("Other"))).toBe(true);
    expect(labels[labels.length - 1]?.startsWith("Unsorted")).toBe(true);
  });

  it("shows only the open tab's credentials", async () => {
    answerWith([
      row({ id: "bank", label: "Chase", service: "chase", category: "financial" }),
      row({ id: "bsky", label: "Bluesky", service: "bluesky", category: "social" }),
    ]);
    const { container } = render(<CredentialsWorkspace />);
    expect(await screen.findByText("Chase")).toBeInTheDocument();
    expect(screen.queryByText("Bluesky")).not.toBeInTheDocument();

    selectTab(container, "Social");
    expect(await screen.findByText("Bluesky")).toBeInTheDocument();
    expect(screen.queryByText("Chase")).not.toBeInTheDocument();
  });

  it("REACHES EVERY CREDENTIAL THE STORE HOLDS from some tab", async () => {
    // The lens rule, asserted against the rendered screen rather than against the bucketing function.
    // A tab is a view, never a filter that can hide data — so walking the tabs must show every row,
    // INCLUDING one whose stored category this build has no tab for. That last row is the one a
    // naive implementation drops, and it would be invisible in every other test here.
    answerWith([
      row({ id: "bank", label: "Chase", category: "financial" }),
      row({ id: "bsky", label: "Bluesky", category: "social" }),
      row({ id: "misc", label: "Misc Thing", category: "other" }),
      row({ id: "blank", label: "No Category", category: undefined }),
      row({ id: "future", label: "Some Health Portal", category: "healthcare" }),
    ]);
    const { container } = render(<CredentialsWorkspace />);
    await waitFor(() => expect(container.querySelectorAll(".tab").length).toBeGreaterThan(0));

    const seen = new Set<string>();
    for (const label of ["Financial", "Social", "Other", "Unsorted"]) {
      selectTab(container, label);
      await waitFor(() => expect(container.querySelector(".cred-list, .empty-state, [class*=empty]")).toBeTruthy());
      for (const n of container.querySelectorAll(".cred-name")) seen.add(n.textContent ?? "");
    }
    expect([...seen].sort()).toEqual(
      ["Bluesky", "Chase", "Misc Thing", "No Category", "Some Health Portal"],
    );
  });

  it("badges each tab with its own count", async () => {
    answerWith([
      row({ id: "a", label: "A", category: "financial" }),
      row({ id: "b", label: "B", category: "financial" }),
      row({ id: "c", label: "C", category: "social" }),
    ]);
    const { container } = render(<CredentialsWorkspace />);
    await waitFor(() => expect(container.querySelectorAll(".tab").length).toBeGreaterThan(0));
    const fin = container.querySelector<HTMLElement>('.tab[title^="Financial"]');
    const soc = container.querySelector<HTMLElement>('.tab[title^="Social"]');
    // The count makes an empty tab visible BEFORE it is opened, which is what keeps the unsorted
    // queue from being somewhere work goes to be forgotten.
    expect(fin?.textContent).toContain("2");
    expect(soc?.textContent).toContain("1");
  });

  it("keeps the ATTENTION count whole-store, not scoped to the open tab", async () => {
    // Scoping it would let a failing credential go unmentioned because another tab happened to be
    // selected — and surfacing exactly that is why this screen exists.
    answerWith([
      row({ id: "ok", label: "Fine", category: "financial", status: "ok" }),
      row({ id: "bad", label: "Broken", category: "social", status: "failing", needsAttention: true }),
    ]);
    render(<CredentialsWorkspace />);
    expect(await screen.findByText("1 of 2 need attention")).toBeInTheDocument();
  });

  it("distinguishes an empty TAB from an empty STORE", async () => {
    // Opposite facts. Reporting the first as the second tells the user their credentials are gone.
    answerWith([row({ id: "bsky", label: "Bluesky", category: "social" })]);
    const { container } = render(<CredentialsWorkspace />);
    await waitFor(() => expect(container.querySelectorAll(".tab").length).toBeGreaterThan(0));
    // Opens on Financial, which is empty while the store is not.
    expect(await screen.findByText(/Nothing filed under Financial/)).toBeInTheDocument();
    expect(screen.queryByText("No credentials registered")).not.toBeInTheDocument();
    // ...and it says WHERE the rows are, so they are findable without clicking every tab.
    expect(screen.getByText(/1 social/)).toBeInTheDocument();

    selectTab(container, "Social");
    expect(await screen.findByText("Bluesky")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing filed under/)).not.toBeInTheDocument();
  });

  it("still reports an empty STORE as an empty store, on whatever tab", async () => {
    answerWith([]);
    render(<CredentialsWorkspace />);
    expect(await screen.findByText("No credentials registered")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing filed under/)).not.toBeInTheDocument();
  });
});

describe("service glyphs", () => {
  it("gives every mapped service a glyph of its own, never the fallback", async () => {
    // `lib` decides WHICH glyph name a service gets; this module decides what that name draws as.
    // A service mapped to a name with no renderer silently falls through to the key glyph — a row
    // that looks fine and is wrong, and only noticed when someone adds that exact service.
    //
    // Asserted by IDENTITY rather than by type: a lucide icon is a forwardRef object, not a plain
    // function, so a typeof check both fails for real icons and would pass for anything truthy.
    const fallbackGlyph = glyphFor("a-service-nobody-has-ever-mapped");
    expect(serviceIcon("a-service-nobody-has-ever-mapped")).toBe(FALLBACK_ICON);
    for (const [service, iconKey] of Object.entries(SERVICE_ICONS)) {
      const glyph = glyphFor(service);
      expect(glyph, `${service} has no glyph`).toBeTruthy();
      if (iconKey !== FALLBACK_ICON) {
        expect(glyph, `${service} maps to "${iconKey}" but renders the fallback`).not.toBe(fallbackGlyph);
      }
    }
    // An absent service still resolves to something renderable rather than undefined.
    expect(glyphFor(undefined)).toBeTruthy();
  });

  it("draws different services with different glyphs", async () => {
    // Guards a map that collapsed everything onto one icon, which would satisfy the check above for
    // the fallback alone while making every row look identical.
    const distinct = new Set([glyphFor("github"), glyphFor("stripe"), glyphFor("resend"), glyphFor("slack")]);
    expect(distinct.size).toBe(4);
  });
});
