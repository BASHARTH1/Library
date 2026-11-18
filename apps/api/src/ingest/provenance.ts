/** Whitespace is unreliable in OCR text, so compare with it removed. */
function normalise(text: string): string {
  return text.replace(/\s+/gu, '');
}

/** How much of the opening must appear in the source for the text to be real. */
const PROVENANCE_PROBE_CHARS = 40;

/**
 * True when text the model returned demonstrably came from the source.
 *
 * The opening is probed rather than the whole string: the model legitimately
 * drops a trailing keywords line or a page number, but it has no reason to
 * change the first words of a passage it was told to copy.
 */
export function cameFromSource(candidate: string, source: string): boolean {
  const probe = normalise(candidate).slice(0, PROVENANCE_PROBE_CHARS);
  return probe.length > 0 && normalise(source).includes(probe);
}
