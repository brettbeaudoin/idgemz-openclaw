import { describe, expect, it } from "vitest";
import entry, { mergeHits } from "./index.js";
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
