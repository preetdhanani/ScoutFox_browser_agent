# User requirements: Custom Endpoint
## Third-party model provider, OpenAI- or Anthropic-compatible

Feature: [PRD.md](PRD.md) · UI spec: [prototype.md](prototype.md)
Priority key: **M** must · **S** should · **C** could · **W** won't (this version)
Every requirement is testable as written.
"Panel" means the Side Panel Settings tab, "endpoint" means the origin plus path of a Base URL.

---

## 1. Personas

| Persona | Context | What they need |
|---|---|---|
| **Local-first power user** | Ollama is already supported; runs vLLM, llama.cpp, LM Studio, TGI on a LAN box or a second GPU machine | Point Tarka at an IP address without waiting for a release |
| **Team gateway admin** | One LiteLLM, one-api, or Kong proxy in front of four vendors plus one in-house model | One entry in Tarka, not one Tarka release per model |
| **Cost shifter** | Buys quota from a relay that is not in the list, often per-token cheaper for the model they use | Use the quota they already paid for |
| **Evaluator and researcher** | Exposes their own fine-tune behind a FastAPI shim, wants Tarka to score it | Reproduce a run against a model id nobody has heard of |

---

## 2. Epic A: Add a provider

### A1 (M) Add a provider from the Settings tab without a rebuild

**As** any persona, **I want** to add a provider by giving an id, a display name, a base URL, a protocol, and an optional key, **so that** I can use an endpoint that Tarka has never heard of.

Acceptance:

1. The provider dropdown contains a **Custom endpoint** entry at the end of the built-in list, and choosing it opens the Add form.
2. The form has exactly: Provider ID, Display name, Base URL, API protocol (segmented, two values), API key with a reveal toggle, and Models (section D).
3. With a valid form, Add closes the form, saves, selects the provider, and shows one toast naming the provider.
4. The new provider is offered in the dropdown on the next panel open with no reload of the extension.
5. `npm run build` is not part of the flow, and the extension is not reloaded.
6. `npm run evalscan` still reports 0 disallowed hits after this feature.

### A2 (M) Provider id rules

Acceptance:

1. Valid: `^[a-z][a-z0-9-]{1,31}$`. So `acme-gateway` yes, `Acme-Gateway` no, `acme_gateway` no, `1acme` no, `-acme` no, 33 characters no.
2. The inline error names the rule, not just "invalid": "Lowercase letters, digits, and dashes, starting with a letter, up to 32 characters."
3. A clash with an existing id is refused, naming which provider holds it, with a one-click "Use `<id>-2`".
4. A clash with a built-in id (`openrouter`, `agent_router`, `gemini`, `ollama`, `openai`, `openai_compatible`, `anthropic`, `nvidia`) is refused and says the built-in cannot be shadowed.
5. The id cannot be edited after Add; editing opens the form with the id locked.
6. The id is what appears in `providerConfigs`, in the Logs tab, and in a saved session's model line.

### A3 (M) Display name defaults to the host

Acceptance:

1. Typing a Base URL fills an empty Display name with the host (`gateway.example`, not `https://gateway.example/v1`).
2. An edited Display name is never overwritten by the auto value.
3. The name appears in the dropdown, the header pill, the timeline, and a saved session's provider label, truncated with an ellipsis past the box width rather than wrapping.
4. Empty after trim falls back to the host at save time, so an empty name cannot produce a blank option.

### A4 (M) Base URL validation and an honest request preview

Acceptance:

1. The field shows a live line under it with the **exact** URL that will be posted, and the model-list URL next to it, both recomputed as the user types and when the protocol toggles.
2. The preview is produced by the same function the sender uses. A test asserts preview text equals the URL a request is sent to, for a table of at least 12 URLs covering both protocols.
3. Add is blocked when the value does not parse, or its scheme is neither `http:` nor `https:`. The error names what was found.
4. A trailing slash, a trailing `/chat/completions`, `/models`, or `/messages` is accepted; the preview shows the resulting URL.
5. `/v1` is added only when the path carries no version segment, per PRD section 4.3.
   A URL typed as `https://gateway.example` is previewed as `https://gateway.example/v1/chat/completions`, and one typed as `https://relay.example/api/openai` is previewed without `/v1`.
