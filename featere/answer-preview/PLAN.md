# Answer preview: flowing answers, code boxes, file preview

## Why

The final answer sits in a bordered card with an orange edge.
Prit reads it as a message in a box, not as the agent's reply, so it feels less trustworthy than a chat answer.
A ```json fence in the answer shows as raw backticks and text, with no box and no copy button.
Links are plain text.
The attached file can only be downloaded, never looked at.
The model also pastes the whole file into the answer, so a 10-record file is shown twice.

## Decisions (Prit, 2026-11-05)

- Status: one small status line above the answer (icon plus "Done", amber or red icon and text for partial, failed, unverified). No card box.
- File preview: clicking a file chip opens an overlay in the panel with the file pretty-printed, JSON coloured, Copy and Download buttons, and Close.
- Duplication: when a file is attached, the answer shows at most two entries as the pattern. Code boxes longer than 15 lines fold, with a "Show all N lines" button.
- Links: http(s) links in answers are clickable and open in a new tab. Anything else stays text.

## Phase 1: the answer without a box

- CSS only on `.finish-card`: no background, no border, no edge, no padding. The class names stay, so every harness selector and unit test keeps working.
- `.finish-title` becomes a quiet status line: 12px, muted text, the icon coloured by state. Failed, blocked, unconfirmed, unverified and partial colour the icon and the title text (danger or warning), so a failure is never read as "Done".
- `.finish-body` stays readable at 13px with the panel's body font.
- The audit details, evidence, findings table and file chips stay where they are.

## Phase 2: the renderer

The blocks renderer (`parseMarkdownBlocks` / `renderMarkdownBlocks` in `sidepanel/sidepanel.js`) takes over when an answer has a heading, a table, a fenced code block, or an http(s) link.
Answers with none of these keep the legacy path byte for byte (the oracle test still holds for them).

- Fenced code: a line of three or more backticks or tildes, an optional language word, up to the matching closing fence or the end of the answer. Inside a list item the fence ends the item (no nesting).
  Rendered as `.code-box` with a head (`.code-lang` label, `.code-copy` button) and `pre.code-pre > code`.
  The text is escaped before any markup; the copy button copies the `code` element's `textContent`, so there is no second store of the text.
- JSON colouring: when the language is json/jsonc, or the fence has no language and the text parses as JSON, a linear tokenizer wraps keys, strings, numbers and true/false/null in `span.tok-*`. Each token is escaped on its own. Anything it does not recognise is copied escaped as it is. A 1 MB fence must render in well under 100 ms (unit test).
- Folding: a code box with more than 15 lines gets `.folded` (max-height with a fade) and a "Show all N lines" button that removes it.
- Links: `[text](https://...)` and bare `https://...` in paragraphs, list items and headings become `a.md-link` with `target="_blank" rel="noopener noreferrer"`. They are found on escaped text, never inside a code span or a code box. Trailing `.,;:!?)` is left out of a bare URL unless the `)` closes a `(` inside it. `javascript:`, `data:` and every other scheme stay text.
- Copy: `navigator.clipboard.writeText`, falling back to a hidden textarea and `document.execCommand('copy')`. The button shows "Copied" for 1.5 s, or "Copy failed".

## Phase 3: the file preview

- Clicking `.file-chip` opens `.file-preview` (role="dialog", aria-modal, labelled by the file name) over the panel. Header: file name, size, Copy, Download, Close. Body: the code box renderer on the file text. A JSON file is shown pretty-printed with 2 spaces when it parses, else as written. Other types are shown as written (no colouring).
- Escape and Close close it and return focus to the chip. Only one preview is open at a time.
- Download keeps the user-click Blob plus `<a download>` path (`downloadShownFile`), now from the preview's Download button.
- Copy copies the file as it is stored, not the pretty-printed text.

## Phase 4: answer does not repeat the file

- System prompt rule 6 in `src/background/mcp/client.ts` gains: when you attach records_file or files, do not paste the whole file in the answer; show at most two entries in a code block as the pattern and name the file.
- The mock's credentials answer follows it (a ```json fence with two records, plus a markdown link). If the system prompt lacks the rule, the mock pastes all ten records, so the harness check fails.

## Tests and harness

- Unit (`tests/sidepanelMarkdown.test.js`): fences (languages, tildes, unclosed, inside a list, hostile text), JSON token spans and escaping, folding threshold, links (markdown, bare, trailing punctuation, parentheses, javascript:/data: stay text, never inside code), legacy path untouched for plain answers, speed on a 1 MB fence.
- Harness (`tests/e2e/smoke.mjs`), credentials-json and web-credentials-json:
  - the answer has a `.code-box` with a `.code-copy` button; on the mock its language is json and it has `.tok-key` spans;
  - the card computes no border and no background (it is not a box);
  - the chip opens `.file-preview`, its text holds every certificate name, Copy puts the stored file on the clipboard (CDP clipboard permission), Download saves the file, Escape closes it;
  - the answer lists at most two credential URLs (the file is not repeated).
- Screenshots: the answer, a folded code box, and the open preview, light and dark.
- Tampers (`tests/e2e/lib/extensionCopy.mjs`):
  - `no-code-box`: the fence parser is turned off. The code box check fails.
  - `chip-downloads`: the chip downloads directly. The preview check fails.
  - `answer-repeats-file`: the prompt rule is removed. The mock pastes all records and the repeat check fails.
- Both layers run: unit tests, mock self-test, mock e2e, every new tamper, and the real-model run on NVIDIA NIM (LISA is down).

## Review (independent subagent, 2026-11-05) and what changes

- Existing unit tests that pin the old behaviour are updated on purpose: PLAIN corpus entries with a link or a fence move to the blocks list, "links are never rendered" becomes the new link test, and the visible-text helpers skip the code head and the fold button.
- The findings table is hidden only when the parser saw a real table (`hasTable`), not when the answer has a `|` and some block.
- Links are found on the RAW text with a whitelist (no whitespace, `<>"'` or backtick), then text and href are escaped separately. Table cells use the same link function.
- Inside a fence every other matcher is skipped. The fence is checked first, before heading, table, list item and list continuation. The info string is shown as escaped text only, cut to 20 characters.
- Re-renders replace the timeline: fold state lives in a Set keyed by turn and block index, and the preview is a native `<dialog>` on `document.body`, outside the timeline. Close returns focus by looking the chip up again by its key.
- Rule 6 is reworded: a fenced json block of at most two entries is fine, the answer itself is never a JSON object. The chip's title says "Preview".
- The repeat check is hard on the mock and a warning on real-model runs.
- Clipboard in the harness: grant clipboard permission over CDP, check the button reached "Copied", read the clipboard back; a read that the headless browser refuses is a warning.
- Tamper anchors are literal strings in the built bundle, each checked to match once.
- JSON colouring tries `JSON.parse` only when the trimmed text starts with `{` or `[`, and the rendered box is cached by text.
- `<dialog>` with showModal gives Escape, the focus trap and the backdrop for free.

## As built

- Long code lines scroll sideways inside the box, as in a Claude chat. Wrapping them was tried and dropped: a wrapped JSON line loses its indentation and can leave a lone quote on its own line.
- The page reset sets every margin to 0, so the preview dialog sets `margin: auto` itself to stay centred.
- The status line of a successful run uses the success colour for its icon; every other ending colours the icon and the words.
- The self-test's walk carries the attached-file line in its system message, and a negative walk without it must fail on the repeated URLs.
- The harness reads the clipboard back after Copy (permission granted over CDP); if the browser refuses the read, it prints a note and relies on the "Copied" label.
