/**
 * Bytes the app sends to a PTY to wipe the pending input line (the typed-but-
 * unsubmitted text on the prompt). Ctrl+U is the portable choice (#192):
 *
 * - **bash readline**: `unix-line-discard` — kills from the cursor to the start
 *   of the line. With the cursor at end-of-line (the common case when you stop
 *   mid-type and want to abandon what you've typed), that's the whole line.
 * - **claude's TUI input box**: clears the input. Many ink-based TUIs inherit
 *   the readline convention even though their input handling is otherwise
 *   bespoke.
 *
 * Mid-line clear in bash is a known partial: only the left half goes; the user
 * can press Ctrl+K (or Ctrl+E first) to finish the job. We opted for the
 * single, well-known control byte over a multi-byte combo so it works
 * uniformly in both contexts — the Ctrl+A select-all behavior some TUIs use
 * would make a combined Ctrl+A Ctrl+K sequence land the user in a "text
 * highlighted" state in claude.
 */
export const CLEAR_INPUT_BYTES = "\x15";