6. For a saved provider, editing the field updates the preview before save, so the user sees the consequence of a path change without guessing.

### A5 (M) Protocol choice

Acceptance:

1. The control is a two-segment control, not a dropdown with five items that mean the same thing: **OpenAI Chat Completions** and **Anthropic Messages**.
2. Each segment carries one line of sub-copy naming the request path and the key header (`Authorization: Bearer`, `x-api-key` plus `anthropic-version`).
3. Switching protocol updates the preview, and asks for the key again if the new protocol needs one and the saved key was entered for the other protocol on a different origin.
4. The saved value is one of the two literals. A stored value outside them is treated as unknown at load, disables the provider, and points at Edit; it never guesses.

### A6 (M) Add works with no key

Acceptance:

1. The key field accepts the empty value, and Add succeeds with it.
2. No `Authorization` header reaches the wire when there is no key (verified by a test on the fetch layer, not by reading config).
3. The form states why keyless is allowed, in one line, naming the local and allowlisted cases.
4. A provider saved keyless works against a local test server that answers only when no `Authorization` header is present.

### A7 (S) Test before Add

Acceptance:

1. A Test button calls the model list, and if that answers 404 or 405 it sends one minimal chat request.
2. Success shows the model count, or "no models listed, you can still type an id", plus the latency in milliseconds in the existing `(842ms)` telemetry format.
3. Failure shows the HTTP status, then the server's own message when it had one, truncated to one line with a copyable full text in the Logs tab.
4. The key text appears nowhere in the panel or the Logs output for either outcome, including when the server echoes it back in an error body.
5. Test is not required for Add, and the form says so, since some gateways block the model list.
6. A Test that is still running when the dialog closes is aborted, and no response is applied to a closed form.

### A8 (C) Edit and delete

Acceptance:

1. Each custom entry in the list has Edit and Delete affordances; built-ins have neither.
2. Delete asks once, and the confirmation names how many saved sessions used this provider.
3. Delete removes the descriptor, the credentials, and the model cache entry for that endpoint, and leaves history readable.
4. After deleting the currently active provider, the panel falls back to the built-in default provider and states what happened.

### A9 (C) A cap on the number of custom providers

Acceptance: Add is refused past the limit (PRD O4, 20 recommended) with the count and the limit in the message, and the message offers to delete an existing entry.

---

## 3. Epic B: Use it like a built-in

### B1 (M) The provider is selectable and remembers its own state

Acceptance:

1. Switching to the provider loads its own Base URL, key, model, and timeout, and switching away leaves them untouched, exactly as the per-provider memory works for the eight built-ins today.
2. Switching does not clear another provider's stored values (the behaviour pinned by `tests/llm/settings.test.ts` and `tests/shared/storage.test.ts`).
3. The active provider survives a panel close and reopen, and a service worker restart.
4. The options are built before the value is assigned, so `select.value` is never silently `''`.
   The same trap is documented for the model picker in the header comment of [`sidepanel.js:46-50`](../../sidepanel/sidepanel.js).

### B2 (M) It runs a real task

Acceptance:

1. With a custom provider selected, a task starts, plans, acts, and finishes.
2. Planner Model and Reflect Model overrides accept a model id of a custom provider, and the override routes to the same endpoint as the main model unless a different provider is chosen for it.
3. The effort selector, max steps, and per-step telemetry behave identically to a built-in run.
4. A custom-provider run records its provider id in the saved session, so History shows which endpoint produced it.

### B3 (M) Errors name the protocol and the URL

Acceptance:

