-- ============================================================================
-- Gulf University Research Repository — proposed initial schema
-- PostgreSQL 15+ with pgvector
--
-- STATUS: PROPOSAL. Not yet applied. Review before running.
-- Apply with:  psql "$DATABASE_URL" -f docs/schema/001_initial_schema.sql
--
-- Conventions:
--   * UUID primary keys (gen_random_uuid from pgcrypto).
--   * created_at / updated_at on every table; deleted_at for soft deletion.
--   * Every AI-generated artefact records model, prompt hash, and token usage.
--   * Vector dimension is 1536 (GEMINI_EMBEDDING_DIMENSIONS).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy author-name matching
CREATE EXTENSION IF NOT EXISTS unaccent;  -- diacritic-insensitive search

-- Arabic-aware full-text configuration. Postgres has no Arabic stemmer built in;
-- 'simple' + unaccent avoids destroying Arabic tokens the way 'english' would.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'research_ar') THEN
    CREATE TEXT SEARCH CONFIGURATION research_ar (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION research_ar
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------
CREATE TYPE research_status      AS ENUM ('pending','processing','extracted','requires_review','approved','published','failed','rejected');
CREATE TYPE access_level         AS ENUM ('public','university_only','abstract_only','view_only','download_disabled','restricted','confidential','embargoed');
CREATE TYPE research_language    AS ENUM ('ar','en','mixed','unknown');
CREATE TYPE text_source_kind     AS ENUM ('pdf_text_layer','word_text_layer','word_twin_text','vision_ocr','manual');
CREATE TYPE extraction_method    AS ENUM ('rule_based','gemini_structured','folder_convention','vision_ocr','manual','none');
CREATE TYPE import_job_status    AS ENUM ('queued','running','paused','completed','failed','cancelled');
CREATE TYPE import_file_status   AS ENUM ('pending','processing','extracted','requires_review','approved','published','failed','rejected','skipped_duplicate');
CREATE TYPE ai_content_kind      AS ENUM (
  'summary_one_sentence','summary_short','summary_detailed','summary_student','summary_executive',
  'summary_ar','summary_en','key_findings','methodology','research_problem','objectives',
  'limitations','recommendations','future_research','analysis','keywords','suggested_questions',
  'translation','comparison','literature_review','research_idea');
CREATE TYPE ai_review_state      AS ENUM ('generated','under_review','approved','edited','rejected','regenerated');
CREATE TYPE ai_operation_kind    AS ENUM ('embedding','metadata_extraction','ocr','chat_single','chat_repository','summary','analysis','comparison','literature_review','translation','suggestions','classification');

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------
CREATE TABLE faculties (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar      TEXT NOT NULL,
  name_en      TEXT,
  slug         TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX faculties_name_ar_key ON faculties (name_ar) WHERE deleted_at IS NULL;

CREATE TABLE departments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id   UUID NOT NULL REFERENCES faculties(id) ON DELETE RESTRICT,
  name_ar      TEXT NOT NULL,
  name_en      TEXT,
  slug         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  UNIQUE (faculty_id, slug)
);

CREATE TABLE journals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  issn         TEXT,
  publisher    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX journals_issn_key ON journals (issn) WHERE issn IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE conferences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  year         INTEGER,
  location     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Authentication & authorisation
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL UNIQUE,  -- super_admin, admin, librarian, researcher, student, staff, public_visitor
  name_ar      TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  -- Per-role AI budget (spec §20 "per-role usage limits")
  daily_token_limit    INTEGER NOT NULL DEFAULT 50000,
  daily_request_limit  INTEGER NOT NULL DEFAULT 200,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL UNIQUE,  -- research.read_fulltext, research.download, ai.chat, ai.compare, ...
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id        UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL,
  password_hash  TEXT,
  full_name_ar   TEXT,
  full_name_en   TEXT,
  faculty_id     UUID REFERENCES faculties(id) ON DELETE SET NULL,
  department_id  UUID REFERENCES departments(id) ON DELETE SET NULL,
  is_university_member BOOLEAN NOT NULL DEFAULT false,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE user_roles (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

-- ---------------------------------------------------------------------------
-- Authors
-- ---------------------------------------------------------------------------
CREATE TABLE authors (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name_ar       TEXT,
  full_name_en       TEXT,
  normalized_name    TEXT NOT NULL,      -- diacritic/alef-normalized for dedup
  email              TEXT,
  orcid              TEXT,
  faculty_id         UUID REFERENCES faculties(id) ON DELETE SET NULL,
  department_id      UUID REFERENCES departments(id) ON DELETE SET NULL,
  user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  research_interests TEXT,
  interests_embedding VECTOR(1536),      -- spec §5 "author research interests"
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX authors_orcid_key ON authors (orcid) WHERE orcid IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX authors_normalized_name_trgm ON authors USING gin (normalized_name gin_trgm_ops);

CREATE TABLE author_aliases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    UUID NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (author_id, normalized_alias)
);
CREATE INDEX author_aliases_norm_trgm ON author_aliases USING gin (normalized_alias gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Research core
-- ---------------------------------------------------------------------------
CREATE TABLE research (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title_ar           TEXT,
  title_en           TEXT,
  abstract_ar        TEXT,
  abstract_en        TEXT,
  publication_year   INTEGER,
  faculty_id         UUID REFERENCES faculties(id) ON DELETE SET NULL,
  department_id      UUID REFERENCES departments(id) ON DELETE SET NULL,
  journal_id         UUID REFERENCES journals(id) ON DELETE SET NULL,
  conference_id      UUID REFERENCES conferences(id) ON DELETE SET NULL,
  volume             TEXT,
  issue              TEXT,
  page_range         TEXT,
  doi                TEXT,
  issn               TEXT,
  isbn               TEXT,
  research_type      TEXT,
  publication_type   TEXT,
  language           research_language NOT NULL DEFAULT 'unknown',
  degree             TEXT,
  corresponding_author_id UUID REFERENCES authors(id) ON DELETE SET NULL,
  total_pages        INTEGER,
  full_text          TEXT,
  text_source        text_source_kind,
  status             research_status NOT NULL DEFAULT 'pending',
  access_level       access_level NOT NULL DEFAULT 'restricted',
  embargo_until      DATE,
  view_count         BIGINT NOT NULL DEFAULT 0,
  download_count     BIGINT NOT NULL DEFAULT 0,
  is_featured        BOOLEAN NOT NULL DEFAULT false,
  -- Embeddings for semantic search (spec §5)
  title_embedding    VECTOR(1536),
  abstract_embedding VECTOR(1536),
  keywords_embedding VECTOR(1536),
  -- Full-text search vector, maintained by trigger below
  search_vector      TSVECTOR,
  published_at       TIMESTAMPTZ,
  approved_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT research_year_range CHECK (publication_year IS NULL OR publication_year BETWEEN 1950 AND 2100),
  CONSTRAINT research_embargo_requires_date CHECK (access_level <> 'embargoed' OR embargo_until IS NOT NULL),
  CONSTRAINT research_has_a_title CHECK (title_ar IS NOT NULL OR title_en IS NOT NULL)
);
CREATE UNIQUE INDEX research_doi_key ON research (lower(doi)) WHERE doi IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX research_status_idx        ON research (status) WHERE deleted_at IS NULL;
CREATE INDEX research_access_level_idx  ON research (access_level) WHERE deleted_at IS NULL;
CREATE INDEX research_year_idx          ON research (publication_year DESC) WHERE deleted_at IS NULL;
CREATE INDEX research_faculty_idx       ON research (faculty_id) WHERE deleted_at IS NULL;
CREATE INDEX research_department_idx    ON research (department_id) WHERE deleted_at IS NULL;
CREATE INDEX research_search_vector_idx ON research USING gin (search_vector);
CREATE INDEX research_title_ar_trgm     ON research USING gin (title_ar gin_trgm_ops);
CREATE INDEX research_title_en_trgm     ON research USING gin (title_en gin_trgm_ops);
-- HNSW indexes for cosine similarity on title/abstract vectors.
CREATE INDEX research_title_embedding_idx    ON research USING hnsw (title_embedding vector_cosine_ops)    WITH (m = 16, ef_construction = 64);
CREATE INDEX research_abstract_embedding_idx ON research USING hnsw (abstract_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Trigger functions pin their own search_path and fully qualify the text search
-- configuration. pg_dump emits `set_config('search_path','',false)` before data,
-- and Neon's connection pooler forces an empty search_path, so an unqualified
-- 'research_ar' resolves in neither case.
CREATE OR REPLACE FUNCTION research_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('public.research_ar'::regconfig, coalesce(NEW.title_ar, '') || ' ' || coalesce(NEW.title_en, '')), 'A')
    || setweight(to_tsvector('public.research_ar'::regconfig, coalesce(NEW.abstract_ar, '') || ' ' || coalesce(NEW.abstract_en, '')), 'B')
    || setweight(to_tsvector('public.research_ar'::regconfig, coalesce(NEW.full_text, '')), 'D');
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, pg_catalog;

CREATE TRIGGER research_search_vector_trg
  BEFORE INSERT OR UPDATE OF title_ar, title_en, abstract_ar, abstract_en, full_text
  ON research FOR EACH ROW EXECUTE FUNCTION research_search_vector_update();

CREATE TABLE research_authors (
  research_id  UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  author_id    UUID NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  author_order SMALLINT NOT NULL DEFAULT 1,
  role         TEXT NOT NULL DEFAULT 'author',  -- author | supervisor | co_supervisor
  affiliation  TEXT,
  is_corresponding BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (research_id, author_id, role)
);
CREATE INDEX research_authors_author_idx ON research_authors (author_id);

CREATE TABLE keywords (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term        TEXT NOT NULL,
  normalized  TEXT NOT NULL,
  language    research_language NOT NULL DEFAULT 'unknown',
  embedding   VECTOR(1536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (normalized, language)
);

CREATE TABLE research_keywords (
  research_id  UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  keyword_id   UUID NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  is_ai_generated BOOLEAN NOT NULL DEFAULT false,
  confidence   NUMERIC(4,3),
  PRIMARY KEY (research_id, keyword_id)
);

-- ---------------------------------------------------------------------------
-- Files, pages, sections, chunks
-- ---------------------------------------------------------------------------
CREATE TABLE research_files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id    UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  stored_path    TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  file_kind      TEXT NOT NULL,          -- pdf | docx | doc
  size_bytes     BIGINT NOT NULL,
  sha256         TEXT NOT NULL,
  page_count     INTEGER,
  is_canonical   BOOLEAN NOT NULL DEFAULT false,  -- the file shown in the viewer
  is_downloadable BOOLEAN NOT NULL DEFAULT true,
  text_quality   TEXT,                   -- clean | ligature_only | severe
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX research_files_sha256_key ON research_files (sha256) WHERE deleted_at IS NULL;
CREATE INDEX research_files_research_idx ON research_files (research_id);
-- Exactly one canonical file per research.
CREATE UNIQUE INDEX research_files_one_canonical ON research_files (research_id) WHERE is_canonical AND deleted_at IS NULL;

CREATE TABLE research_pages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id  UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  file_id      UUID NOT NULL REFERENCES research_files(id) ON DELETE CASCADE,
  page_number  INTEGER NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  char_count   INTEGER NOT NULL DEFAULT 0,
  text_source  text_source_kind NOT NULL,
  ocr_confidence NUMERIC(4,3),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, page_number),
  CONSTRAINT research_pages_page_positive CHECK (page_number >= 1)
);
CREATE INDEX research_pages_research_idx ON research_pages (research_id, page_number);

CREATE TABLE research_sections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id  UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,     -- abstract_ar, methodology, results, references, ...
  heading      TEXT,
  start_page   INTEGER NOT NULL,
  end_page     INTEGER NOT NULL,
  section_order SMALLINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_sections_page_order CHECK (end_page >= start_page)
);
CREATE INDEX research_sections_research_idx ON research_sections (research_id);

CREATE TABLE research_chunks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id    UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  file_id        UUID REFERENCES research_files(id) ON DELETE SET NULL,
  section_id     UUID REFERENCES research_sections(id) ON DELETE SET NULL,
  chunk_index    INTEGER NOT NULL,
  text           TEXT NOT NULL,
  page_number    INTEGER NOT NULL,
  section_name   TEXT,
  heading        TEXT,
  token_count    INTEGER NOT NULL,
  char_count     INTEGER NOT NULL,
  language       research_language NOT NULL DEFAULT 'unknown',
  is_overlap     BOOLEAN NOT NULL DEFAULT false,
  source_filename TEXT,
  content_hash   TEXT NOT NULL,   -- dedup + embedding cache key
  search_vector  TSVECTOR,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (research_id, chunk_index),
  CONSTRAINT research_chunks_nonempty CHECK (length(btrim(text)) > 0)
);
CREATE INDEX research_chunks_research_idx      ON research_chunks (research_id);
CREATE INDEX research_chunks_page_idx          ON research_chunks (research_id, page_number);
CREATE INDEX research_chunks_content_hash_idx  ON research_chunks (content_hash);
CREATE INDEX research_chunks_search_vector_idx ON research_chunks USING gin (search_vector);

