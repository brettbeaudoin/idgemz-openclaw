import fs from "node:fs";
import path from "node:path";

import { MetricType, MilvusClient } from "@zilliz/milvus2-sdk-node";
import pg from "pg";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

const { Pool } = pg;

type PluginConfig = {
  envPath?: string;
  databaseUrl?: string;
  milvusAddress?: string;
  milvusCollection?: string;
  ollamaEmbeddingEndpoint?: string;
  ollamaEmbeddingModel?: string;
  embeddingQueryPrefix?: string;
};

type SearchHit = {
  id: string;
  relPath: string;
  absPath?: string;
  sourceType?: string;
  startLine: number;
  endLine: number;
  text: string;
  vectorScore: number;
  textScore: number;
  score: number;
  backend: "milvus" | "postgres" | "hybrid";
};

const DEFAULT_ENV_PATH = "/Users/bbeaudoin/clawd/idgemz-openclaw/memory-stack/.env";
const DEFAULT_DATABASE_URL = "postgresql://localhost:55432/openclaw_memory";
const DEFAULT_MILVUS_ADDRESS = "localhost:19531";
const DEFAULT_MILVUS_COLLECTION = "openclaw_chunks_nomic_v1";
const DEFAULT_OLLAMA_EMBEDDING_ENDPOINT = "http://localhost:11434/api/embed";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

function parseEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? "";
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1] ?? ""] = value;
  }
  return out;
}

