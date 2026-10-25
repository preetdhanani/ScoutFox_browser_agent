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
 *   web         true = an open-web task: a neutral start page and only a question. The default set of a
 *               real-model run (NVIDIA or Ollama); never run with --mock
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
 *               then ends with no final entry, and that is expected
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
    answer: final ? final.answer : null,
    unconfirmed: !!(final && final.unconfirmed),
    failed,
    siteEnds: turn.filter((h) => h.type === 'site_end').map((h) => ({ siteId: h.siteId, site: h.site, status: h.status, reason: h.reason, findings: h.findings, stepsUsed: h.stepsUsed })),
    plan: (planSteps || []).map((s) => ({ text: s.text, status: s.status })),
    steps,
    executions: turn.filter((h) => h.type === 'execution_result').length,
    errors: turn.filter((h) => h.type === 'error').map((h) => h.content),
    calls: { total: modelCalls.length, byNode },
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

// ---- the tasks ----------------------------------------------------------------------------------

export const TASKS = {
  'user-stop': {
    // The user clicks Stop mid-run. The card must say so, not "Failed: the run ended with an error".
    page: 'store.html',
    prompt: 'Keep waiting on this page until I stop you.',
    mockOnly: true,
    stopAfterSteps: 1,
    expectCard: { title: 'Stopped by you' },
    check: () => true,
    expectMock: (run) => (run.steps.length > 0 && run.steps.every((s) => s.action && s.action.action === 'wait')
      ? []
      : [`the run's actions were [${run.steps.map((s) => s.action && s.action.action).join(', ')}], expected only waits`])
  },
  'far-link': {
    // frame.work in small: identical "Configure now" links far below the first screen. Only the
    // link path says which one is the Laptop 16, and the click has to reach a link off the screen.
    page: 'far-link.html',
    prompt: 'Open the Configure now link for the Framework Laptop 16 and tell me what that page says.',
    mockOnly: true,
    check: (run) => /For in-stock laptop/.test(run.answer || ''),
    expectMock: (run) => expectActions(run, ['find_elements', 'click', 'read_page_text', 'finish'])
  },
  'consent-link': {
    // frame.work's cookie banner swallows every click until it is answered. The click must say the
    // link did not open, so the run answers the banner instead of believing it arrived.
    page: 'consent-link.html',
    prompt: 'Open the configurator of the Framework Laptop 16 and tell me what that page says.',
    mockOnly: true,
    blocksClicks: true,
    check: (run) => /For in-stock laptop/.test(run.answer || ''),
    expectMock: (run) => expectActions(run, ['find_elements', 'click', 'find_elements', 'click', 'find_elements', 'click', 'read_page_text', 'finish'])
  },
  'store-price': {
    page: 'store.html',
    prompt: 'What does the Framework Laptop 16 cost on this page? Give the price exactly as the page shows it.',
    check: (run) => /1\.399,00 EUR/.test(run.answer || ''),
    expectMock: (run) => expectActions(run, ['read_page_text', 'finish'])
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
    expectMock: (run) => expectActions(run, ['read_page_text', 'finish'])
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
