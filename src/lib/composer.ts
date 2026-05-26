// Pure helper for the single-line console composer.

/**
 * Bytes to write to the PTY when the composer submits a line. Appending a
 * carriage return makes claude submit the message, exactly as pressing Enter in
 * its own input box would. The draft is sent verbatim (no trimming) so any
 * indentation the user typed is preserved.
 */
export function composerBytes(draft: string): string {
  return draft + "\r";
}