function resolveSettings(config: PluginConfig = {}) {
  const envPath = config.envPath || process.env.OPENCLAW_MEMORY_STACK_ENV || DEFAULT_ENV_PATH;
  const fileEnv = parseEnvFile(envPath);
  return {
    envPath,
    databaseUrl: config.databaseUrl || process.env.MEMORY_DATABASE_URL || fileEnv.MEMORY_DATABASE_URL || DEFAULT_DATABASE_URL,
    milvusAddress: config.milvusAddress || process.env.MILVUS_ADDRESS || fileEnv.MILVUS_ADDRESS || DEFAULT_MILVUS_ADDRESS,
    milvusCollection: config.milvusCollection || process.env.MILVUS_COLLECTION || fileEnv.MILVUS_COLLECTION || DEFAULT_MILVUS_COLLECTION,
    ollamaEmbeddingEndpoint: config.ollamaEmbeddingEndpoint || process.env.OLLAMA_EMBEDDING_ENDPOINT || fileEnv.OLLAMA_EMBEDDING_ENDPOINT || DEFAULT_OLLAMA_EMBEDDING_ENDPOINT,
    ollamaEmbeddingModel: config.ollamaEmbeddingModel || process.env.OLLAMA_EMBEDDING_MODEL || fileEnv.OLLAMA_EMBEDDING_MODEL || DEFAULT_OLLAMA_EMBEDDING_MODEL,
    embeddingQueryPrefix: config.embeddingQueryPrefix ?? process.env.EMBEDDING_QUERY_PREFIX ?? fileEnv.EMBEDDING_QUERY_PREFIX ?? "",
  };
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}...`;
}

function normalizePath(absPath: string | undefined, relPath: string): string {
  if (relPath) return relPath;
  if (!absPath) return "";
  return path.relative("/Users/bbeaudoin/clawd", absPath);
}

function buildLexicalTsQuery(query: string): string {
  const stop = new Set([
    "the", "and", "for", "with", "from", "that", "this", "what", "where", "when", "into", "using", "use",
  ]);
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])]
    .filter((term) => !stop.has(term))
    .map((term) => term.replace(/'/g, ""));
  return terms.length > 0 ? terms.map((term) => `${term}:*`).join(" | ") : "memory:*";
}

async function embedQuery(settings: ReturnType<typeof resolveSettings>, query: string): Promise<number[]> {
  const response = await fetch(settings.ollamaEmbeddingEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: settings.ollamaEmbeddingModel,
      input: [`${settings.embeddingQueryPrefix}${query}`],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embedding request failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
  const payload = await response.json() as { embeddings?: number[][] };
  const vector = payload.embeddings?.[0];
  if (!Array.isArray(vector)) throw new Error("Ollama embedding response did not include a vector");
  return vector;
}

async function searchMilvus(settings: ReturnType<typeof resolveSettings>, query: string, limit: number): Promise<SearchHit[]> {
  const vector = await embedQuery(settings, query);
  const client = new MilvusClient({ address: settings.milvusAddress });
  try {
    await client.connectPromise;
    await client.loadCollectionSync({ collection_name: settings.milvusCollection });
    const response = await client.search({
      collection_name: settings.milvusCollection,
      vector,
      anns_field: "embedding",
      limit,
      metric_type: MetricType.COSINE,
      output_fields: ["id", "rel_path", "abs_path", "source_type", "start_line", "end_line", "text"],
    });
    return (response.results ?? []).map((row: Record<string, unknown>) => {
      const relPath = normalizePath(String(row.abs_path ?? ""), String(row.rel_path ?? ""));
      return {
        id: String(row.id ?? `${relPath}:${row.start_line ?? 0}`),
        relPath,
        absPath: String(row.abs_path ?? ""),
        sourceType: String(row.source_type ?? ""),
        startLine: numberValue(row.start_line),
        endLine: numberValue(row.end_line),
        text: String(row.text ?? ""),
        vectorScore: numberValue(row.score),
        textScore: 0,
        score: numberValue(row.score),
        backend: "milvus",
      };
    });
  } finally {
    await client.closeConnection();
  }
}

async function searchPostgres(settings: ReturnType<typeof resolveSettings>, query: string, limit: number): Promise<SearchHit[]> {
  const pool = new Pool({ connectionString: settings.databaseUrl });
  try {
    const lexicalQuery = buildLexicalTsQuery(query);
    const response = await pool.query(
      `WITH q AS (SELECT to_tsquery('simple', $1) AS query)
       SELECT
         sp.id,
         src.rel_path,
         src.abs_path,
         src.source_type,
         sp.start_line,
         sp.end_line,
         sp.text,
         ts_rank_cd(to_tsvector('simple', sp.text), q.query) AS text_score
       FROM memory_spans sp
       JOIN memory_sources src ON src.id = sp.source_id
       CROSS JOIN q
       WHERE q.query @@ to_tsvector('simple', sp.text)
       ORDER BY text_score DESC, src.rel_path ASC, sp.start_line ASC
       LIMIT $2`,
      [lexicalQuery, limit],
    );
    return response.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      relPath: String(row.rel_path ?? ""),
      absPath: String(row.abs_path ?? ""),
      sourceType: String(row.source_type ?? ""),
      startLine: numberValue(row.start_line),
      endLine: numberValue(row.end_line),
      text: String(row.text ?? ""),
      vectorScore: 0,
      textScore: numberValue(row.text_score),
      score: numberValue(row.text_score),
      backend: "postgres",
    }));
  } finally {
    await pool.end();
  }
}

function mergeHits(vectorHits: SearchHit[], textHits: SearchHit[], limit: number): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  const maxVector = Math.max(1, ...vectorHits.map((hit) => hit.vectorScore));
  const maxText = Math.max(1, ...textHits.map((hit) => hit.textScore));
  for (const hit of vectorHits) byId.set(hit.id, { ...hit, vectorScore: hit.vectorScore / maxVector });
  for (const hit of textHits) {
    const existing = byId.get(hit.id);
    if (existing) {
      existing.textScore = hit.textScore / maxText;
      existing.backend = "hybrid";
    } else {
      byId.set(hit.id, { ...hit, textScore: hit.textScore / maxText });
    }
  }
  return [...byId.values()]
    .map((hit) => ({
      ...hit,
      score: hit.textScore > 0
        ? Math.max(hit.vectorScore, 0) * 0.25 + Math.max(hit.textScore, 0) * 0.75
        : Math.max(hit.vectorScore, 0) * 0.25,
    }))
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath) || a.startLine - b.startLine)
    .slice(0, limit);
}

function formatRecall(query: string, hits: SearchHit[], settings: ReturnType<typeof resolveSettings>) {
  if (hits.length === 0) {
    return {
      summary: `No Milvus/Postgres memory hits for: ${query}`,
      backend: "milvus-postgres",
      collection: settings.milvusCollection,
      results: [],
    };
  }
  return {
    summary: [
      `Milvus/Postgres memory recall for: ${query}`,
      `Collection: ${settings.milvusCollection}`,
      "",
      ...hits.map((hit, index) => [
        `${index + 1}. ${hit.relPath}:${hit.startLine}`,
        `Score: ${hit.score.toFixed(3)} (${hit.backend}; vector=${hit.vectorScore.toFixed(3)}, text=${hit.textScore.toFixed(3)})`,
        compactText(hit.text, 700),
        `Source: ${hit.relPath}#L${hit.startLine}${hit.endLine && hit.endLine !== hit.startLine ? `-L${hit.endLine}` : ""}`,
      ].join("\n")),
    ].join("\n\n"),
    backend: "milvus-postgres",
    collection: settings.milvusCollection,
    results: hits.map((hit) => ({
      path: hit.relPath,
      startLine: hit.startLine,
      endLine: hit.endLine,
      score: hit.score,
      vectorScore: hit.vectorScore,
      textScore: hit.textScore,
      backend: hit.backend,
      snippet: compactText(hit.text, 1000),
      citation: `${hit.relPath}#L${hit.startLine}${hit.endLine && hit.endLine !== hit.startLine ? `-L${hit.endLine}` : ""}`,
    })),
  };
}

