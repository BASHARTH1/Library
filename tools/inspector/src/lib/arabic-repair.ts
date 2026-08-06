/**
 * Detection and repair of corrupted Arabic text layers in PDFs.
 *
 * Root cause: many Arabic PDFs encode the lam-alef ligature (ﻻ ﻷ ﻹ ﻵ) as a single
 * glyph whose ToUnicode mapping decomposes to [alef, lam] in VISUAL order instead
 * of [lam, alef] in LOGICAL order. Extractors that trust the CMap therefore emit
 * "اال" where the source says "الا", and "اإل" where the source says "الإ".
 *
 * A second, worse failure mode is whole-word reordering plus lost inter-word
 * spaces ("هذهالدر اسة"), which happens when the font has no usable ToUnicode
 * table at all. That class is NOT repairable by substitution and must be re-read
 * with OCR or a vision model.
 */

const ALEF_FORMS = 'اأإآ';

/**
 * Corruption signature: an alef immediately followed by lam, inside a word,
 * where the correct logical order would be lam followed by alef.
 */
const REVERSED_LIGATURE = new RegExp(`([${ALEF_FORMS}])ل`, 'gu');

/**
 * Precise corruption signature.
 *
 * Arabic orthography never begins a word with two consecutive alef-forms.
 * When the reversed-ligature bug hits a word whose second letter is lam
 * followed by alef (e.g. "الاتصال", "الإعلام"), it produces exactly that
 * impossible prefix ("االتصال", "اإلعالم"). Counting it gives a near
 * zero-false-positive detector, unlike a raw alef-lam frequency which also
 * matches the legitimate definite article after the prefixes و/ب/ف/ك/ل.
 */
const IMPOSSIBLE_PREFIX = /(?:^|[^ؠ-ي])[اأإآ][اأإآ]ل/gu;

export interface CorruptionScore {
  /** Impossible word-initial double-alef sequences per 1000 Arabic tokens. */
  impossiblePrefixRate: number;
  /** Raw reversed lam-alef candidates per 1000 chars (noisy; diagnostic only). */
  ligatureErrorRate: number;
  /** Suspiciously long tokens, a proxy for lost inter-word spacing. */
  longTokenRate: number;
  /** Share of tokens that are valid-looking Arabic words. */
  arabicTokenRatio: number;
  severity: 'clean' | 'ligature_only' | 'severe';
  sampleBefore: string;
  sampleAfter: string;
}

/**
 * Repair reversed lam-alef ligatures.
 *
 * Only applied where the pattern is unambiguous: an alef-form followed by lam
 * that is NOT at the start of a word (word-initial "ال" is the definite article
 * and must never be touched).
 */
export function repairLamAlef(text: string): string {
  return text.replace(
    // Preceded by an Arabic letter => we are mid-word, so "ا ل" is a reversed ligature.
    new RegExp(`(?<=[\\u0620-\\u063A\\u0641-\\u064A])([${ALEF_FORMS}])ل`, 'gu'),
    'ل$1',
  );
}

/**
 * Word-initial "اال" / "اإل" / "األ" / "اآل" is always a corrupted "الا" / "الإ" /
 * "الأ" / "الآ": Arabic has no word that legitimately starts alef-alef.
 */
export function repairWordInitialLigature(text: string): string {
  return text.replace(new RegExp(`(^|[^\\u0620-\\u064A])ا([${ALEF_FORMS}])ل`, 'gu'), '$1ال$2');
}

export function repairArabic(text: string): string {
  let out = text;
  out = repairWordInitialLigature(out);
  out = repairLamAlef(out);
  return out;
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

export function scoreCorruption(text: string): CorruptionScore {
  const sample = text.slice(0, 60000);
  const arabicChars = (sample.match(/[ؠ-ي]/g) ?? []).length;

  if (arabicChars < 200) {
    return {
      impossiblePrefixRate: 0,
      ligatureErrorRate: 0,
      longTokenRate: 0,
      arabicTokenRatio: 0,
      severity: 'clean',
      sampleBefore: '',
      sampleAfter: '',
    };
  }

  // Count mid-word reversed ligatures.
  const reversed = (sample.match(new RegExp(`(?<=[\\u0620-\\u063A\\u0641-\\u064A])([${ALEF_FORMS}])ل`, 'gu')) ?? []).length;
  const ligatureErrorRate = Number(((reversed / arabicChars) * 1000).toFixed(2));

  const tokens = tokenize(sample);
  const arabicTokens = tokens.filter((t) => /[ؠ-ي]/.test(t));
  // Arabic words are rarely longer than 12 letters; 18+ signals lost spaces.
  const longTokens = arabicTokens.filter((t) => t.replace(/[^ؠ-ي]/g, '').length >= 18).length;
  const longTokenRate = arabicTokens.length > 0 ? Number((longTokens / arabicTokens.length).toFixed(4)) : 0;
  const arabicTokenRatio = tokens.length > 0 ? Number((arabicTokens.length / tokens.length).toFixed(3)) : 0;

  const impossible = (sample.match(IMPOSSIBLE_PREFIX) ?? []).length;
  const impossiblePrefixRate =
    arabicTokens.length > 0 ? Number(((impossible / arabicTokens.length) * 1000).toFixed(2)) : 0;

  let severity: CorruptionScore['severity'] = 'clean';
  if (longTokenRate > 0.06) severity = 'severe';
  else if (impossiblePrefixRate > 3) severity = 'ligature_only';

  // Find a representative excerpt containing the corruption for reporting.
  const match = sample.match(new RegExp(`\\S*[\\u0620-\\u063A\\u0641-\\u064A][${ALEF_FORMS}]ل\\S*`, 'u'));
  const before = match ? sample.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 80).replace(/\s+/g, ' ') : sample.slice(0, 100);

  return {
    impossiblePrefixRate,
    ligatureErrorRate,
    longTokenRate,
    arabicTokenRatio,
    severity,
    sampleBefore: before.trim(),
    sampleAfter: repairArabic(before).trim(),
  };
}
