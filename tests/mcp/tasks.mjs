/**
 * The smoke tasks: the real-model e2e tasks, where a real model (LISA by default) acts in a real
 * Chromium through the built extension. The open-web ones start on a neutral page and give only a
 * question, and the model picks and opens every real website itself. Three run on local fixture pages
 * (tests/fixtures/site/notebook.html and credentials.html) that only a real model can do justice; one
 * of them (web-chat-chain) has a second turn in the same chat.
 * Every task has a `check` that reads the facts of the run (the final answer first) and says whether
 * the run was right, so a run that "finishes" with a wrong answer is not a pass.
 *
 * What a run is, for these checks (runFacts below builds it from what the MCP engine leaves behind: the
 * history of the panel, the plan rows, the calls the model got, and the messages the engine sent to the page):
 *   rows         the history rows of the last turn, as the panel got them (the raw material of everything below)
 *   duplicateRows  how many of them are an exact copy of an earlier row. Everything below is read from the rows
 *                without the copies, and this number is only reported, never a failure
 *   outcome      'finish' or 'partial_result', or null (no final entry)
 *   answer       the text the user reads under that final entry
 *   failed       true when a step of this turn failed (a failed execution_result, or an error row)
 *   plan         the plan rows of the final state: { text, status }
 *   steps        the model's tool calls: { step, action, raw, result }. action is the mapped action object the
 *                panel renders (mapToolToAction in src/background/mcp/historyEntries.ts); update_plan has no
 *                action row, it is the plan checklist
 *   calls        the model calls: { total, byNode }
 *   toolResults  every tool result the model was sent, in full, in order (from the call records: a history row
 *                is cut to one line, so what the model really read is checked here)
 *   loopNotes    the notes the loop added after a tool block (the reflection, the step limit), in order
 *   pageMessages what the engine sent to the page, by message name (null when the harness could not count)
 *   cdpCommands  what the engine sent over the debugger, by method (null when the harness could not count)
 *
 * A task can also carry:
 *   expectLogs  true = the Logs tab is read after the run: model calls and steps as JSON trees, no plumbing
 *   restartWorker  true = after the run the harness stops the service worker, wakes a new one, and
 *               the real side panel must still show the finished run
 *   web         true = a real-model task: an open-web task (a neutral start page and only a question), or
 *               a local fixture task (web-notebook-fix, web-credentials-json, web-chat-chain). The default set of a run
 *   heldOut     true = a held-out open-web task: run only with --held-out, never tuned against
 *   sealed      true = a sealed open-web task: run only with --sealed, which shows its verdict and numbers
 *               but never its trace (see the sealed tasks below)
 *   expectOutcome  the final entry the run must end with (default 'finish')
 *   expectFinishOutcome  the outcome the model must name in finish (default 'done' for a web task, none
 *               otherwise; see lib/metrics.mjs). A right-looking answer the model calls "partial" fails
 *   expectCard  what the final card of the side panel must show: { title, classes, body, noBody }
 *   answers     the answers to questions the run asks the user: [{ match: RegExp, answer: string }]
 *   pending     a reason: the task is skipped and does not count as a failure. Its data stays for the stage that
 *               brings it back
 *   expectPage  async (puppeteer page) => problems: evidence the page itself gives after the run (a
 *               cookie its own button set), read before the tab closes.
 *   warn        (run) => notes: printed with the report, never a failure
 *   reachable   addresses a real-model task needs: the harness checks them first and skips the task (not a failure)
 *               when one does not answer, so an offline machine or a site outage never reads as an agent bug
 *   timeoutMs   the task's own time limit (--timeout overrides it)
 *   followUp    a second turn in the same tab and the same chat, after the first one ended (see the
 *               web-chat-chain task): { compact, navigate, prompt, check, noReads, timeoutMs }
 *                 compact   true = before the second turn the harness opens the context ring's card in
 *                           the real side panel and clicks "Compact chat", like a user, and waits for the
 *                           "Chat compacted" row; the second turn's first request must then hold the summary
 *                 navigate  a fixture page the tab is sent to before the second turn (a page without the fact)
 *                 prompt    the second turn's prompt
 *                 check     (run) => boolean, on the facts of the second turn (runFacts)
 *                 noReads   true = the second turn may not read or look at the page (read_page,
 *                           get_page_elements, find, take_screenshot): its answer must come from the chat
 */

