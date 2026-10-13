# UI spec: Add custom endpoint
## Field by field, from the supplied mock

Parent: [PRD.md](PRD.md) · Requirements: [USER_REQUIREMENTS.md](USER_REQUIREMENTS.md)
This file is the contract between the mock and the implementation.
Where the mock shows a value, that value is the placeholder or the example, not a default to store.

---

## 1. Where it lives

| Mock heading | Implementation |
|---|---|
| "Third-party model provider" | Section header inside the Add dialog, opened from the **Custom endpoint** entry at the end of the `providerSelect` dropdown |
| "Custom model API" | Dialog title |
| "Connect a relay, a self-hosted server, or any other OpenAI- or Anthropic-compatible endpoint by its base URL, protocol, and models." | Dialog sub-title, one paragraph, no more |

Why a dialog rather than extending the Settings form: the eight built-in providers keep their current form untouched ([`sidepanel.html:149-206`](../../sidepanel/sidepanel.html)), the P8 tree has its own guards around that file, and Add is a modal action with a clear done state.
See PRD open question O6.

Layout order is exactly the mock's order:
Provider ID, Display name, Base URL, API protocol, API key, Models, then the Add and Cancel row.
Each field stacks one per row at panel widths from 320 px up.

---

## 2. Field spec

### 2.1 Provider ID

| Aspect | Spec |
|---|---|
| Mock label | `Provider ID` |
| Mock value | `acme-gateway` |
| Mock helper | "Lowercase identifier, starting with a letter, that uniquely names this provider in requests and as its credential name." |
| Control | Text input, monospace, 32 max, no autocorrect |
| Stored as | `customProviders[id].id`, and as the key of `providerConfigs[id]` |
| Validation | `^[a-z][a-z0-9-]{1,31}$`, unique against built-ins and custom, not editable after Add |
| Error text | Rule quoted in full, then "Got `Acme_Gateway`." |
| Notes | The helper line must say the same thing the validator enforces. The mock says "starting with a letter" but not the character set, so the helper gains the set: lowercase letters, digits, and dashes |

The helper line and the error line are the same sentence in the same order, so a user never reads a rule the form does not apply.

### 2.2 Display name

| Aspect | Spec |
|---|---|
| Mock label | `Display name` |
| Mock placeholder | `Display name` |
| Control | Text input, 64 max |
| Default | The host of Base URL, filled only while the field is untouched |
| Validation | Optional; empty at save falls back to the host |
| Where shown | Dropdown option, header pill, timeline rows, saved session label |

### 2.3 Base URL

| Aspect | Spec |
|---|---|
| Mock label | `Base URL` |
| Mock value | `https://gateway.example/v1` |
| Control | Text input, monospace, spellcheck off |
| Validation | Parses, scheme `http:` or `https:` |
| Required | Yes |
| Below the field | Two live lines, the request preview: `Chat request:` full URL, `Model list:` full URL. Both from the same function the sender uses (A4) |
| Warning states | `http://` on a non-private host: one amber line, still addable. A path with a version segment already present: neutral line explaining that nothing is appended |

The preview is the whole reason this field is trustworthy, since [`withV1`](../../src/background/llm/settings.ts) appends `/v1` today and Anthropic-style bases end differently.
A user must see the URL before saving, not after a 404 in the Logs tab.

### 2.4 API protocol

| Aspect | Spec |
|---|---|
| Mock label | `API protocol` |
| Mock value | `OpenAI Chat Completions` selected |
| Control | Two-segment control, `role="radiogroup"`, arrow keys move, focus visible |
| Segment 1 | **OpenAI Chat Completions** · sub-copy `POST {base}/chat/completions` · `Authorization: Bearer <key>` |
| Segment 2 | **Anthropic Messages** · sub-copy `POST {base}/v1/messages` · `x-api-key` + `anthropic-version: 2023-06-01` |
| Default | Segment 1 |
| Stored as | `protocol: 'openai' \| 'anthropic'` |
| On change | Recompute the preview, and the model-list URL |

The mock shows one option with a chevron, which reads as a longer dropdown.
Two segments with the path and header spelled out is better here, because the whole decision is which path and which header.

### 2.5 API key

