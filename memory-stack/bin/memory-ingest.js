#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env.local'), quiet: true });
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const { Pool } = require('pg');

const PARSER_VERSION = 'file-parser-v1';
const CHUNK_RECIPE = process.env.MEMORY_CHUNK_RECIPE || 'file-span-v1/plain-v1/postgres-full-text';
const HINDSIGHT_RETAIN_FORMAT_VERSION = 'hindsight-source-spans-v2';
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonl', '.log']);
const CODE_EXTENSIONS = new Set(['.js', '.ts', '.py', '.sh', '.sql', '.yaml', '.yml']);
const DEFAULT_CONTEXT_FILES = new Set([
  'AGENTS.md',
  'CONTEXT.md',
  'SOUL.md',
  'USER.md',
  'CURRENT.md',
  'OPS.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md'
]);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'backups',
  'data',
  'logs',
  'tmp',
  '.Spotlight-V100',
  '.Trashes'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableId(kind, ...parts) {
  return sha256([kind, ...parts].join('\0')).slice(0, 40);
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function intEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sourceRoot() {
  return path.resolve(process.env.MEMORY_WORKSPACE_ROOT || '/Users/bbeaudoin/clawd');
}

function sourceType(absPath, relPath) {
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(relPath)) return 'daily-note';
  if (['AGENTS.md', 'CONTEXT.md', 'SOUL.md', 'USER.md', 'CURRENT.md', 'OPS.md', 'TOOLS.md', 'MEMORY.md', 'HEARTBEAT.md'].includes(relPath)) {
    return 'workspace-context';
  }
  if (relPath.includes('/session') || relPath.includes('session')) return 'session-log';
  if (CODE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) return 'code';
  return 'file';
}

function includeFile(absPath, relPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) && !CODE_EXTENSIONS.has(ext)) return false;
  const safeDefault = DEFAULT_CONTEXT_FILES.has(relPath) || /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(relPath);
  const includeProjectDocs = boolEnv('MEMORY_INCLUDE_PROJECT_DOCS');
  if (!safeDefault && !includeProjectDocs) return false;
  if (relPath.startsWith('idgemz-openclaw/node_modules/')) return false;
  if (relPath.includes('/.git/')) return false;
  if (!boolEnv('MEMORY_INCLUDE_SESSION_LOGS') && sourceType(absPath, relPath) === 'session-log') return false;
  if (path.basename(absPath).startsWith('.env')) return false;
  if (/(token|credential|secret|keyring|known_hosts)/i.test(relPath)) return false;
  return true;
}

function walk(dir, root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);
    if (entry.isDirectory()) {
      walk(abs, root, out);
    } else if (entry.isFile() && includeFile(abs, rel)) {
      out.push({ abs, rel });
    }
  }
  return out;
}

function chunkText(text, maxChars, overlapLines) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const chunks = [];
  let start = 0;
  let current = [];
  let currentChars = 0;

  function flush(endLineExclusive) {
    while (current.length && current[0].trim() === '') {
      current.shift();
      start += 1;
    }
    while (current.length && current[current.length - 1].trim() === '') current.pop();
    if (!current.length) return;
    chunks.push({
      startLine: start + 1,
      endLine: endLineExclusive,
      text: current.join('\n')
    });
    const keep = Math.max(0, Math.min(overlapLines, current.length));
    start = endLineExclusive - keep;
    current = keep ? current.slice(-keep) : [];
    currentChars = current.reduce((sum, line) => sum + line.length + 1, 0);
  }

  lines.forEach((line, index) => {
    const headingBreak = /^#{1,3}\s+\S/.test(line) && currentChars > 0;
    if (headingBreak || currentChars + line.length + 1 > maxChars) flush(index);
    if (!current.length) start = index;
    current.push(line);
    currentChars += line.length + 1;
  });
  flush(lines.length);
  return chunks;
}