/**
 * Where an open-web task starts: a real page with nothing on it about any task, so the model has to
 * pick and open every site itself.
 */
export const WEB_START = 'https://example.com/';

/** The log entries of the last turn: from the user_goal entry of the last prompt on. */
export function lastTurn(history) {
  const list = history || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'user_goal') return list.slice(i);
  }
  return list;
}

/**
 * The facts of a run, from what the panel shows. `calls` is the record of the model calls of this run (the
 * proxy's), `tally` what the harness counted at the worker: { messages, cdp } or null.
 *
 * @param {{history: object[], planSteps?: object[], calls?: object[], tally?: {messages: object, cdp: object} | null}} input
 */
export function runFacts({ history, planSteps, calls, tally, pageClicked = null }) {
  const rows = lastTurn(history);
  const seen = new Set();
  const turn = rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const final = [...turn].reverse().find((h) => h.type === 'finish' || h.type === 'partial_result') || null;

  const steps = [];
  for (const item of turn) {
    if (item.type === 'agent_response') steps.push({ step: item.step, mode: item.mode || null, action: item.action || null, raw: item.rawResponse, thought: item.thought || '' });
    if (item.type === 'execution_result') {
      const mine = [...steps].reverse().find((s) => s.step === item.step);
      if (mine && !mine.result) mine.result = item.success ? `ok: ${item.message || ''}${item.effect ? ` (effect ${item.effect})` : ''}` : `FAILED: ${item.error || ''}`;
    }
  }

  const modelCalls = calls || [];
  const byNode = {};
  for (const call of modelCalls) byNode[call.node || 'unknown'] = (byNode[call.node || 'unknown'] || 0) + 1;

  // A step of this turn failed. The run reported it and ended, so the card at the end of the
  // timeline is a failed one, not a green "Done": the answer being honest about the failure does
  // not make the task a success.
  const failed = turn.some((h) => (h.type === 'execution_result' && h.success === false) || h.type === 'error');

  return {
    rows,
    duplicateRows: rows.length - turn.length,
    outcome: final ? final.type : null,
    // How the run went, as the finish said it (done, partial, blocked); null for a plain-text reply.
    finishOutcome: final && final.type === 'finish' && typeof final.outcome === 'string' ? final.outcome : null,
    answer: final ? final.answer : null,
    // The files the finish handed over (records_file, files): { name, mime, content }.
    files: final && Array.isArray(final.files) ? final.files : [],
    unconfirmed: !!(final && final.unconfirmed),
    failed,
    siteEnds: turn.filter((h) => h.type === 'site_end').map((h) => ({ siteId: h.siteId, site: h.site, status: h.status, reason: h.reason, findings: h.findings, stepsUsed: h.stepsUsed })),
    plan: (planSteps || []).map((s) => ({ text: s.text, status: s.status })),
    steps,
    executions: turn.filter((h) => h.type === 'execution_result').length,
    errors: turn.filter((h) => h.type === 'error').map((h) => h.content),
    calls: { total: modelCalls.length, byNode },
    // The size of each request in order, as the proxy measured it (bytes of the body).
    requestSizes: modelCalls.map((call) => Number(call.requestBytes) || 0),
    // The run state each request ended with ("[Run state] Goal: ..."), in order; null where none.
    runStates: modelCalls.map((call) => (typeof call.runState === 'string' ? call.runState : null)),
    toolResults: modelCalls.flatMap((call) => (Array.isArray(call.toolResults) ? call.toolResults : [])),
    loopNotes: modelCalls.flatMap((call) => (Array.isArray(call.loopNotes) ? call.loopNotes : [])),
    pageMessages: tally ? tally.messages : null,
    cdpCommands: tally ? tally.cdp : null,
    // Evidence from the page itself (the harness reads it after the run): a fixture can record
    // that it was clicked, which is the one thing a history row cannot prove.
    pageClicked
  };
}

/** The notebook task (web-notebook-fix). */
export const NOTEBOOK_PROMPT = 'Cell 14 of this notebook fails with a permission error. Fix that cell so it installs Ollama without sudo: replace its code with one shell command that downloads ollama-linux-amd64.tar.zst from https://ollama.com/download/ into ~/.local and prints the installed version, run the cell with Shift+Enter, and tell me the version it prints.';

