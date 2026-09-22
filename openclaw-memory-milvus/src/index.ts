import fs from "node:fs";
import path from "node:path";

import pg from "pg";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

const { Pool } = pg;

type PluginConfig = {
  envPath?: string;
  databaseUrl?: string;
  hindsightBaseUrl?: string;
  hindsightBankId?: string;
  hindsightTimeoutMs?: number;
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
  backend: "postgres" | "hindsight" | "hybrid";
};

type TextSearchMode = "loose" | "strict";

const DEFAULT_ENV_PATH = "/Users/bbeaudoin/clawd/idgemz-openclaw/memory-stack/.env";
const DEFAULT_DATABASE_URL = "postgresql://localhost:55432/openclaw_memory";
const DEFAULT_HINDSIGHT_BASE_URL = "http://localhost:8888";
const DEFAULT_HINDSIGHT_BANK_ID = "openclaw-v1";
const DEFAULT_HINDSIGHT_TIMEOUT_MS = 2500;
const RRF_K = 60;
const DUPLICATE_LINE_WINDOW = 2;
const SPAN_ID_PATTERN = /\b(?:Postgres\s+span\s+(?:UUID|ID)|memory_span(?:\.id)?|span_id)\s*:\s*([a-f0-9]{40})\b/gi;
const QUERY_STOP_TERMS = new Set([
  "a", "an", "are", "as", "at", "be", "by", "do", "does", "for", "from", "had", "has", "have", "how", "in",
  "into", "is", "it", "no", "not", "of", "on", "or", "that", "the", "this", "to", "use", "used", "uses", "using",
  "was", "were", "what", "when", "where", "with",
]);
const DISTINCTIVE_STOP_TERMS = new Set([
  ...QUERY_STOP_TERMS,
  "active", "agent", "all", "always", "api", "call", "calls", "completed", "current", "data", "file", "fix",
  "key", "local", "memory", "new", "old", "path", "plugin", "query", "recall", "report", "results", "search",
  "source", "stack", "tool", "uses",
]);

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
    hindsightBaseUrl: (config.hindsightBaseUrl || process.env.HINDSIGHT_BASE_URL || fileEnv.HINDSIGHT_BASE_URL || DEFAULT_HINDSIGHT_BASE_URL).replace(/\/+$/, ""),
    hindsightBankId: config.hindsightBankId || process.env.HINDSIGHT_BANK_ID || fileEnv.HINDSIGHT_BANK_ID || DEFAULT_HINDSIGHT_BANK_ID,
    hindsightApiKey: process.env.HINDSIGHT_API_KEY || fileEnv.HINDSIGHT_API_KEY || "",
    hindsightTimeoutMs: Math.max(250, Number(config.hindsightTimeoutMs || process.env.HINDSIGHT_TIMEOUT_MS || fileEnv.HINDSIGHT_TIMEOUT_MS || DEFAULT_HINDSIGHT_TIMEOUT_MS)),
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

