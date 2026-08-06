/**
 * Detects Arabic text-layer corruption in extracted PDF text.
 *
 * Root cause: many Arabic PDFs embed fonts whose ToUnicode table decomposes the
 * lam-alef ligature (ﻻ ﻷ ﻹ ﻵ) in VISUAL order, so extraction yields [alef][lam]
 * where the document reads [lam][alef]:
 *
 *     الإعلام  (what the page shows)
 *     اإلعالم  (what the text layer contains)
 *
 * The signature used here is near-zero-false-positive: Arabic orthography never
 * starts a word with two consecutive alef-forms, which is exactly what the bug
 * produces. Counting raw alef-lam pairs instead would fire constantly on the
 * legitimate definite article after the prefixes و/ب/ف/ك/ل.
 */

const ALEF = 'اأإآ';
const IMPOSSIBLE_PREFIX = new RegExp(`(?:^|[^ؠ-ي])[${ALEF}][${ALEF}]ل`, 'gu');
const ARABIC_CHAR = /[ؠ-ي]/;

export type TextQuality = 'clean' | 'ligature_only' | 'severe' | 'no_text';

export interface PageQuality {
  quality: TextQuality;
  /** Impossible word-initial double-alef sequences per 1000 Arabic tokens. */
  impossiblePrefixRate: number;
  /** Share of Arabic tokens that are implausibly long — lost inter-word spaces. */
  longTokenRate: number;
  arabicTokenCount: number;
  needsOcr: boolean;
}

/** Pages with almost no extractable text are image-only and need OCR outright. */
const MIN_CHARS_FOR_TEXT = 120;

export function assessPage(text: string): PageQuality {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS_FOR_TEXT) {
    return {
      quality: 'no_text',
      impossiblePrefixRate: 0,
      longTokenRate: 0,
      arabicTokenCount: 0,
      needsOcr: true,
    };
  }

  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  const arabicTokens = tokens.filter((t) => ARABIC_CHAR.test(t));

  // A page with no Arabic cannot suffer from this defect.
  if (arabicTokens.length < 20) {
    return {
      quality: 'clean',
      impossiblePrefixRate: 0,
      longTokenRate: 0,
      arabicTokenCount: arabicTokens.length,
      needsOcr: false,
    };
  }

  const impossible = (trimmed.match(IMPOSSIBLE_PREFIX) ?? []).length;
  const impossiblePrefixRate = Number(((impossible / arabicTokens.length) * 1000).toFixed(2));

  // Arabic words rarely exceed 12 letters; 18+ signals lost spacing.
  const longTokens = arabicTokens.filter((t) => t.replace(/[^ؠ-ي]/g, '').length >= 18).length;
  const longTokenRate = Number((longTokens / arabicTokens.length).toFixed(4));

  let quality: TextQuality = 'clean';
  if (longTokenRate > 0.06) quality = 'severe';
  else if (impossiblePrefixRate > 3) quality = 'ligature_only';

  return {
    quality,
    impossiblePrefixRate,
    longTokenRate,
    arabicTokenCount: arabicTokens.length,
    needsOcr: quality !== 'clean',
  };
}

/** Roll page-level assessments up to a document verdict. */
export function assessDocument(pages: Array<{ pageNumber: number; text: string }>): {
  quality: TextQuality;
  pagesNeedingOcr: number[];
  totalPages: number;
} {
  const pagesNeedingOcr: number[] = [];
  let severe = 0;
  let ligature = 0;

  for (const page of pages) {
    const assessment = assessPage(page.text);
    if (assessment.needsOcr) pagesNeedingOcr.push(page.pageNumber);
    if (assessment.quality === 'severe') severe += 1;
    if (assessment.quality === 'ligature_only') ligature += 1;
  }

  const quality: TextQuality =
    severe > pages.length * 0.1 ? 'severe' : ligature > 0 ? 'ligature_only' : 'clean';

  return { quality, pagesNeedingOcr, totalPages: pages.length };
}
