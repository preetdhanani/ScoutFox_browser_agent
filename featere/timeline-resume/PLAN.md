# Timeline follow, picture thumbnails, and resumable chats

## Why

Three things Prit found while using the side panel (2026-11-05).

1. While a task runs, new step rows are written but the panel does not scroll to them.
2. A collapsed action group gives no hint of what the agent saw. Claude's own panel shows a small thumbnail of the captured page at the right of the collapsed group, and the full picture at the top when it is opened.
3. Prit reopened a chat from Recent tasks whose run had been cut off, typed "resume", and the agent answered that there was nothing to resume. A reopened chat is only drawn in the panel; the tab's runner keeps its own (empty) history, so the new request had no context at all.

## Findings (code map)

- `renderState` follows the bottom only when the reader was within 80 px of it before the rewrite. A step picture gets its height later (`attachShotPicture` after an async load), up to 180 px, so the next broadcast finds the view more than 80 px from the bottom and following stops for good.
- The act-group head is `<button class="act-head">` with a chevron and the headline. Step pictures are `.act-shot-slot` elements after their row, filled from `shotCache`, which holds one `<img>` per picture and moves it into the slot.
- `loadSelectedSession` only renders a saved chat (`contextReadOnly = true`); nothing reaches the background.
- Saved chats are written only on terminal states, so a run cut off by closing the browser is never saved with its last steps.
- The chat chain gives an unfinished turn only its goal and "stopped". Its plan, saved records and last steps are not in the history at all.

## Phase 1: follow the run

