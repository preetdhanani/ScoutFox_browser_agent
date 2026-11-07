# Agent cognition: see the data, remember, judge progress, deliver

Status: implemented (all four phases), reviewed before the test run.
See "As built" at the end for where the build differs from this plan.
Owner: Prit.

## The problem

A user asked Tarka, on their LinkedIn certifications page, for a JSON file with each certificate's name, issue date and credential URL.
Run 1 took 16 steps of `find` for one certificate name after another and was stopped.
Run 2 took 74 steps: it read every "Show credential" link, every "Edit" button, then the nav bar, the Premium ad, the messaging overlay and the footer, one element at a time.
It never finished.

The engine gave the model no way to see what it needed, no compact view of where the task stands, no signal that it was not moving, and no allowed way to deliver the result.

## Root causes (from the code)

1. The data was invisible.
   `read_page` returns rendered text (`src/content/pageText.ts:55`, `readableText` for one element in `src/content/actions.ts:356`, `extractFullPageText` for the whole page in `actions.ts:362`), which has no link targets.
   A link to another site shows only `domain="credly.com"` in the element list (`src/content/perception.ts:348`).
   No tool could show the credential URL, so the model searched for it forever.
2. The model has no view of where the task stands.
   It sees each step's `reason` (the tool arguments stay in the history, `client.ts:540`), but nothing says what was collected, which plan steps are done, or how long it has gone without progress.
   The plan checklist advances by one on every successful tool call (`advancePlanChecklist`, `client.ts:874`), whatever the call did.
3. Progress is measured as page change, not task progress.
   A read that returns new text counts as progress (`src/background/mcp/progress.ts:203`), so reading element 41, 42, 43 never trips the reflection.
4. There is no way to deliver a file.
   No tool writes one, and the system prompt forbids raw JSON in the answer (`client.ts:449-451`).
5. The context only grows.
   Only pictures are trimmed (`trimPictures`), so every old tool result is re-sent every round.

## Principles

- Fix the engine for every task, never for LinkedIn or for one held-out task.
- Facts come from the harness (measured), judgments from the model, and the loop only escalates.
- Page-derived text, URLs included, only ever reaches the model inside the untrusted envelope.
- Each phase lands alone, with unit tests, a mock scenario, a harness scenario and a tamper that proves the check can fail.
- The wire protocol changes in phases 2 and 4: the mock and its validator change in the same commit.

## Phase 1: show link targets in reads

Goal: any URL a user could click is visible to the model when it reads the part of the page that holds it.

Design: the text itself stays exactly as today (`innerText`, `extractFullPageText`, collapse, paging, editor and raw-text handling untouched).
Each `read_page` result gets a links block after the text of that part, inside the same untrusted envelope:

```
Links in this part:
- Show credential (Implement advanced multi-agent orchestration): https://www.credly.com/badges/...
- Show credential (AZ-400: Development for ...): https://learn.microsoft.com/...
```

Changes:

- `src/content/pageText.ts`: `linksOf(container)` collects visible `<a href>` elements: absolute URL, label = link text, else `aria-label`, plus the nearest heading or list item title when the label repeats (so ten "Show credential" links are told apart).
  - Left out: `javascript:`, fragment-only links, links whose label is the URL itself (the URL is already in the text), hidden links.
  - Deduplicated by URL; a URL over 300 characters keeps host and path and cuts the query with a marker.
  - Quotes, brackets and newlines in labels and URLs are escaped.
- Paging: each link is assigned to the part whose text contains its label (first occurrence), so part 3 lists the links of part 3; unplaced links go to the last part.
  At most 60 links per part; the block says how many more there are.
- `read_page` with `element_id` lists the links inside that element.
- Frames: each frame agent returns its own links with its text (`readFrameTexts`).
- Not changed: the element lines (`perception.ts` keeps `domain=` only, so no attacker-controlled query string appears outside the envelope), the change signatures (`sig.textHash`, `server.ts:599`, so rotating tracking parameters never look like a page change), the observation text (`server.ts:838`) and the 2000-character opening preview.
- The "Same text as your last read" hash (`server.ts:392`) covers text and links together.

Tests:

- Unit: `tests/content/pageTextExtractor.test.ts` for relative, cross-site, hidden, `javascript:`, repeated label with context, over-long and escaped links, the per-part assignment and the 60 cap.
- Unit: the existing parity and paging tests stay green unchanged, which shows the text is untouched.
- Fixture `tests/fixtures/site/credentials.html`: a certifications section shaped like a profile page.
  Ten items with name, issuer, "Issued <month year>", a "Show credential" link to another site (several hosts, one with a long query string) and an "Edit" button.
  Around it a nav bar, a promo box, a messaging overlay and a footer with many links, so wandering is possible.
