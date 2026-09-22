# OpenClaw Memory Postgres

OpenClaw tool plugin that exposes `memory_recall` against the local
Postgres memory index.

Canonical truth remains `/Users/bbeaudoin/clawd`; this plugin only reads the
derived Postgres manifest/search index. It combines loose and strict
Postgres full-text hits, applies the local ranker, and returns compact
source-path citations for Active Memory. The package/plugin id is still
`openclaw-memory-milvus` for installed-config compatibility.

Hindsight is still part of the memory stack and retains the same canonical
chunks, but live recall goes through this plugin so responses can include
deterministic file/line provenance without requiring Milvus or TEI.

## Build

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

Install/reload locally:

```bash
openclaw plugins install /Users/bbeaudoin/clawd/idgemz-openclaw/openclaw-memory-milvus
openclaw plugins enable openclaw-memory-milvus active-memory
openclaw plugins reload openclaw-memory-milvus active-memory
```

Expected OpenClaw config shape:

```json
{
  "plugins": {
    "entries": {
      "openclaw-memory-milvus": {
        "enabled": true,
        "config": {
          "envPath": "/Users/bbeaudoin/clawd/idgemz-openclaw/memory-stack/.env"
        }
      },
      "active-memory": {
        "enabled": true,
        "config": {
          "enabled": true,
          "mode": "always",
          "agents": ["main"],
          "allowedChatTypes": ["direct", "explicit"],
          "toolsAllow": ["memory_recall"]
        }
      }
    }
  }
}
```

Smoke test:

```bash
openclaw agent --agent main \
  --session-key agent:main:memory-postgres-smoke \
  --message 'Call memory_recall with query "OpenClaw memory stack Hindsight bootstrap" and answer with the top citation path only.' \
  --json --timeout 180
```

A good result includes `successfulToolNames: ["memory_recall"]` and a top
citation from `memory/2026-09-21.md`.
