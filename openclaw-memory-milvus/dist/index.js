import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
const { Pool } = pg;
const DEFAULT_ENV_PATH = "/Users/bbeaudoin/clawd/idgemz-openclaw/memory-stack/.env";
const DEFAULT_DATABASE_URL = "postgresql://localhost:55432/openclaw_memory";
const DEFAULT_HINDSIGHT_BASE_URL = "http://localhost:8888";
const DEFAULT_HINDSIGHT_BANK_ID = "openclaw-v1";
const DEFAULT_HINDSIGHT_TIMEOUT_MS = 2500;
const RRF_K = 60;
const DUPLICATE_LINE_WINDOW = 2;
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:[-_/][\p{L}\p{N}]+)*/gu;
const DEFAULT_RANKING_WEIGHTS = {
    vectorRrf: 0.8,
    looseLexicalRrf: 1,
    strictLexicalRrf: 1.6,
    distinctiveTerm: 0.06,
    phrase: 0.03,
    allDistinctiveTerms: 0.015,
    currentSource: 0.015,
    memorySource: 0.01,
    dailyMemorySource: 0.012,
    metaResultPenalty: -0.05,
};
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
        hindsightBaseUrl: (config.hindsightBaseUrl || process.env.HINDSIGHT_BASE_URL || fileEnv.HINDSIGHT_BASE_URL || DEFAULT_HINDSIGHT_BASE_URL).replace(/\/+$/, ""),
        hindsightBankId: config.hindsightBankId || process.env.HINDSIGHT_BANK_ID || fileEnv.HINDSIGHT_BANK_ID || DEFAULT_HINDSIGHT_BANK_ID,
        hindsightApiKey: process.env.HINDSIGHT_API_KEY || fileEnv.HINDSIGHT_API_KEY || "",
        hindsightTimeoutMs: Math.max(250, Number(config.hindsightTimeoutMs || process.env.HINDSIGHT_TIMEOUT_MS || fileEnv.HINDSIGHT_TIMEOUT_MS || DEFAULT_HINDSIGHT_TIMEOUT_MS)),
        rankingWeights: { ...DEFAULT_RANKING_WEIGHTS, ...(config.rankingWeights ?? {}) },
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
    return tokenizeText(text).join(" ");
}
function tokenizeText(text) {
    return [...text.toLocaleLowerCase().matchAll(TOKEN_PATTERN)].map((match) => match[0]);
}
export function tokenizeQuery(query) {
    return [...new Set(tokenizeText(query))]
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
async function fetchPostgresSpansByIds(settings, candidates) {
    const byId = new Map();
    for (const candidate of candidates) {
        const existing = byId.get(candidate.id);
        if (!existing || candidate.score > existing.score)
            byId.set(candidate.id, candidate);
    }
    const ids = [...byId.keys()].filter(Boolean);
    if (ids.length === 0)
        return [];
    const pool = new Pool({ connectionString: settings.databaseUrl });
    try {
        const response = await pool.query(`SELECT
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
       ORDER BY array_position($1::text[], sp.id) ASC`, [ids]);
        return response.rows.map((row) => {
            const id = String(row.id);
            const candidate = byId.get(id);
            const score = (candidate?.score ?? 0) + evidenceOverlapBoost(String(row.text ?? ""), candidate?.evidenceText ?? "");
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
        }).sort((a, b) => b.score - a.score || ids.indexOf(a.id) - ids.indexOf(b.id));
    }
    finally {
        await pool.end();
    }
}
function extractSpanIdsFromText(text) {
    if (!text)
        return [];
    SPAN_ID_PATTERN.lastIndex = 0;
    return [...text.matchAll(SPAN_ID_PATTERN)].map((match) => String(match[1] ?? ""));
}
function validSpanId(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim().toLowerCase();
    return /^[a-f0-9]{40}$/.test(normalized) ? normalized : undefined;
}
function extractSpanIdsFromMetadata(metadata) {
    const ids = [];
    for (const [key, value] of Object.entries(metadata ?? {})) {
        if (typeof value === "string") {
            ids.push(...extractSpanIdsFromText(value));
            if (/span.*ids.*json/i.test(key)) {
                try {
                    const parsed = JSON.parse(value);
                    if (Array.isArray(parsed))
                        ids.push(...parsed.map(validSpanId).filter((id) => Boolean(id)));
                }
                catch {
                    // Metadata from older Hindsight rows may be arbitrary strings.
                }
            }
        }
        else if (Array.isArray(value) && /span.*ids?/i.test(key)) {
            ids.push(...value.map(validSpanId).filter((id) => Boolean(id)));
        }
    }
    return ids;
}
function evidenceOverlapBoost(spanText, evidenceText) {
    const terms = distinctiveTerms(evidenceText);
    if (terms.length === 0)
        return 0;
    const haystack = new Set(tokenizeText(spanText));
    const matched = terms.filter((term) => haystack.has(term)).length;
    return Math.min(0.5, (matched / terms.length) * 0.5);
}
function extractSpanCandidatesFromHindsightResponse(payload) {
    const candidates = new Map();
    const data = payload;
    const addCandidate = (id, score, evidenceText) => {
        const existing = candidates.get(id);
        if (!existing || score > existing.score) {
            candidates.set(id, { id, score, evidenceText });
        }
    };
    const addIds = (ids, score, evidenceText) => {
        for (const id of ids.map(validSpanId).filter((value) => Boolean(value))) {
            addCandidate(id, score, evidenceText);
        }
    };
    const addFromItem = (item, inheritedEvidence = "") => {
        if (!item)
            return;
        const evidenceText = [inheritedEvidence, item.text, item.context].filter(Boolean).join("\n");
        addIds(extractSpanIdsFromText(item.text), 1, evidenceText);
        addIds(extractSpanIdsFromText(item.context), 0.9, evidenceText);
        addIds(extractSpanIdsFromMetadata(item.metadata), 0.7, evidenceText);
        const chunkText = item.chunk_id ? data.chunks?.[item.chunk_id]?.text : undefined;
        addIds(extractSpanIdsFromText(chunkText), 0.45, evidenceText);
    };
    for (const result of data.results ?? []) {
        const evidenceText = [result.text, result.context].filter(Boolean).join("\n");
        addFromItem(result, evidenceText);
        for (const sourceFactId of result.source_fact_ids ?? []) {
            addFromItem(data.source_facts?.[sourceFactId], evidenceText);
        }
    }
    return [...candidates.values()].sort((a, b) => b.score - a.score);
}
export function extractSpanIdsFromHindsightResponse(payload) {
    return extractSpanCandidatesFromHindsightResponse(payload).map((candidate) => candidate.id);
}
async function searchHindsightSpanIds(settings, query, limit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.hindsightTimeoutMs);
    try {
        const headers = { "content-type": "application/json" };
        if (settings.hindsightApiKey)
            headers.authorization = `Bearer ${settings.hindsightApiKey}`;
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
        if (!response.ok)
            return { candidates: [], unavailable: `HTTP ${response.status}` };
        const payload = await response.json();
        return { candidates: extractSpanCandidatesFromHindsightResponse(payload).slice(0, limit) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { candidates: [], unavailable: message };
    }
    finally {
        clearTimeout(timeout);
    }
}
function reciprocalRank(rank, weight) {
    return weight / (RRF_K + rank);
}
function sourceQualityBoost(hit, weights) {
    if (hit.relPath === "CURRENT.md")
        return weights.currentSource;
    if (hit.relPath === "MEMORY.md")
        return weights.memorySource;
    if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(hit.relPath))
        return weights.dailyMemorySource;
    return 0;
}
function metaResultPenalty(query, hit, weights) {
    const normalizedQuery = normalizeSearchText(query);
    if (/\b(benchmark|test|query|ranking|ranker|evaluation|eval)\b/.test(normalizedQuery))
        return 0;
    const normalizedHit = normalizeSearchText(hit.text);
    return /\b(benchmark|query set|missed the|tuning target|hit@|mrr)\b/.test(normalizedHit) ? weights.metaResultPenalty : 0;
}
function phraseMatches(tokens, phrase) {
    const phraseTokens = phrase.split(" ");
    if (phraseTokens.length === 0 || tokens.length < phraseTokens.length)
        return false;
    for (let index = 0; index <= tokens.length - phraseTokens.length; index += 1) {
        if (phraseTokens.every((token, offset) => tokens[index + offset] === token))
            return true;
    }
    return false;
}
function lexicalBoost(hit, terms, phrases, weights) {
    const haystackTokens = tokenizeText(`${hit.relPath} ${hit.text}`);
    const haystack = new Set(haystackTokens);
    const matchedTerms = terms.filter((term) => haystack.has(term)).length;
    const coverage = terms.length > 0 ? matchedTerms / terms.length : 0;
    const matchedPhrases = phrases.filter((phrase) => phraseMatches(haystackTokens, phrase)).length;
    const phraseCoverage = phrases.length > 0 ? matchedPhrases / phrases.length : 0;
    const allDistinctiveTermsMatched = terms.length > 0 && matchedTerms === terms.length;
    return (coverage * weights.distinctiveTerm)
        + (phraseCoverage * weights.phrase)
        + (allDistinctiveTermsMatched ? weights.allDistinctiveTerms : 0);
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
export function mergeHits(vectorHits, looseTextHits, strictTextHits, query, limit, weights = DEFAULT_RANKING_WEIGHTS) {
    const byId = new Map();
    const maxVector = Math.max(1, ...vectorHits.map((hit) => hit.vectorScore));
    const maxText = Math.max(1, ...looseTextHits.map((hit) => hit.textScore), ...strictTextHits.map((hit) => hit.textScore));
    const rrfScores = new Map();
    const terms = distinctiveTerms(query);
    const phrases = queryPhrases(query);
    const addHit = (hit, rank, weight, normalizedScores, rankField) => {
        const existing = byId.get(hit.id);
        if (existing) {
            existing.vectorScore = Math.max(existing.vectorScore, normalizedScores.vectorScore ?? 0);
            existing.textScore = Math.max(existing.textScore, normalizedScores.textScore ?? 0);
            existing[rankField] = Math.min(existing[rankField] ?? rank, rank);
            if ((existing.vectorRank || rankField === "vectorRank") && (existing.looseLexicalRank || existing.strictLexicalRank || rankField !== "vectorRank")) {
                existing.backend = "hybrid";
            }
        }
        else {
            byId.set(hit.id, { ...hit, ...normalizedScores, [rankField]: rank });
        }
        rrfScores.set(hit.id, (rrfScores.get(hit.id) ?? 0) + reciprocalRank(rank, weight));
    };
    for (const [index, hit] of vectorHits.entries()) {
        addHit(hit, index + 1, weights.vectorRrf, { vectorScore: hit.vectorScore / maxVector, textScore: 0 }, "vectorRank");
    }
    for (const [index, hit] of looseTextHits.entries()) {
        addHit(hit, index + 1, weights.looseLexicalRrf, { vectorScore: 0, textScore: hit.textScore / maxText }, "looseLexicalRank");
    }
    for (const [index, hit] of strictTextHits.entries()) {
        addHit(hit, index + 1, weights.strictLexicalRrf, { vectorScore: 0, textScore: hit.textScore / maxText }, "strictLexicalRank");
    }
    const ranked = [...byId.values()]
        .map((hit) => {
        const rrfScore = rrfScores.get(hit.id) ?? 0;
        const lexicalFeatureScore = lexicalBoost(hit, terms, phrases, weights);
        const sourceQualityScore = sourceQualityBoost(hit, weights);
        const metaPenaltyScore = metaResultPenalty(query, hit, weights);
        return {
            ...hit,
            rrfScore,
            lexicalFeatureScore,
            sourceQualityScore,
            metaPenaltyScore,
            score: rrfScore + lexicalFeatureScore + sourceQualityScore + metaPenaltyScore,
        };
    })
        .sort((a, b) => b.score - a.score
        || b.textScore - a.textScore
        || b.vectorScore - a.vectorScore
        || a.relPath.localeCompare(b.relPath)
        || a.startLine - b.startLine);
    return collapseNearbyDuplicates(ranked, limit);
}
function formatRecall(query, hits, settings, hindsightStatus, usedHindsightSpans) {
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
            diagnostics: {
                vectorRank: hit.vectorRank,
                looseLexicalRank: hit.looseLexicalRank,
                strictLexicalRank: hit.strictLexicalRank,
                rrfScore: hit.rrfScore,
                lexicalFeatureScore: hit.lexicalFeatureScore,
                sourceQualityScore: hit.sourceQualityScore,
                metaPenaltyScore: hit.metaPenaltyScore,
            },
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
        rankingWeights: Type.Optional(Type.Object({
            vectorRrf: Type.Optional(Type.Number()),
            looseLexicalRrf: Type.Optional(Type.Number()),
            strictLexicalRrf: Type.Optional(Type.Number()),
            distinctiveTerm: Type.Optional(Type.Number()),
            phrase: Type.Optional(Type.Number()),
            allDistinctiveTerms: Type.Optional(Type.Number()),
            currentSource: Type.Optional(Type.Number()),
            memorySource: Type.Optional(Type.Number()),
            dailyMemorySource: Type.Optional(Type.Number()),
            metaResultPenalty: Type.Optional(Type.Number()),
        })),
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
                    diagnostics: Type.Optional(Type.Object({
                        vectorRank: Type.Optional(Type.Number()),
                        looseLexicalRank: Type.Optional(Type.Number()),
                        strictLexicalRank: Type.Optional(Type.Number()),
                        rrfScore: Type.Optional(Type.Number()),
                        lexicalFeatureScore: Type.Optional(Type.Number()),
                        sourceQualityScore: Type.Optional(Type.Number()),
                        metaPenaltyScore: Type.Optional(Type.Number()),
                    })),
                    snippet: Type.String(),
                    citation: Type.String(),
                })),
            }),
            execute: async ({ query, limit }, config = {}) => {
                const settings = resolveSettings(config);
                const requestedLimit = Math.max(1, Math.min(20, Number(limit ?? 8)));
                const candidateLimit = Math.max(requestedLimit * 6, 30);
                const [hindsightResult, looseTextHits, strictTextHits] = await Promise.all([
                    searchHindsightSpanIds(settings, query, candidateLimit),
                    searchPostgres(settings, query, candidateLimit, "loose"),
                    searchPostgres(settings, query, candidateLimit, "strict"),
                ]);
                const hindsightHits = await fetchPostgresSpansByIds(settings, hindsightResult.candidates).catch(() => []);
                const hindsightStatus = hindsightResult.unavailable
                    ? `unavailable (${hindsightResult.unavailable})`
                    : `ok (${hindsightHits.length} span${hindsightHits.length === 1 ? "" : "s"})`;
                return formatRecall(query, mergeHits(hindsightHits, looseTextHits, strictTextHits, query, requestedLimit, settings.rankingWeights), settings, hindsightStatus, hindsightHits.length > 0);
            },
        }),
    ],
});
