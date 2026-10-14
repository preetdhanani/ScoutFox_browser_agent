/**
 * An answer site ends in browse mode with `subgoal_done`: its summary IS the answer. That ending used to store the
 * summary as a confirmed finalAnswer without the answer audit, so a summary with a number no page showed reached the
 * panel as a green "Done". It now goes through the same finish pipeline as `finish` (audit, finish policy, send-back
 * counter and clamps, annotate or replace, audit record on the entry).
 *
 * Also here: the [RUN_STATS] line of finalize says how the run really ended (finished, partial, stopped).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act } from '../helpers/graphHarness.ts';
import { link } from '../helpers/fakeDom.ts';
import type { PageSpec } from '../helpers/fakeDom.ts';
import type { GateContext } from '../../src/background/agent/finishPolicy.ts';
import type { FinishAuditRecord } from '../../src/background/agent/planEvidence.ts';
import { Logger } from '../../src/shared/logger.ts';

const LIST = '1. debpalash / VoiceStudio - 61,949 stars\n2. acme / other-repo - 12,345 stars';
/** The same list with a price that no page showed (star counts are counts, not claims the audit checks). */
const INVENTED = `${LIST}\nA GitHub Pro plan for VoiceStudio costs 48.50 USD per month.`;

const pages: PageSpec[] = [{
  url: 'https://github.test/trending/python',
  title: 'Trending Python repositories on GitHub today',
  text: ['debpalash / VoiceStudio', '61,949 stars', 'acme / other-repo', '12,345 stars', 'Trending repositories on GitHub today'],
  elements: [link('debpalash / VoiceStudio', 'https://github.test/debpalash/VoiceStudio')],
}];

/** One answer site (research columns, planned as an answer site by the override), as in answerSiteGuards.test.ts. */
const roundupPlan = JSON.stringify({
  task_kind: 'research',
  columns: ['repository', 'stars'],
  search_query: 'trending python repositories',
  sites: [{ domain: 'github.test', goal: 'Find the top trending Python repositories', role: 'reference', kind: 'page', difficulty: 1, required_fields: ['repository', 'stars'], done_when: 'all_required', check: { type: 'none', value: '' } }],
});

const TASK = 'Find top trending repositories on GitHub for python';

async function roundupRig(
  t: { after: (fn: () => void | Promise<void>) => void },
  policy: string[],
  finishPolicy?: (ctx: GateContext) => 'send_back' | 'annotate' | 'replace',
) {
  const rig = await graphRig({ pages, startUrl: pages[0].url, plan: roundupPlan, policy, ...(finishPolicy ? { finishPolicy } : {}) });
  t.after(rig.cleanup);
  return rig;
}

describe('subgoal_done on an answer site goes through the answer audit', () => {
  test('a summary with an invented number is annotated, never a confirmed Done, and the finish entry carries the audit', async (t) => {
    const calls: GateContext[] = [];
    const rig = await roundupRig(t, [act.subgoalDone(INVENTED)], (ctx) => {
      calls.push({ ...ctx });
      return 'annotate';
    });
    await rig.start(TASK);

    assert.equal(rig.status(), 'idle');
    assert.equal(calls.length, 1, 'the finish policy decided on the subgoal_done summary');
    assert.ok((calls[0]?.lieCount ?? 0) >= 1, 'the invented price is a lie');
    const finishes = rig.entries('finish');
    assert.equal(finishes.length, 1);
    const audit = (finishes[0] as any).audit as FinishAuditRecord | undefined;
    assert.ok(audit, 'the finish entry of a subgoal_done answer has an audit');
    assert.equal(audit.verdict, 'unverified');
    const answer = String((finishes[0] as any).answer ?? '');
    assert.match(answer, /^WARNING - UNVERIFIED ANSWER/, 'the code-written warning is the first line');
    assert.ok(answer.includes('debpalash / VoiceStudio'), 'the model text is kept under the warning');
  });

  test('send_back: the first summary is refused with the reason, the honest second one is accepted with sendBacks=1', async (t) => {
    const calls: GateContext[] = [];
    const rig = await roundupRig(t, [act.subgoalDone(INVENTED), act.subgoalDone(LIST)], (ctx) => {
      calls.push({ ...ctx });
      return ctx.sendBacks === 0 ? 'send_back' : 'annotate';
    });
    await rig.start(TASK);

    assert.equal(rig.status(), 'idle');
    assert.equal(calls.length, 1, 'only the invented summary reached the policy; the honest one was verified');
    assert.equal(rig.llm.callsOf('policy').length, 2, 'the model got a second round');
    const second = String((rig.llm.callsOf('policy')[1] as any)?.messages?.at(-1)?.content ?? '');
    assert.match(second, /48\.50/, 'the send-back names the price no page showed');
    const finishes = rig.entries('finish');
    assert.equal(finishes.length, 1);
    assert.equal((finishes[0] as any).answer, LIST);
    const audit = (finishes[0] as any).audit as FinishAuditRecord;
    assert.equal(audit?.verdict, 'verified');
    assert.equal(audit?.sendBacks, 1);
  });

  test('an honest summary is verified and delivered byte for byte, the policy is never asked', async (t) => {
    let asked = false;
    const rig = await roundupRig(t, [act.subgoalDone(LIST)], () => {
      asked = true;
      return 'send_back';
    });
    await rig.start(TASK);

    assert.equal(rig.finishAnswer(), LIST);
    const entry = rig.entries('finish')[0] as any;
    assert.equal(entry?.audit?.verdict, 'verified');
    assert.notEqual(entry?.unconfirmed, true);
    assert.equal(asked, false);
  });
});

describe('the [RUN_STATS] line says how the run ended', () => {
  const runStatsLine = (): string => Logger.getLogsHistory().map((e) => e.message).find((m) => m.startsWith('[RUN_STATS]')) ?? '';

  test('a finished run: "Task finished", with the same fields', async (t) => {
    Logger.clearLogs();
    const rig = await roundupRig(t, [act.subgoalDone(LIST)]);
    await rig.start(TASK);

    assert.match(runStatsLine(), /^\[RUN_STATS\] Task finished: level=\w+, steps=\d+, sitesDone=1, sitesPartial=0, elapsed=\d+ms$/);
  });

  test('a partial run: "Task ended partial (<reason>)", never "completed"', async (t) => {
    Logger.clearLogs();
    const empty = act.subgoalDone('', '');
    const rig = await roundupRig(t, [empty, empty, empty]);
    await rig.start(TASK);

    const line = runStatsLine();
    assert.match(line, /^\[RUN_STATS\] Task ended partial \(\w+\): level=\w+, steps=\d+, sitesDone=0, sitesPartial=1, elapsed=\d+ms$/);
    assert.doesNotMatch(line, /completed/);
  });
});
