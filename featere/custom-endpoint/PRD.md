# Product Requirement Document (PRD)
## Tarka Custom Endpoint (user-added third-party model provider)

> **Version**: 0.2
> **Status**: Implemented on the extension path (storage, LLM layer, background routes, Settings UI, tests). The open questions of section 9 were decided as recommended; section 11 records what shipped and where.
> **Feature id**: `custom-endpoint`
> **Related**: [PRD.md](../../PRD.md) section 2 item 3 (Multi-Provider API Client), [docs/langgraph-design.md](../../docs/langgraph-design.md)
> **Field-by-field UI spec**: [prototype.md](prototype.md)
> **Numbered requirements**: [USER_REQUIREMENTS.md](USER_REQUIREMENTS.md)
> **Written**: 2026-10-12, against branch `dev` at `cdbc15c` with the Phase P8 tree

---

## 1. Why

### 1.1 The problem

Tarka today supports eight providers, and the list is a compile-time constant.

- [`src/background/llm/types.ts:47`](../../src/background/llm/types.ts) is a closed union: `'openrouter' | 'openai' | 'openai_compatible' | 'anthropic' | 'gemini' | 'nvidia'`.
  [`isChatProvider`](../../src/background/llm/types.ts) is a hand-written `||` chain over those same names.
- [`llm/index.ts:35`](../../src/background/llm/index.ts) is the hard stop: `if (!isChatProvider(provider)) throw new Error(...)`.
  Any id outside the six dies there, before a request is built, with "Unsupported LLM provider".
  This one line is the whole blocker, and everything else in this list is downstream of it.
- [`sidepanel.html:150-158`](../../sidepanel/sidepanel.html) is eight literal `<option>` elements.
- [`models.ts:85-225`](../../src/background/llm/models.ts) is an `if`/`else if` chain on provider name, each branch carrying its own hard-coded URL.
- [`factory.ts:196-213`](../../src/background/llm/factory.ts) picks the base URL from three module constants plus one NVIDIA normalizer, and the default model from a nested ternary.
  `anthropicCall` ([`factory.ts:244-267`](../../src/background/llm/factory.ts)) never passes a base URL at all, so it can only reach `api.anthropic.com`.

The result: every new service, however standard its API, needs a code change, a build, a reload, and a release.
That is backwards for the two providers most likely to appear next, because almost everything on the self-hosted and relay side of the market speaks one of two dialects.

### 1.2 What "OpenAI-compatible" really buys

`openai_compatible` already exists as a provider, but it is a fixed preset pointed at Groq, not an open door.
The dialect is the valuable part, and it is the same dialect the whole industry converged on:

- OpenAI Chat Completions: `POST {base}/chat/completions`, `Authorization: Bearer`, `GET {base}/models`.
  vLLM, SGLang, LM Studio, Ollama's `/v1` shim, llama.cpp server, LocalAI, TGI, OpenRouter, NVIDIA NIM, Groq, DeepSeek, Together, Fireworks, Cerebras, xAI, and most paid relays all answer to it.
- Anthropic Messages: `POST {base}/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, `GET {base}/v1/models`.
  LiteLLM, one-api and new-api style relays, LiteLLM Proxy, and the Claude-compatible gateways of several clouds answer to it.

A user who can paste a base URL, a protocol, and a key is insulated from this list forever.
The provider list stops being a product surface and becomes a convenience.

### 1.3 Fit with the Tarka niche

The niche in [PRD.md section 1](../../PRD.md) is small local models and privacy.
That niche lives on a long tail of servers, not on eight brands:

- a vLLM box on the LAN at `http://192.168.1.40:8000/v1`;
- a llama.cpp or LM Studio server behind Tailscale with a self-signed certificate;
- a team's LiteLLM proxy that sits in front of four vendors and one pet model;
- a self-hosted one-api relay with a personal quota;
- a paper's in-house model exposed behind a FastAPI shim.

Every one of those is unreachable today without shipping code.
Each one is the kind of endpoint the project exists to serve.

---

## 2. Product definition

### 2.1 The two things this feature adds

1. **A third-party provider type.**
   A provider the user creates at runtime from a form, stored in `chrome.storage.local`, and offered in the same dropdown as the built-ins.
   It speaks OpenAI Chat Completions or Anthropic Messages.
