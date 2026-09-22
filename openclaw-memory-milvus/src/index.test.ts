import { describe, expect, it } from "vitest";
import entry, { extractSpanIdsFromHindsightResponse, mergeHits } from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("openclaw-memory-milvus", () => {
  it("declares tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual(["memory_recall"]);
  });

  it("boosts distinctive exact terms above generic lexical matches", () => {
    const generic = hit({
      id: "generic",
      relPath: "MEMORY.md",
      startLine: 111,
      endLine: 115,
      text: "No first-class authenticated Notion connector helper at turn start. No OpenAI action needed.",
      textScore: 1,
    });
    const specific = hit({
      id: "specific",
      relPath: "memory/2026-09-21.md",
      startLine: 19,
      endLine: 21,
      text: "Hindsight is containerized and healthy. It uses local Ollama qwen3 for LLM calls and the stack TEI service for embeddings; this avoided the missing OpenAI key and ONNX memory startup failure.",
      textScore: 0.7,
    });

    const ranked = mergeHits(
      [],
      [generic, specific],
      [specific],
      "Hindsight uses local Ollama qwen3 TEI embeddings no OpenAI key",
      2,
    );

    expect(ranked[0]?.id).toBe("specific");
  });

  it("does not treat token substrings as exact distinctive matches", () => {
    const substringOnly = hit({
      id: "substring-only",
      relPath: "memory/2026-09-21.md",
      startLine: 1,
      endLine: 1,
      text: "The catalog mentions scarab design notes and archived shells.",
      textScore: 1,
    });
    const exactToken = hit({
      id: "exact-token",
      relPath: "memory/2026-09-21.md",
      startLine: 10,
      endLine: 10,
      text: "The CAR SKU needs the current product mapping.",
      textScore: 0.9,
    });

    const ranked = mergeHits([], [substringOnly, exactToken], [], "CAR SKU", 2);

    expect(ranked[0]?.id).toBe("exact-token");
    expect(ranked.find((item) => item.id === "substring-only")?.lexicalFeatureScore).toBeLessThan(
      ranked.find((item) => item.id === "exact-token")?.lexicalFeatureScore ?? 0,
    );
  });

  it("matches Unicode and structured ID tokens without ASCII-only substring logic", () => {
    const generic = hit({
      id: "generic",
      relPath: "memory/2026-09-21.md",
      text: "A cafe note references BHT2STE version history.",
      textScore: 1,
    });
    const specific = hit({
      id: "specific",
      relPath: "memory/2026-09-21.md",
      text: "The café order used structured ID BHT2STE-V2 and should keep the exact SKU.",
      textScore: 0.8,
    });

    const ranked = mergeHits([], [generic, specific], [], "café BHT2STE-V2", 2);

    expect(ranked[0]?.id).toBe("specific");
  });

  it("keeps lexical-only provenance as postgres while exposing both lexical ranks", () => {
    const sameHit = hit({
      id: "same",
      relPath: "CURRENT.md",
      text: "Hindsight retain queue has serialized Ollama workers.",
      textScore: 1,
    });

    const [ranked] = mergeHits([], [sameHit], [sameHit], "Hindsight retain queue", 1);

    expect(ranked?.backend).toBe("postgres");
    expect(ranked?.looseLexicalRank).toBe(1);
    expect(ranked?.strictLexicalRank).toBe(1);
    expect(ranked?.vectorRank).toBeUndefined();
    expect(ranked?.rrfScore).toBeGreaterThan(0);
  });

  it("marks provenance hybrid only when vector and lexical arms both find the hit", () => {
    const sameHit = hit({
      id: "same",
      relPath: "CURRENT.md",
      text: "Hindsight retain queue has serialized Ollama workers.",
      vectorScore: 1,
      textScore: 1,
      backend: "hindsight",
    });

    const [ranked] = mergeHits([sameHit], [sameHit], [], "Hindsight retain queue", 1);

    expect(ranked?.backend).toBe("hybrid");
    expect(ranked?.vectorRank).toBe(1);
    expect(ranked?.looseLexicalRank).toBe(1);
  });

  it("collapses nearby duplicate spans from the same source", () => {
    const ranked = mergeHits(
      [],
      [
        hit({ id: "a", relPath: "MEMORY.md", startLine: 111, endLine: 115, textScore: 1 }),
        hit({ id: "b", relPath: "MEMORY.md", startLine: 113, endLine: 117, textScore: 0.9 }),
        hit({ id: "c", relPath: "CURRENT.md", startLine: 20, endLine: 22, textScore: 0.8 }),
      ],
      [],
      "Notion connector helper",
      3,
    );

    expect(ranked.map((item) => item.id).sort()).toEqual(["a", "c"]);
  });

  it("extracts Postgres span ids from Hindsight result chunks", () => {
    const spanId = "1234567890abcdef1234567890abcdef12345678";
    const ids = extractSpanIdsFromHindsightResponse({
      results: [{ id: "fact-1", text: "Remembered fact", chunk_id: "chunk-1" }],
      chunks: {
        "chunk-1": {
          text: [
            "--- BEGIN POSTGRES MEMORY SPAN 2 ---",
            `Postgres span UUID: ${spanId}`,
            "Source lines: 10-12",
            "The actual source text.",
          ].join("\n"),
        },
      },
    });

    expect(ids).toEqual([spanId]);
  });

  it("deduplicates Hindsight span ids across facts and chunks", () => {
    const spanId = "abcdef1234567890abcdef1234567890abcdef12";
    const ids = extractSpanIdsFromHindsightResponse({
      results: [
        { id: "fact-1", text: `memory_span.id: ${spanId}`, chunk_id: "chunk-1" },
        { id: "fact-2", text: "Another fact", chunk_id: "chunk-1" },
      ],
      chunks: {
        "chunk-1": { text: `Postgres span ID: ${spanId}` },
      },
    });

    expect(ids).toEqual([spanId]);
  });

  it("extracts Postgres span ids from Hindsight span_ids_json metadata", () => {
    const first = "1111111111111111111111111111111111111111";
    const second = "2222222222222222222222222222222222222222";
    const ids = extractSpanIdsFromHindsightResponse({
      results: [{
        id: "fact-1",
        text: "User has key priorities including Amazon listing audit",
        metadata: {
          span_ids_json: JSON.stringify([first, second]),
        },
      }],
    });

    expect(ids).toEqual([first, second]);
  });

});

function hit(overrides: Partial<Parameters<typeof mergeHits>[0][number]>): Parameters<typeof mergeHits>[0][number] {
  return {
    id: "",
    relPath: "memory/2026-09-21.md",
    absPath: "",
    sourceType: "daily-note",
    startLine: 1,
    endLine: 1,
    text: "",
    vectorScore: 0,
    textScore: 0,
    score: 0,
    backend: "postgres",
    ...overrides,
  };
}
