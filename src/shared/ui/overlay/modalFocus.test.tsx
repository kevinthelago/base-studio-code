// Modal focus management (#2725 Tier 0). jsdom cannot do layout or the cascade, but it DOES track
// `document.activeElement` and dispatch real keydown — so focus-in, restore, and the Tab wrap are all
// observable here. What is NOT observable is the browser's own Tab traversal: jsdom never moves focus on
// Tab by itself, so these tests assert the trap's OWN handling (it preventDefaults and moves focus at the
// ends), which is precisely the behaviour that keeps focus inside.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Dialog } from "@/shared/ui/overlay/Dialog";

function Modal({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <ModalScrim onDismiss={onDismiss}>
      <div className="card" role="dialog" aria-modal="true" aria-label="Test modal">
        <button>first</button>
        <button>middle</button>
        <button>last</button>
      </div>
    </ModalScrim>
  );
}

describe("modal focus management", () => {
  it("moves focus into the modal on open", () => {
    render(<Modal />);
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("returns focus to the trigger when the modal closes", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && <ModalScrim><button onClick={() => setOpen(false)}>close</button></ModalScrim>}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByText("open");
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByText("close"));

    fireEvent.click(screen.getByText("close"));
    // The whole point: the user lands back where they were, not at the top of the document.
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps Tab from the last focusable back to the first", () => {
    render(<Modal />);
    const scrim = document.querySelector(".modal-scrim") as HTMLElement;
    screen.getByText("last").focus();
    fireEvent.keyDown(scrim, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("wraps Shift+Tab from the first focusable back to the last", () => {
    render(<Modal />);
    const scrim = document.querySelector(".modal-scrim") as HTMLElement;
    screen.getByText("first").focus();
    fireEvent.keyDown(scrim, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });

  it("pulls focus back when it has escaped the modal entirely", () => {
    render(
      <>
        <button>outside</button>
        <Modal />
      </>,
    );
    const scrim = document.querySelector(".modal-scrim") as HTMLElement;
    screen.getByText("outside").focus();
    fireEvent.keyDown(scrim, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("traps a NON-dismissable modal too — that is the one you must not escape", () => {
    render(<Modal onDismiss={undefined} />);
    const scrim = document.querySelector(".modal-scrim") as HTMLElement;
    expect(document.activeElement).toBe(screen.getByText("first"));
    screen.getByText("last").focus();
    fireEvent.keyDown(scrim, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("focuses the container itself when the modal has nothing focusable", () => {
    render(<ModalScrim><div className="card">working…</div></ModalScrim>);
    // Otherwise the reader stays behind the scrim with no way in.
    expect(document.activeElement).toBe(document.querySelector(".modal-scrim"));
  });

  it("puts the dialog role on the CARD and exactly once, never on the scrim too", () => {
    // The scrim is the BACKDROP. Marking it a dialog as well nested one dialog inside another and made
    // `getByRole("dialog")` ambiguous — which is exactly how ModalCard's existing test caught it.
    render(<Modal />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("card")).toBe(true);
    expect(dialog.classList.contains("modal-scrim")).toBe(false);
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });
});

describe("Dialog", () => {
  it("names itself from its own title rather than a duplicated string", () => {
    render(<Dialog title="Delete project" actions={<button>ok</button>} onDismiss={() => {}}>body</Dialog>);
    const labelledBy = screen.getByRole("dialog").getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Delete project");
  });
});