2. **A registry.**
   User-added providers become first-class everywhere a built-in provider is understood: the dropdown, the model picker, per-provider credentials, timeouts, Planner and Reflect overrides, history, and the Logs labels.

### 2.2 The one-line rule

**A custom provider is a provider.**
Anything that works for `nvidia` should work for `acme-gateway`, with one exception: Tarka can ship no default model list, no default timeout, and no vendor-specific fixup for a provider it has never heard of.
Where a built-in has a curated default, a custom provider shows an honest empty state instead of a guessed one.

### 2.3 Non-goals

This feature is not:

- arbitrary JSON shaping (custom headers per request, body templating, response paths);
- a general plugin system;
- a way to add an Ollama-native or Gemini-native dialect (a self-hosted Ollama is reachable as OpenAI-compatible at `/v1` with `GET /v1/models`, and self-hosted Gemini endpoints are rare).

Those are separate decisions, listed in section 8.

---

## 3. Terms

| Term | Meaning |
|---|---|
| Provider id | The stable lowercase key the user types, stored in `providerConfigs` and echoed in logs. `acme-gateway`. |
| Display name | The label in the dropdown and the timeline. `Acme Gateway`. |
| Protocol | Which dialect to speak: `openai` or `anthropic`. A property of the endpoint, not of the model behind it. |
| Base URL | The root the client appends its path to. The form always shows the exact request URL it will send. |
| Model list | The ids fetched from the endpoint, editable by hand. The allowlist for the picker, not a limit on what can be sent. |
| Endpoint (endpoint origin) | The scheme, host, and port of the base URL. The unit that a test and a credential belong to. |

---

## 4. Design

### 4.1 Data model

The credential store is already open-ended: [`storage.ts:15`](../../src/shared/storage.ts) types `providerConfigs` as `Record<string, ProviderConfig>` with the comment "A stored value can hold ids this build does not know".
What is missing is the descriptor that makes an id a provider.
A new sibling collection holds it, so `ProviderConfig` keeps its shape and existing migrations stay untouched.

```ts
export type ProviderProtocol = 'openai' | 'anthropic';

export interface CustomProvider {
  id: string;                    // ^[a-z][a-z0-9-]{1,31}$, and not a reserved built-in id
  displayName: string;           // form default: the endpoint host
  protocol: ProviderProtocol;
  baseUrl: string;               // stored as typed; normalized on use
  models: string[];              // fetched, edited, then ordered as in the picker; [] allowed
  keyMode: 'apiKey' | 'none';    // 'none' is the reason Add works with no key
  llmTimeoutMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  // ... existing fields
  customProviders?: Record<string, CustomProvider>;   // keyed by id
}
```

Two notes on shape:

- **The API key does not live in `CustomProvider`.**
  It stays in `providerConfigs[id].apiKey`, so the existing per-provider credential memory and the top-level sync in [`saveSettings`](../../src/shared/storage.ts) work unchanged.
  The descriptor holds non-secret metadata; the credential holds the secret.
- **`models` lives on the descriptor, not in the cache.**
  The 1-hour `models_cache` in [`getCachedModels`](../../src/shared/storage.ts) is a refresh mechanism.
  The saved list is what the user chose to keep, and it is what the picker shows when offline.

### 4.2 Where the closed union goes

`ChatProvider` stays as the name of the built-in union, and the call path widens to accept a custom descriptor.

- The gate in [`llm/index.ts:35`](../../src/background/llm/index.ts) becomes a lookup: a name in the built-in set behaves as today, a name in `customProviders` is resolved to its descriptor, and anything else still fails with a named error rather than a guess.
- `createProviderCall` gains a shape that takes `{ protocol, baseUrl, apiKey, defaultModel }` instead of switching on a name.
  `openaiFamilyCall` keeps its base-URL rules for the built-ins and gains a path that uses the caller's URL verbatim.
  The Anthropic path needs the work here, since `anthropicCall` passes no base URL today.