/** What notebook.html must show after a run that fixed cell 14: the new code, run, with the version. */
export async function notebookPageProblems(page) {
  const state = await page.evaluate(() => {
    const cell = document.querySelector('.cell[data-cell="14"]');
    return { code: cell && cell.dataset.code, runs: cell && cell.dataset.runs, out: document.getElementById('output-14') && document.getElementById('output-14').textContent };
  });
  const problems = [];
  if (!state.code || !/ollama-linux-amd64\.tar\.zst/.test(state.code)) problems.push(`cell 14 holds ${JSON.stringify(state.code)}, expected a download of ollama-linux-amd64.tar.zst`);
  if (state.code && /\bsudo\b|\bapt(-get)?\b/.test(state.code)) problems.push(`cell 14 still uses sudo or apt: ${JSON.stringify(state.code)}`);
  if (!(Number(state.runs) >= 1)) problems.push('cell 14 was never run with a trusted Shift+Enter');
  if (state.out !== 'ollama version 0.40.11') problems.push(`the output of cell 14 is ${JSON.stringify(state.out)}, expected "ollama version 0.40.11"`);
  return problems;
}

/** The steps of a run that read or look at the page: a follow-up that answers from the chat makes none. */
export const PAGE_READ_ACTIONS = ['read_page', 'get_page_elements', 'find_elements', 'take_screenshot'];
export const pageReadSteps = (run) => run.steps.filter((s) => s.action && PAGE_READ_ACTIONS.includes(s.action.action));

/** The chain task (web-chat-chain): the first turn asks for a count, the second derives a number from that answer. */
export const CHAIN_FIRST_PROMPT = 'How many certifications does this page list? Answer with the number in one short sentence.';
export const CHAIN_FOLLOW_UP_PROMPT = 'Take the number of certifications you gave me in your last answer, multiply it by 7, and reply with the result only.';

/** The research steps of a run (web_search and fetch_url), as the panel renders them. */
export const researchSteps = (run) => run.steps.filter((s) => s.action && (s.action.action === 'web_search' || s.action.action === 'fetch_url'));

/** The certifications task: a JSON file whose URLs are only in the links' targets, never in the page text. */
export const CREDENTIALS_PROMPT = 'Make me a JSON file of the certifications on this page: for each certificate its name, issue date and credential URL.';

/** The ten credentials of tests/fixtures/site/credentials.html, as a right file holds them. */
export const CREDENTIALS = [
  ['Implement advanced multi-agent orchestration', 'Oct 2026', 'https://verify.skilljar.example/c/7xq2m4kd9p'],
  ['Design advanced prompting strategies', 'Sep 2026', 'https://verify.skilljar.example/c/3hd8s1zu4w'],
  ['Design stateful agentic loops', 'Sep 2026', 'https://verify.skilljar.example/c/9ar5t2ve6n'],
  ['Build enterprise-grade tool ecosystems', 'Aug 2026', 'https://verify.skilljar.example/c/1kp7w3qb8m'],
  ['Implement CI/CD pipelines for agents', 'Jul 2026', 'https://learn.deeplearning.example/accomplishments/5b0c2e7a-91d4-4f6e-8a3b-2c9d71e04f58?usp=sharing&utm_source=profile&utm_medium=share'],
  ['Monitoring Production Agents', 'Jun 2026', 'https://learn.deeplearning.example/accomplishments/e4a91f30-6c2b-47d8-b5e1-0f3a8c6d2b19'],
  ['Introduction to Deep Agents', 'May 2026', 'https://academy.langchain.example/certificates/zq4rl8ce2x'],
  ['AZ-400: Development for Enterprise DevOps', 'Mar 2026', 'https://learn.microsoft.example/api/credentials/share/en-us/someone/A1B2C3D4E5F6'],
  ['AZ-204: Developing Solutions for Microsoft Azure', 'Jan 2026', 'https://learn.microsoft.example/api/credentials/share/en-us/someone/F6E5D4C3B2A1'],
  ['Kubernetes Application Developer', 'Nov 2025', 'https://www.credly.example/badges/0d6e3c8b-2a41-4f9e-9b7c-5e1a3d2f8c40/public_url']
];