CREATE OR REPLACE FUNCTION research_chunks_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('public.research_ar'::regconfig, coalesce(NEW.text, ''));
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, pg_catalog;

CREATE TRIGGER research_chunks_search_vector_trg
  BEFORE INSERT OR UPDATE OF text ON research_chunks
  FOR EACH ROW EXECUTE FUNCTION research_chunks_search_vector_update();

-- Embeddings live in their own table so a model change does not rewrite chunks.
CREATE TABLE research_embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id    UUID NOT NULL REFERENCES research_chunks(id) ON DELETE CASCADE,
  research_id UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  embedding   VECTOR(1536) NOT NULL,
  model       TEXT NOT NULL,
  dimensions  SMALLINT NOT NULL DEFAULT 1536,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chunk_id, model)
);
-- Access filtering happens BEFORE vector search, so research_id must be indexed.
CREATE INDEX research_embeddings_research_idx ON research_embeddings (research_id);
CREATE INDEX research_embeddings_vector_idx
  ON research_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- Field-level extraction provenance (spec §2)
-- ---------------------------------------------------------------------------
CREATE TABLE extraction_fields (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id         UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  file_id             UUID REFERENCES research_files(id) ON DELETE SET NULL,
  field_name          TEXT NOT NULL,
  field_value         TEXT,
  extraction_source   TEXT,                       -- pdf_text | docx_text | filename | folder_structure | gemini | derived
  extraction_method   extraction_method NOT NULL DEFAULT 'none',
  page_number         INTEGER,
  evidence            TEXT,
  evidence_verified   BOOLEAN NOT NULL DEFAULT false,
  evidence_match_ratio NUMERIC(4,3),
  confidence          NUMERIC(4,3) NOT NULL DEFAULT 0,
  requires_manual_review BOOLEAN NOT NULL DEFAULT true,
  reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (research_id, field_name)
);
CREATE INDEX extraction_fields_review_idx ON extraction_fields (requires_manual_review, confidence);

