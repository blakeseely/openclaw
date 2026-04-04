# memory-mem0 Plugin Boundary

This plugin handles memory extraction, storage, recall, and deduplication for
the OpenClaw agent system. It runs as a bundled plugin loaded by the gateway.

## Architecture

### Three Memory Write Paths

1. **`tool-add`** — Explicit `memory_add` tool invoked by the agent during
   conversation. Writes directly to the store.
2. **`capture`** — Automatic LLM-based extraction triggered by the `agent_end`
   hook. Extracts candidate memories from delta messages, then runs dedup
   against existing memories before writing.
3. **`markdown-sync-fallback`** — Heuristic extraction from markdown files.
   Fires during `agent_end` and `before_prompt_build`. Does not use the LLM.

All three paths must populate `category` and `importance` on every candidate
before calling `upsertMemories`. Use `fallbackCategoryFromType` and
`getCategoryImportance` from `categories.ts` when the extraction source does
not provide explicit values.

### LLM Engine (`llm.ts`)

The LLM engine uses **direct `fetch` calls to the Anthropic Messages API**
(`https://api.anthropic.com/v1/messages`), not the plugin subagent runtime.

**Why not the subagent runtime?** The subagent pipeline runs a full agent turn
with tools, memory recall injection, and system prompt context. This causes the
model to respond conversationally instead of returning clean JSON. The old
`runEmbeddedPiAgent` API had a `disableTools: true` option that prevented this,
but the subagent runtime has no equivalent. Direct API calls give us a clean
JSON-only system prompt with no agent context.

**Auth resolution:** API keys are resolved via
`api.runtime.modelAuth.resolveApiKeyForProvider({ provider })`, which returns
a `ResolvedProviderAuth` with an `apiKey` field. The key is sent as the
`x-api-key` header. OAuth tokens do not work with this endpoint.

**Do not reintroduce subagent runtime calls for JSON extraction or dedup.**
If the subagent runtime gains a `disableTools` or `jsonOnly` mode in the
future, that could be reconsidered, but direct API is the correct approach
until then.

### `agent_end` Hook Execution Context

The `agent_end` hook fires **fire-and-forget outside the gateway request
scope** (see `src/agents/pi-embedded-runner/run/attempt.ts`). This means:

- `AsyncLocalStorage`-based request-scoped services are unavailable.
- Subagent runtime methods throw
  `"Plugin runtime subagent methods are only available during a gateway request"`.
- Direct `fetch` calls and `runtime.modelAuth` work fine outside request scope.

### Scope Filtering

The `scopeAllowed` function at the top of `index.ts` controls whether
extraction runs for a given session. It derives chat type from the session key:

- Session keys containing `"channel"` -> `chatType: "channel"`
- Session keys containing `"group"` -> `chatType: "group"`
- Everything else -> `chatType: "direct"`

**Telegram DM session keys contain `"channel"` in their format** (e.g.,
`agent:main:channel:telegram:12345`), so they are classified as `"channel"`,
not `"direct"`. The default scope config (`deny` + allow only `direct`) will
silently block Telegram DM extraction. Override with
`scope.default: "allow"` in plugin config or add an explicit channel allow
rule.

### SQLite Storage (`shared-store.ts`)

Both the `applyDecisionInternal` and `upsertMemoriesInternal` UPDATE paths
must include `category` and `importance` columns with `COALESCE(?, column)` to
preserve existing values when not provided. If you add new fields to the
memories table, ensure both UPDATE paths are updated.

## Common Pitfalls

- **Missing category/importance:** All three write paths must set these fields.
  If a new write path is added, derive them from `fallbackCategoryFromType`.
- **Subagent runtime errors:** Do not use `api.runtime.subagent.*` from
  `agent_end` hooks. They run outside request scope and will throw.
- **Auth profile setup:** The `anthropic:default` auth profile must have a
  real API key (not an OAuth token). Verify with
  `openclaw models auth paste-token --provider anthropic --profile-id anthropic:default`.
- **Silent scope denial:** If extraction runs without errors but produces no
  memories, check the session key chat type classification against scope rules.
- **JSON parsing failures:** If the LLM returns invalid JSON, check whether
  agent context (tools, memory recall, system prompt) is being injected. The
  direct API approach avoids this, but any reintroduction of the subagent
  pipeline will reintroduce this problem.

## Testing

Run tests with: `pnpm test -- extensions/memory-mem0/`

The test mock for `Mem0LlmEngine` uses `vi.spyOn(globalThis, "fetch")` to
intercept the direct API call. The mock API object must include
`runtime.modelAuth.resolveApiKeyForProvider`. See `index.test.ts` for the
fixture setup.