- Mock goal `extract-records` (`tests/mcp/mockOllama.mjs`): `read_page`, then `finish` with the records as a table.
  It answers `MOCK-FAIL` when a credential URL is missing from what it read.
  Selftest: the walk with links stripped must fail.
- Harness task `credentials-json` (mock) on `credentials.html`; the check needs all ten URLs exactly.
- Real-model task `web-credentials-json` (local fixture, like `web-notebook-fix`).
- Tamper `no-link-targets`: the temp copy's content script returns no links block; the run must exit 1 with `MOCK-FAIL`.

## Phase 2: run state, plan marks, saved data, compact context

Goal: every round the model sees where the task stands, and a long run sends a bounded context.

Changes:

- `reason` is required on every tool except `finish`.
  New description: "One or two sentences: what the last result told you, and why this step comes next."
  The server never refuses a call for a missing `reason`; the client logs it.
  The panel already shows it as the row's "why" (`sidepanel.js:2874`).
- The model's free text next to tool calls is NOT kept: every provider path drops it today (`src/background/llm/index.ts:362-374`, `:483-496`, `:603-604`), many models emit none, and `reason` already carries the step's thinking.
- `update_plan`:
  - `plan` becomes optional when `done` is given; `done: integer[]` lists finished steps (1-based).
  - Same step texts (or no `plan`): the done marks are merged, nothing resets, no approval is asked again.
  - Changed step texts: today's behaviour (reset, and in manual mode ask the user).
  - `advancePlanChecklist` is removed. `finish` with outcome `done` marks every step done, so the panel's "x of y" (`sidepanel.js:2761`) ends right for models that never mark steps.
- New tool `save_data {records: object[], reason}`.
  The client keeps the run's records, deduplicated by a stable JSON of each record.
  The result is a fact line: "Saved 3 new records (10 in total). Fields: name, issued, url. Empty: url in 2 records."
  Caps: 500 records and 200 KB; above that the call is refused with the reason.
  The panel shows a row "Saved 3 records (10 in total)".
- Run state, request-only.
  In `requestModel`, next to `trimPictures`, the text below is appended to the content of the LAST message of the request (the last tool result, or the last note), never as a new message.
  Message order, tool-call pairing, strict turn alternation and the mock's `tail` and `notes` stay exactly as today; only the tail of the request differs, which caching already tolerates.
  ```
  [Run state] Goal: <task>
  Plan: 1 [done] ..., 2 [ ] ...
  Collected: 10 records (fields: name, issued, url; empty: url in 2)
  Steps: 14 of 250. Steps since the last progress: 6.
  ```
  When the last message carries a picture (content blocks), the state goes in a text block appended to it.
- Context compaction, in blocks so the cache is broken rarely.
  When tool results older than 12 rounds exist, every tool result older than the last 6 rounds becomes one head line, with no page body: `[earlier result, shortened] Page text (part 2 of 5). Run the call again if you need it.`
  The head is taken before the untrusted envelope, so no envelope is ever cut open.
  Only content changes; no message is added or removed.
  A re-read of a compacted result is marked by the client so phase 3 does not count it as a repeat.
- System prompt, a short THINK section, no site names: "Before each step, compare the goal with what you have. Say in reason what the last result gave you. If the data you need is not in what the tools show, say so and finish with outcome partial. For lists: read the section (links are listed under the text), save the records with save_data, then finish."

Tests:

- Unit `tests/mcp/client.test.ts`: the run state is in the request and not in `messageHistory`, attached to the last message (text and picture cases), pairing intact; done marks merge without re-approval in manual mode; changed texts re-ask; finish `done` marks all; `save_data` dedup, caps and fact line; compaction triggers at 12, shortens to 6, keeps heads only, pairing intact, stable between triggers.
- Mock: `validateToolArgs` (`mockOllama.mjs:239`) is extended to object arrays, integer arrays and nested objects, with selftest cases that a wrong shape is caught.
  Every scripted reply gets a `reason`.
  `readConversation` exposes `runState` (parsed from the tail) and the records count.
  `extract-records` becomes `read_page`, `save_data`, `update_plan {done}`, `finish`, and answers `MOCK-FAIL` if the run state does not show ten records before it finishes.
  A new long mock goal `long-read` (20 rounds of reading parts) exposes the request size per round.