1. On a non-2xx from the chat call, the message contains the provider display name, the protocol used, the full URL, the status, and the server's message when there was one.
2. A user who pointed an OpenAI-protocol provider at an Anthropic endpoint can tell that is the problem from the panel text alone, without opening Logs.
3. The timeout message names the effective timeout and where it came from (provider setting, global setting, or default), matching the precedence in [`settings.ts:88`](../../src/background/llm/settings.ts).
4. Key scrubbing applies to all of the above.

### B4 (S) The empty model list is a real state, not a broken one

Acceptance:

1. With `models: []`, the picker shows the empty-state line from the mock: "No models will be shown in the selector. Unlisted IDs can still be sent directly."
2. A model id typed by hand is accepted, saved, and used, with no fetch and no validation against the list.
3. Nothing in the code path falls back to a built-in's model list, so `gemini-*` and `qwen2.5:14b` never appear for a user's gateway.
   This is [`getFallbackModels`](../../src/background/llm/models.ts) `default` behaviour that must be special-cased, and a test pins it.
4. The Agent tab warns once, subtly, that no model is selected, and refuses Start Task with that reason rather than sending an empty model.

### B5 (S) Works after the endpoint is gone

Acceptance: with a provider whose endpoint is unreachable, the panel still opens, settings still load, History still opens, and starting a task fails with the B3 message rather than hanging or blanking the panel.

---

## 4. Epic C: Credentials and safety

### C1 (M) The key follows the origin

Acceptance:

1. Changing the scheme, host, or port of a saved provider clears the stored key and states why inline: "The host changed, so the key was removed. Paste it again to send it to the new host."
2. Changing only the path keeps the key.
3. A test covers both cases and asserts the key is absent from storage after case 1.

### C2 (M) Cross-origin redirects are refused

Per PRD section 7.1, this is the reason the extension cannot be walked to cloud metadata or a LAN host by a relay.

Acceptance:

1. A 3xx whose `Location` is a different origin from the configured endpoint origin is not followed.
2. The error names the refused redirect target host and the configured host.
3. Tests cover same-origin redirect (followed) and cross-origin redirect (refused) for both protocols and for the model list request.

### C3 (S) Plain HTTP is allowed and labelled

Acceptance:

1. `http://localhost`, `http://127.0.0.1`, and private ranges (`10/8`, `172.16/12`, `192.168/16`) are accepted quietly.
2. `http://` on any other host is accepted with a one-line warning in the form and a single log line per run.
3. `https://` is recommended in the form copy, never enforced.

### C4 (S) A provider cannot see another provider's key

Acceptance: the request builder is given the credential for the provider being called, and a test asserts that a request to provider A carries no header value stored under provider B.

### C5 (M) No new CSP surface

Acceptance: no new `eval` or `new Function`; `npm run evalscan` output unchanged in count; `npm run check` and all three `npm run typecheck` projects stay clean.

---

## 5. Epic D: Models

### D1 (M) Fetch available models

Acceptance:

1. One button in the form fetches from the endpoint using the protocol's rule from PRD section 4.4.
2. It reports loading, success with a count, and failure with the reason, and never throws into the UI.
3. Results are sorted and de-duplicated, and non-chat ids are filtered with the same pattern NVIDIA uses, with a count of what was filtered shown.
4. The result is cached for an hour keyed by provider id, base URL, and key suffix, matching the existing cache rule, so a panel reopen is instant.

### D2 (M) Edit the list by hand

Acceptance:

1. **Add model** appends an id, and the id is trimmed, de-duplicated against the list, and kept in the position the user placed it.
2. Each row has a remove control, and an empty list is a valid saved state.
3. There is no drag order in this version, and the picker shows the saved order.
4. An id containing a newline or a tab is refused with a naming message, since it would corrupt the picker and the logs.

### D3 (M) Unlisted ids still work

Acceptance: sending an id that is not in `models` is allowed everywhere, and no code path rejects it. The mock's sentence is the contract.

### D4 (S) The picker is the saved list

