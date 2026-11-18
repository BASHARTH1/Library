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

### Adding a new batch of theses

Each delivery is inspected into its own set of reports (`--batch NAME`) and
loaded straight into Neon, the database the deployment serves. Do **not** use
`scripts/migrate-to-neon.sh` for this: it truncates every Neon table, which
would wipe extracted abstracts, OCR repairs, users and conversations.

```powershell
$src = "C:\Users\Bashar\Desktop\رسائل ماجستير-الدفعة الثانية"
npx tsx tools/inspector/src/inspect-folder.ts --source $src --batch batch2
npx tsx tools/inspector/src/diagnose-arabic.ts --batch batch2
npm run api:ingest-all -- --batch batch2 --dry-run   # review reports/ingest-plan-batch2.json
npm run api:ingest-all -- --batch batch2
npm run api:ocr                                      # before the upload: OCR reads from disk
npm run api:upload-r2
npm run api:extract-abstracts
npm run api:embed
```

A thesis may arrive as one file, as a PDF + Word pair, or as a folder of parts
(cover, chapters, references, appendices). A folder is one thesis: a complete
PDF/Word inside it is used when there is one, otherwise the parts are joined in
reading order. Theses that exist only as scans are listed and skipped.

## Admin page

Sign in at `/login`; accounts with the `super_admin`, `admin` or `librarian` role get an **Admin** link.
Create the first administrator with `ADMIN_EMAIL=admin ADMIN_PASSWORD=... npm run api:seed-auth` (`ADMIN_EMAIL` can be an email or a plain username; sign-in accepts either).

| Page | What it does | Who |
|---|---|---|
| Overview | Counts by status, passages awaiting vectors, AI tokens today | all three roles |
| Theses | Add, edit, publish, unpublish, trash and restore, replace the file | all three roles |
| Faculties & departments | Add, rename, remove (only when empty) | all three roles |
| Users | Add accounts, roles, deactivate, set passwords | `super_admin` |
| Activity log | Who changed what | all three roles |

**Adding a thesis.** The browser uploads the file straight to R2, then the thesis page runs it through the
same stages as the batch import, one bounded step per request so it fits a function timeout:

```
parse -> OCR for corrupted or scanned pages -> sections and chunks -> AI-filled details -> embeddings
```

Nothing is public until someone reviews the details and presses **Publish**. From then on the thesis is
served by the same queries as the rest of the corpus, so search and the assistant use and cite it.
Processing runs while the thesis page is open; if it is closed, it resumes the next time the page is opened.

**Setting up production uploads.** A browser can only PUT to the private bucket if its CORS rules allow the site:

```powershell
npm run api:r2-cors -- https://gulf-research-repository.vercel.app
```

If the R2 token only has object permissions, add this rule under the bucket's *Settings → CORS Policy* instead:

```json
[{ "AllowedOrigins": ["https://gulf-research-repository.vercel.app"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
```

Without R2 keys in `.env` (local development), uploads are written to `FILE_STORAGE_PATH` instead.

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
