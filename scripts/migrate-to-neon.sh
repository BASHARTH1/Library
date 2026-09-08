#!/usr/bin/env bash
# Migrate the local corpus into the Vercel-provisioned Neon database.
#
# Constraints this works around:
#   * Neon's role cannot SET session_replication_role, so foreign keys are
#     enforced throughout the load — tables must be copied in dependency order.
#   * HNSW indexes are dropped before loading 16k vectors and rebuilt after;
#     maintaining them per-row during insert is dramatically slower.
#
# Idempotent per table: each table is truncated before it is loaded, so a failed
# run can simply be repeated.
set -uo pipefail

cd "$(dirname "$0")/.."
PSQL=".localdb/pgsql/bin/psql.exe"
PGDUMP=".localdb/pgsql/bin/pg_dump.exe"

LOCAL_PASSWORD=$(grep '^DATABASE_PASSWORD=' .env | cut -d= -f2)
LOCAL_URL="postgresql://postgres:${LOCAL_PASSWORD}@127.0.0.1:5433/gulf_research_repository"
# Neon's pooler forces search_path='' and rejects any override, which breaks
# every unqualified query. The unpooled endpoint reports a normal
# ["$user", public], so migration and the app both use it.
NEON_URL=$(grep '^DATABASE_URL_UNPOOLED=' .env.local | head -1 | cut -d= -f2- | tr -d '"')
if [ -z "$NEON_URL" ]; then
  NEON_URL=$(grep '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2- | tr -d '"')
fi

if [ -z "$NEON_URL" ]; then echo "DATABASE_URL missing from .env.local"; exit 1; fi

# Dependency order. A table may only appear after everything it references.
TABLES=(
  faculties departments roles permissions role_permissions
  users user_roles authors author_aliases journals conferences
  research research_authors keywords research_keywords
  research_files research_pages research_sections research_chunks research_embeddings
  import_jobs import_files import_errors extraction_fields
  duplicate_suggestions author_merge_suggestions
  ai_conversations ai_messages ai_message_sources ai_generated_content
  ai_usage_logs ai_feedback access_policies
  views downloads favorites search_logs audit_logs
)

# HNSW indexes are rebuilt after the load, not maintained during it.
HNSW=(
  "research_embeddings_vector_idx|ON research_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
  "research_title_embedding_idx|ON research USING hnsw (title_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
  "research_abstract_embedding_idx|ON research USING hnsw (abstract_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
)

echo "=== dropping vector indexes on target ==="
for entry in "${HNSW[@]}"; do
  name="${entry%%|*}"
  "$PSQL" "$NEON_URL" -q -c "DROP INDEX IF EXISTS ${name};" && echo "  dropped ${name}"
done

echo ""
echo "=== copying tables in dependency order ==="
failed=0
for t in "${TABLES[@]}"; do
  rows=$("$PSQL" "$LOCAL_URL" -t -A -c "SELECT count(*) FROM ${t};" 2>/dev/null || echo 0)
  if [ "$rows" = "0" ]; then
    printf "  %-26s empty, skipped\n" "$t"
    continue
  fi

  "$PSQL" "$NEON_URL" -q -c "TRUNCATE ${t} CASCADE;" >/dev/null 2>&1

  if "$PGDUMP" "$LOCAL_URL" --data-only --no-owner --no-privileges --table="public.${t}" \
       | "$PSQL" "$NEON_URL" -q -v ON_ERROR_STOP=1 >/dev/null 2>/tmp/mig_err.txt; then
    got=$("$PSQL" "$NEON_URL" -t -A -c "SELECT count(*) FROM ${t};")
    if [ "$rows" = "$got" ]; then
      printf "  %-26s %8s rows  ok\n" "$t" "$rows"
    else
      printf "  %-26s MISMATCH local=%s neon=%s\n" "$t" "$rows" "$got"
      failed=1
    fi
  else
    printf "  %-26s FAILED: %s\n" "$t" "$(head -2 /tmp/mig_err.txt | tr '\n' ' ')"
    failed=1
  fi
done

echo ""
echo "=== rebuilding vector indexes ==="
for entry in "${HNSW[@]}"; do
  name="${entry%%|*}"; ddl="${entry#*|}"
  echo "  building ${name} ..."
  "$PSQL" "$NEON_URL" -q -c "CREATE INDEX ${name} ${ddl};" && echo "    done"
done

echo ""
echo "=== verification ==="
"$PSQL" "$NEON_URL" -c "
SELECT (SELECT count(*) FROM research)            AS research,
       (SELECT count(*) FROM research_chunks)     AS chunks,
       (SELECT count(*) FROM research_embeddings) AS vectors,
       (SELECT count(*) FROM research_pages)      AS pages,
       (SELECT count(*) FROM users)               AS users,
       (SELECT count(*) FROM roles)               AS roles;"
"$PSQL" "$NEON_URL" -c "SELECT pg_size_pretty(pg_database_size(current_database())) AS neon_size;"

exit $failed