| Aspect | Spec |
|---|---|
| Mock label | `API key` |
| Mock placeholder | `Enter your API key` |
| Control | `type="password"` with a reveal toggle, `autocomplete="off"`, `spellcheck="false"` |
| Required | No. The mock's own design proves it: Add is enabled, Test shows a spinner, and the Models row already reads "No models will be shown in the selector", so the dialog was drawn with no key |
| Copy under the field | "Optional for local and allowlisted servers. No `Authorization` header is sent when it is empty." |
| Stored in | `providerConfigs[id].apiKey`, never in the descriptor (PRD 4.1) |
| Trim rules | Leading `Bearer ` and wrapping quotes are stripped on save, the same cleanup as the built-ins ([`settings.ts:34-37`](../../src/background/llm/settings.ts)) |
| Erased when | The endpoint origin changes (C1) |
| Never | Written to the Logs tab, an error message, or a saved session |

### 2.6 Models

| Mock element | Implementation |
|---|---|
| `Models` label | Section label, group of the list plus its controls |
| `Fetch available models` | Text button with a spinner while in flight. Disabled while the URL is invalid, with the tooltip naming the reason |
| `No models will be shown in the selector. Unlisted IDs can still be sent directly.` | The empty state. It is the whole promise of the feature, so it stays verbatim |
| `Add model` | Text button appending an id typed into the small input beside it. Disabled on an empty or duplicate value, with the reason inline |

Fetch behaviour, matching the mock's two-state line:

| Result | Line shown |
|---|---|
| Success, N ids | `Fetched N model(s) (842ms). Review, remove, or add ids.` plus the count filtered as non-chat when N differs |
| Success, 0 usable | `The endpoint returned no chat models. Add ids by hand.` |
| 404 or 405 | `This endpoint has no model list. Add ids by hand, and Test still works.` |
| 401 or 403 | `The endpoint refused the key (401). Check the key, or use No key if this server does not need one.` |
| Network failure | `Could not reach <host>: <reason>. You can still add by hand.` |
| Timeout | `Timed out after <effective timeout>. Raise it in Settings if this gateway is slow.` |

Every failure keeps Add enabled, and the error body is truncated to one line with the full text only in the Logs tab, with the key scrubbed.

List rows after fetch: id in monospace, a remove control, a `Added by hand` tag on hand-typed rows, and the count in the section header.
No reordering in this version.
The picker shows the saved order.

### 2.7 Actions

| Control | Enabled when | Does |
|---|---|---|
| `Test` | The Base URL parses | Section A7. Shows a spinner, then a status line, never blocks Add |
| `Add` | Id valid and unique, Base URL parses, protocol known | Saves, selects the provider, closes, one toast, and jumps to the model picker if ids came back |
| `Cancel` | Always | Aborts an in-flight Test or fetch, closes, writes nothing |
| `Save changes` (edit mode) | Same as Add, id locked | Same, and applies the origin rule C1 |

`Add` is enabled without a Test run and without a key, exactly as the mock draws it.

---

## 3. State machine of the dialog

```
idle ──typing──▶ dirty ──Add──▶ saving ──ok──▶ closed(selected)
                    │                └──storage rejected──▶ dirty + error line
                    └──Test──▶ testing ──▶ tested(result line, still dirty)
```

Rules:

1. Nothing is written to storage until Add, so Cancel is free.
   This matters because the existing panel autosaves on every field change (`autoSaveCurrentForm` at [`sidepanel.js:449`](../../sidepanel/sidepanel.js), wired to the inputs at lines 853 and 938 to 959), and a half-typed URL must not become a saved provider.
2. An in-flight Test or fetch is aborted on close, on protocol change, and on a Base URL change, so a late answer cannot overwrite a newer form.
3. The dialog is one component with one state object, so the preview, the Test button, and Add all read the same validated values.

---

## 4. Changes this UI needs in existing files