- `providerOf`, `getApiKey`, `timeoutMsOf` and friends keep working, because they already take a string.
  `timeoutMsOf` ([`settings.ts:88-103`](../../src/background/llm/settings.ts)) keeps the NVIDIA special case and adds one more: a custom provider's own `llmTimeoutMs`, then the global, then `DEFAULT_LLM_TIMEOUT_MS`.
  `assertApiKey` ([`errors.ts:35`](../../src/background/llm/errors.ts)) looks a provider up in a `MISSING_KEY` table, so an unknown id already means "no key required", which is the behaviour keyless endpoints need; it stays that way on purpose once `keyMode` makes it explicit.
- `isChatProvider` is no longer a gate on the call path.
  It becomes a question about built-ins, used only by code that genuinely needs to know.
- `getFallbackModels` returns `[]` for a custom provider.
  Its `default` arm today returns `gemini-2.0-flash`, `gemini-1.5-flash`, `qwen2.5:14b` and `gpt-4o-mini` ([`models.ts:77-79`](../../src/background/llm/models.ts)), which would put Google and Ollama ids in the picker for the user's gateway.
  The empty state is the correct answer, and it is what the form already says.

### 4.3 URL rules per protocol

There is a live bug waiting here, and it is worth deciding out loud.
[`withV1`](../../src/background/llm/settings.ts) strips trailing slashes and **appends `/v1` when it is missing**.
That is right for OpenAI-style bases and wrong for a server mounted without a version segment (`https://gateway.example`): the client would post to `/v1/chat/completions`, get a 404, and the Logs tab would show a status the user cannot explain.
Anthropic-style clients append `/v1/messages` on top of a base that already ends in `/v1`, which produces `/v1/v1/messages` for a URL typed as the console URL.

The rule that removes both surprises:

- The form shows the exact request URL under the Base URL field, recomputed as the user types, for both paths.
- **Add and save store the URL as typed.**
  Normalization happens on use, and the preview is the same function the sender uses, so the preview is never a lie.
- OpenAI protocol: strip a trailing `/chat/completions` or `/models`, then append `/v1` only when the path has no version segment.
  A URL already ending in `/v1` is used as is.
  A URL with a path that is not a version segment is used as is (relays mounted at `/api/openai` are real).
- Anthropic protocol: strip a trailing `/messages`, append `/v1` when absent.
- A wrong guess is always fixable: the preview shows what will be sent, and the field accepts the full path when a server needs it.

### 4.4 Model discovery

`fetchAvailableModels` gains a branch before the built-in chain: for a custom id, fetch from the descriptor.

| Protocol | Request | Parse |
|---|---|---|
| `openai` | `GET {base}/models`, `Authorization: Bearer <key>` when a key exists, header omitted when it does not | `data[].id`, sorted |
| `anthropic` | `GET {base}/v1/models`, `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true` | `data[].id`, sorted |

Behaviour that must match the built-ins, because the built-ins got it right:

- A failure never throws at the caller; it resolves to the provider's fallback, which for a custom provider is the saved `models` list, possibly empty.
- The raw error body is kept and shown, and the key is scrubbed from it.
  [`watchFetch`](../../src/background/llm/factory.ts) already does exactly that (`scrubKey`) for the built-in OpenAI family, and the same watcher is what makes a user's endpoint safe to talk to.
- The non-chat filter NVIDIA uses (`/embed|rerank|guard|safety|clip/i`) applies to custom lists too, so an all-embeddings gateway does not fill the picker with ids that cannot answer a chat call.
  The hand-edit path can still add any id back.

### 4.5 Credentials

Two decisions worth their weight, both visible in the supplied mock: **API key is optional, and Models are optional.**

