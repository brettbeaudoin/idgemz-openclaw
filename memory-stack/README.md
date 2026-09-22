# OpenClaw Memory Stack

This directory contains the rollback-safe memory stack for Dangerboat/OpenClaw.

Canonical truth remains the source files under `/Users/bbeaudoin/clawd`.
Postgres is the live manifest/search index and audit log. Hindsight is a
derived, rebuildable retention/consolidation sidecar.

## Components

- `memory-postgres`: manifest tables for sources, spans, ingest runs, and outbox.
- `hindsight`: durable derived memory/observations over coherent documents.
- `tei`: embedding service used only by Hindsight.

Hindsight defaults to the local Ollama server via `host.docker.internal` so the
stack can boot without committing or storing an OpenAI key. Set
`HINDSIGHT_API_LLM_PROVIDER=openai` and `HINDSIGHT_API_LLM_API_KEY` only in your
local `.env` if you want hosted extraction.

Live OpenClaw recall asks Hindsight for fuzzy semantic candidates, resolves any
returned Postgres `memory_spans.id` markers back through Postgres, also runs
Postgres full-text search, and applies the local reranker in the `memory_recall`
plugin. Final snippets and citations still come from Postgres/source files. It
does not require Milvus. When Hindsight or its TEI embedding sidecar is
unavailable, recall falls back to Postgres full-text.

Hindsight keeps TEI as its embedding sidecar because the embedded ONNX path was
still killed by the same local memory spike observed during bootstrap. TEI is
used only through Hindsight; the Postgres fallback path does not depend on it.

## First Run

```bash
cd memory-stack
cp .env.example .env
docker compose --env-file .env up -d memory-postgres hindsight-db tei hindsight
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

Or run both derived-store steps together:

```bash
npm run bootstrap
```

`ingest` writes the Postgres manifest/search index and Hindsight outbox.
`retain` sends one coherent document per source file to Hindsight with
`update_mode=replace`. The retained content includes explicit Postgres span ids
before each canonical span so Hindsight can act as a semantic router while
Postgres remains the provenance source. Async retain acceptance marks outbox
rows `queued`; queued rows older than 12 hours are retried on the next retain
run.

## Scheduler

Live OpenClaw recall depends on Postgres, so the fast refresh runs often:

```bash
/Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-memory-stack-refresh.sh fast
```

The fast mode runs `npm run ingest`, which scans and hashes source files every
time. Unchanged files only refresh `memory_sources.last_seen_at`; they do not
rewrite spans or enqueue Hindsight work.

Hindsight is slower than Postgres and has a hard Postgres fallback, so it runs
hourly:

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

Rollback never depends on Hindsight or Postgres because source files remain
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
- Chunk recipe: `file-span-v1/plain-v1/postgres-full-text`

## Docling

Docling is intentionally not in the core path. Most canonical OpenClaw memory is
Markdown, JSON, JSONL, logs, code, and plain text, so deterministic file parsers
are simpler and easier to audit. Add Docling later as an optional parser for PDFs
or Office documents.