| File | Change |
|---|---|
| [`sidepanel/sidepanel.html:150-158`](../../sidepanel/sidepanel.html) | Keep the eight literal options. Append `<option value="__custom">Custom endpoint…</option>`. No new option is hard-coded for a user's provider |
| [`sidepanel/sidepanel.js`](../../sidepanel/sidepanel.js) | Build options from built-ins plus `settings.customProviders` **before** assigning `select.value`, since an option that is not in the DOM leaves `select.value === ''` (the header comment at lines 46 to 50 documents this trap for the model picker). Replace the eleven `DEFAULT_PROVIDER_CONFIGS[...]` reads (lines 234, 237, 238, 243, 472, 523, 977, 984, 985, 989, 992) with a resolver that covers both sources |
| [`src/shared/storage.ts:15-65`](../../src/shared/storage.ts) | Add `CustomProvider`, `ProviderProtocol`, `customProviders` on `Settings`, and CRUD helpers. `DEFAULT_PROVIDER_CONFIGS` stays the built-in registry |
| [`src/background/llm/types.ts:47-51`](../../src/background/llm/types.ts) | Widen past the closed union. `ChatProvider` remains the built-in list; the call path takes a descriptor |
| [`src/background/llm/factory.ts:196-213,244-267,320-326`](../../src/background/llm/factory.ts) | Accept a descriptor. `anthropicCall` currently has **no** custom base URL support at all (it always hits `api.anthropic.com`), which is the work the Anthropic protocol needs |
| [`src/background/llm/settings.ts:50-53,88-103`](../../src/background/llm/settings.ts) | Protocol-aware base URL rule (replacing a blanket `/v1` append), plus a custom-provider timeout branch |
| [`src/background/llm/models.ts:32-80,85-225`](../../src/background/llm/models.ts) | A branch for custom providers, and `getFallbackModels` returning `[]` instead of the current `default` arm, which returns `gemini-*` and `qwen2.5:14b` |
| [`src/background/background.ts:750-759`](../../src/background/background.ts) | `FETCH_MODELS` already forwards its payload, so the descriptor rides along. On failure it must send back `[]` for a custom provider, not `getFallbackModels(payload.provider)` |
| [`public/manifest.json`](../../public/manifest.json) | No change. `host_permissions: ["<all_urls>"]` already covers a user-typed endpoint |

---

## 5. Copy

The mock's wording is kept wherever it is already right. Additions:

| Place | Copy |
|---|---|
| Dropdown entry | `Custom endpoint…` |
| Dialog title | `Custom model API` |
| Sub-title | `Connect a relay, a self-hosted server, or any other OpenAI- or Anthropic-compatible endpoint by its base URL, protocol, and models.` |
| Key helper | `Optional for local and allowlisted servers. No Authorization header is sent when it is empty.` |
| Key erased (C1) | `The host changed, so the key was removed. Paste it again to send it to the new host.` |
| Wrong host (C2) | `The endpoint redirected to <host>, which is not <configured host>. ScoutFox did not follow it.` |
| Provider deleted elsewhere | `Provider <id> is no longer configured, so ScoutFox switched to <fallback>.` |
| Toast after Add | `Provider <display name> added.` |
| Chat error (B3) | `<display name> (<protocol>) returned <status> at <url>: <server message>` |

---

## 6. Visual rules

1. Existing `--surface` tokens and Studio Mono styling, dark and light, matching Phase P6.
2. The segmented control reuses the effort-selector pattern, so six controls do not become two dialects of one control.
3. Monospace for provider id, base URL, and model ids.
4. At 320 px: one field per row, buttons on their own row, model rows truncate the id with a tooltip rather than wrapping.
5. The dialog scrolls inside the panel height; the panel itself never scrolls sideways.
6. A validation error sits under its field in the error colour and is also reachable by keyboard order, since colour alone is not an announcement.
7. The Test status line keeps its height while running, so a spinner does not shift the Models section (N6).

---

## 7. What the mock leaves open, answered

| Mock detail | Answer, and where it is decided |
|---|---|
| `Provider ID` is filled while `Display name` is a placeholder | Id is required, name is optional and derived. A2, A3 |
| No "No key" affordance, but Add looks enabled | Key is optional with a helper line naming why. A6 |
| `API protocol` shown as one value with a chevron | Two segments naming path and header. A5 |
| No Test button visible in the crop | Test exists, is optional before Add. A7 |
| No list of already-added providers | Needed for Edit and Delete, and for the cap. A8, A9 |
| Empty-state line only | Also needed: fetch errors, filtered count, `Added by hand` tag |
| No request preview | Added, because the `/v1` rule and the Anthropic path are both guesswork without it. A4 |
| Where in Settings this opens from | The dropdown's last entry, so "add a provider" is found where providers are chosen. O6 |