-- ---------------------------------------------------------------------------
-- Import pipeline (spec §3) — resumable, per-file isolation
-- ---------------------------------------------------------------------------
CREATE TABLE import_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_directory TEXT NOT NULL,
  status           import_job_status NOT NULL DEFAULT 'queued',
  total_files      INTEGER NOT NULL DEFAULT 0,
  processed_files  INTEGER NOT NULL DEFAULT 0,
  failed_files     INTEGER NOT NULL DEFAULT 0,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE import_files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_job_id  UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  research_id    UUID REFERENCES research(id) ON DELETE SET NULL,
  absolute_path  TEXT NOT NULL,
  relative_path  TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  sha256         TEXT,
  size_bytes     BIGINT,
  status         import_file_status NOT NULL DEFAULT 'pending',
  -- Resumability: the last pipeline stage that completed successfully.
  completed_stage TEXT,
  attempts       SMALLINT NOT NULL DEFAULT 0,
  text_source    text_source_kind,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (import_job_id, absolute_path)
);
CREATE INDEX import_files_status_idx ON import_files (import_job_id, status);
CREATE INDEX import_files_sha256_idx ON import_files (sha256);

CREATE TABLE import_errors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_file_id UUID NOT NULL REFERENCES import_files(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL,
  error_code     TEXT,
  message        TEXT NOT NULL,
  stack          TEXT,
  is_retryable   BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX import_errors_file_idx ON import_errors (import_file_id);

CREATE TABLE duplicate_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id     UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  duplicate_of_id UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL,      -- identical_checksum | identical_text | title_similarity | embedding_similarity
  similarity      NUMERIC(5,4),
  state           ai_review_state NOT NULL DEFAULT 'generated',
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT duplicate_suggestions_distinct CHECK (research_id <> duplicate_of_id),
  UNIQUE (research_id, duplicate_of_id)
);