Acceptance: the Settings model picker shows the saved list, searchable as the existing combobox is; a fetched list that differs from the saved one is offered as "N new ids from the endpoint. Merge?" rather than silently replacing it.

### D5 (C) Filter and search a long list

Acceptance: with 900 ids from an OpenAI-compatible gateway, the picker opens under 100 ms, filters as you type, and does not render 900 DOM nodes.

---

## 6. Epic E: Parity and docs

| Id | Pri | Requirement | Acceptance |
|---|---|---|---|
| E1 | S | Built-ins untouched | The eight built-ins keep their curated defaults, headers, and timeouts; the existing provider tests pass unmodified |
| E2 | S | Storage is additive | No `ProviderConfig` shape change; no new `engine` field; a stored `customProviders` written by a newer build is ignored, not fatal |
| E3 | M | Test count does not fall | `npm test` failures 0, skipped 0, todo 0; the count is at least the pre-feature number, per the P8 monotonic rule |
| E4 | S | Python runner parity | `python_runner/agent.py` takes `--protocol` plus a base URL and key, and its tests cover both protocols |
| E5 | M | Docs land | README Providers section gains a Custom endpoint subsection; DEVELOPMENT.md provider table gains a row; `docs/progress.md` gains a phase row |
| E6 | C | e2e coverage | `npm run test:e2e` gains a mock endpoint served by the harness itself, driving a custom OpenAI-protocol provider end to end |
| E7 | C | Migration path for `openai_compatible` | The Groq preset stays a built-in, and the form links to it as an example of a custom entry rather than replacing it |

---

## 7. Non-functional requirements

| Id | Requirement | Bar |
|---|---|---|
| N1 | Panel open stays instant with custom providers present | No network call on open; model list served from cache, matching the existing 0 ms dropdown promise |
| N2 | Storage footprint | 20 providers plus their lists stay under 64 KB of `chrome.storage.local` |
| N3 | Request size unchanged | No header is added to a built-in provider's request by this feature |
| N4 | Accessibility | Every form control is labelled, the segmented control is operable by keyboard with visible focus, errors are announced, and the key reveal toggle names what it reveals |
| N5 | Light and dark themes at 320 to 480 px | The dialog and the model list stay inside the panel width with no horizontal scroll, per the existing pixel-review rule |
| N6 | No layout shift on fetch | The Models area keeps its height while loading |
| N7 | Timeout honesty | The effective timeout for the selected provider is visible wherever the timeout field is |

---

## 8. Out of scope for this version

| Id | Item | Why |
|---|---|---|
| W1 | Custom request headers per provider | Real need, and a credential-exfiltration surface that needs its own design |
| W2 | A JSON or import-file provider format | Good v2, keeps v1's form small |
| W3 | Ollama-native and Gemini-native custom protocols | The `/v1` shim covers most self-host servers |
| W4 | Auto-detecting the protocol from the endpoint | Relays that speak both make a wrong guess likely |
| W5 | Constrained decoding for custom endpoints | Deserves its own phase; PRD section 8 records why it is attractive |
| W6 | Streaming responses | Nothing streams on the wire today |
| W7 | Prompt-injection hardening | Unchanged, still out of scope per [PRD.md 3.4](../../PRD.md) |

---

## 9. Definition of done

1. All M requirements implemented, S requirements implemented or explicitly deferred with a reason recorded in the PRD.
2. `npm run typecheck` clean across all three projects, `npm test` green with a non-decreasing count, `npm run check` clean, `npm run build` self-check clean, `npm run evalscan` unchanged, `npm run test:e2e` green.
3. Manual check list run and recorded: vLLM, LM Studio or Ollama `/v1`, LiteLLM Proxy, one keyed relay, one deliberately wrong base URL, one keyless server, one self-signed `https://` server.
4. Docs and the progress row landed (E5).
5. One commit or commit series that does not touch the built-in provider registry files except where the union widens.
