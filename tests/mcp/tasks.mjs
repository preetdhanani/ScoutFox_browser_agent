/**
 * The smoke tasks. The real ones (`web`) are the use cases: they start on a neutral page and give
 * only a question, and the model (NVIDIA Nemotron by default) picks and opens every real website
 * itself. Two small tasks on the fixture site (tests/fixtures/site/store.html) stay for the offline
 * mock run in CI: a price read, and the same read after the composer's model pick (which also reads
 * the effort menu). They check that the extension loads and a run reaches the page, not use cases. Every task has a `check` that reads the facts of the run (the final answer first) and says whether the run was right, so
 * a run that "finishes" with a wrong answer is not a pass.
 *
 * Shared by smoke.mjs and by the mock's self-test (mockOllama.selftest.mjs), so the mock is
 * judged by the same checks as a real model.
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
 *   calls        the model calls: { total, byNode } (the mock records node 'mcp')
 *   toolResults  every tool result the model was sent, in full, in order (from the call records: a history row
 *                is cut to one line, so what the model really read is checked here)
 *   loopNotes    the notes the loop added after a tool block (the reflection, the step limit), in order
 *   pageMessages what the engine sent to the page, by message name (null when the harness could not count)
 *   cdpCommands  what the engine sent over the debugger, by method (null when the harness could not count)
 *
 * A task can also carry:
 *   host        the site the start page is served as (mapped to the fixture server by the harness, see
 *               HOST_RULES in twoSources.mjs)
 *   mockModel   the model name to use with --mock (the mock's behaviour can depend on it)
 *   mockOnly    true = left out of the default list of a real-Ollama run
 *   expectLogs  true = the Logs tab is read after the run: model calls and steps as JSON trees, no plumbing
 *   restartWorker  true = after the run the harness stops the service worker, wakes a new one, and
 *               the real side panel must still show the finished run
 *   web         true = a real-model task: an open-web task (a neutral start page and only a question), or
 *               a local fixture task that only a real model can do justice (web-notebook-fix). The default
 *               set of a real-model run (NVIDIA or Ollama); never run with --mock
 *   maxRounds   the most model rounds the mock's self-test walks for this task (default 12)
 *   expectOutcome  the final entry the run must end with (default 'finish')
 *   expectMock  with --mock only: the engine's own facts about the run (the action sequence, the plan rows,
 *               whether a click really reached the page) as a list of problems. The mock is deterministic,
 *               so these are exact. `check` judges the ANSWER (what the user reads), `expectMock` judges
 *               what the engine did to get there
 *   answers     the answers to questions the run asks the user: [{ match: RegExp, answer: string }]
 *   pending     a reason: the task is skipped and does not count as a failure. Its data stays for the stage that
 *               brings it back
 *   before      a task ({page, prompt, check, expectOutcome?, expectMock?}) that runs to its end in the same tab first.
 *   expectPage  async (puppeteer page) => problems: evidence the page itself gives after the run (a
 *               cookie its own button set), read before the tab closes.
 *   blocksClicks  true = the page's consent banner swallows every link click until it is answered. The
 *               self-test walk plays the page that way (the live page does it with its own script)
 *   stopAfterSteps  the harness clicks Stop, like a user, once the run has taken this many steps. The run
 *               then ends with a "Stopped by you" partial_result entry
 *   restartWorkerAfterSteps  the harness stops the service worker in the MIDDLE of the run, once it has taken
 *               this many steps, and wakes a new one. The new worker cannot go on with the run, so it must end
 *               it with an "Interrupted" card
 *   cardShots   true = the final card is also shot in light and dark, tall and as a close-up
 *   manualApprove  true = the run starts with manual plan approval; the harness approves the plan card like a
 *               user, and the run fails if it never stopped at one
 *   clearAfterSteps  the harness presses New chat (CLEAR_HISTORY) once the run has taken this many steps. The
 *               run must stop with it: no more model calls, no rows, and the clean start screen
 *   research    the Research settings the harness sets through the side panel's Settings tab before the run, like a
 *               user: { backend: 'searxng', path } points SearXNG at the fixture's research host (RESEARCH_HOST in
 *               twoSources.mjs) plus that path. The section is screenshotted in light and dark
 *   expectPanelRows  patterns the timeline rows of the side panel must show (one row per pattern), read on the panel
 *   reachable   addresses a real-model task needs: the harness checks them first and skips the task (not a failure)
 *               when one does not answer, so an offline machine or a site outage never reads as an agent bug
 */