CREATE TABLE author_merge_suggestions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     UUID NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  merge_into_id UUID NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  similarity    NUMERIC(5,4),
  reason        TEXT,
  state         ai_review_state NOT NULL DEFAULT 'generated',
  resolved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT author_merge_distinct CHECK (author_id <> merge_into_id),
  UNIQUE (author_id, merge_into_id)
);

-- ---------------------------------------------------------------------------
-- AI conversations, grounding and auditability (spec §18)
-- ---------------------------------------------------------------------------
CREATE TABLE ai_conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  research_id  UUID REFERENCES research(id) ON DELETE CASCADE,  -- NULL = repository-wide assistant
  scope        TEXT NOT NULL DEFAULT 'single_research',         -- single_research | repository
  title        TEXT,
  general_knowledge_enabled BOOLEAN NOT NULL DEFAULT false,     -- spec §6, opt-in only
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id, created_at DESC);

CREATE TABLE ai_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,   -- user | assistant | system
  content          TEXT NOT NULL,
  language         research_language,
  confidence       NUMERIC(4,3),
  model            TEXT,
  prompt_tokens    INTEGER,
  response_tokens  INTEGER,
  total_tokens     INTEGER,
  latency_ms       INTEGER,
  -- Admin inspection (spec §18): full prompt retained for audit, hashed for cache lookup.
  prompt_hash      TEXT,
  rendered_prompt  TEXT,
  finish_reason    TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_messages_role_valid CHECK (role IN ('user','assistant','system'))
);
CREATE INDEX ai_messages_conversation_idx ON ai_messages (conversation_id, created_at);
CREATE INDEX ai_messages_prompt_hash_idx  ON ai_messages (prompt_hash);

