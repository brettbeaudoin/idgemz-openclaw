# OpenClaw Memory Stack

This directory contains the rollback-safe memory stack for Dangerboat/OpenClaw.

Canonical truth remains the source files under `/Users/bbeaudoin/clawd`.
Postgres is a manifest/index and audit log. Hindsight and Milvus are derived,
rebuildable stores.

## Components

- `memory-postgres`: manifest tables for sources, spans, ingest runs, and outbox.
- `hindsight`: durable derived memory/observations over coherent documents.
- `milvus`: semantic retrieval over raw source chunks.
- `tei`: local embedding service for Milvus chunk embeddings.

## First Run

```bash
cd memory-stack
cp .env.example .env
docker compose --env-file .env up -d memory-postgres hindsight-db hindsight milvus tei
npm install
npm run dry-run
```

Dry-run scans files and prints source/span counts without writing.
By default, it only scans the core workspace context files and
`memory/YYYY-MM-DD.md` daily notes. Set `MEMORY_INCLUDE_PROJECT_DOCS=true` only
after reviewing the dry-run output.

When dry-run looks sane:

```bash
npm run ingest
npm run retain
```

## Rollback

Rollback never depends on Hindsight or Milvus because source files remain
canonical.

1. Stop the stack:
   `docker compose --env-file .env down`
2. Point OpenClaw back to file-only memory mode.
3. Keep or remove derived stores:
   - preserve volumes for inspection, or
   - remove only memory-stack volumes if the bootstrap was bad.
4. Rebuild from source files after fixing parser/config.

Versioned identifiers prevent destructive replacement during major changes:

- Hindsight bank: `openclaw-v1`
- Milvus collection: `openclaw_chunks_v1`
- Chunk recipe: `file-span-v1/plain-v1/e5-small`

## Docling

Docling is intentionally not in the core path. Most canonical OpenClaw memory is
Markdown, JSON, JSONL, logs, code, and plain text, so deterministic file parsers
are simpler and easier to audit. Add Docling later as an optional parser for PDFs
or Office documents.
