/**
 * How the smoke run measures a task, kept apart from the harness so it is pure and unit-tested
 * (tests/mcp/metrics.test.ts).
 *
 * - Success: a run succeeds only when it ended with the expected final entry, its answer passed the
 *   task's check, AND (for a task that names one) the model said the outcome it must say. An
 *   open-web task must end "done": an answer the model itself calls "partial" or "blocked" is not a
 *   success, however plausible its text looks to a loose check.
 * - Repeats: a real model is not deterministic (the same task took 4 steps in one run and 12 in
 *   another), so a task can run k times (--repeat=k) and is reported by its median and p90, never
 *   by one lucky or unlucky run.
 */

/** The finish outcome a task must end with: its own expectFinishOutcome, else "done" for an open-web task, else none. */
export function expectedFinishOutcome(task) {
  if (!task) return null;
  if (task.expectFinishOutcome !== undefined) return task.expectFinishOutcome;
  return task.web ? 'done' : null;
}

/**
 * Why a run did not succeed, as one sentence, or null for a success. The order is the order a
 * reader needs: no final entry, the wrong final entry, the wrong outcome, the wrong answer.
 */
export function runVerdict(r) {
  if (!r.outcome) {
    // A run the user (the harness, as the user) stopped or cleared on purpose ends with no final entry by design.
    if (r.userStopped || r.cleared) return null;
    if (r.stopped) return `the harness stopped the run (${r.stopped})`;
    return `the run ended with no final entry (status ${r.status})`;
  }
  if (r.outcome !== r.expectOutcome) return `the run ended with a ${r.outcome} entry, expected ${r.expectOutcome}`;
  if (r.expectFinishOutcome && r.finishOutcome !== r.expectFinishOutcome) {
    return `the model ended with outcome ${JSON.stringify(r.finishOutcome)}, expected ${JSON.stringify(r.expectFinishOutcome)}`;
  }
  if (!r.answerCorrect) return 'the answer is wrong';
  return null;
}

/** The value at quantile q (0..1) of the numbers, by the nearest-rank method; null for none. */
export function quantile(values, q) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.max(1, Math.ceil(q * xs.length));
  return xs[rank - 1];
}

/** The measured numbers of one run. */
export function runNumbers(r) {
  return {
    steps: r.facts?.steps?.length ?? 0,
    calls: r.modelCalls ?? 0,
    promptTokens: r.promptTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    wallMs: r.wallMs ?? 0
  };
}

const METRICS = ['steps', 'calls', 'promptTokens', 'outputTokens', 'wallMs'];

/**
 * The runs grouped by task, in first-seen order: how many ran, how many succeeded, and the median
 * and p90 of each number. With one run the median and the p90 are that run.
 */
export function aggregate(reports) {
  const byTask = new Map();
  for (const r of reports) {
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task).push(r);
  }
  return [...byTask.entries()].map(([task, runs]) => {
    const numbers = runs.map(runNumbers);
    const stats = {};
    for (const m of METRICS) {
      const values = numbers.map((n) => n[m]);
      stats[m] = { median: quantile(values, 0.5), p90: quantile(values, 0.9) };
    }
    return { task, runs: runs.length, successes: runs.filter((r) => runVerdict(r) === null).length, ...stats };
  });
}

const fmt = (n) => (n === null ? '-' : Math.round(n).toLocaleString('en-US'));
const secs = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);

/** The aggregate as aligned text lines, for the console summary. */
export function aggregateLines(rows) {
  const width = Math.max(4, ...rows.map((r) => r.task.length));
  const lines = [`${'task'.padEnd(width)}  ok    steps med/p90   calls med/p90   prompt tokens med/p90    wall med/p90`];
  for (const r of rows) {
    lines.push([
      r.task.padEnd(width),
      `${r.successes}/${r.runs}`.padEnd(5),
      `${fmt(r.steps.median)}/${fmt(r.steps.p90)}`.padEnd(15),
      `${fmt(r.calls.median)}/${fmt(r.calls.p90)}`.padEnd(15),
      `${fmt(r.promptTokens.median)}/${fmt(r.promptTokens.p90)}`.padEnd(24),
      `${secs(r.wallMs.median)}/${secs(r.wallMs.p90)}`
    ].join('  '));
  }
  const runs = rows.reduce((s, r) => s + r.runs, 0);
  const ok = rows.reduce((s, r) => s + r.successes, 0);
  lines.push(`success: ${ok}/${runs} runs`);
  return lines;
}

/**
 * Every model call of a run for the saved report: the numbers of each call (none are dropped, so a
 * 60-call run is still fully measured) and the model's reply cut to `contentChars`.
 */
export function callsForReport(calls, contentChars = 400) {
  return calls.map((c) => ({ ...c, content: typeof c.content === 'string' && c.content.length > contentChars ? `${c.content.slice(0, contentChars)}...` : c.content }));
}
