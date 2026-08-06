# Gulf University AI Research Repository

AI-powered digital research repository for Gulf University publications.

**Angular 20 · NestJS 11 · PostgreSQL 18 + pgvector 0.8.1 · TypeORM · Google Gemini · SSE streaming**

---

## Run it

```powershell
npm install
npm run dev
```

Then open **http://localhost:4200**

`npm run dev` starts the database, the API (:3000) and the web app (:4200).
Ctrl+C stops the API and web server; the database keeps running (`npm run db:stop`).

To run the pieces separately:

```powershell
npm run db:start     # portable PostgreSQL on :5433
npm run api:dev      # NestJS on :3000
npm run web:dev      # Angular on :4200
```

No installation or admin rights are needed — the database is self-contained under
`.localdb/`. See [docs/setup/LOCAL-DATABASE.md](docs/setup/LOCAL-DATABASE.md).

## What works today

| Feature | Status |
|---|---|
| Homepage — search, statistics, latest, most viewed, browse by faculty/year | working |
| Hybrid search — full-text + pgvector + fuzzy authors + weighted ranking | working |
| Research details — metadata, authors, supervisors, keywords, sections | working |
| PDF viewer with deep-link to a cited page | working |
| "Ask This Research" — streaming RAG chat with page citations | working |
| Citation validation + confidence scoring | working |
| Similar research with explanations | working |
| Suggested questions | working |
| Arabic/English UI with RTL/LTR | working |
| Corpus loaded | **all 79 theses** — 16,119 chunks, 8,681 pages |
| AI assistants | "Ask the repository" (grounded Q&A with sources) + "Find research" |
| Gemini tier | Paid Tier 1 — no daily cap, pro model available |

## Loading the corpus

```powershell
npm run api:ingest-all      # parse + chunk + index every file (no AI needed)
npm run api:embed           # backfill vectors; safe to re-run
```

`ingest-all` merges the 14 PDF/Word twin groups into single research records
(93 files → 79 theses) and picks the cleanest available text source for each.

**15,434 chunks still need vectors.** The Gemini free tier caps embeddings at
**1,000 per day** (each text counts as one request, so batching does not help),
which is ~16 days for the backlog. Enable billing to do it in one pass. Until
then full-text search, browsing, metadata and the PDF viewer work across the
whole corpus; semantic search and AI chat only cover the embedded papers.

## Repository layout

```
apps/api/          NestJS backend
  src/gemini/      GeminiService + grounding / anti-injection layer
  src/ingest/      parse -> sections -> chunks -> embeddings pipeline
  src/search/      hybrid search + retrieval
  src/chat/        RAG chat with SSE streaming
apps/web/          Angular frontend
docs/schema/       PostgreSQL + pgvector schema (38 tables)
docs/setup/        database setup notes
reports/           phase-1 corpus analysis (gitignored)
tools/inspector/   corpus inspection & metadata extraction tooling
scripts/           dev, database and smoke-test helpers
```

## Phase-1 analysis

[`reports/PHASE-1-REPORT.md`](reports/PHASE-1-REPORT.md) covers the 93-file corpus
inventory, metadata extraction with page evidence, the chunking strategy, cost
estimates, security risks, and a critical finding: **59 of 76 PDFs have corrupted
Arabic text layers** (a lam-alef ligature bug in the embedded fonts). Gemini
vision OCR fixes it; that stage is not built yet.

```powershell
npx tsx tools/inspector/src/inspect-folder.ts     # corpus inventory
npx tsx tools/inspector/src/diagnose-arabic.ts    # Arabic text quality
npx tsx tools/inspector/src/extract-sample.ts     # metadata extraction
```

## Smoke tests

```powershell
node scripts/test-chat.mjs <researchId> "ما هي أهداف هذه الدراسة؟"
```

## Security

The Gemini API key is read **only** by the NestJS backend, in `GeminiService`.
It must never appear in Angular environment files, browser JavaScript, HTML, or
client HTTP requests.

Research documents are treated as untrusted data: they are wrapped in explicit
delimiters, the system instruction forbids following instructions found inside
them, and every page the model cites is validated against the retrieved context
before the answer is shown.

**Rotate the credentials that were shared in chat** (Gemini key, Supabase password
and publishable key) before any deployment.
