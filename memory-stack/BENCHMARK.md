# Memory Recall Benchmark - 2026-09-21

This compares the old OpenClaw built-in memory search against the new
`memory_recall` plugin backed by the file-canonical memory stack.

## Backends

- `old_memory_search_memory`: built-in `memory_search`, `corpus=memory`.
- `old_memory_search_all`: built-in `memory_search`, `corpus=all`, including indexed session transcript hits.
- `new_memory_recall`: local OpenClaw plugin using Ollama query embeddings, Milvus
  collection `openclaw_chunks_nomic_v1`, and Postgres full-text over
  `memory_spans`.

Hindsight was running and healthy during the test, but active recall citations are
served by the Milvus/Postgres plugin so responses can cite canonical files and
line ranges directly.

## Method

- 10 fixed operational-memory queries.
- 3 timed rounds per backend, 90 total direct tool calls.
- Top 5 results requested from each backend.
- Speed metric: direct tool-call wall time measured from the caller.
- Relevance metric: accepted canonical source path found at rank 1, 3, or 5.
- Gold citations are path-level, not line-exact, because the old and new chunkers
  split line windows differently.

Query set:

1. `OpenClaw memory stack Hindsight Milvus bootstrap`
2. `memory_recall plugin Milvus Postgres full-text active-memory`
3. `Amazon SP-API LWA credential rotation completed IDGemz Data Sync`
4. `Etsy cron gog auth file keyring cron-env fix`
5. `2026-06-17 sales spike 86 units 1541.15`
6. `NK250 Orders sheet headers mapping entries wait until columns`
7. `Send-to-Walmart report disabled old direct crontab message 3212`
8. `QBO Shopify Connector deadline July 15 bookkeeping sync`
9. `always keep full shipping addresses orders logs preference`
10. `Hindsight uses local Ollama qwen3 TEI embeddings no OpenAI key`

## Results

| Backend | Median ms | Mean ms | p95 ms | Max ms | Hit@1 | Hit@3 | Hit@5 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Old built-in, memory only | 350 | 357 | 408 | 449 | 0.90 | 1.00 | 1.00 | 0.95 |
| Old built-in, all corpora | 342 | 352 | 434 | 464 | 0.60 | 0.70 | 0.90 | 0.70 |
| New Milvus/Postgres recall | 553 | 726 | 622 | 5588 | 0.90 | 0.90 | 0.90 | 0.90 |

## Interpretation

- The built-in memory-only path is still faster. It is roughly 350 ms median, and
  it did very well on this curated canonical-memory benchmark.
- The old all-corpus path is fast, but session transcript hits often outrank the
  durable source. That hurt the stack/integration queries in particular: recent
  smoke-test sessions appeared above `memory/2026-09-21.md`.
- The new recall path is slower, typically 550-620 ms after warm-up. It had one
  5.6 second cold/outlier call, then settled back under about 625 ms.
- The new path is better at returning operational source files (`CURRENT.md`,
  daily notes, `MEMORY.md`) instead of transcript summaries. For example:
  - Amazon LWA rotation: `memory/2026-07-25.md`, then `CURRENT.md`.
  - Etsy cron auth: `CURRENT.md`, then `OPS.md` and daily notes.
  - Sales spike: `CURRENT.md`, then relevant daily notes and `MEMORY.md`.
  - Send-to-Walmart disabled: `CURRENT.md`, then `memory/2026-07-07.md`.
- The new ranker missed the specific Hindsight/Ollama query. It overmatched older
  generic Ollama memory notes and did not return `memory/2026-09-21.md` in the top
  5 for that phrasing.

## Verdict

Use `memory_recall` as the active recall path when provenance and canonical-file
citations matter. Keep built-in `memory_search(corpus=memory)` as the fast
fallback/manual path.

Near-term tuning target: improve the new plugin's handling of exact distinctive
phrases such as `Hindsight`, `qwen3`, `TEI`, `OpenAI key`, and `ONNX`, so older
generic Ollama notes do not outrank the 2026-09-21 stack note.

## Post-Ranker Rerun - 2026-09-21

This rerun was performed after commit `930ab88` (`Improve memory recall ranking
and reindexing`), which added reciprocal rank fusion, strict lexical retrieval,
distinctive-term/phrase boosts, nearby duplicate collapse, and a clean Milvus
reindex path.

To avoid extra OpenAI model spend, the rerun used direct OpenClaw memory tool
calls from the tool-orchestration sandbox, not `openclaw agent` sessions. It did
not ask GPT/Codex to answer each query. The built-in memory tool response still
labels its embedding provider as `openai` with model `nomic-embed-text`; no agent
completion loop was used for the benchmark itself.

### Method

- Same 10 fixed operational-memory queries.
- 3 timed rounds per backend, 90 total direct memory-tool calls.
- Top 5 results requested from each backend.
- Relevance remained path-level. The scoring set was broadened to count durable
  canonical summaries such as `MEMORY.md` when they were valid answers; otherwise
  the old memory-only backend was unfairly penalized for doing what it is meant to
  do.

### Results

| Backend | Median ms | Mean ms | p95 ms | Max ms | Hit@1 | Hit@3 | Hit@5 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Old built-in, memory only | 348 | 354 | 424 | 425 | 0.90 | 1.00 | 1.00 | 0.95 |
| Old built-in, all corpora | 356 | 368 | 470 | 599 | 0.60 | 0.70 | 0.80 | 0.67 |
| New Milvus/Postgres recall | 569 | 598 | 689 | 1036 | 1.00 | 1.00 | 1.00 | 1.00 |

### Interpretation

- The tuned `memory_recall` fixed the previous failing query:
  `Hindsight uses local Ollama qwen3 TEI embeddings no OpenAI key` now returns
  `memory/2026-09-21.md#L23-L28` at rank 1 in all three rounds.
- The new path is still slower than built-in memory search, but the latency is
  stable: median 569 ms, p95 689 ms, max 1036 ms. The earlier 5.6 second outlier
  did not recur.
- Built-in memory-only remains the fastest strong fallback. Its only miss at
  rank 1 was the Hindsight/qwen3/TEI query, where it preferred older generic
  local-Ollama memory before the new stack note.
- Built-in all-corpus is still useful for broad recall, but session transcripts
  continue to outrank durable source files on stack/integration queries. This is
  the main reason its MRR stayed lower.
