import { interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph/web';

// The stock interrupt() reads the node config from AsyncLocalStorage, which a service worker does
// not have (core falls back to a mock whose getStore() is always undefined, so interrupt() throws
// "Called interrupt() outside the context of a graph."). It is also what plain Node gets from the
// /web entry. getConfig, getWriter, getStore and getCurrentTaskInput depend on the same thing, so
// nothing in this repo may use them: nodes take (state, config) and pass config on.
//
// interrupt() is synchronous, so a one-shot store that hands back the node's own config for the
// duration of that one call is enough. The two Symbol.for keys are internal to @langchain/core and
// langsmith, which is why package.json pins the versions exactly and tests/graph/interruptShim.test.ts
// runs against the installed ones.
const ALS_KEY = Symbol.for('ls:tracing_async_local_storage');
const CHILD_CONFIG_KEY = Symbol.for('lc:child_config');

/**
 * interrupt() for a node that only has its `config` parameter. Only the two `hold` nodes call it,
 * as their first statement, with their own `config`. That makes a re-run of a hold on resume free
 * of side effects: it just returns the saved resume value again.
 *
 * In a worker subgraph the config carries the worker's checkpoint namespace, so the interrupt is
 * saved there and still surfaces through the parent graph.
 */
export function interruptWithConfig<I = unknown, R = unknown>(config: LangGraphRunnableConfig, value: I): R {
  const slots = globalThis as Record<symbol, unknown>;
  const had = Object.hasOwn(slots, ALS_KEY);
  const previous = slots[ALS_KEY];
  slots[ALS_KEY] = {
    getStore: () => ({ extra: { [CHILD_CONFIG_KEY]: config } }),
    run: (_store: unknown, callback: () => unknown) => callback(),
    enterWith() {},
  };
  try {
    return interrupt<I, R>(value);
  } finally {
    // Put back exactly what was there, including "nothing" (a later stock interrupt() must still throw outside a graph).
    if (had) slots[ALS_KEY] = previous;
    else delete slots[ALS_KEY];
  }
}