import { REFLECTION_TEXT, REPEAT_HINT_PREFIX } from '../../src/background/mcp/progress.ts';
import { UNTRUSTED_PREFIX } from '../../src/background/mcp/untrusted.ts';

/** A task that only ends when the harness ends it (Stop, a worker restart, New chat). */
export const endedByHarness = (task) => !!(task.stopAfterSteps || task.restartWorkerAfterSteps || task.clearAfterSteps);

/** The problems of a run that should only have waited (the mock's "keep waiting" goal). */
export const onlyWaits = (run) => (run.steps.length > 0 && run.steps.every((s) => s.action && s.action.action === 'wait')
  ? []
  : [`the run's actions were [${run.steps.map((s) => s.action && s.action.action).join(', ')}], expected only waits`]);

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
 * The facts of a run, from what the panel shows. `calls` is the record of the model calls of this run (the mock's, or the
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
    if (item.type === 'agent_response') steps.push({ step: item.step, mode: item.mode || null, action: item.action || null, raw: item.rawResponse });
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
    unconfirmed: !!(final && final.unconfirmed),
    failed,
    siteEnds: turn.filter((h) => h.type === 'site_end').map((h) => ({ siteId: h.siteId, site: h.site, status: h.status, reason: h.reason, findings: h.findings, stepsUsed: h.stepsUsed })),
    plan: (planSteps || []).map((s) => ({ text: s.text, status: s.status })),
    steps,
    executions: turn.filter((h) => h.type === 'execution_result').length,
    errors: turn.filter((h) => h.type === 'error').map((h) => h.content),
    calls: { total: modelCalls.length, byNode },
    toolResults: modelCalls.flatMap((call) => (Array.isArray(call.toolResults) ? call.toolResults : [])),
    loopNotes: modelCalls.flatMap((call) => (Array.isArray(call.loopNotes) ? call.loopNotes : [])),
    pageMessages: tally ? tally.messages : null,
    cdpCommands: tally ? tally.cdp : null,
    // Evidence from the page itself (the harness reads it after the run): a fixture can record
    // that it was clicked, which is the one thing a history row cannot prove.
    pageClicked
  };
}

/** The run's tool calls, as the action names the panel renders, exactly these, in this order. */
export function expectActions(run, names) {
  const got = run.steps.map((s) => (s.action && s.action.action) || null);
  return got.length === names.length && got.every((g, i) => g === names[i])
    ? []
    : [`the run's actions were [${got.join(', ') || 'none'}], expected [${names.join(', ')}]`];
}

/**
 * The problems of a run whose actions must each have told the model what they did: every result
 * of these actions, as the model was sent it, must carry an "Observation:" line, and the type
 * must have read the field back.
 */