/**
 * The problems of a JSON text that should list the ten credentials: it must parse, be a list, and
 * hold every credential's name, issue date (the month and year, with or without "Issued") and its
 * exact URL. Used on the files the finish row hands over.
 */
export function credentialsFileProblems(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (err) {
    return [`the file is not valid JSON: ${err.message}`];
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.certifications) ? data.certifications : null;
  if (!list) return ['the file holds no list of certifications'];
  const problems = [];
  for (const [name, issued, url] of CREDENTIALS) {
    const row = list.find((r) => r && typeof r === 'object' && Object.values(r).some((v) => String(v).trim() === name));
    if (!row) { problems.push(`no record for "${name}"`); continue; }
    const values = Object.values(row).map((v) => String(v));
    if (!values.some((v) => v.includes(issued))) problems.push(`"${name}" has no issue date ${issued}`);
    if (!values.some((v) => v.trim() === url)) problems.push(`"${name}" has no credential URL ${url}`);
  }
  return problems;
}

/**
 * The file is attached and the panel previews it, so the answer must not paste it again
 * (ATTACHED_FILE_RULE): at most two of the credential URLs may be in the answer.
 */
export function answerRepeatProblems(answer) {
  const repeated = CREDENTIALS.filter(([, , url]) => String(answer || '').includes(url)).length;
  return repeated > 2 ? [`the answer repeats ${repeated} of the ${CREDENTIALS.length} credential URLs; the file is attached, so it should show at most two`] : [];
}

// ---- the tasks ----------------------------------------------------------------------------------