- Harness:
  - `credentials-json`: the panel shows the "Saved 10 records" row, every action row has a "why", and the plan checklist shows the done marks in the DOM.
  - `long-read`: request characters (the mock's characters / 4 token estimate, `mockOllama.mjs:828`) stay within 10% between compactions and drop at each compaction.
  - `stuck-recovery` and `stuck-recovery-manual` re-verified: the reflection is still the last message's own text after the tool block.
- Tampers:
  - `no-run-state`: the run state is not appended; the mock answers `MOCK-FAIL`.
  - `plan-marks-ignored`: `update_plan {done}` changes nothing; the checklist check fails.
  - `no-compaction`: `long-read` fails the size check.

## Phase 3: progress is task progress

Goal: wandering is noticed within a few steps, said plainly, and ended honestly if it goes on.

Changes in `src/background/mcp/progress.ts` (stays pure; `record` gets the page URL as a new input):

- Task progress:
  - `save_data` that added a new record,
  - `update_plan` that marked a new step done,
  - an action whose Observation shows the page changed (today's rule),
  - `navigate`, or a click that changed the URL,
  - `read_page` of a part not read before at this URL,
  - `web_search` with a new query, `fetch_url` of a new URL (information gain on the open web).
- No progress: `find`, `get_page_elements`, `read_page` with `element_id`, `take_screenshot`, quiet actions, and any repeated read target.
  A re-read of a compacted result (phase 2) is neutral: it neither counts nor resets.
- Stall 1: `STALL_AT = 8` no-progress steps in a row.
  The next request gets its own note (`STALL_TEXT`), as a loop note like the reflection: "You have taken 8 steps without new data or a finished plan step. Say in reason what you are looking for and whether the tools can show it. Then save what you have, mark plan steps done, take a different approach, or finish with outcome partial."
- Stall 2: another `STALL_AT` no-progress steps after stall 1.
  The next round offers only `finish`, with its own note (`STALL_END_TEXT`) and its own fallback answer ("The run stopped: it made no progress for 16 steps."), never the step-limit text.
  An outcome left out becomes `partial`.
  The log and the panel name it a stall, not a step limit.
- The repeat hint and reflection stay as they are.
  If a step would trigger both the reflection and stall 1, only the reflection is sent, so `stuck-recovery` (budget of 10 steps, `tasks.mjs:196`) is unchanged.

Tests:

- Unit `tests/mcp/progress.test.ts`: each progress kind, the reset, stall 1, stall 2, part coverage per URL, compacted re-reads neutral, reflection wins over stall 1.
- Mock goal `unreachable-field` on `credentials.html` (asks for an expiry date the page never shows): reads elements one by one like run 2, stops only on the stall note, finishes `partial` naming the missing field.
  Harness task `stall-wander`: ends with a "Partly done" card within 20 steps, `loopNotes` holds `STALL_TEXT`.
- Mock goal `stall-recover`: on the stall note it calls `save_data` and goes on to finish `done`.
  Harness task `stall-recover`: ends "Done" and `loopNotes` holds `STALL_TEXT` exactly once, which shows stall 1 is a nudge, not an end.
- Tamper `no-stall-guard`: no stall note; `stall-wander` runs into the harness loop guard or timeout and exits 1.
- Real model: `web-research-archive` and the held-out set must not show `STALL_TEXT` on a successful run; if they do, `STALL_AT` is the knob.

## Phase 4: deliver files

Goal: a request for a file ends with that file.

Changes:

- `finish` gets:
  - `records_file: "name.json"` (or `.csv`): the client writes the records saved with `save_data` into that file. This is how large files are made: no model copies hundreds of records by hand.
  - `files: [{name, content, mime?}]` for small hand-written files: at most 3 files and 20 KB in total (a model reply is capped at 8192 tokens, `index.ts:432`).
  - A `.json` file must parse; if not, the call is answered like a missing outcome ("Error: files[0] is not valid JSON at line 4. Call finish again with valid JSON.") and the run goes on.
- Storage:
  - The finish row keeps the files (see "As built").
  - The log records file names and sizes only, never the content (`client.ts:648` logs full arguments today; `files` is replaced there by a summary).
- Side panel finish card (`sidepanel/cards.js`): one chip per file, name and size; a click builds a Blob and downloads it with an `<a download>`.
  The download is always the user's click.
  Light and dark styles.
- System prompt rule 6: "The answer is prose for a person. Structured data goes in table, or in a file (records_file or files) when the user asks for a file or a format." The "never raw JSON" rule stays for the answer field only.
- Cut from the first draft: the optional `finish.checklist` (a refusal path for little gain).

Harness infrastructure (new, planned explicitly):

- The temp profile gets a download folder through CDP `Browser.setDownloadBehavior` (`behavior: allowAndName`, `eventsEnabled: true`), and the harness waits for `Browser.downloadProgress` `completed`.
- A helper in `tests/e2e/lib/downloads.mjs` clicks a chip in the real side panel like a user and returns the saved file's path and content.

Tests:

- Unit: `tests/mcp/historyEntries.test.ts` for files in the finish entry and the 64 KB rule; `tests/mcp/client.test.ts` for `records_file`, the JSON refusal, the 20 KB cap and the log summary; `tests/runSnapshot*` for a finish row with files under the snapshot cap.
- Mock: `extract-records` finishes with `records_file: "certifications.json"`.
  Mock goal `bad-json`: finishes first with broken JSON in `files`, must get the refusal, then sends valid JSON.
- Harness `credentials-json`: the card shows the chip (light, dark, close-up); the harness clicks it; the file must parse and hold all ten records with their URLs.
- Harness `bad-json`: `toolResults` hold the JSON refusal, and the final file parses.
- Tampers:
  - `files-not-stored`: `finishEntry` drops files; no chip, exit 1.
  - `no-json-check`: the refusal is skipped; `bad-json` downloads an unparsable file, exit 1.

## Order and size

| Phase | Depends on | Size | Value |
| --- | --- | --- | --- |
| 1 Link targets in reads | none | small | unblocks every "get the links" task |
| 2 Run state, plan marks, saved data, compaction | none | medium | the model sees where the task stands; bounded cost |
| 3 Task progress | 2 | small | ends wandering honestly |
| 4 Files | 2 | medium | file requests become possible |

Phases 1 and 2 touch different files and can be built in parallel; 3 and 4 after 2.

## Verification of each phase (AGENTS.md)

- Layer 1: `node tests/mcp/mockOllama.selftest.mjs` walks the new and changed goals, and the stripped-input walks fail with `MOCK-FAIL`.
- Layer 2: `npm run test:e2e:mock` with the new tasks and tampers, then `npm run test:e2e` on LISA (each task once, no `--repeat`), then `-- --held-out`.
- Screenshots of every task in light and dark, including the new rows, checklist marks and file chips.
- A phase is done only when both layers are green and every new tamper exits 1.
- After the last phase, one `--sealed` run for verdicts and numbers only.

## Open questions

- 60 links per part and the label-based part assignment are first choices; phase 1 measures them on `credentials.html` and two recorded real pages (`tests/e2e/lib/realCorpus.mjs`).
- `STALL_AT = 8` is a first guess; phase 3 measures it on the regular and held-out tasks.

## Review

An independent subagent reviewed the first draft against the code (2026-11-05).
Its findings are folded in above:

- Keeping the model's free text was dropped: every provider path discards it today, and `reason` already round-trips.
- The run state rides on the last message instead of a new user message, which would have broken `stuck-recovery`'s tail check, polluted `loopNotes`, and put user turns back to back on strict chat templates.
- Stall 2 has its own note and fallback, not the step-limit path.
- Links moved from inline markdown to a per-part block inside the envelope, so the text, the collapse of repeats, the change signatures and the observations stay untouched, and no full URL appears in the unwrapped element lines.
- `update_plan` merges done marks without reset or re-approval; `finish` done marks every step.
- New URLs and queries count as progress, so open-web research is not ended as a stall.
- Compaction runs in blocks (12, then down to 6), shortens to heads only, and compacted re-reads are neutral.
- Hand-written files are capped at 20 KB and large files come from `records_file`; snapshot and log sizes are bounded; the harness download handling is planned.
- The mock validator is extended to the new argument shapes; new scenarios and tampers cover plan marks, stall recovery and the JSON refusal; the optional checklist was cut.

## As built

- The files of a finish stay in the finish row whole.
  The caps keep them small enough for the run snapshot (`RUN_SNAPSHOT_MAX_CHARS`, 800 000): at most 200 KB of saved records, and 20 KB of hand-written files.
  The plan's second store in the client's memory for files over 64 KB was not built: with these caps it would only add a second path to keep in step.
- A stall resets on any task progress, so a run that recovers can stall again later and gets the note again; only two stalls in a row end the run.
- Reading one link element lists that link's own target too, so a model that reads a "Show credential" link by id sees where it goes.
- The pure parts of the client (`formatRunState`, `withRunState`, `compactToolResults`, `saveRecords`, `buildFinishFiles`) are exported, and the mock's self-test walk uses them, so the walk checks the client's own logic instead of a copy of it.
- `credentials.json` was first generated from the fixture with the Node fake DOM; `node tests/e2e/smoke.mjs --dump-snapshots=credentials` records the real one from Chromium.
