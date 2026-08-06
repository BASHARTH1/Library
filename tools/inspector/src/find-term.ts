/**
 * Locate a term inside a specific research file and show how it actually appears
 * in the extracted text layer. Used to diagnose search misses.
 *
 * Usage: npx tsx tools/inspector/src/find-term.ts "<absolute path>" "<term>"
 */
import { classifyExtension, extractDocument } from './lib/file-analysis.js';
import { extname } from 'node:path';

function normalizeArabic(text: string): string {
  return text
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '');
}

async function main(): Promise<void> {
  const [, , path, ...termParts] = process.argv;
  const term = termParts.join(' ');
  if (!path || !term) {
    console.error('Usage: find-term.ts "<path>" "<term>"');
    process.exit(1);
  }

  const kind = classifyExtension(extname(path));
  const doc = await extractDocument(path, kind);
  console.log(`file  : ${path.split(/[\\/]/).pop()}`);
  console.log(`pages : ${doc.pageCount}, chars: ${doc.fullText.length}\n`);

  const needleExact = term;
  const needleNorm = normalizeArabic(term).replace(/\s+/g, '');

  let exactHits = 0;
  let normHits = 0;

  for (const page of doc.pages) {
    if (page.text.includes(needleExact)) {
      exactHits += 1;
      const i = page.text.indexOf(needleExact);
      console.log(`EXACT  p.${page.pageNumber}: …${page.text.slice(Math.max(0, i - 90), i + 110).replace(/\s+/g, ' ')}…`);
    }
    const flat = normalizeArabic(page.text).replace(/\s+/g, '');
    if (flat.includes(needleNorm)) {
      normHits += 1;
      if (exactHits === 0 && normHits <= 6) {
        const j = flat.indexOf(needleNorm);
        console.log(`NORM   p.${page.pageNumber}: …${flat.slice(Math.max(0, j - 70), j + 90)}…`);
      }
    }
  }

  console.log(`\nexact-match pages     : ${exactHits}`);
  console.log(`normalized-match pages: ${normHits}`);

  // Show each token separately — one may survive extraction while the other does not.
  for (const token of term.split(/\s+/)) {
    const count = doc.pages.filter((p) => p.text.includes(token)).length;
    const flatCount = doc.pages.filter((p) =>
      normalizeArabic(p.text).replace(/\s+/g, '').includes(normalizeArabic(token).replace(/\s+/g, '')),
    ).length;
    console.log(`  token "${token}": exact on ${count} page(s), normalized on ${flatCount} page(s)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