export const TASKS = {
  // ---------------------------------------------------------------------------------------------
  // The open web. Each task starts on a neutral page that has nothing to do with the question
  // (WEB_START), and the prompt is only the question: which site to open, what to search, where to
  // click and when to stop are all the model's decisions. Nothing is scripted and no site is
  // named or prepared. The checks only read facts a right answer must contain.
  // ---------------------------------------------------------------------------------------------
  'web-eiffel-tower': {
    page: WEB_START,
    web: true,
    prompt: 'In which year was the Eiffel Tower completed, and how tall is it today? Look it up on the web and tell me which site you used.',
    expectLogs: true,
    // The user who leaves during a run and comes back meets a new worker: the run and its logs must still be there.
    restartWorker: true,
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /1889/.test(run.answer || '') && /\b3\d\d\b|\b1[,.]?0\d\d\b/.test(run.answer || '')
  },
  'web-python-release': {
    page: WEB_START,
    web: true,
    prompt: 'What is the newest stable Python 3 release right now? Check the official source and give me the exact version number and its release date.',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b3\.\d{1,2}\.\d{1,2}\b/.test(run.answer || '')
  },
  'web-npm-react': {
    page: WEB_START,
    web: true,
    prompt: 'What is the latest published version of the React library on npm, and roughly how many weekly downloads does it have?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b(1[89]|[2-9]\d)\.\d+\.\d+\b/.test(run.answer || '')
  },
  'web-arxiv-agents': {
    page: WEB_START,
    web: true,
    prompt: 'Find one recent research paper about LLM agents that browse the web. Give me its title, the first author, and its arXiv id.',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b\d{4}\.\d{4,5}\b/.test(run.answer || '') && (run.answer || '').length > 40
  },
  'web-github-playwright': {
    page: WEB_START,
    web: true,
    prompt: 'How many stars does the Playwright repository by Microsoft have on GitHub, and what is its latest release?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /star/i.test(run.answer || '') && /\d/.test(run.answer || '') && /v?1\.\d+/.test(run.answer || '')
  },
  'web-train-hof-munich': {
    page: WEB_START,
    web: true,
    prompt: 'Find me a train connection from Hof to München Hbf for tomorrow around 08:00, and tell me the departure time, arrival time, train type and any changes.',
    timeoutMs: 8 * 60 * 1000,
    // bahn.de answers its timetable API with HTTP 403 for an automated Chromium (measured
    // 2026-10-25): the agent accepted the shadow-root cookie layer and filled the form, then the
    // site refused the search. Not something the agent can fix, so the task waits for a site that
    // lets it through, and the check no longer passes an answer that says it could not.
    pending: 'bahn.de refuses the timetable search (HTTP 403) to an automated browser',
    check: (run) => {
      const a = run.answer || '';
      return a.length > 20 && /\b\d{1,2}:\d{2}\b/.test(a) && !/unable|could not|couldn't|blocked|bot detection|not able/i.test(a);
    }
  },
  'web-notebook-fix': {
    // The JupyterLab case on the local notebook fixture, with the real model: an inner scroll
    // panel, CodeMirror 6 cells, a ticking kernel status, and the apt/sudo error in cell 14. Not
    // an open-web question, but a task only a real model can do justice.
    page: 'notebook.html',
    web: true,
    prompt: NOTEBOOK_PROMPT,
    timeoutMs: 8 * 60 * 1000,
    check: (run) => /0\.40\.11/.test(run.answer || ''),
    expectPage: notebookPageProblems
  },
  'web-credentials-json': {
    // The LinkedIn case on the local certifications fixture, with the real model: a JSON file of
    // ten certificates whose credential URLs are only in the links' targets.
    page: 'credentials.html',
    web: true,
    prompt: CREDENTIALS_PROMPT,
    timeoutMs: 6 * 60 * 1000,
    check: (run) => run.files.some((f) => /\.json$/i.test(f.name) && credentialsFileProblems(f.content).length === 0),
    // A real model may still paste the file: a note, not a failure.
    warn: (run) => answerRepeatProblems(run.answer)
  },
  'web-chat-chain': {
    // A chat is a chain: a second request in the same chat gets the earlier turns (here, after a
    // Compact, their summary). Turn 1 counts the certifications on credentials.html. The harness then
    // compacts the chat through the context ring's card like a user, and sends the tab to
    // notebook.html, a page that does not have the fact. Turn 2 must derive its answer from turn 1's
    // (10 x 7 = 70) without reading or looking at the page, and its first request must hold the summary.
    page: 'credentials.html',
    web: true,
    prompt: CHAIN_FIRST_PROMPT,
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b10\b|\bten\b/i.test(run.answer || ''),
    followUp: {
      compact: true,
      navigate: 'notebook.html',
      prompt: CHAIN_FOLLOW_UP_PROMPT,
      noReads: true,
      timeoutMs: 4 * 60 * 1000,
      // 70, and no other number than the 10 and the 7 it comes from.
      check: (run) => /\b70\b/.test(run.answer || '') && !/\d/.test(String(run.answer || '').replace(/\b(?:70|10|7)\b/g, ''))
    }
  },
  'web-research-archive': {
    // The fact the JupyterLab run guessed wrong (a 404 URL): the name of Ollama's Linux archive.
    // The run must look it up with web_search or fetch_url (the default keyless DuckDuckGo
    // backend), not only in the tab, and give the exact name.
    page: WEB_START,
    web: true,
    prompt: 'What is the exact file name of the Linux amd64 archive in the latest Ollama release, and does extracting it need zstd? Use web search or fetch, not just the tab.',
    reachable: ['https://html.duckduckgo.com/html/', 'https://github.com/ollama/ollama/releases/latest'],
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /ollama-linux-amd64\.tar\.(zst|tgz)/.test(run.answer || '') && researchSteps(run).length > 0
  },
  'web-cookie-accept': {
    // The cookie banner is the obstacle the user saw the agent fail on: the click landed next to
    // the button. Stack Overflow's banner sets a consent cookie from its own button handler, so the
    // page proves the click, whatever the history says.
    page: WEB_START,
    web: true,
    prompt: 'Open stackoverflow.com, accept all cookies in its cookie banner, and tell me the title of the first question in the list on the page.',
    timeoutMs: 6 * 60 * 1000,
    expectPage: async (page) => {
      const cookies = await page.cookies('https://stackoverflow.com/');
      return cookies.some((c) => c.name === 'OptanonAlertBoxClosed')
        ? []
        : ['the cookie banner was never accepted: stackoverflow.com has no OptanonAlertBoxClosed cookie'];
    },
    check: (run) => (run.answer || '').length > 15
  },

  // Held-out open-web tasks (`--held-out`). Nothing in the engine, the prompts or the tools is ever
  // tuned against these: they only run after a change made for the tasks above, to show that the
  // change helps in general and is not fitted to those tasks. A held-out task that fails is a finding
  // about the agent, never a reason to edit the task. Each one asks for a different kind of work:
  // an official download page, a release log, a wiki fact, a reference doc, a live list, a registry.
  'held-node-lts': {
    page: WEB_START,
    web: true,
    heldOut: true,
    prompt: 'Which Node.js major version is the current Active LTS release, and what is its codename? Use the official Node.js website.',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b(2[2-9]|3\d)\b/.test(run.answer || '') && /[A-Z][a-z]+/.test(run.answer || '')
  },
  'held-rust-release': {
    page: WEB_START,
    web: true,
    heldOut: true,
    prompt: 'What is the latest stable version of the Rust programming language, and on which date was it released?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b1\.\d{2,3}(\.\d+)?\b/.test(run.answer || '') && /\b20\d\d\b/.test(run.answer || '')
  },
  'held-munich-population': {
    page: WEB_START,
    web: true,
    heldOut: true,
    prompt: 'What is the population of Munich according to its English Wikipedia article, and which year is that number from?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b1[.,]\d{3}[.,]\d{3}\b|\b1[.,]\d+\s*million\b/i.test(run.answer || '') && /\b20[12]\d\b/.test(run.answer || '')
  },
  'held-mdn-array-at': {
    page: WEB_START,
    web: true,
    heldOut: true,
    prompt: 'According to MDN, what does the JavaScript method Array.prototype.at() return when it is given a negative index? Answer with one short example.',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\bend\b|\blast\b|from the back|counting back/i.test(run.answer || '') && /at\(\s*-\d+\s*\)/.test(run.answer || '')
  },
  'held-hn-top-story': {
    page: WEB_START,
    web: true,
    heldOut: true,
    prompt: 'What is the title of the story at position 1 on the Hacker News front page right now, and how many points does it have?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b\d+\s*points?\b/i.test(run.answer || '') && (run.answer || '').length > 25
  },
  'held-pypi-requests': {
    page: WEB_START,
    web: true,
    heldOut: true,
    prompt: 'What is the latest version of the Python package "requests" on PyPI, and which minimum Python version does it require?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b2\.\d{2}\.\d+\b/.test(run.answer || '') && /\b3\.\d{1,2}\b/.test(run.answer || '')
  },

  // Sealed open-web tasks (`--sealed`). They judge the finished work of a series of changes, so they are
  // never looked at while the work is going on: the harness shows only their verdicts and numbers, never
  // their steps, answers or model calls, and refuses to run one by name without --sealed. The held-out set
  // above shaped decisions once its traces were read; this set has not. If a trace of one is ever read,
  // the set is unsealed and must be replaced with new tasks.
  'sealed-go-release': {
    page: WEB_START,
    web: true,
    sealed: true,
    prompt: 'What is the latest stable release of the Go programming language, and on which date was it released?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b(go)?1\.\d{2}(\.\d+)?\b/i.test(run.answer || '') && /\b20\d\d\b/.test(run.answer || '')
  },
  'sealed-k2-height': {
    page: WEB_START,
    web: true,
    sealed: true,
    prompt: 'How high is the mountain K2 in metres, according to its English Wikipedia article?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b8[,.]?6\d\d\b/.test(run.answer || '')
  },
  'sealed-python-batched': {
    page: WEB_START,
    web: true,
    sealed: true,
    prompt: 'According to the official Python documentation, what does itertools.batched() return, and in which Python version was it added?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b3\.1[2-9]\b/.test(run.answer || '') && /tuple/i.test(run.answer || '')
  },
  'sealed-crates-serde': {
    page: WEB_START,
    web: true,
    sealed: true,
    prompt: 'What is the latest version of the Rust crate "serde" on crates.io, and when was it published?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b1\.\d+\.\d{2,3}\b/.test(run.answer || '') && /\b20\d\d\b/.test(run.answer || '')
  },
  'sealed-vscode-license': {
    page: WEB_START,
    web: true,
    sealed: true,
    prompt: 'Which license does the microsoft/vscode repository on GitHub use, and about how many stars does it have?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\bMIT\b/.test(run.answer || '') && /\d/.test(run.answer || '') && /star/i.test(run.answer || '')
  },
  'sealed-kernel-mainline': {
    page: WEB_START,
    web: true,
    sealed: true,
    prompt: 'Which Linux kernel version is listed as "mainline" on kernel.org right now?',
    timeoutMs: 6 * 60 * 1000,
    check: (run) => /\b[6-9]\.\d{1,2}(-rc\d+)?\b/.test(run.answer || '')
  }
};
