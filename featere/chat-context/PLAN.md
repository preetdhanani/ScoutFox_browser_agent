# Chat context: chained requests, a context meter, and Compact

## Why

A chat in the side panel holds several tasks, but each task starts the model with an empty history.
A follow-up like "now do the same for the second page" or "put that in a CSV" has no idea what came before.
The user also cannot see how full the model's context is, and has no way to shrink it.

## Decisions (Prit, 2026-11-05)

- The meter shows the current chat only. Earlier chats do nothing for the current one.
- A new request in the same chat gets the earlier turns of that chat, like a chain.
- Compact summarises the current chat, and later requests in it start from that summary.
- The context window is per model: the provider's own number when it can be learned, else 256K. The user can set it per model.
- The meter is a small ring in the composer. Clicking it opens a card with a bar, the tokens used, the window and a Compact button.

## Phase 1: token usage

- `ToolReply` (`src/background/llm/index.ts`) gains `usage?: { promptTokens: number; outputTokens: number }`.
  It is read from the OpenAI-compatible `usage` (prompt_tokens, completion_tokens), Ollama's `prompt_eval_count` / `eval_count`, and LangChain's `usage_metadata` where a path has it.
- When a provider sends no usage, the client estimates the prompt as characters / 4 of what it sent and marks it estimated.
- The MCP client keeps the prompt tokens of the last model call. `AgentRunner.getState()` gains `context: { used, window, estimated, windowSource, summarizedTurns }`. It persists with the run snapshot.
- `runStats.tokensIn/tokensOut` are filled from the same numbers (they exist and are never set today).

## Phase 2: the context window per model

`getEffectiveContextWindow` returns `{ tokens, source }` with this order:

1. The user's value, `settings.contextWindow["provider|model"]` (source `user`).
2. What the provider says: Ollama `/api/show`, or the OpenAI-compatible `/models` entry of the model (`context_length`, `max_model_len`, `context_window`, `max_context_length`, `top_provider.context_length`). The model list fetch keeps these numbers in a small cache next to the ids (source `provider`).
3. The Ollama family table that exists today (source `estimate`).
4. 256K, `DEFAULT_CONTEXT_WINDOW` (source `default`).

The Ollama `num_ctx` keeps using the same value, so nothing changes for Ollama memory.

Settings tab: a "Context window" field under the model, with the effective number and where it comes from ("from the provider", "default", "set by you").
It takes `200000`, `200K` or `1M`; an empty field removes the user's value.

## Phase 3: the chain

- `src/background/mcp/chatChain.ts` (new, pure) builds the text of the earlier turns from `runner.history`: for each turn its goal, how it ended (done, partly done, failed, stopped), its answer cut to 1,500 characters, and the names of files it handed over.
- With a summary, the chain is the summary plus the turns after it.
- `startTask` puts the chain at the top of the first user message, under `EARLIER IN THIS CHAT (for context; the task below is the current one):`. It is not a new message, so roles still alternate.
- The chain is capped at 25% of the window. If it is longer, the chat is compacted before the task starts (auto-compact), and the timeline says so.

## Phase 4: Compact

- The panel sends `COMPACT_CHAT`. The runner refuses while a task runs.
- `compactChat()` sends one plain model call (`generateCompletion`) with the chain and a fixed instruction: keep the goals, the answers and their facts, the files, the sites used, and anything left open; at most about 400 words.
- The runner stores `chatSummary` and `summarizedTurns` (persisted with the snapshot) and records a `chat_compacted` history row. The timeline shows it as a divider, "Chat compacted", with the summary in a section the reader opens.
- New chat clears the summary with the rest.
- A failed summary call leaves the chat as it was and shows the error as a toast.

## Phase 5: the ring and its card

- A 16 px SVG ring before the effort button. It fills by used / window, turns amber from 70% and red from 90%. `aria-label` says "Context: 12% of 256K used".
- Clicking it opens `#contextMenu`, built like the effort menu:
  - "Context · <model>" and the window ("256K, default"),
  - a bar for "This chat" with "31.2K of 256K" and the percent,
  - "Estimated" when the provider sent no usage,
  - a "Compact chat" button, off while a task runs or when there is no earlier turn,
  - "Set the window in Settings".
- Empty chat: 0%.

## Tests

- Unit:
  - usage parsing per provider shape, the estimate when absent;
  - window order and the `/models` field names, the `K` / `M` parser;
  - the chain text (turn order, outcomes, cut answers, files, summary plus later turns, the 25% cap);
  - compactChat (refused while running, stores the summary, records the row, failure leaves state);
  - the ring and card markup (percent, colours, labels, button states).
  Each new check is confirmed to fail on code without the behaviour.
- Real model (LISA), new task `web-chat-chain` on `credentials.html`:
  - turn 1 asks how many certifications the page lists;
  - the harness opens the ring card and clicks Compact like a user, and checks the "Chat compacted" row;
  - turn 2 asks "Which number did you give me in your last answer? Reply with the number only." The answer must be 10.
  - the ring's label must show a percent above 0 after turn 1.
  The harness gains a follow-up step for this (a second task in the same tab after the first ends).
- Screenshots: the ring, the open card, and the compacted divider, light and dark.

## Review (independent subagent, 2026-11-05) and what changes

