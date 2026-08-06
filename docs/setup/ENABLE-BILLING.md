# Enabling billing to embed the full corpus

> **Status: DONE.** Gemini Paid Tier 1 was activated on 2026-08-05. The daily cap
> is gone, `.env` is on the paid throughput block, and `gemini-3.1-pro-preview`
> (the `GEMINI_DEEP_MODEL` used for comparisons and literature reviews) is
> reachable — it returned HTTP 429 on the free tier. This document is kept as the
> record of why, and as the runbook if the key or project is ever replaced.

## Why

The Gemini free tier caps embeddings at **1,000 requests per day, per model**
(`EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier`). Each chunk of
text counts as one request, so batching does not help.

| | |
|---|---|
| Chunks awaiting vectors | 15,434 |
| Free-tier ceiling | 1,000 / day |
| Time to finish on free tier | ~16 days |
| Approximate cost on paid tier | **~$0.90** (≈5.8M tokens at $0.15/1M) |

Until embeddings exist, full-text search, browsing, metadata and the PDF viewer
work across all 79 theses; semantic search and AI chat do not.

## Steps

1. Open <https://console.cloud.google.com/billing> and link a billing account to
   the project that owns the `GEMINI_API_KEY`.
2. Confirm the Generative Language API is enabled for that project:
   <https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com>
3. Verify the daily cap is gone:

   ```powershell
   npx tsx tools/inspector/src/probe-embed-models.ts
   ```

   `gemini-embedding-001` should report `AVAILABLE`.

4. Switch `.env` to the paid-tier throughput block (comment the free-tier lines,
   uncomment the paid ones):

   ```env
   GEMINI_EMBED_BATCH=100
   GEMINI_EMBED_RPM=1500
   GEMINI_EMBED_TPM=500000
   ```

5. Run the backfill:

   ```powershell
   npm run api:embed
   ```

   It is resumable and skips chunks that already have vectors, so it is safe to
   stop and re-run at any point.

6. Confirm coverage:

   ```powershell
   curl http://localhost:3000/api/stats
   ```

   `semantic_ready_count` should reach 79 and `pending_embedding_count` 0.

## Cost control after billing is on

These are already in `.env` and enforced in `GeminiService` / `ai_usage_logs`:

- `AI_DAILY_TOKEN_LIMIT_PER_USER` — per-user daily token budget
- `AI_MAX_RETRIEVED_CHUNKS` — caps context size per question
- `AI_CACHE_TTL_SECONDS` — response, summary and embedding caching
- Per-role `daily_token_limit` / `daily_request_limit` columns on `roles`

Every call is recorded in `ai_usage_logs` with model, tokens, latency and cache
hit, so spend is auditable per user and per operation.

## Ongoing cost after the one-time backfill

Embeddings are generated once per chunk and cached. Steady-state cost is
dominated by chat, at roughly **$0.003 per question** (one query embedding plus
~8k context tokens and ~1k output).
