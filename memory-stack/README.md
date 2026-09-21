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

Hindsight defaults to the local Ollama server via `host.docker.internal` so the
stack can boot without committing or storing an OpenAI key. Set
`HINDSIGHT_API_LLM_PROVIDER=openai` and `HINDSIGHT_API_LLM_API_KEY` only in your
local `.env` if you want hosted extraction.

Hindsight uses the stack's TEI service for embeddings. Keeping embeddings out of
the Hindsight API process avoids the local ONNX startup memory spike.

Milvus indexing defaults to the host's native Ollama `nomic-embed-text` model.
That keeps the chunk index fast on Apple Silicon while preserving TEI for
Hindsight's API-internal embeddings.

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
npm run index-milvus
npm run retain
```

Or run both derived-store steps together:

```bash
npm run bootstrap
```

`ingest` writes only the Postgres manifest/outbox. `index-milvus` embeds each
pending span and upserts it into `MILVUS_COLLECTION`, keeping the source
path, line range, hash, and parser recipe in every row. `retain` sends one
coherent document per source file to Hindsight with `update_mode=replace`.

When changing Milvus embedding model or collection, use:

```bash
npm run reindex-milvus
```

## Scheduler

Live OpenClaw recall depends on Postgres + Milvus, so the fast refresh runs
often:

```bash
/Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-memory-stack-refresh.sh fast
```

The fast mode runs `npm run index-milvus`, which applies the Postgres manifest
and indexes only pending Milvus spans. The ingest path scans and hashes source
files every time, but unchanged files only refresh `memory_sources.last_seen_at`;
they do not rewrite spans or enqueue Milvus/Hindsight work.

Hindsight is slower and not in the live recall path, so it runs hourly:

```bash
/Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-memory-stack-refresh.sh hindsight
```

On Brett's Mac these are installed as user LaunchAgents because `crontab <file>`
hung during setup and prior cron reliability has been spotty:

- `~/Library/LaunchAgents/com.openclaw.memory-stack-fast.plist` runs every 300 seconds.
- `~/Library/LaunchAgents/com.openclaw.memory-stack-hindsight.plist` runs hourly at minute 22.

Tracked copies live in `memory-stack/launchagents/` for GitHub/reference. After
changing scheduler behavior, update both the installed LaunchAgent and the
tracked copy.

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
- Milvus collection: `openclaw_chunks_nomic_v1`
- Chunk recipe: `file-span-v1/plain-v1/nomic-embed-text`

## Docling

Docling is intentionally not in the core path. Most canonical OpenClaw memory is
Markdown, JSON, JSONL, logs, code, and plain text, so deterministic file parsers
are simpler and easier to audit. Add Docling later as an optional parser for PDFs
or Office documents.