- The e2e follow-up runs on a page without the fact: the harness navigates the tab to `notebook.html` before turn 2, and turn 2 asks for a number derived from turn 1's answer ("multiply it by 7, reply with the number only": 70). Turn 2 must make no read or snapshot call, and its first request must hold the summary.
- What the meter shows: during a run, the prompt tokens of the last model call; when idle, an estimate of what the next request starts with (system prompt, tool definitions, the chain). It is recomputed right after Compact and New chat.
- Window fallback: `ollamaNumCtx` is a fallback for Ollama only. Cloud and custom models fall back to 256K. Ollama keeps `ollamaNumCtx` as its floor for an unknown model, and the Settings field says it is `num_ctx` for Ollama.
- `saveSettings` merges `contextWindow` from the new settings and drops a key when the field is emptied.
- The chain and the summary go inside the untrusted envelope (`wrapUntrusted`, source "earlier answers of this chat"); the user's own goals stay outside it.
- Usage: `callProvider` returns usage where LangChain has it; Ollama uses max(reported, estimate) because cached prefix tokens are left out; an image block counts as 1,500 tokens in the estimate and the tool schemas are added; the retry after an image refusal takes usage from the call that returned.
- Compaction: COMPACT_CHAT takes `claimForTask()` and releases it after, is in `TAB_ACTIONS`, and checks a chat generation number before it stores a summary (New chat in between drops it). Auto-compact runs under the task's stop signal, and its input is capped (the oldest turns are cut first).
- The summary lives in the `chat_compacted` row itself; the chain is "the summary of the last such row, plus the turns after it". Turn numbers become max(turn) + 1. The snapshot fit keeps the last `chat_compacted` row.
- A saved session shown from Recent tasks is read-only for the meter: the ring and Compact are off while it is shown.
- The timeline renders `chat_compacted` as its own item between turns, outside run keys and step counts.
- The window is resolved asynchronously and cached on the runner, refreshed when the model or settings change; `/models` is never fetched per call. The model-list cache gains a parallel `models_ctx_cache` map (ids stay as they are).
- `context` and the summary live on the runner, and New chat resets both.
- The chain carries each turn's answer up to 1,500 characters and each handed-over file up to 4,000 characters.
- The card says that earlier answers of this chat are sent with each new request.

## As built (2026-11-05)

Where the build differs from the plan above, or settles what the plan left open.

- `callProvider` still returns a string, so its many callers stay as they are.
  The usage LangChain reports (`usage_metadata`) goes out through a new `onUsage` callback in `CompletionOptions`; the prompt path (Gemini, Anthropic-protocol custom endpoints) and `callOllama` use it.
- The three wire shapes of usage are read in a new pure module, `src/background/llm/usage.ts` (re-exported from `llm/index.ts`).
- The estimate (characters / 4, 1,500 per picture, plus the tool schemas) lives in `src/shared/tokens.ts`, next to the `200K` / `1M` parser and the formatter, because the panel needs the same parser and formatter.
- `callUsage` in the MCP client turns a reply into the meter's numbers; the client reports it through an optional `RunRecorder.noteUsage`, so the test recorders did not have to change.
- The idle estimate needs the system prompt without a client, so the prompt became a pure function, `systemPromptText`, and `idleRequestTokens` builds the estimate from it, the tool definitions and the chain.
- `getState().context` also carries `hasEarlierTurn` and `compacting`, which the card needs for the Compact button. `summarizedTurns` is read from the last `chat_compacted` row, not stored on the runner.
- The run snapshot keeps the last call's usage (`lastCall`) and `runStats`; the summary needs no field of its own because it lives in the `chat_compacted` row.
- `models_ctx_cache` is keyed by provider id and then model id, not by the `provider_baseUrl_key` key of `models_cache`: the settings a run reads and the snapshot the panel fetched with do not always build the same key, and a miss would silently fall back to 256K.
- The custom endpoint list (LISA) also fills `models_ctx_cache` when its `/models` names a window.
- Ollama's `/api/show` window is remembered in memory per base URL and model, so `num_ctx` no longer costs a request every model call. The model-info key `<architecture>.context_length` is read as well.
- The Ollama fallback for an unknown model is `ollamaNumCtx` with source `default` (the plan's "floor"); the family table is source `estimate`.
- The window and the base estimate are refreshed when a task starts, after every `GET_AGENT_STATE` (after the answer, broadcast only when they changed), and on `chrome.storage.onChanged` for `agent_settings` or `models_ctx_cache` (background.ts, every session).
- Auto-compact runs while the task is still being claimed, before the status becomes running and before the turn's `user_goal` row is written. A Stop in that phase is a Stop before the start and aborts the summary call (`compactAbort`), so no stopped card lands on the previous turn.
- The compaction input is capped at half the window in characters (window x 4 x 0.5, at least 8,000).
- A failed or empty summary returns the error; the panel shows it as a toast (a new `.toast.error` rule gives it the danger edge).
- A new background message, `GET_CONTEXT_WINDOW`, lets the Settings field show the effective number and its source for the chosen model.
- The window formatter writes powers of two as the model card names them (262144 is `256K`), while the parser reads `K` as 1,000, so typing `256K` stores 256,000.
- The Compact card is a `role="dialog"` in the `.menu` family, centred over the composer; the ring sits before the effort button with no separator.
- The turn renderer keeps a `chat_compacted` row as its own item (`compacted: true`) in the list `buildTurns` returns; `renderTurns` filters it out of the runs, so it is never the live turn, never gets the synthetic end card and counts no steps.
- The open state of a divider's summary survives the re-render like the audit details (`openCompactSummaries`).
- The e2e follow-up's answer check accepts 70 with no other number than the 10 and the 7 it comes from.
- "No read or snapshot call" means no `read_page`, `get_page_elements`, `find` or `take_screenshot` step; the opening screenshot the client takes by itself is not a model call and does not count.
- The call record of the harness gained `firstUserText`, the first user message without the run state, which is where the chain is.
- The router test rig exposes `httpCalls` so a router test can read the chain in the real request.
- Not done: AGENTS.md still says "the two local tasks" in its harness line; it was left alone because it is an instruction file.