function scanSources() {
  const root = sourceRoot();
  return walk(root, root)
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map(({ abs, rel }) => {
      const content = fs.readFileSync(abs);
      const text = content.toString('utf8');
      const stat = fs.statSync(abs);
      const contentHash = sha256(content);
      const type = sourceType(abs, rel);
      const sourceId = stableId('source', abs, contentHash);
      const spans = chunkText(text, intEnv('MEMORY_MAX_CHARS', 1800), intEnv('MEMORY_OVERLAP_LINES', 4))
        .map((span, index) => ({
          ...span,
          spanIndex: index,
          id: stableId('span', sourceId, index, sha256(span.text)),
          textSha256: sha256(span.text)
        }));
      return {
        id: sourceId,
        absPath: abs,
        relPath: rel,
        sourceType: type,
        contentSha256: contentHash,
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        spans
      };
    });
}

async function ensureSchema(pool) {
  const schemaPath = path.resolve(__dirname, '..', 'schema.sql');
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
}

async function writeManifest(pool, sources, mode) {
  await ensureSchema(pool);
  const root = sourceRoot();
  let skippedSources = 0;
  let changedSources = 0;
  const run = await pool.query(
    `INSERT INTO memory_ingest_runs (mode, source_root, source_count, span_count)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [mode, root, sources.length, sources.reduce((sum, s) => sum + s.spans.length, 0)]
  );
  const runId = run.rows[0].id;

  for (const source of sources) {
    const existingSource = await pool.query(
      `SELECT id, content_sha256, parser_version
       FROM memory_sources
       WHERE abs_path = $1`,
      [source.absPath]
    );
    const existing = existingSource.rows[0];
    if (existing?.id) {
      source.id = existing.id;
      if (existing.content_sha256 === source.contentSha256 && existing.parser_version === PARSER_VERSION) {
        skippedSources += 1;
        await pool.query(
          `UPDATE memory_sources
           SET rel_path = $2,
               source_type = $3,
               size_bytes = $4,
               mtime_ms = $5,
               metadata = $6,
               last_seen_at = now()
           WHERE id = $1`,
          [
            source.id,
            source.relPath,
            source.sourceType,
            source.sizeBytes,
            source.mtimeMs,
            { privacy: process.env.MEMORY_PRIVACY_TAG || 'personal' }
          ]
        );
        const savedSpans = await pool.query(
          `SELECT id, span_index
           FROM memory_spans
           WHERE source_id = $1`,
          [source.id]
        );
        const savedSpanIds = new Map(savedSpans.rows.map((row) => [row.span_index, row.id]));
        for (const span of source.spans) {
          const savedId = savedSpanIds.get(span.spanIndex);
          if (savedId) span.id = savedId;
        }
        await upsertHindsightOutbox(pool, source);
        continue;
      }
    }
    changedSources += 1;

    await pool.query(
      `INSERT INTO memory_sources (
         id, abs_path, rel_path, source_type, content_sha256, size_bytes,
         mtime_ms, parser_version, metadata, last_seen_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (id) DO UPDATE SET
         abs_path = excluded.abs_path,
         rel_path = excluded.rel_path,
         source_type = excluded.source_type,
         content_sha256 = excluded.content_sha256,
         size_bytes = excluded.size_bytes,
         mtime_ms = excluded.mtime_ms,
         parser_version = excluded.parser_version,
         metadata = excluded.metadata,
         last_seen_at = now()`,
      [
        source.id,
        source.absPath,
        source.relPath,
        source.sourceType,
        source.contentSha256,
        source.sizeBytes,
        source.mtimeMs,
        PARSER_VERSION,
        { privacy: process.env.MEMORY_PRIVACY_TAG || 'personal' }
      ]
    );

    for (const span of source.spans) {
      const savedSpan = await pool.query(
        `INSERT INTO memory_spans (
           id, source_id, span_index, start_line, end_line, text_sha256,
           text, chunk_recipe, metadata, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (source_id, span_index) DO UPDATE SET
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           text_sha256 = excluded.text_sha256,
           text = excluded.text,
           chunk_recipe = excluded.chunk_recipe,
           metadata = excluded.metadata,
           updated_at = now()
         RETURNING id`,
        [
          span.id,
          source.id,
          span.spanIndex,
          span.startLine,
          span.endLine,
          span.textSha256,
          span.text,
          CHUNK_RECIPE,
          {
            abs_path: source.absPath,
            rel_path: source.relPath,
            source_type: source.sourceType
          }
        ]
      );
      span.id = savedSpan.rows[0].id;

    }

    await upsertHindsightOutbox(pool, source);

    await pool.query(
      `DELETE FROM memory_spans
       WHERE source_id = $1
         AND span_index >= $2
       RETURNING id`,
      [source.id, source.spans.length]
    );
  }

  const currentAbsPaths = sources.map((source) => source.absPath);
  const pruneProjectDocs = boolEnv('MEMORY_INCLUDE_PROJECT_DOCS');
  const deletedSources = await pool.query(
    `SELECT id
     FROM memory_sources
     WHERE abs_path <> ALL($1::text[])
       AND ($2::boolean OR source_type IN ('workspace-context', 'daily-note'))`,
    [currentAbsPaths, pruneProjectDocs]
  );
  const deletedSourceIds = deletedSources.rows.map((row) => row.id);
  if (deletedSourceIds.length > 0) {
    await pool.query(
      `DELETE FROM memory_sources
       WHERE id = ANY($1::text[])`,
      [deletedSourceIds]
    );
  }

  await pool.query(
    `UPDATE memory_ingest_runs
     SET finished_at = now()
     WHERE id = $1`,
    [runId]
  );
  return {
    runId,
    skippedSources,
    changedSources,
    deletedSources: deletedSourceIds.length,
    obsoleteOutboxRows: 0
  };
}

function hindsightContentSha(span) {
  return sha256([HINDSIGHT_RETAIN_FORMAT_VERSION, span.id, span.textSha256].join('\0'));
}

function hindsightOutboxId(span) {
  return stableId('outbox', 'hindsight', span.id);
}

async function upsertHindsightOutbox(pool, source) {
  for (const span of source.spans) {
    await pool.query(
      `INSERT INTO memory_outbox (
         id, span_id, document_id, target, content_sha256, status, updated_at
       ) VALUES (
         $1,$2,$3,'hindsight',$4,
         COALESCE((
           SELECT status
           FROM memory_outbox
           WHERE target = 'hindsight'
             AND span_id = $2
             AND content_sha256 = $4
           ORDER BY updated_at DESC
           LIMIT 1
         ), 'pending'),
         now()
       )
       ON CONFLICT (id) DO UPDATE SET
         span_id = excluded.span_id,
         document_id = excluded.document_id,
         content_sha256 = excluded.content_sha256,
         status = CASE
           WHEN memory_outbox.content_sha256 = excluded.content_sha256 THEN memory_outbox.status
           ELSE 'pending'
         END,
         updated_at = CASE
           WHEN memory_outbox.content_sha256 = excluded.content_sha256 THEN memory_outbox.updated_at
           ELSE now()
         END`,
      [
        hindsightOutboxId(span),
        span.id,
        `file:${source.relPath}`,
        hindsightContentSha(span)
      ]
    );
  }

  await pool.query(
    `DELETE FROM memory_outbox
     WHERE target = 'hindsight'
       AND document_id = $1
       AND id <> ALL($2::text[])`,
    [`file:${source.relPath}`, source.spans.map((span) => hindsightOutboxId(span))]
  );
}

function hindsightRetainContent(source) {
  return [
    `Source path: ${source.relPath}`,
    `Source sha256: ${source.contentSha256}`,
    `Source type: ${source.sourceType}`,
    `Hindsight retain format: ${HINDSIGHT_RETAIN_FORMAT_VERSION}`,
    '',
    'Each canonical span below includes its Postgres memory_span id. If a memory fact is extracted from a span, keep that id available for later retrieval and provenance.',
    '',
    ...source.spans.flatMap((span) => [
      `--- BEGIN POSTGRES MEMORY SPAN ${span.spanIndex} ---`,
      `Postgres span UUID: ${span.id}`,
      `Postgres span index: ${span.spanIndex}`,
      `Source lines: ${span.startLine}-${span.endLine}`,
      `Span sha256: ${span.textSha256}`,
      '',
      span.text,
      `--- END POSTGRES MEMORY SPAN ${span.spanIndex} ---`,
      ''
    ])
  ].join('\n');
}

async function retainInHindsight(pool, sources) {
  const baseUrl = (process.env.HINDSIGHT_BASE_URL || 'http://localhost:8888').replace(/\/+$/, '');
  const bankId = process.env.HINDSIGHT_BANK_ID || 'openclaw-v1';
  const headers = { 'content-type': 'application/json' };
  if (process.env.HINDSIGHT_API_KEY) headers.authorization = `Bearer ${process.env.HINDSIGHT_API_KEY}`;

  let retained = 0;
  const pending = await pool.query(
    `SELECT DISTINCT document_id
     FROM memory_outbox
     WHERE target = 'hindsight'
       AND (
         status = 'pending'
         OR (status = 'queued' AND updated_at < now() - interval '12 hours')
       )`
  );
  const pendingDocuments = new Set(pending.rows.map((row) => row.document_id));
  for (const source of sources.filter((source) => pendingDocuments.has(`file:${source.relPath}`))) {
    const payload = {
      items: [{
        content: hindsightRetainContent(source),
        context: 'OpenClaw canonical file memory for Dangerboat assisting Brett. Source path, hash, and Postgres span ids are canonical provenance; verify important claims against the source file.',
        document_id: `file:${source.relPath}`,
        update_mode: 'replace',
        timestamp: 'unset',
        metadata: {
          abs_path: source.absPath,
          rel_path: source.relPath,
          source_type: source.sourceType,
          sha256: source.contentSha256,
          parser_version: PARSER_VERSION,
          retain_format: HINDSIGHT_RETAIN_FORMAT_VERSION,
          span_ids_json: JSON.stringify(source.spans.map((span) => span.id))
        },
        tags: [
          'source:file',
          'workspace:clawd',
          `kind:${source.sourceType}`,
          `privacy:${process.env.MEMORY_PRIVACY_TAG || 'personal'}`
        ],
        observation_scopes: [['workspace:clawd']]
      }],
      async: boolEnv('HINDSIGHT_RETAIN_ASYNC', true)
    };

    const response = await fetch(`${baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const body = await response.text();
      await pool.query(
        `UPDATE memory_outbox
         SET attempts = attempts + 1, last_error = $2, updated_at = now()
         WHERE target = 'hindsight'
           AND document_id = $1`,
        [`file:${source.relPath}`, `HTTP ${response.status} ${body.slice(0, 1000)}`]
      );
      throw new Error(`Hindsight retain failed for ${source.relPath}: HTTP ${response.status} ${body.slice(0, 1000)}`);
    }
    retained += 1;
    await pool.query(
      `UPDATE memory_outbox
       SET status = $2, attempts = attempts + 1, last_error = null, updated_at = now()
       WHERE target = 'hindsight'
         AND document_id = $1
         AND status IN ('pending', 'queued')`,
      [`file:${source.relPath}`, payload.async ? 'queued' : 'sent']
    );
  }
  return retained;
}

function printSummary(sources) {
  const byType = new Map();
  let spans = 0;
  for (const source of sources) {
    spans += source.spans.length;
    byType.set(source.sourceType, (byType.get(source.sourceType) || 0) + 1);
  }
  console.log(JSON.stringify({
    root: sourceRoot(),
    sources: sources.length,
    spans,
    byType: Object.fromEntries([...byType.entries()].sort()),
    sample: sources.slice(0, 10).map((source) => ({
      relPath: source.relPath,
      type: source.sourceType,
      spans: source.spans.length,
      sha256: source.contentSha256
    }))
  }, null, 2));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply');
  const retain = process.argv.includes('--retain-hindsight');
  const sources = scanSources();
  printSummary(sources);
  if (dryRun) return;

  const pool = new Pool({
    connectionString: process.env.MEMORY_DATABASE_URL || 'postgresql://openclaw_memory:openclaw_memory_dev_password@localhost:55432/openclaw_memory'
  });
  try {
    const mode = ['apply', retain && 'retain-hindsight'].filter(Boolean).join('+');
    const manifest = await writeManifest(pool, sources, mode);
    console.log(`Manifest changed ${manifest.changedSources} source(s), skipped ${manifest.skippedSources} unchanged source(s), deleted ${manifest.deletedSources} missing source(s), pruned ${manifest.obsoleteOutboxRows} obsolete outbox row(s).`);
    if (retain) {
      const retained = await retainInHindsight(pool, sources);
      await pool.query(
        `UPDATE memory_ingest_runs SET retained_hindsight_count = $2 WHERE id = $1`,
        [manifest.runId, retained]
      );
      console.log(`Retained ${retained} source documents in Hindsight.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