function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function tokenizeQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])]
    .map((term) => term.replace(/'/g, ""));
}

function buildLexicalTsQuery(query: string, mode: TextSearchMode): string {
  const terms = tokenizeQuery(query).filter((term) => !QUERY_STOP_TERMS.has(term));
  const operator = mode === "strict" ? " & " : " | ";
  return terms.length > 0 ? terms.map((term) => `${term}:*`).join(operator) : "memory:*";
}

function distinctiveTerms(query: string): string[] {
  return tokenizeQuery(query).filter((term) => !DISTINCTIVE_STOP_TERMS.has(term) && (term.length >= 3 || /\d/.test(term)));
}

function queryPhrases(query: string): string[] {
  const terms = tokenizeQuery(query).filter((term) => !QUERY_STOP_TERMS.has(term));
  const phrases = new Set<string>();
  for (const size of [3, 2]) {
    for (let index = 0; index <= terms.length - size; index += 1) {
      const phrase = terms.slice(index, index + size).join(" ");
      if (phrase.length >= 8) phrases.add(phrase);
    }
  }
  return [...phrases];
}

async function searchPostgres(
  settings: ReturnType<typeof resolveSettings>,
  query: string,
  limit: number,
  mode: TextSearchMode,
): Promise<SearchHit[]> {
  const pool = new Pool({ connectionString: settings.databaseUrl });
  try {
    const lexicalQuery = buildLexicalTsQuery(query, mode);
    const response = await pool.query(
      `WITH q AS (SELECT to_tsquery('simple', $1) AS query)
       SELECT
         sp.id,
         src.rel_path,
         src.abs_path,
         src.source_type,
         sp.span_index,
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

async function fetchPostgresSpansByIds(
  settings: ReturnType<typeof resolveSettings>,
  spanIds: string[],
  hindsightScores: Map<string, number>,
): Promise<SearchHit[]> {
  const ids = [...new Set(spanIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const pool = new Pool({ connectionString: settings.databaseUrl });
  try {
    const response = await pool.query(
      `SELECT
         sp.id,
         src.rel_path,
         src.abs_path,
         src.source_type,
         sp.start_line,
         sp.end_line,
         sp.text
       FROM memory_spans sp
       JOIN memory_sources src ON src.id = sp.source_id
       WHERE sp.id = ANY($1::text[])
       ORDER BY array_position($1::text[], sp.id) ASC`,
      [ids],
    );
    return response.rows.map((row: Record<string, unknown>) => {
      const id = String(row.id);
      const score = hindsightScores.get(id) ?? 0;
      return {
        id,
        relPath: String(row.rel_path ?? ""),
        absPath: String(row.abs_path ?? ""),
        sourceType: String(row.source_type ?? ""),
        startLine: numberValue(row.start_line),
        endLine: numberValue(row.end_line),
        text: String(row.text ?? ""),
        vectorScore: score,
        textScore: 0,
        score,
        backend: "hindsight",
      };
    });
  } finally {
    await pool.end();
  }
}

function extractSpanIdsFromText(text: string | undefined): string[] {
  if (!text) return [];
  SPAN_ID_PATTERN.lastIndex = 0;
  return [...text.matchAll(SPAN_ID_PATTERN)].map((match) => String(match[1] ?? ""));
}

export function extractSpanIdsFromHindsightResponse(payload: unknown): string[] {
  const ids: string[] = [];
  const data = payload as {
    results?: Array<{ text?: string; context?: string; metadata?: Record<string, unknown>; chunk_id?: string | null; source_fact_ids?: string[] | null }>;
    chunks?: Record<string, { text?: string }> | null;
    source_facts?: Record<string, { text?: string; context?: string; metadata?: Record<string, unknown>; chunk_id?: string | null }> | null;
  };
  const addFromItem = (item: { text?: string; context?: string; metadata?: Record<string, unknown>; chunk_id?: string | null } | undefined) => {
    if (!item) return;
    ids.push(...extractSpanIdsFromText(item.text));
    ids.push(...extractSpanIdsFromText(item.context));
    for (const value of Object.values(item.metadata ?? {})) {
      if (typeof value === "string") ids.push(...extractSpanIdsFromText(value));
    }
    const chunkText = item.chunk_id ? data.chunks?.[item.chunk_id]?.text : undefined;
    ids.push(...extractSpanIdsFromText(chunkText));
  };
  for (const result of data.results ?? []) {
    addFromItem(result);
    for (const sourceFactId of result.source_fact_ids ?? []) {
      addFromItem(data.source_facts?.[sourceFactId]);
    }
  }
  return [...new Set(ids)];
}

async function searchHindsightSpanIds(
  settings: ReturnType<typeof resolveSettings>,
  query: string,
  limit: number,
): Promise<{ spanIds: string[]; scores: Map<string, number>; unavailable?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.hindsightTimeoutMs);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (settings.hindsightApiKey) headers.authorization = `Bearer ${settings.hindsightApiKey}`;
    const response = await fetch(`${settings.hindsightBaseUrl}/v1/default/banks/${encodeURIComponent(settings.hindsightBankId)}/memories/recall`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        query,
        types: ["world", "experience"],
        budget: "low",
        max_tokens: 500,
        include: { entities: null, chunks: {} },
        tags: ["workspace:clawd"],
        tags_match: "any_strict",
      }),
    });
    if (!response.ok) return { spanIds: [], scores: new Map(), unavailable: `HTTP ${response.status}` };
    const payload = await response.json();
    const limitedSpanIds = extractSpanIdsFromHindsightResponse(payload).slice(0, limit);
    const scores = new Map<string, number>();
    limitedSpanIds.forEach((id, index) => scores.set(id, Math.max(0.05, 1 - (index * 0.05))));
    return { spanIds: limitedSpanIds, scores };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { spanIds: [], scores: new Map(), unavailable: message };
  } finally {
    clearTimeout(timeout);
  }
}

function reciprocalRank(rank: number, weight: number): number {
  return weight / (RRF_K + rank);
}

function sourceQualityBoost(hit: SearchHit): number {
  if (hit.relPath === "CURRENT.md") return 0.05;
  if (hit.relPath === "MEMORY.md") return 0.03;
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(hit.relPath)) return 0.04;
  return 0;
}

function metaResultPenalty(query: string, hit: SearchHit): number {
  const normalizedQuery = normalizeSearchText(query);
  if (/\b(benchmark|test|query|ranking|ranker|evaluation|eval)\b/.test(normalizedQuery)) return 0;
  const normalizedHit = normalizeSearchText(hit.text);
  return /\b(benchmark|query set|missed the|tuning target|hit@|mrr)\b/.test(normalizedHit) ? -0.25 : 0;
}

function lexicalBoost(hit: SearchHit, terms: string[], phrases: string[]): number {
  const haystack = normalizeSearchText(`${hit.relPath} ${hit.text}`);
  const matchedTerms = terms.filter((term) => haystack.includes(term)).length;
  const coverage = terms.length > 0 ? matchedTerms / terms.length : 0;
  const matchedPhrases = phrases.filter((phrase) => haystack.includes(phrase)).length;
  const phraseCoverage = phrases.length > 0 ? matchedPhrases / phrases.length : 0;
  const allDistinctiveTermsMatched = terms.length > 0 && matchedTerms === terms.length;
  return (coverage * 0.6) + (phraseCoverage * 0.25) + (allDistinctiveTermsMatched ? 0.15 : 0);
}

function collapseNearbyDuplicates(hits: SearchHit[], limit: number): SearchHit[] {
  const kept: SearchHit[] = [];
  for (const hit of hits) {
    const duplicate = kept.some((existing) =>
      existing.relPath === hit.relPath
      && hit.startLine <= existing.endLine + DUPLICATE_LINE_WINDOW
      && hit.endLine >= existing.startLine - DUPLICATE_LINE_WINDOW
    );
    if (!duplicate) kept.push(hit);
    if (kept.length >= limit) break;
  }
  return kept;
}

export function mergeHits(
  vectorHits: SearchHit[],
  looseTextHits: SearchHit[],
  strictTextHits: SearchHit[],
  query: string,
  limit: number,
): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  const maxVector = Math.max(1, ...vectorHits.map((hit) => hit.vectorScore));
  const maxText = Math.max(1, ...looseTextHits.map((hit) => hit.textScore), ...strictTextHits.map((hit) => hit.textScore));
  const rrfScores = new Map<string, number>();
  const terms = distinctiveTerms(query);
  const phrases = queryPhrases(query);

  const addHit = (hit: SearchHit, rank: number, weight: number, normalizedScores: Partial<SearchHit>) => {
    const existing = byId.get(hit.id);
    if (existing) {
      existing.vectorScore = Math.max(existing.vectorScore, normalizedScores.vectorScore ?? 0);
      existing.textScore = Math.max(existing.textScore, normalizedScores.textScore ?? 0);
      existing.backend = "hybrid";
    } else {
      byId.set(hit.id, { ...hit, ...normalizedScores });
    }
    rrfScores.set(hit.id, (rrfScores.get(hit.id) ?? 0) + reciprocalRank(rank, weight));
  };

  for (const [index, hit] of vectorHits.entries()) {
    addHit(hit, index + 1, 0.8, { vectorScore: hit.vectorScore / maxVector, textScore: 0 });
  }
  for (const [index, hit] of looseTextHits.entries()) {
    addHit(hit, index + 1, 1.0, { vectorScore: 0, textScore: hit.textScore / maxText });
  }
  for (const [index, hit] of strictTextHits.entries()) {
    addHit(hit, index + 1, 1.6, { vectorScore: 0, textScore: hit.textScore / maxText });
  }

  const ranked = [...byId.values()]
    .map((hit) => ({
      ...hit,
      score: (rrfScores.get(hit.id) ?? 0)
        + lexicalBoost(hit, terms, phrases)
        + sourceQualityBoost(hit)
        + metaResultPenalty(query, hit),
    }))
    .sort((a, b) =>
      b.score - a.score
      || b.textScore - a.textScore
      || b.vectorScore - a.vectorScore
      || a.relPath.localeCompare(b.relPath)
      || a.startLine - b.startLine
    );
  return collapseNearbyDuplicates(ranked, limit);
}

function formatRecall(
  query: string,
  hits: SearchHit[],
  settings: ReturnType<typeof resolveSettings>,
  hindsightStatus: string,
  usedHindsightSpans: boolean,
) {
  const backend = usedHindsightSpans ? "hindsight+postgres" : "postgres";
  const collection = usedHindsightSpans ? "hindsight-router+postgres-full-text" : "postgres-full-text";
  const summaryPrefix = usedHindsightSpans ? "Hindsight-routed Postgres memory recall" : "Postgres memory recall";
  if (hits.length === 0) {
    return {
      summary: `No Postgres memory hits for: ${query}`,
      backend,
      collection,
      hindsightStatus,
      results: [],
    };
  }
  return {
    summary: [
      `${summaryPrefix} for: ${query}`,
      `Index: ${settings.databaseUrl.replace(/:[^:@/]+@/, ":***@")}`,
      `Hindsight: ${hindsightStatus}`,
      "",
      ...hits.map((hit, index) => [
        `${index + 1}. ${hit.relPath}:${hit.startLine}`,
        `Score: ${hit.score.toFixed(3)} (${hit.backend}; vector=${hit.vectorScore.toFixed(3)}, text=${hit.textScore.toFixed(3)})`,
        compactText(hit.text, 700),
        `Source: ${hit.relPath}#L${hit.startLine}${hit.endLine && hit.endLine !== hit.startLine ? `-L${hit.endLine}` : ""}`,
      ].join("\n")),
    ].join("\n\n"),
    backend,
    collection,
    hindsightStatus,
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
  name: "OpenClaw Memory Postgres",
  description: "Recall canonical OpenClaw memory chunks from the local Postgres memory index.",
  configSchema: Type.Object({
    envPath: Type.Optional(Type.String({ description: "Path to the memory-stack .env file." })),
    databaseUrl: Type.Optional(Type.String({ description: "Postgres manifest database URL." })),
    hindsightBaseUrl: Type.Optional(Type.String({ description: "Hindsight API base URL." })),
    hindsightBankId: Type.Optional(Type.String({ description: "Hindsight bank id." })),
    hindsightTimeoutMs: Type.Optional(Type.Number({ description: "Hindsight recall timeout in milliseconds." })),
  }),
  tools: (tool) => [
    tool({
      name: "memory_recall",
      description: "Search Brett's canonical OpenClaw memory files through the local Postgres full-text index. Returns source-path citations.",
      parameters: Type.Object({
        query: Type.String({ description: "What to recall." }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum recall hits." })),
      }),
      outputSchema: Type.Object({
        summary: Type.String(),
        backend: Type.String(),
        collection: Type.String(),
        hindsightStatus: Type.Optional(Type.String()),
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
        const candidateLimit = Math.max(requestedLimit * 6, 30);
        const [hindsightResult, looseTextHits, strictTextHits] = await Promise.all([
          searchHindsightSpanIds(settings, query, candidateLimit),
          searchPostgres(settings, query, candidateLimit, "loose"),
          searchPostgres(settings, query, candidateLimit, "strict").catch(() => []),
        ]);
        const hindsightHits = await fetchPostgresSpansByIds(settings, hindsightResult.spanIds, hindsightResult.scores).catch(() => []);
        const hindsightStatus = hindsightResult.unavailable
          ? `unavailable (${hindsightResult.unavailable})`
          : `ok (${hindsightHits.length} span${hindsightHits.length === 1 ? "" : "s"})`;
        return formatRecall(
          query,
          mergeHits(hindsightHits, looseTextHits, strictTextHits, query, requestedLimit),
          settings,
          hindsightStatus,
          hindsightHits.length > 0,
        );
      },
    }),
  ],
});
