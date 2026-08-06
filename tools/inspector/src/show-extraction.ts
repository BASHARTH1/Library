/** Human-readable audit dump of reports/sample-extraction.json. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from './lib/env.js';
import type { ExtractedField, SampleExtractionResult } from './lib/types.js';

function render(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' | ').slice(0, 300);
  return String(value).replace(/\s+/g, ' ').slice(0, 300);
}

async function main(): Promise<void> {
  const data = JSON.parse(
    await readFile(resolve(env.reportsDir, 'sample-extraction.json'), 'utf8'),
  ) as { results: SampleExtractionResult[] };

  const KEY_FIELDS = [
    'titleAr', 'titleEn', 'authors', 'supervisors', 'degree', 'publicationYear',
    'faculty', 'department', 'researchType', 'publicationType', 'researchLanguage',
    'keywordsAr', 'keywordsEn', 'abstractAr', 'abstractEn', 'doi', 'authorEmails',
    'references', 'totalPages',
  ];

  for (const result of data.results) {
    console.log(`\n${'='.repeat(100)}`);
    console.log(`FILE: ${result.originalFilename}`);
    console.log(`status=${result.status} pages=${result.pageCount} chunks=${result.chunkPreview.total} aiTokens=${result.ai.totalTokens}`);
    console.log('-'.repeat(100));
    for (const name of KEY_FIELDS) {
      const f = (result.metadata as unknown as Record<string, ExtractedField<unknown>>)[name];
      if (!f) continue;
      const flag = f.value === null ? '  --' : f.requiresManualReview ? 'REV ' : ' OK ';
      console.log(
        `${flag} ${name.padEnd(18)} conf=${f.confidence.toFixed(2)} src=${(f.source ?? '-').padEnd(16)} p=${String(f.pageNumber ?? '-').padStart(3)}  ${render(f.value)}`,
      );
    }
    console.log(`  MISSING (${result.fieldsMissing.length}): ${result.fieldsMissing.join(', ')}`);
    if (result.fieldsLowConfidence.length > 0) {
      console.log(`  LOW CONFIDENCE: ${result.fieldsLowConfidence.join(', ')}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