export default defineToolPlugin({
  id: "openclaw-memory-milvus",
  name: "OpenClaw Memory Milvus",
  description: "Recall canonical OpenClaw memory chunks from the local Postgres + Milvus memory stack.",
  configSchema: Type.Object({
    envPath: Type.Optional(Type.String({ description: "Path to the memory-stack .env file." })),
    databaseUrl: Type.Optional(Type.String({ description: "Postgres manifest database URL." })),
    milvusAddress: Type.Optional(Type.String({ description: "Milvus host:port." })),
    milvusCollection: Type.Optional(Type.String({ description: "Milvus collection name." })),
    ollamaEmbeddingEndpoint: Type.Optional(Type.String({ description: "Ollama /api/embed endpoint." })),
    ollamaEmbeddingModel: Type.Optional(Type.String({ description: "Ollama embedding model." })),
    embeddingQueryPrefix: Type.Optional(Type.String({ description: "Optional prefix prepended to embedding queries." })),
  }),
  tools: (tool) => [
    tool({
      name: "memory_recall",
      description: "Search Brett's canonical OpenClaw memory stack using Milvus vectors plus Postgres full-text fallback. Returns source-path citations.",
      parameters: Type.Object({
        query: Type.String({ description: "What to recall." }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum recall hits." })),
      }),
      outputSchema: Type.Object({
        summary: Type.String(),
        backend: Type.String(),
        collection: Type.String(),
        results: Type.Array(Type.Object({
          path: Type.String(),
          startLine: Type.Number(),
          endLine: Type.Number(),
          score: Type.Number(),
          vectorScore: Type.Number(),
          textScore: Type.Number(),
          backend: Type.String(),
          snippet: Type.String(),
          citation: Type.String(),
        })),
      }),
      execute: async ({ query, limit }, config: PluginConfig = {}) => {
        const settings = resolveSettings(config);
        const requestedLimit = Math.max(1, Math.min(20, Number(limit ?? 8)));
        const [vectorHits, textHits] = await Promise.all([
          searchMilvus(settings, query, Math.max(requestedLimit * 3, 12)),
          searchPostgres(settings, query, Math.max(requestedLimit * 3, 12)),
        ]);
        return formatRecall(query, mergeHits(vectorHits, textHits, requestedLimit), settings);
      },
    }),
  ],
});