-- Every chunk retrieved for an answer is recorded, so citations are auditable.
CREATE TABLE ai_message_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  chunk_id      UUID REFERENCES research_chunks(id) ON DELETE SET NULL,
  research_id   UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  page_number   INTEGER,
  similarity    NUMERIC(6,5),
  rank          SMALLINT,
  was_cited     BOOLEAN NOT NULL DEFAULT false,
  quoted_text   TEXT,
  -- Validated against research_pages: does the cited page actually exist?
  citation_valid BOOLEAN,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_message_sources_message_idx  ON ai_message_sources (message_id);
CREATE INDEX ai_message_sources_research_idx ON ai_message_sources (research_id);

CREATE TABLE ai_generated_content (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id   UUID REFERENCES research(id) ON DELETE CASCADE,
  kind          ai_content_kind NOT NULL,
  language      research_language NOT NULL DEFAULT 'unknown',
  content       TEXT NOT NULL,
  -- Structured payload for analyses/comparisons: items with evidence + page + confidence.
  payload       JSONB,
  state         ai_review_state NOT NULL DEFAULT 'generated',
  model         TEXT NOT NULL,
  prompt_hash   TEXT,
  total_tokens  INTEGER,
  confidence    NUMERIC(4,3),
  edited_content TEXT,
  reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
-- Cache key: one live artefact per (research, kind, language).
CREATE UNIQUE INDEX ai_generated_content_unique
  ON ai_generated_content (research_id, kind, language) WHERE deleted_at IS NULL;
CREATE INDEX ai_generated_content_state_idx ON ai_generated_content (state);
CREATE INDEX ai_generated_content_payload_idx ON ai_generated_content USING gin (payload);

CREATE TABLE ai_usage_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  research_id    UUID REFERENCES research(id) ON DELETE SET NULL,
  operation      ai_operation_kind NOT NULL,
  model          TEXT NOT NULL,
  prompt_tokens  INTEGER NOT NULL DEFAULT 0,
  response_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6),
  latency_ms     INTEGER,
  cache_hit      BOOLEAN NOT NULL DEFAULT false,
  succeeded      BOOLEAN NOT NULL DEFAULT true,
  error_code     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Drives per-user daily quota enforcement.
