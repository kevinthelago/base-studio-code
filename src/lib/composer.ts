// Pure helper for the single-line console composer.

/**
 * Bytes to write to the PTY when the composer submits a line. Appending a
 * carriage return submits the line to whatever's running (a shell or claude),
 * exactly as pressing Enter in the terminal would. The draft is sent verbatim
 * (no trimming) so any indentation the user typed is preserved.
 */
export function composerBytes(draft: string): string {
  return draft + "\r";
}
