/**
 * Two small graphs that pause the way ScoutFox's `hold` nodes do, for the interrupt shim and the
 * checkpointer tests. Both use interruptWithConfig() as the first statement of the hold node.
 *
 *   flat:   a -> hold -> c
 *   nested: plan -> site -> summary, where `site` calls the worker subgraph (open -> hold -> finish)
 *           with its own config parameter, like the design's site wrapper. The worker has private
 *           channels (steps, page) that the parent state never gets.
 *
 * `calls` counts how often each node body ran, so a test can prove that a resume does not run a
 * finished node again.
 */
import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph/web';
import { interruptWithConfig } from '../../src/background/graph/interrupt.ts';

export interface FlatCalls {
  a: number;
  holdAfterInterrupt: number;
  c: number;
}
export interface NestedCalls {
  plan: number;
  site: number;
  open: number;
  holdAfterInterrupt: number;
  summary: number;
}

const concat = <T>(left: T[], right: T[]): T[] => left.concat(right);

export function flatCalls(): FlatCalls {
  return { a: 0, holdAfterInterrupt: 0, c: 0 };
}

export function nestedCalls(): NestedCalls {
  return { plan: 0, site: 0, open: 0, holdAfterInterrupt: 0, summary: 0 };
}

export function buildFlatGraph(checkpointer: BaseCheckpointSaver, calls: FlatCalls = flatCalls()) {
  const State = Annotation.Root({
    count: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
    log: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });
  return new StateGraph(State)
    .addNode('a', async () => {
      calls.a++;
      return { count: 1, log: ['a'] };
    })
    .addNode('hold', async (_state, config) => {
      const answer = interruptWithConfig<{ question: string }, string>(config, { question: 'approve?' });
      calls.holdAfterInterrupt++;
      return { count: 10, log: [`hold:${answer}`] };
    })
    .addNode('c', async () => {
      calls.c++;
      return { count: 100, log: ['c'] };
    })
    .addEdge(START, 'a')
    .addEdge('a', 'hold')
    .addEdge('hold', 'c')
    .addEdge('c', END)
    .compile({ checkpointer });
}

export function buildNestedGraph(checkpointer: BaseCheckpointSaver, calls: NestedCalls = nestedCalls()) {
  const Worker = Annotation.Root({
    siteIn: Annotation<string>(),
    siteOut: Annotation<string>(),
    steps: Annotation<string[]>({ reducer: concat, default: () => [] }),
    page: Annotation<string>(),
  });
  // No checkpointer of its own: called with the parent's config, it checkpoints in its own namespace through the parent's saver.
  const worker = new StateGraph(Worker)
    .addNode('open', async (state) => {
      calls.open++;
      return { page: `page of ${state.siteIn}`, steps: ['open'] };
    })
    .addNode('hold', async (_state, config) => {
      const answer = interruptWithConfig<{ question: string }, string>(config, { question: 'which offer?' });
      calls.holdAfterInterrupt++;
      return { steps: [`hold:${answer}`] };
    })
    .addNode('finish', async (state) => ({ siteOut: `${state.siteIn}|${state.steps.join('>')}` }))
    .addEdge(START, 'open')
    .addEdge('open', 'hold')
    .addEdge('hold', 'finish')
    .addEdge('finish', END)
    .compile();

  const Parent = Annotation.Root({
    log: Annotation<string[]>({ reducer: concat, default: () => [] }),
    results: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });
  return new StateGraph(Parent)
    .addNode('plan', async () => {
      calls.plan++;
      return { log: ['plan'] };
    })
    .addNode('site', async (_state, config) => {
      calls.site++;
      const out = await worker.invoke({ siteIn: 'shop-a' }, config);
      return { results: [out.siteOut], log: ['site'] };
    })
    .addNode('summary', async () => {
      calls.summary++;
      return { log: ['summary'] };
    })
    .addEdge(START, 'plan')
    .addEdge('plan', 'site')
    .addEdge('site', 'summary')
    .addEdge('summary', END)
    .compile({ checkpointer });
}
