BEGIN;

CREATE TABLE IF NOT EXISTS memory_ingest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL,
  source_root text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  source_count integer NOT NULL DEFAULT 0,
  span_count integer NOT NULL DEFAULT 0,
  retained_hindsight_count integer NOT NULL DEFAULT 0,
  indexed_milvus_count integer NOT NULL DEFAULT 0,
  error text
);

CREATE TABLE IF NOT EXISTS memory_sources (
  id text PRIMARY KEY,
  abs_path text NOT NULL UNIQUE,
  rel_path text NOT NULL,
  source_type text NOT NULL,
  content_sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  mtime_ms bigint NOT NULL,
  parser_version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_spans (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
  span_index integer NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  text_sha256 text NOT NULL,
  text text NOT NULL,
  chunk_recipe text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, span_index)
);

CREATE TABLE IF NOT EXISTS memory_outbox (
  id text PRIMARY KEY,
  span_id text REFERENCES memory_spans(id) ON DELETE CASCADE,
  document_id text,
  target text NOT NULL CHECK (target IN ('hindsight', 'milvus')),
  content_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_rel_path
  ON memory_sources (rel_path);
CREATE INDEX IF NOT EXISTS idx_memory_sources_type
  ON memory_sources (source_type);
CREATE INDEX IF NOT EXISTS idx_memory_spans_source
  ON memory_spans (source_id, span_index);
CREATE INDEX IF NOT EXISTS idx_memory_spans_text_fts
  ON memory_spans USING gin (to_tsvector('simple', text));
CREATE INDEX IF NOT EXISTS idx_memory_outbox_pending
  ON memory_outbox (target, created_at)
  WHERE status = 'pending';

COMMIT;