CREATE INDEX ai_usage_logs_user_day_idx ON ai_usage_logs (user_id, created_at DESC);
CREATE INDEX ai_usage_logs_operation_idx ON ai_usage_logs (operation, created_at DESC);

CREATE TABLE ai_feedback (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   UUID REFERENCES ai_messages(id) ON DELETE CASCADE,
  content_id   UUID REFERENCES ai_generated_content(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  rating       SMALLINT NOT NULL,
  reason       TEXT,
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_feedback_rating_range CHECK (rating BETWEEN -1 AND 1),
  CONSTRAINT ai_feedback_target CHECK (num_nonnulls(message_id, content_id) = 1)
);

-- ---------------------------------------------------------------------------
-- Access policies, engagement, audit
-- ---------------------------------------------------------------------------
CREATE TABLE access_policies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id   UUID REFERENCES research(id) ON DELETE CASCADE,
  access_level  access_level NOT NULL,
  role_id       UUID REFERENCES roles(id) ON DELETE CASCADE,
  can_view_metadata  BOOLEAN NOT NULL DEFAULT true,
  can_view_abstract  BOOLEAN NOT NULL DEFAULT false,
  can_view_fulltext  BOOLEAN NOT NULL DEFAULT false,
  can_download       BOOLEAN NOT NULL DEFAULT false,
  can_use_ai_chat    BOOLEAN NOT NULL DEFAULT false,
  can_use_ai_compare BOOLEAN NOT NULL DEFAULT false,
  effective_from DATE,
  effective_to   DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX access_policies_research_idx ON access_policies (research_id);
CREATE INDEX access_policies_role_idx     ON access_policies (role_id, access_level);

CREATE TABLE views (
  id           BIGSERIAL PRIMARY KEY,
  research_id  UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_hash      TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX views_research_idx ON views (research_id, created_at DESC);

CREATE TABLE downloads (
  id           BIGSERIAL PRIMARY KEY,
  research_id  UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  file_id      UUID REFERENCES research_files(id) ON DELETE SET NULL,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX downloads_research_idx ON downloads (research_id, created_at DESC);

CREATE TABLE favorites (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  research_id  UUID NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, research_id)
);

CREATE TABLE search_logs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  query         TEXT NOT NULL,
  query_language research_language,
  filters       JSONB,
  result_count  INTEGER NOT NULL DEFAULT 0,
  used_semantic BOOLEAN NOT NULL DEFAULT false,
  latency_ms    INTEGER,
  clicked_research_id UUID REFERENCES research(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX search_logs_created_idx ON search_logs (created_at DESC);

CREATE TABLE audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    UUID,
  before_value JSONB,
  after_value  JSONB,
  ip_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx  ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_user_idx    ON audit_logs (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = public, pg_catalog;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t);
  END LOOP;
END $$;