- The panel keeps a `followTimeline` flag, on by default and on again at New chat, a new task, and when the reader scrolls back to within 80 px of the bottom.
- It turns off only when the reader scrolls up themself (a wheel, touch or key scroll that leaves the bottom), never because content grew.
- While it is on, every render, every picture that attaches, and every thought the reader opens keep the view at the bottom.
- While it is off and new content arrives, a round "Jump to latest" button (a down arrow, like Claude's) shows above the composer. A click scrolls down and turns following on.
- The landing on a tall finish card (`finishLandingTop`) stays as it is.

## Phase 2: the captured page in the action group

- `renderTurns` finds the last step picture of a turn.
- Collapsed group: a 44 x 28 px thumbnail at the right end of the head, rounded, with a hairline border. It is decorative for screen readers; the head's label says "K actions, with a captured page".
- Opened group: a "Captured page" section at the top of the body with the picture at full width (max-height 220 px). The per-row slot of that same picture is left out, so it is not shown twice. Other pictures keep their row slots.
- `shotCache` hands each slot its own element (`cloneNode` for the second slot), so the thumbnail and the large picture never steal one `<img>`.
- A picture that is no longer kept: no thumbnail, and the section says "Picture no longer kept".
- While a turn runs, the thumbnail follows the newest picture.

## Phase 3: a chat that can be reopened and resumed

- Saved chats are written while a run goes too: on each new step, throttled to once every 3 s, with `status` kept. A chat saved while running and never finished opens as interrupted.
- The saved record also keeps the plan steps and the saved records of `save_data` (up to the same caps as the run: 500 records, 200 KB).
- Opening a chat from Recent tasks makes it the live chat of the tab: the panel sends `LOAD_CHAT { sessionId }`.
  - The runner refuses while a task runs (the panel says so).
  - It takes the saved history, plan and records as its own, adds the `partial_result` "interrupted" row when the saved run never ended, saves its snapshot and broadcasts.
  - The ring, Compact and the chain then work on the reopened chat. `contextReadOnly` goes away for a loaded chat.
- The chain gives an unfinished turn (stopped, interrupted, partial) what is needed to go on, inside the untrusted envelope:
  - its plan with done marks,
  - the number of saved records and their field names,
  - the last page URL,
  - its last 6 steps (action and a 160-character result).
- The chain header gains one sentence: "If the user asks to resume or continue, carry on the last unfinished task from where it stopped; do not start it over."
- The saved records of an unfinished turn are put back into the new run's record store, so `save_data` goes on counting and `finish records_file` writes the whole file.
- An Interrupted or Stopped card gets a "Resume" button. It starts the task "Resume the unfinished task." in the same chat, exactly like typing it.

## Tests

- Unit:
  - follow flag: content growth keeps following, a user scroll up stops it, coming back starts it, the Jump button shows only when off and new content came;
  - a picture that attaches while following scrolls to the bottom;
  - the head thumbnail and the "Captured page" section markup, no double picture, the clone for a second slot, the gone case;
  - throttled saving during a run, the saved plan and records, `LOAD_CHAT` (refused while running, history taken over, interrupted row added, snapshot written);
  - the chain of an unfinished turn (plan, records, URL, last steps, the resume sentence);
  - records restored into the new run's store.
  Each new check is confirmed to fail on code without the behaviour.
- Reproduce first: a real-model task `web-resume-chat` is added and run on LISA BEFORE the fix, to see the bug the way Prit saw it.
  - Turn 1 on `credentials.html`: the JSON file task. The harness clicks Stop like a user after the first `save_data` or after 2 steps.
  - The harness clicks New chat, opens Recent tasks, and opens that chat with real clicks.
  - It types "resume" in the composer and sends it like a user.
  - The run must finish "done" with `certifications.json` holding all ten certificates. Its first request must hold the plan of the stopped turn.
  - Before the fix this task must fail (the answer says there is nothing to resume); after it, it must pass.
- The harness also checks, on the same run, that the timeline was at the bottom after each new step row while the run went, and takes screenshots of the collapsed group with its thumbnail and the opened group with "Captured page", light and dark.

## Review (independent subagent, 2026-11-05) and what changes

- Records: the client mirrors every `save_data` into the runner; the runner keeps them in `RunSnapshot` and writes them as a `records` field on the turn's closing row (finish or partial_result, also the row `restoredRun` adds). They never ride on every broadcast.
- The background saves chats, not the panel: `notifyStateChange` is the single writer, throttled to once every 3 s and on every terminal state. The history goes through `fitSnapshot`/`slimRow`. Each chat is its own key (`sf:chat:<id>`) plus a small index; the old `saved_sessions` array is read once and migrated.
- The runner owns a `chatId`. New chat makes a new one, `LOAD_CHAT` takes the saved one, and every save goes to it, so a resumed chat stays one Recent entry.
- `LOAD_CHAT`: refused while running, paused or claimed, and refused when another runner holds the same `chatId` live. It bumps `chatGeneration`, clears pending prompts, findings, lastCall, runStats and the client, fits the history, then snapshots. The panel resets `lastRenderedStateVersion`, `turnExpandOverride` and `seenFinishKey`, as New chat does. A saved chat whose run never ended gets an interrupted row with a new reason `closed` ("The run was cut off when the browser or panel closed").
- Restored records go back into the store only when the previous turn ended unfinished, and the run state names them "restored from turn N". A test makes sure an unrelated follow-up does not include them.
- Following: a landing on the top of a tall finish card turns following off. A scrollbar drag counts as the reader scrolling, and keys typed in the composer do not. Opening a thought keeps the bottom only in the last turn.
- Root fix for the lost 80 px: the slot markup gets `aspect-ratio` from `data-w`/`data-h`, so the picture's height is reserved before it loads.
- The picture cache keeps two elements per id, `{ img, thumb }`, so nothing is cloned or decoded again per render. The "Captured page" section shows only in a finished group (a live group keeps its row pictures, so nothing jumps).
- e2e: the deterministic check is that the resume request holds the stopped turn's plan; the answer and the file are checked too. Stop is a real click. If turn 1 finished before the Stop landed, the run is inconclusive, not a pass. `followUp` gains `stopAfterSteps`, `newChat` and `reopen` steps instead of a separate driver.
- Privacy: records are capped (500 records, 200 KB per chat), deleted with the chat, and the README says they are kept in local storage.

## As built (2026-11-06)

### Reproduction first

- The real-model task `web-resume-chat` (tests/mcp/tasks.mjs) was added with the harness steps it needs, and run on LISA before any fix.
- The first try never clicked Stop: the panel was opened before the tab had a session, Chrome showed no panel there, and the fallback page in a background tab never took the click (the first turn then finished on its own).
  The harness now gives the tab its session first (a `GET_AGENT_STATE`, as the toolbar button does) and refuses a Stop surface that is not Chrome's real panel.
- The second try reproduced the bug: the Stop landed after `read_page` and `save_data`, the chat was reopened from Recent tasks, and "resume" was sent.
  The first request held only "TASK: resume" and the page, no chain at all.
  The model read "resume" as a CV and wrote a "Licenses & Certifications" section for one, with no JSON file.
- LISA made no plan on this task, so the deterministic check reads what the stopped turn left: the chain, its goal, every plan step when there is one, and the tool of each of its steps (`resumeRequestProblems`).

### Phase 1: following the run

- `followTimeline` (sidepanel.js) replaces the old "within 80 px before the rewrite" rule; content that grows never turns it off.
- It turns off on the reader's own scroll up (a wheel up, a touch, PageUp, ArrowUp, Home or Shift+Space in the timeline, or a drag of its scrollbar) and on a landing on the top of a tall finish card.
- It turns on at New chat, a new task, an opened chat, the Jump button, and any scroll back to within 80 px of the bottom.
- Every render, every picture that attaches, and every group or thought the reader opens in the newest turn keep the bottom while it is on.
- "Jump to latest" is a round button with a down arrow over the bottom of the timeline, shown only while following is off and the rendered markup changed.
- The slot markup reserves the picture's shape (`aspect-ratio` from `data-w`/`data-h`), so a picture that arrives later moves nothing below it.

### Phase 2: the captured page

- `lastShotOf(turn)` is the turn's newest picture.
- The head of a group with one carries a 44 x 28 thumbnail at its right end (`aria-hidden`); the head's label is "K actions, with a captured page".
  The thumbnail is hidden by CSS while the group is open.
- A finished group's body starts with "Captured page" and the picture (max-height 220 px); that picture's row slot is left out.
  A live group keeps its row pictures, and its thumbnail follows the newest one.
- `shotCache` keeps `{ dataUrl, img, thumb }` per picture: the thumbnail element is made once at load, so the head and the section never take one element from each other.
  A picture is fetched once even when two slots show it.
- A picture that is no longer kept: its thumbnail slot is removed and the section says "Picture no longer kept".

### Phase 3: reopen and resume

- Storage: each chat is its own key (`sf:chat:<id>`) plus an index (`sf:chats`, newest first, at most 50); `saved_sessions` is read once and moved.
  The API is `Storage.saveChat`, `getChat`, `getSessions` (the index) and `deleteSession` (the key and the index entry).
- The runner is the single writer (`ChatSaver`, chatSaver.ts): from `notifyStateChange`, throttled to one write per 3 s while a run goes and at once on every resting state.
  The history goes through `fitSnapshot` (300,000 characters for a chat).
- The runner owns `chatId` (in the state and the snapshot); New chat makes a new one, `LOAD_CHAT` takes the saved one.
  The chat's title is its first goal, so a resumed chat stays one entry under its first task.
- The client mirrors the records to the runner right after `save_data` (a Stop that lands at once still has them) and the page after each step (`noteRunData`).
  `endRun` writes them onto the closing row (`withRunData`): records on a finish or partial_result, plan and last page on a partial_result.
  `restoredRun` does the same for its interrupted row.
  Only the last closing row keeps records in a stored history.
- `LOAD_CHAT` (background.ts, `AgentRunner.loadChat`): refused while running, paused, claimed or compacting, and refused when another tab holds the chat.
  It bumps `chatGeneration`, drops the client, the holds, findings, lastCall and runStats, adds a `closed` interrupted row to a chat saved while it ran, fits the history, and broadcasts (snapshot and chat saved).
- The panel never writes a chat.
  `loadSelectedSession` sends `LOAD_CHAT` and resets the view (watermark, group and thought overrides, the finish landing, following); a refusal is a toast.
  `contextReadOnly` and the meter's read-only mode are gone.
- The chain (chatChain.ts) gives an unfinished turn (a partial_result of any reason, or rows that just end) a "Where it stopped" block inside the envelope: the plan with done marks, the number of records and their fields, the last page, and the last 6 steps with a 160-character result.
  Its header has the resume sentence.
- `restorableRecords` puts the records of an unfinished last turn back into the new run's store, and the run state says "restored from turn N".
  After a finished turn a follow-up starts empty.
- An Interrupted or Stopped card of the newest turn of a resting chat has a Resume button that sends "Resume the unfinished task." like typing it.
  The `closed` reason reads "Interrupted" with its own subtitle.

### Verification

- Unit tests: 1654 (all pass).
  New files: tests/sidepanel/timelineFollow.test.js, capturedPage.test.js, resumeCard.test.js, tests/mcp/chainResume.test.ts, resumeTask.test.js, tests/runner/chatResume.test.ts, loadChatRoute.test.ts, tests/shared/savedChats.test.ts; sessionHistory, contextWiring, contextMeter, screenshotRow, storage and client tests were updated.
- Each new check was confirmed to fail on code without its behaviour (35 mutations, each made and undone by a script).
- `web-resume-chat` on LISA after the fix: turn 1 stopped after `read_page` and `save_data`, the resume request held the chain with the stopped turn ("Saved records: 10"), the run finished "done" with a `certifications.json` of all ten certificates, the timeline followed both turns with no miss, and the smoke passed.
- LISA took no picture in either turn, so the run had no captured page to shoot (a note).
  The thumbnail, the "Captured page" section, the Resume card and the Jump button were looked at in a scratch preview of the built panel in light and dark.