export function observationProblems(run, actions) {
  const problems = [];
  const results = run.toolResults || [];
  const observed = results.filter((r) => /\nObservation: /.test(r));
  if (observed.length < actions.length) {
    problems.push(`only ${observed.length} tool result(s) the model got carry an "Observation:" line, expected at least ${actions.length} (one per ${actions.join(', ')})`);
  }
  if (actions.includes('type') && !results.some((r) => /Field now starts with: "/.test(r))) {
    problems.push('no type result the model got read the field back ("Field now starts with:")');
  }
  return problems;
}

/** The stuck-recovery task: a dead button, and a run that must notice it and end honestly. */
export const STUCK_PROMPT = 'Download the monthly sales report as a CSV file with the Download CSV button on this page, and tell me whether it worked.';

/** The most steps a stuck-recovery run may take: the guard must end the loop long before the step limit. */
export const STUCK_STEP_BUDGET = 10;

/**
 * The problems of a stuck-recovery run: the hint and the reflection reached the model (the
 * reflection exactly once), the run finished within its budget, and the answer is honest.
 */
export function stuckProblems(run) {
  const problems = [];
  const hints = (run.toolResults || []).filter((r) => r.includes(REPEAT_HINT_PREFIX));
  const reflections = (run.loopNotes || []).filter((n) => n === REFLECTION_TEXT);
  if (!hints.length) problems.push('no tool result the model got carries the repeat hint');
  if (reflections.length !== 1) problems.push(`the reflection reached the model ${reflections.length} time(s), expected exactly once`);
  if (run.steps.length > STUCK_STEP_BUDGET) problems.push(`the run took ${run.steps.length} steps, more than its budget of ${STUCK_STEP_BUDGET}`);
  const clicks = run.steps.filter((s) => s.action && s.action.action === 'click').length;
  if (clicks < 2) problems.push(`the run clicked ${clicks} time(s); the scenario needs the dead click repeated`);
  // The button never worked, so the run could not do the task: the finish says "blocked", and the
  // card is "Could not finish", never the green "Done" an honest "it did not work" used to get.
  if (run.finishOutcome !== 'blocked') problems.push(`the finish outcome is ${JSON.stringify(run.finishOutcome)}, expected "blocked" (the button never worked)`);
  return problems;
}

/** An honest answer about the dead button: it says it did not work, and never that it did. */
export const stuckAnswerHonest = (run) => {
  const a = run.answer || '';
  return /download csv/i.test(a) && /did not work|didn't work|nothing (on the page )?changed|did nothing/i.test(a)
    && !/\b(successfully|was downloaded|download (started|completed))\b/i.test(a);
};

/** The notebook task, for the mock and for the real model alike. */
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

/** The research task: a fact that is only in a file the run has to find and read outside the tab. */
export const RESEARCH_PROMPT = 'Which archive file does the official Lantern CLI install script download on Linux amd64, and does extracting it need zstd? Use web search and fetch, not just this tab.';

/** The archive name, written only in tests/fixtures/site/research/install.sh. */
export const RESEARCH_ARCHIVE = 'lantern-linux-amd64-v3.8.1.tar.zst';

/** The research steps of a run (web_search and fetch_url), as the panel renders them. */
export const researchSteps = (run) => run.steps.filter((s) => s.action && (s.action.action === 'web_search' || s.action.action === 'fetch_url'));

/**
 * The problems of a research run: the search and the fetch results the model got came in the
 * untrusted envelope, and the tab never moved (research does not touch it).
 */
export function researchProblems(run) {
  const problems = [];
  const results = run.toolResults || [];
  const search = results.find((r) => /^Web search \(/.test(r));
  const fetched = results.find((r) => /^Fetched https?:\/\//.test(r));
  if (!search) problems.push('no web_search result reached the model');
  else if (!search.includes(UNTRUSTED_PREFIX)) problems.push('the web_search result is not in the untrusted envelope');
  if (!fetched) problems.push('no fetch_url result reached the model');
  else if (!fetched.includes(UNTRUSTED_PREFIX)) problems.push('the fetch_url result is not in the untrusted envelope');
  return problems;
}

// ---- the tasks ----------------------------------------------------------------------------------

export const TASKS = {
  'user-stop': {
    // The user clicks Stop mid-run. The card must say so, not "Failed: the run ended with an error".
    page: 'store.html',
    prompt: 'Keep waiting on this page until I stop you.',
    mockOnly: true,
    stopAfterSteps: 1,
    expectOutcome: 'partial_result',
    expectCard: { title: 'Stopped by you' },
    cardShots: true,
    check: () => true,
    expectMock: onlyWaits
  },
  'worker-restart-midrun': {
    // Chrome stops the worker in the middle of a run (an idle worker after about 30 s, or an
    // update). The new worker cannot go on with the run, but the panel must end it with a card
    // that says why, never an idle thread with no ending.
    page: 'store.html',
    prompt: 'Keep waiting on this page until I stop you.',
    mockOnly: true,
    restartWorkerAfterSteps: 2,
    expectOutcome: 'partial_result',
    expectCard: { title: 'Interrupted', classes: ['partial'] },
    cardShots: true,
    check: (run) => /restarted/i.test(run.answer || ''),
    expectMock: onlyWaits
  },
  'clear-midrun': {
    // The user presses New chat while a run is going. The run must stop with it, and the thread
    // stays clean: no more model calls and no rows written back into it.
    page: 'store.html',
    prompt: 'Keep waiting on this page until I stop you.',
    mockOnly: true,
    clearAfterSteps: 1,
    check: () => true,
    expectMock: (run) => (run.rows.length === 0 ? [] : [`the cleared thread has ${run.rows.length} row(s) again`])
  },
  'far-link': {
    // frame.work in small: identical "Configure now" links far below the first screen. Only the
    // link path says which one is the Laptop 16, and the click has to reach a link off the screen.
    page: 'far-link.html',
    prompt: 'Open the Configure now link for the Framework Laptop 16 and tell me what that page says.',
    mockOnly: true,
    check: (run) => /For in-stock laptop/.test(run.answer || ''),
    expectMock: (run) => expectActions(run, ['find_elements', 'click', 'read_page', 'finish'])
  },
  'consent-link': {
    // frame.work's cookie banner swallows every click until it is answered. The click must say the
    // link did not open, so the run answers the banner instead of believing it arrived.
    page: 'consent-link.html',
    prompt: 'Open the configurator of the Framework Laptop 16 and tell me what that page says.',
    mockOnly: true,
    blocksClicks: true,
    check: (run) => /For in-stock laptop/.test(run.answer || ''),
    expectMock: (run) => expectActions(run, ['find_elements', 'click', 'find_elements', 'click', 'find_elements', 'click', 'read_page', 'finish'])
  },
  'editor-replace': {
    // A notebook cell like CodeMirror: its text lives in its own model and only trusted input
    // changes it. The run clicks into it, selects all with a real key, types without an element
    // id (into the focused editor), runs it with Shift+Enter and reads the output line. Every
    // action's result must carry the observation line, and the page itself is the witness.
    page: 'editor.html',
    prompt: 'In the code editor on this page, replace the whole code with: echo scoutfox. Then run the cell with Shift+Enter and tell me the output line.',
    mockOnly: true,
    cardShots: true,
    check: (run) => /Out \[2\]: scoutfox/.test(run.answer || ''),
    expectMock: (run) => [
      ...expectActions(run, ['get_page_elements', 'click', 'press_key', 'type', 'press_key', 'read_page', 'finish']),
      ...observationProblems(run, ['click', 'press_key', 'type', 'press_key'])
    ],
    expectPage: async (page) => {
      const state = await page.evaluate(() => ({ text: document.body.getAttribute('data-editor-text'), out: document.getElementById('output').textContent }));
      const problems = [];
      if (state.text !== 'echo scoutfox') problems.push(`the editor holds ${JSON.stringify(state.text)}, expected exactly "echo scoutfox" (replaced, not appended)`);
      if (state.out !== 'Out [2]: scoutfox') problems.push(`the output line is ${JSON.stringify(state.out)}, expected "Out [2]: scoutfox" (the cell did not run with a trusted Shift+Enter)`);
      return problems;
    }
  },
  'notebook-fix': {
    // JupyterLab in small: the page never scrolls, the cells do, inside a panel; every cell is a
    // real CodeMirror 6 editor, and a kernel status ticks all the time. Cell 14 fails with the
    // apt/sudo permission error. The run scrolls the panel (and the scroll must say what really
    // moved), reads the page in parts (part 2 holds cell 14), clicks into the cell, selects all
    // with a real key, types the fix into the focused editor, runs it with Shift+Enter and reads
    // the output. The page itself is the witness of the edit and the run.
    page: 'notebook.html',
    prompt: NOTEBOOK_PROMPT,
    mockOnly: true,
    cardShots: true,
    maxRounds: 16,
    check: (run) => /ollama version 0\.40\.11/.test(run.answer || ''),
    expectMock: (run) => [
      ...expectActions(run, ['scroll', 'read_page', 'read_page', 'get_page_elements', 'click', 'press_key', 'type', 'press_key', 'read_page', 'finish']),
      ...observationProblems(run, ['scroll', 'click', 'press_key', 'type', 'press_key'])
    ],
    expectPage: notebookPageProblems
  },
  'virtual-scroll': {
    // A windowed list (only the rows near the view are in the DOM) inside a panel, on a page that
    // does not scroll. The target row is far down: the run must scroll the list, and each scroll
    // must really move it, until the row is drawn and can be read.
    page: 'virtual-list.html',
    prompt: 'Scroll the order list until you find the order from Zanzibar Spice Co., and tell me its order number and status.',
    mockOnly: true,
    maxRounds: 30,
    check: (run) => /41096/.test(run.answer || '') && /refund approved/i.test(run.answer || ''),
    expectMock: (run) => {
      const actions = run.steps.map((s) => (s.action && s.action.action) || null);
      const scrolls = actions.filter((a) => a === 'scroll').length;
      const problems = [];
      if (actions[0] !== 'scroll') problems.push(`the run did not start with a scroll: [${actions.join(', ')}]`);
      if (scrolls < 3) problems.push(`the run scrolled ${scrolls} time(s); the row is far down, so it takes at least 3`);
      if (actions.some((a) => a !== 'scroll' && a !== 'read_page' && a !== 'finish')) problems.push(`unexpected actions: [${actions.join(', ')}]`);
      return [...problems, ...observationProblems(run, Array.from({ length: scrolls }, () => 'scroll'))];
    },
    expectPage: async (page) => {
      const state = await page.evaluate(() => ({
        top: document.getElementById('orders').scrollTop,
        drawn: Number(document.body.getAttribute('data-rows-drawn')),
        target: [...document.querySelectorAll('#orders .row')].some((r) => /Zanzibar Spice Co\./.test(r.textContent))
      }));
      const problems = [];
      if (!(state.top > 0)) problems.push('the order list was never scrolled');
      if (!(state.drawn > 0 && state.drawn <= 40)) problems.push(`the list drew ${state.drawn} rows; it is a windowed list, so it draws only the rows near the view`);
      if (!state.target) problems.push('the Zanzibar Spice Co. row is not drawn: the list did not end where the run read it');
      return problems;
    }
  },
  'stuck-recovery': {
    // A dead button: its handler fails silently, so every click changes nothing. A stubborn model
    // clicks it again and again (a real run repeated click(700,420) six times). The loop must tell
    // it so: a repeat hint on the second quiet click, then one reflection note, and the run ends
    // honestly within its budget, long before the step limit.
    page: 'dead-button.html',
    prompt: STUCK_PROMPT,
    mockOnly: true,
    cardShots: true,
    expectCard: { title: 'Could not finish', classes: ['blocked'] },
    check: stuckAnswerHonest,
    expectMock: stuckProblems,
    expectPage: async (page) => {
      const text = await page.evaluate(() => document.body.innerText);
      return /Download CSV/.test(text) ? [] : ['the report page lost its Download CSV button'];
    }
  },
  'stuck-recovery-manual': {
    // The same dead button with manual approval: the plan card must come up and be approved by
    // the user (the harness), and the guard must never get past it or ask the user anything else.
    page: 'dead-button.html',
    prompt: STUCK_PROMPT,
    mockOnly: true,
    manualApprove: true,
    expectCard: { title: 'Could not finish', classes: ['blocked'] },
    check: stuckAnswerHonest,
    expectMock: (run) => [
      ...stuckProblems(run),
      ...(run.plan.length === 2 ? [] : [`the plan has ${run.plan.length} row(s), expected the 2 the user approved`])
    ]
  },
  'research-then-answer': {
    // Research outside the tab: the fact (the archive name) is only in an install script on
    // another site. The run searches the web (SearXNG, set in Settings > Research like a user
    // would, pointing at the fixture's search endpoint), fetches the script from the service
    // worker, and answers with the name. The tab stays on the store page the whole time.
    page: 'store.html',
    prompt: RESEARCH_PROMPT,
    mockOnly: true,
    research: { backend: 'searxng', path: '/research' },
    cardShots: true,
    expectPanelRows: [/^Searched the web: /, /^Read install\.sh \(docs\.lantern\.test\)/],
    check: (run) => (run.answer || '').includes(RESEARCH_ARCHIVE) && /zstd/i.test(run.answer || ''),
    expectMock: (run) => [...expectActions(run, ['web_search', 'fetch_url', 'finish']), ...researchProblems(run)],
    expectPage: async (page) => (/\/store\.html$/.test(page.url()) ? [] : [`the tab moved to ${page.url()}: research must leave the tab alone`])
  },
  'partial-answer': {
    // Two facts asked, and the page has only one: the run answers the price and says the battery
    // life is not on the page. The finish says "partial", and the card is the amber "Partly done".
    // The price is written as inline code, so the card shot also shows a rendered code span.
    page: 'store.html',
    prompt: 'What does the Framework Laptop 16 cost on this page, and how many hours does its battery last?',
    mockOnly: true,
    cardShots: true,
    // The inline code is rendered: the reader sees the price, and never the backticks around it.
    expectCard: { title: 'Partly done', classes: ['partial'], body: { 'name the price': '1\\.399,00 EUR' }, noBody: ['`'] },
    check: (run) => /1\.399,00 EUR/.test(run.answer || '') && /battery/i.test(run.answer || ''),
    expectMock: (run) => [
      ...expectActions(run, ['read_page', 'finish']),
      ...(run.finishOutcome === 'partial' ? [] : [`the finish outcome is ${JSON.stringify(run.finishOutcome)}, expected "partial" (the battery is not on the page)`])
    ]
  },
  'store-price': {
    page: 'store.html',
    prompt: 'What does the Framework Laptop 16 cost on this page? Give the price exactly as the page shows it.',
    check: (run) => /1\.399,00 EUR/.test(run.answer || ''),
    expectMock: (run) => expectActions(run, ['read_page', 'finish'])
  },
  'model-pick': {
    // The composer's model picker, used like a user would before sending anything: the model
    // name opens the provider's model list, a pick configures it. The task itself is the plain
    // price question, so the run also proves the picked model actually executed.
    page: 'store.html',
    prompt: 'What does the Framework Laptop 16 cost on this page? Give the price exactly as the page shows it.',
    modelPick: true,
    // The composer's effort menu: the levels the model takes, the chosen one, the note (smoke.mjs).
    effortMenu: true,
    check: (run) => /1\.399,00 EUR/.test(run.answer || ''),
    expectMock: (run) => expectActions(run, ['read_page', 'finish'])
  },
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
  'web-framework-price': {
    page: WEB_START,
    web: true,
    prompt: 'How much does the Framework Laptop 16 cost? Find the official price, then compare it with at least one other shop, and tell me which is cheaper.',
    timeoutMs: 8 * 60 * 1000,
    check: (run) => {
      const a = run.answer || '';
      return a.length > 40 && /framework/i.test(a) && /\d/.test(a) && /eur|€|\$|usd/i.test(a);
    }
  },
  'web-notebook-fix': {
    // The JupyterLab case on the local notebook fixture, with the real model: an inner scroll
    // panel, CodeMirror 6 cells, a ticking kernel status, and the apt/sudo error in cell 14. Not
    // an open-web question, but it runs with the real model only (the mock has notebook-fix).
    page: 'notebook.html',
    web: true,
    prompt: NOTEBOOK_PROMPT,
    timeoutMs: 8 * 60 * 1000,
    check: (run) => /0\.40\.11/.test(run.answer || ''),
    expectPage: notebookPageProblems
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
  }
};
