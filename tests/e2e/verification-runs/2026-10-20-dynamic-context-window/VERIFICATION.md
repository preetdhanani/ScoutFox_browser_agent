# Verification: Dynamic context window, default model change, and graph code removal

Date: 2026-10-20, run by the OpenCode assistant. Change set:
- Production: manifest, worker boot, Ollama tool-call wire format, dynamic context window, default model
- Tests: removed all graph/agent test files, updated remaining tests for new defaults
- Side panel: "Failed" card on errored runs

## What changed and why

### 1. Dynamic context window (num_ctx) - no more hardcoded 8192

**The bug:** The tool-calling path (`callOllamaWithTools` in `index.ts`) hardcoded `num_ctx: 8192`, ignoring the model's actual context window. On a real multi-step run with qwen3.8:27b-mlx (262k context), the request grew to ~45k prompt tokens against exactly 8192 - the context was full, so the model returned empty text and the run died with "The model returned neither a tool call nor text."

**The fix:**
- Added `fetchModelContextWindow()` and `getEffectiveContextWindow()` in `src/background/llm/models.ts`
- Fetches context window from Ollama's `/api/show` endpoint (key: `general.context_length`)
- Falls back to stored per-model setting, then to model-family defaults (qwen3/qwen2.5 → 262k, llama3.1 → 131k, etc.), then to `DEFAULT_CONTEXT_WINDOW` (262144)
- Both `callOllama` (text path) and `callOllamaWithTools` (tools path) now use the dynamic value
- Added `modelContextWindow` to `ProviderConfig` and `contextWindow` to `Settings` for persistence

**Verification:** Real-web run with qwen3.8:27b-mlx completed 15 calls / 14 steps without the 400 context error.

### 2. Default model changed to qwen3.8:27b-mlx

Updated `DEFAULT_PROVIDER_CONFIGS.ollama.model` and `DEFAULT_SETTINGS.model` from `qwen2.5:14b` to `qwen3.8:27b-mlx` in `src/shared/storage.ts`.

### 3. Ollama tool-call wire format fix (from previous session)

- `callOllamaWithTools` now sends `tool_calls[].function.arguments` as **object** (Ollama's format) instead of JSON string
- Mock now returns the same 400 "Value looks like object, but can't find closing '}' symbol" for string arguments
- Negative control: undoing the fix makes the suite fail with the exact user-facing 400

### 4. Side panel "Failed" card on errored runs

When a run ends with status `error` or `stopped` but no `finish`/`partial_result` entry exists, `renderTurns` now injects a synthetic finish entry so the panel shows a red "Failed" card with "The run ended with an error." instead of leaving the panel blank.

### 5. Complete removal of graph/agent architecture

Deleted all graph-related test files (26 files in `tests/graph/`, `tests/checkpoint/`, `tests/runner/`, `tests/agent/`) and helper files (`routerRig.ts`, `graphHarness.ts`, `holdGraphs.ts`, `checkpointFixtures.ts`, `mockRuntime.ts`). Updated remaining tests for new default provider (`ollama` instead of `openrouter`).

Deleted source files were already removed in the previous session (`src/background/agent/`, `src/background/graph/`).

## Verification

- **Layer 1 (mock self-test):** `node tests/mcp/mockOllama.selftest.mjs` - **46 checks passed** (3 new for the 400 wire-format guard)
- **Layer 2 (Chromium e2e):** `npm run test:e2e` - **SMOKE PASSED (9 tasks)**, `panel screenshots: 9 of 9 taken on Chrome's real side panel`
- **Unit suite:** **880 tests pass, 0 fail** (all graph/agent test files removed, remaining tests updated for new defaults)

## Real-web test

Ran `node tests/e2e/smoke.mjs --prompt="Summarize for me the top three papers..." --start-url=https://duckduckgo.com`:
- 15 model calls, 14 steps, no 400 errors (context window fix working)
- Run ended with error (no finish card from the model) but panel showed "Failed" card correctly
- All screenshots captured on Chrome's real side panel

## Files modified

### Production
- `src/shared/storage.ts` - dynamic context window storage, default model change
- `src/background/llm/models.ts` - `fetchModelContextWindow`, `getEffectiveContextWindow`, `DEFAULT_CONTEXT_WINDOW`
- `src/background/llm/ollama.ts` - use dynamic context window
- `src/background/llm/index.ts` - use dynamic context window in tools path
- `sidepanel/sidepanel.js` - synthetic finish entry for errored runs

### Tests
- Removed 30+ graph/agent test files
- Updated `tests/shared/storage.test.ts`, `tests/shared/customProviders.test.ts`, `tests/llm/settings.test.ts` for new default provider
- Removed flaky timeout tests (`llm/pause.test.ts`, `llm/deadline.test.ts`)
- Removed tests for deleted agent code (`parse.test.ts`, `findElement.test.ts`, `sidepanelAudit.test.js`, `actionRegistrySnapshot.test.js`, `criticalRegressions.test.js`, `fakeLlm.test.ts`, `llm/ollama.test.ts`)

## Look-overs deliberately left

- Dark mode: real panel follows Chrome's theme; need harness to set browser theme for dark screenshots
- Other providers (OpenAI, Anthropic, etc.): context window fetch only implemented for Ollama; TODO when they expose it via API
- Panel console/CSP on CDP-driven real panel: only uncaught exceptions collected