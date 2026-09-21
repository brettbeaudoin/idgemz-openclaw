import fs from "node:fs";
import path from "node:path";
import { MetricType, MilvusClient } from "@zilliz/milvus2-sdk-node";
import pg from "pg";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
const { Pool } = pg;
const DEFAULT_ENV_PATH = "/Users/bbeaudoin/clawd/idgemz-openclaw/memory-stack/.env";
const DEFAULT_DATABASE_URL = "postgresql://localhost:55432/openclaw_memory";
const DEFAULT_MILVUS_ADDRESS = "localhost:19531";
const DEFAULT_MILVUS_COLLECTION = "openclaw_chunks_nomic_v1";
const DEFAULT_OLLAMA_EMBEDDING_ENDPOINT = "http://localhost:11434/api/embed";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const RRF_K = 60;
const DUPLICATE_LINE_WINDOW = 2;
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
function parseEnvFile(envPath) {
    if (!fs.existsSync(envPath))
        return {};
    const out = {};
    for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!match)
            continue;
        let value = match[2] ?? "";
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[match[1] ?? ""] = value;
    }
    return out;
}
function resolveSettings(config = {}) {
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
function numberValue(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function compactText(text, maxChars) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars)
        return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}...`;
}
function normalizePath(absPath, relPath) {
    if (relPath)
        return relPath;
    if (!absPath)
        return "";
    return path.relative("/Users/bbeaudoin/clawd", absPath);
}
function normalizeSearchText(text) {
    return text.toLowerCase().replace(/[^a-z0-9_-]+/g, " ").replace(/\s+/g, " ").trim();
}
export function tokenizeQuery(query) {
    return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])]
        .map((term) => term.replace(/'/g, ""));
}
function buildLexicalTsQuery(query, mode) {
    const terms = tokenizeQuery(query).filter((term) => !QUERY_STOP_TERMS.has(term));
    const operator = mode === "strict" ? " & " : " | ";
    return terms.length > 0 ? terms.map((term) => `${term}:*`).join(operator) : "memory:*";
}
function distinctiveTerms(query) {
    return tokenizeQuery(query).filter((term) => !DISTINCTIVE_STOP_TERMS.has(term) && (term.length >= 3 || /\d/.test(term)));
}
function queryPhrases(query) {
    const terms = tokenizeQuery(query).filter((term) => !QUERY_STOP_TERMS.has(term));
    const phrases = new Set();
    for (const size of [3, 2]) {
        for (let index = 0; index <= terms.length - size; index += 1) {
            const phrase = terms.slice(index, index + size).join(" ");
            if (phrase.length >= 8)
                phrases.add(phrase);
        }
    }
    return [...phrases];
}
async function embedQuery(settings, query) {
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
    const payload = await response.json();
    const vector = payload.embeddings?.[0];
    if (!Array.isArray(vector))
        throw new Error("Ollama embedding response did not include a vector");
    return vector;
}
async function searchMilvus(settings, query, limit) {
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
        return (response.results ?? []).map((row) => {
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
    }
    finally {
        await client.closeConnection();
    }
}
async function searchPostgres(settings, query, limit, mode) {
    const pool = new Pool({ connectionString: settings.databaseUrl });
    try {
        const lexicalQuery = buildLexicalTsQuery(query, mode);
        const response = await pool.query(`WITH q AS (SELECT to_tsquery('simple', $1) AS query)
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
       LIMIT $2`, [lexicalQuery, limit]);
        return response.rows.map((row) => ({
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
    }
    finally {
        await pool.end();
    }
}
function reciprocalRank(rank, weight) {
    return weight / (RRF_K + rank);
}
function sourceQualityBoost(hit) {
    if (hit.relPath === "CURRENT.md")
        return 0.05;
    if (hit.relPath === "MEMORY.md")
        return 0.03;
    if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(hit.relPath))
        return 0.04;
    return 0;
}
function metaResultPenalty(query, hit) {
    const normalizedQuery = normalizeSearchText(query);
    if (/\b(benchmark|test|query|ranking|ranker|evaluation|eval)\b/.test(normalizedQuery))
        return 0;
    const normalizedHit = normalizeSearchText(hit.text);
    return /\b(benchmark|query set|missed the|tuning target|hit@|mrr)\b/.test(normalizedHit) ? -0.25 : 0;
}
function lexicalBoost(hit, terms, phrases) {
    const haystack = normalizeSearchText(`${hit.relPath} ${hit.text}`);
    const matchedTerms = terms.filter((term) => haystack.includes(term)).length;
    const coverage = terms.length > 0 ? matchedTerms / terms.length : 0;
    const matchedPhrases = phrases.filter((phrase) => haystack.includes(phrase)).length;
    const phraseCoverage = phrases.length > 0 ? matchedPhrases / phrases.length : 0;
    const allDistinctiveTermsMatched = terms.length > 0 && matchedTerms === terms.length;
    return (coverage * 0.6) + (phraseCoverage * 0.25) + (allDistinctiveTermsMatched ? 0.15 : 0);
}
function collapseNearbyDuplicates(hits, limit) {
    const kept = [];
    for (const hit of hits) {
        const duplicate = kept.some((existing) => existing.relPath === hit.relPath
            && hit.startLine <= existing.endLine + DUPLICATE_LINE_WINDOW
            && hit.endLine >= existing.startLine - DUPLICATE_LINE_WINDOW);
        if (!duplicate)
            kept.push(hit);
        if (kept.length >= limit)
            break;
    }
    return kept;
}
export function mergeHits(vectorHits, looseTextHits, strictTextHits, query, limit) {
    const byId = new Map();
    const maxVector = Math.max(1, ...vectorHits.map((hit) => hit.vectorScore));
    const maxText = Math.max(1, ...looseTextHits.map((hit) => hit.textScore), ...strictTextHits.map((hit) => hit.textScore));
    const rrfScores = new Map();
    const terms = distinctiveTerms(query);
    const phrases = queryPhrases(query);
    const addHit = (hit, rank, weight, normalizedScores) => {
        const existing = byId.get(hit.id);
        if (existing) {
            existing.vectorScore = Math.max(existing.vectorScore, normalizedScores.vectorScore ?? 0);
            existing.textScore = Math.max(existing.textScore, normalizedScores.textScore ?? 0);
            existing.backend = "hybrid";
        }
        else {
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
        .sort((a, b) => b.score - a.score
        || b.textScore - a.textScore
        || b.vectorScore - a.vectorScore
        || a.relPath.localeCompare(b.relPath)
        || a.startLine - b.startLine);
    return collapseNearbyDuplicates(ranked, limit);
}
function formatRecall(query, hits, settings) {
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
            execute: async ({ query, limit }, config = {}) => {
                const settings = resolveSettings(config);
                const requestedLimit = Math.max(1, Math.min(20, Number(limit ?? 8)));
                const candidateLimit = Math.max(requestedLimit * 6, 30);
                const [vectorHits, looseTextHits, strictTextHits] = await Promise.all([
                    searchMilvus(settings, query, candidateLimit),
                    searchPostgres(settings, query, candidateLimit, "loose"),
                    searchPostgres(settings, query, candidateLimit, "strict").catch(() => []),
                ]);
                return formatRecall(query, mergeHits(vectorHits, looseTextHits, strictTextHits, query, requestedLimit), settings);
            },
        }),
    ],
});
