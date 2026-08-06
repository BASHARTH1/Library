/**
 * Query-side compensation for corrupted Arabic text layers.
 *
 * 59 of 76 PDFs in this corpus embed fonts whose ToUnicode table decomposes the
 * lam-alef ligature (ﻻ ﻷ ﻹ ﻵ) in VISUAL order, so the stored text contains
 * [alef][lam] where the document actually reads [lam][alef]:
 *
 *     الإعلام  (correct, what a user types)
 *     اإلعالم  (what is stored)
 *
 * Because the corruption is deterministic, applying the SAME transform to the
 * query produces a string that matches the stored text exactly. Searching for
 * both forms therefore finds the document without rewriting any stored data.
 *
 * This is a compensating measure, not a cure — the OCR stage still needs to
 * repair the text itself so that snippets shown to users are readable.
 */

const ALEF = 'اأإآ';

/** Rewrite a query the way the broken font would have rendered it. */
export function corruptLamAlef(text: string): string {
  return text.replace(new RegExp(`ل([${ALEF}])`, 'gu'), '$1ل');
}

/** True when the transform changes anything, i.e. the query contains a ligature. */
export function hasLamAlef(text: string): boolean {
  return new RegExp(`ل[${ALEF}]`, 'u').test(text);
}

/**
 * All spellings worth searching for: the query as typed, plus its corrupted
 * twin when they differ. Deduplicated and blank-filtered.
 */
/**
 * Build a relaxed OR-tsquery from a free-text query.
 *
 * `websearch_to_tsquery` ANDs every term, so a single uncommon word makes an
 * otherwise reasonable query return nothing. This produces `a | b | c` over both
 * spellings of each token, used only as a fallback when the strict query finds
 * no rows — ranking then surfaces documents matching the most terms.
 *
 * Tokens are stripped to letters and digits so no tsquery operator can be
 * injected through user input.
 */
export function relaxedTsQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;

  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    const corrupted = corruptLamAlef(token);
    if (corrupted !== token) expanded.add(corrupted);
  }
  return [...expanded].join(' | ');
}

export function queryVariants(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed === '') return [];
  const variants = new Set<string>([trimmed]);
  const corrupted = corruptLamAlef(trimmed);
  if (corrupted !== trimmed) variants.add(corrupted);
  return [...variants];
}