**Keyless is a use case, not a hole.**
Local and LAN servers (Ollama's `/v1`, llama.cpp, LM Studio, a private relay with IP allowlisting) take no key, and the niche is local-first.
The form therefore offers a **No key** choice, and Add works without a key.
[`openaiRequestHeaders`](../../src/background/llm/factory.ts) already handles the keyless case for the built-in OpenAI-compatible provider: a placeholder key satisfies the client, and `Authorization` is deleted from the wire.

**The key belongs to the endpoint origin, not to the field.**

- Changing the **origin** (scheme, host, or port) of a saved provider clears the stored key and says so inline.
  It does not clear the key when only the path changes (`/v1` to `/api/v1`), which is a correction, not a new server.
  This rule exists because of section 7.1.
- Re-entering the same key after an origin change is one paste, and it prevents the far worse failure of a live credential being sent to a host the user did not choose.
- Keys are never written to logs, to the Logs tab, or to a saved session.
  The existing key-scrubbing on error paths stays on every custom path, including the model fetch and the connectivity probe.

### 4.6 Validation at Add time

The form must fail closed on a URL that cannot be right, and fail open on anything merely unusual.

| Input | Rule at Add | Why |
|---|---|---|
| Provider id | `^[a-z][a-z0-9-]{1,31}$`, unique, not a reserved built-in id | It is a storage key and a log label. Uppercase and `_` are rejected at the form, not coerced. |
| Display name | Non-empty after trim, 64 max, default from host | Cosmetic, so never block on it. |
| Base URL | Parses as a URL, protocol is `http:` or `https:` | Chrome extensions cannot fetch `file:` or `ws:`, and a non-HTTP scheme is always a mistake. |
| API protocol | One of the two known values | Everything else is a code change. |
| API key | Optional | Section 4.5. |
| Models | Optional | Empty list still allows sending an id typed by hand. |

`http://` stays allowed, with a visible note in the form, for `localhost` and private-network addresses.
It matches how Ollama is configured today ([`storage.ts:60`](../../src/shared/storage.ts) ships `http://localhost:11434`), and blocking it would cut out most self-hosted servers.

The **Test** button is the honest gate: it calls the model list, and when that endpoint does not exist it sends one minimal chat request and reports what came back.
Test is not required for Add, so a server that blocks `GET /models` (some do) is still addable.

### 4.7 Edit and delete

- **Edit** opens the same form with the id locked (it is the storage key), the fields prefilled, and the current request preview shown.
- **Delete** asks once, names the sessions that used the provider, removes `customProviders[id]` and `providerConfigs[id]`, drops its model cache entry, and leaves history intact.
  A past run that names a deleted provider keeps its label; it must not lose its history.
- **Provider not found** is a recoverable state, not a crash.
  When the active `settings.provider` names an id that no longer exists (deleted from another panel, storage edited by hand), the dropdown falls back to the built-in default and the panel says why.
  [`sidepanel.js:48`](../../sidepanel/sidepanel.js) already warns that assigning a `<select>` a value with no matching `<option>` silently leaves `select.value === ''`, so options are built before values are assigned.

---

## 5. Success measures

| # | Measure | How it is checked |
|---|---|---|
| S1 | A new endpoint works with no code change and no rebuild | Manual, four real servers: vLLM, LM Studio, LiteLLM Proxy, one OpenAI-compatible relay with a key |
| S2 | Add is reachable from a clean panel in one interaction | Clicks counted from the Settings tab to a usable provider in the dropdown. Target: 5 or fewer |
| S3 | Model list loads instantly on reopen | No network call on panel open, same as the existing "Persistent Storage Model Caching" promise in [README.md](../../README.md) |
| S4 | A wrong base URL explains itself | With a URL known to be wrong, the panel shows status plus the server's own message, with the key absent from the text |
| S5 | Nothing regresses for the eight built-ins | `npm test` and `npm run test:e2e` stay green, with the existing test count monotonic per the P8 count rules |
| S6 | No provider list change is needed for a new OpenAI-compatible service | Proven by pointing the feature at a service that is not in this repo's registry |
| S7 | A run that used a custom provider replays from History after that provider is deleted | Manual check against the History drawer |

---

## 6. Compatibility and migration

- **Existing settings keep working.**
  `customProviders` is additive, `ProviderConfig` is unchanged, and the only migration is: when `agent_settings` loads without `customProviders`, treat it as `{}`.
  There is nothing to rewrite, so the migration is a default, not a transform.
- **`settings.engine` is already stripped on load and save** ([`storage.ts:110,146,156`](../../src/shared/storage.ts), Phase P8 stage 5b-1).
  This feature must not reintroduce the field, and must not add a stored field the P8 `noLegacy` guards would flag.
- **Manifest and permissions: no change needed.**
  [`public/manifest.json`](../../public/manifest.json) already declares `host_permissions: ["<all_urls>"]`, which is what a user-typed endpoint requires.
  Do not narrow it to a fixed allowlist of vendors, since that is the dependency this feature removes.
- **CSP holds.**
  The build must stay free of new `eval` and `new Function`.
  `npm run evalscan` keeps exactly the five allowed hits it reports today ([`scripts/evalscan.mjs`](../../scripts/evalscan.mjs)), and the only `new Function` remains the page-side `execute_js` snippet in [`browser/executeJs.ts`](../../src/background/browser/executeJs.ts).
- **Built-ins stay curated.**
  The builtin registry is not derived from user data, so a user cannot break OpenRouter's referer headers or NVIDIA's 300s timeout by editing something.
- **Python runner** ([`python_runner/agent.py`](../../python_runner/agent.py)): parity is desirable, not blocking.
  The runner already takes `--base-url`; a `--protocol` flag and a custom-models path is a follow-on, tracked in [USER_REQUIREMENTS.md](USER_REQUIREMENTS.md) R4.2.

---

## 7. Risks and honest limits

### 7.1 The extension can reach the operator's own network (real, pre-existing)

This is the sharpest edge in the feature and it is not hypothetical.
A Chrome MV3 extension service worker is **not** a Secure Context.
The Mixed Content spec blocks `https:` pages from reaching `http:` origins, but the block does not apply to extension pages and workers, and `<all_urls>` host permission is already granted.
The proof is in the repo: Ollama ships as `http://localhost:11434` in [`storage.ts:60`](../../src/shared/storage.ts) and works.

So: an `https://` relay can 302 Tarka to `http://169.254.169.254/...` (cloud metadata) or `http://192.168.x.x:8000/v1` (a LAN model server), and Tarka will follow, because `fetch` follows redirects by default.
That is true of the existing `openai_compatible` provider whenever the user types a third-party base URL, and this feature hands the sharp end to more users with a nicer form.

Decisions asked for in section 9 (O1, O2). The recommended floor, cheap enough to fold into the first cut:

- Send the chat and model requests with `redirect: 'manual'` (or a fetch wrapper that refuses a redirect whose new origin differs from the configured endpoint origin), and report "the endpoint redirected to another host" as a named error.
- Refuse `http://` non-private hosts at Add time with a note (plain HTTP on the public internet is a mistake more often than not).
- Keep the key-rotation rule of section 4.5 as the backstop for the origin change path.

### 7.2 Costs the user owns

- A custom provider has no curated default timeout, so a slow gateway uses the global 120s unless the user sets one.
  The form shows the current effective timeout per provider.
- A gateway that answers with a body Tarka's parser cannot read surfaces as an UnreadableReplyError with the raw body, which is honest but not friendly.
- Users will point an OpenAI-protocol provider at an Anthropic endpoint.
  The error text must name the protocol it used and the URL it posted to, so the fix is obvious without opening the Logs tab.

### 7.3 Deliberately not mitigated here

Prompt-injection hardening of page text, and stronger redaction of card numbers and one-time codes, stay out of scope, exactly as in [PRD.md section 3.4](../../PRD.md).
A user-supplied endpoint neither adds nor removes exposure on those axes.

---

## 8. Out of scope for this feature

| Item | Why it is its own decision |
|---|---|
| Per-request custom headers | Real need (tenant ids, trace ids), and a credential-leak surface. Design separately |
| Non-chat model kinds (embeddings, rerank) | Nothing in Tarka calls them yet |
| Ollama-native and Gemini-native custom protocols | The `/v1` shim covers most self-hosted servers; revisit with demand |
| Streaming for custom providers | No provider streams today (Gemini streams internally only to keep its abort signal alive), so this is a separate change |
| Constrained decoding for custom endpoints | Ollama-only today ([PRD.md 3.3 item 17](../../PRD.md)). A `response_format` probe is a good follow-on: detect support once, cache it per endpoint, send the schema when supported. It would lift small-model reliability on vLLM and SGLang, which is the core niche |
| Provider presets and an import file | A good v2 shape (share a `tarka-provider.json`), out of scope for v1 |
| Auto-detecting the protocol from the endpoint | Tempting, and it guesses wrong on relays that speak both |

---

## 9. Open questions for Prit

| Id | Question | Recommendation |
|---|---|---|
| O1 | Redirect policy for custom endpoints, per section 7.1 | Refuse cross-origin redirects, and name the error |
| O2 | Allow `http://` for a host that is not private or `localhost` | Warn in the form, allow it, and require Test before the first run |
| O3 | Does a custom provider get its own LLM timeout field in Settings, or use the global one | Own field, mirroring the NVIDIA precedent, since `timeoutMsOf` already has per-provider precedence |
| O4 | Cap on the number of custom providers | 20, with the form refusing Add past it and naming the limit |
| O5 | Is `model` free text for a custom provider, or must it come from the fetched list | Free text always allowed (matching the mock's "Unlisted IDs can still be sent directly"), with fetched ids offered as a picker |
| O6 | Where the provider list is edited: inside Settings, or a dialog over it | A dialog over the Settings tab, so the eight built-ins keep their current form untouched |
| O7 | Python runner parity in the same phase, or after | After. Ship the extension path first |
| O8 | Build order against Phase P8 | After P8 stage 7 lands and the tree is committed, so this feature is one clean commit series on a quiet tree. The LLM surface is already settled: `isChatProvider` has exactly one caller ([`llm/index.ts:19`](../../src/background/llm/index.ts)), and the legacy `agentEngine.js` is already deleted by stage 5c |

**Decisions (2026-10-12)**: O1 through O8 all as recommended. O2 shipped as "warn in the form, allow it"; the "require Test before the first run" half was folded into the guard that refuses a run with no model picked, which is the failure a user actually hits first.

---

## 10. Delivery shape

Rough sizing for planning only, in the order that unblocks the least-broken path.

1. Registry plus storage (`customProviders`, CRUD, validation at the boundary, migrations).
2. Call path widened past the closed union (`factory.ts`, `settings.ts` timeout), with unit tests over a fake endpoint for both protocols.
3. Model discovery plus the empty fallback (`models.ts`), with the key-scrub and non-chat filter tests.
4. UI: dropdown from both sources, the Add/Edit dialog with the request preview, the per-provider memory path, and the empty state.
5. Origin-key rule, redirect policy, and the `http://` note, with a test per rule.
6. Docs: the Providers section of [README.md](../../README.md), the provider table in [DEVELOPMENT.md](../../DEVELOPMENT.md), and a row in [docs/progress.md](../../docs/progress.md) as its own phase.

A phase row belongs in `docs/progress.md`, and this feature deserves a phase number of its own rather than being folded into P8, which is a deletion phase with a monotonic test-count rule that does not want new production surface.

---

## 11. Implementation notes (what shipped, and where)

**Storage** (`src/shared/storage.ts`)
- `CustomProvider`, `CustomProviderInput`, `CustomProviders`, and the literal `BUILTIN_PROVIDER_IDS` (kept next to `DEFAULT_PROVIDER_CONFIGS` so the built-in id list has exactly one source of truth, per O4/O5 of the review). The cap constant `MAX_CUSTOM_PROVIDERS` is 20.
- `saveCustomProvider`, `deleteCustomProvider`, `sanitizeCustomProviders`, plus the `customProviders` snapshot in `getSettings` with the active-selection heal. `deleteCustomProvider` writes directly instead of going through `saveSettings`, whose merge cannot express a key deletion; it re-applies the same top-level synchronization for the provider that becomes active.
- The credential lives in `providerConfigs[id].apiKey`, exactly like every provider. The origin rule clears it when the endpoint host changes and keeps it for a path-only correction; `saveCustomProvider` reports `keyCleared` so the dialog can say so in the same breath.

**LLM layer** (`src/background/llm/`)
- `settings.ts`: the protocol-aware URL rules (`customChatUrl`, `customModelsUrl`, the two normalizers), `endpointOriginOf`/`endpointHostOf`, and the per-provider timeout precedence in `timeoutMsOf`.
- `factory.ts`: `createCustomProviderCall` builds a `ChatOpenAICompletions` or `ChatAnthropic` from the descriptor, behind the same `watchFetch` as the built-ins (key scrub, foreign-redirect refusal, reply capture). Errors name the provider, the protocol and the URL host, never the key.
- `models.ts`: `fetchCustomProviderModels`; 404/405 escape the catch with their `.status`, so the panel can say "this endpoint has no model list" instead of "unreachable"; a non-JSON answer has its own message; a 200 with only non-chat ids falls back to the saved list. `getFallbackModels` lost its default arm: an unknown provider gets `[]`, never Gemini's list. The model list goes through the same `watchFetch` as the chat call, so a redirect off the endpoint's origin is refused here too (C2.3), and the count of hidden non-chat ids rides to the panel as `filteredCount` (D1.3).

**Background routes** (`src/background/background.ts`)
- `FETCH_MODELS` refuses a payload whose provider is neither a built-in nor described in the payload's `customProviders` snapshot, and passes the HTTP status through. `TEST_PROVIDER` is the dialog's probe: one minimal chat call through `callProvider`, the same path a run uses, with a 20s deadline and a measured latency.

**Settings UI** (`sidepanel/`)
- `customProvider.js` holds the dialog and the pure helpers (`providerMeta`, `buildProviderOptions`, `isCustomProviderId`, `previewUrls`, `describePrivateHttpHost`, `validateProviderIdInput`). `providerMeta` is the one resolver both sources go through, so the form never reads `DEFAULT_PROVIDER_CONFIGS` for an id that has no entry there. Dropdown options are tracked in a WeakSet so a deleted provider loses its option.
- An untouched display name follows the host of the Base URL as it is typed; a name that was typed or saved is never overwritten (A3). A clash with an existing id comes with the one-click `Use "<id>-2"` (A2.3). A fetch merges with the saved list instead of silently replacing it, and the status line counts what was new (D4). The Test status carries the measured latency (A7.2), and the form says Test is optional (A7.5). Deleting the active provider states which provider the panel fell back to (A8.4).
- A custom provider owns its timeout field in the dialog (O3), and `timeoutMsOf` honors the descriptor's own `llmTimeoutMs` between the shared per-provider config and the global value; the timeout error names the value and where it came from (B3.3). A public plain-http endpoint logs one note per origin per worker life (C3.2); local servers are not warned about.
- The run shows `Display name · model` in the processing banner (A6.3), and saved sessions record their provider (B2.4), which is what the delete confirmation counts.

**Conscious simplifications, with reasons**
- A5.3's "asks for the key again if the new protocol needs one on a different origin": the origin rule already clears the key on any host change regardless of protocol, and a protocol toggle on the same origin keeps the same credential (one secret authenticates both dialects on one server). A separate protocol-scoped key store would invent state the origin rule already covers.
- A5.4's "a stored value outside them disables the provider and points at Edit": `sanitizeCustomProviders` drops a descriptor whose protocol is not one of the two at load time (additive-storage robustness, pinned in tests), and the factory additionally refuses an unknown protocol with a pointer at Edit, so a stale payload can never be guessed into a client. The visible-but-disabled variant is not built; the drop is silent but total, which is the safer of the two.
- A7.6's "a Test still running when the dialog closes is aborted": the background call is not cancelled; its answer is discarded by the dialog's generation counter and can never reach a closed form.
- D5 (the 900-id render bar) is priority C and not built; the existing combobox filters as you type and lists arrive sorted and deduplicated.

**Pending manual validation** (needs real servers, cannot be automated here): the section 9.3 list - vLLM, LM Studio or Ollama `/v1`, LiteLLM Proxy, one keyed relay, one deliberately wrong base URL, one keyless server, one self-signed `https://` server.

**Environment note on `npm run test:e2e`**: the smoke's Chromium refuses to start the extension's service worker in this workspace ("did not start within 20 s"); the failure reproduces identically on the clean tree without this feature's changes, so it is an environment limitation (Chromium launch/profile in the sandbox), not a regression of the custom-endpoint work. Everything the smoke checks before the browser starts (build, self-checks, the mock Ollama self-test: 110/110) passes.

**Tests**
- `tests/llm/customUrls.test.ts` (the URL table), `tests/llm/customProviders.test.ts` (call path, headers, error texts, timeout), `tests/llm/customModels.test.ts` (fetch, filter, fallback, cache), `tests/background/customProviderRoutes.test.ts` (routes), `tests/shared/customProviders.test.ts` (storage rules), `tests/sidepanel/customProvider.test.js` (helpers and dialog flows). Two pre-existing pins changed with the product: the unknown-provider model fallback (`models.test.ts`) and the null-payload route answer (`messageRouter.test.ts`) now expect no invented list.

**Not in this phase** (per O7): the Python runner's `CustomProvider` handling; the descriptor's `keyMode` stays an internal marker ('apiKey' by default - an empty key field already means no credential header on the wire); no custom-header field on the descriptor.
