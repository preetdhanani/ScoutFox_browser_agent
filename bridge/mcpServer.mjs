/**
 * The MCP server surface of the bridge, built on the official SDK. Four tools:
 *   tarka_run_task    - hand a goal to Tarka's agent; blocks until the run ends
 *   tarka_get_status  - current run state
 *   tarka_stop_task   - stop the active run
 *   tarka_get_history - projected recent history entries of the tracked run
 *
 * Step feedback goes out as notifications/progress (with the concise step message) while
 * tarka_run_task is in flight. When the client cancels the request (notifications/cancelled),
 * the SDK aborts the handler's extra.signal; the bridge then stops the browser run.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_NAMES = ['tarka_run_task', 'tarka_get_status', 'tarka_stop_task', 'tarka_get_history'];

const TOOLS = [
  {
    name: 'tarka_run_task',
    description:
      "Run a task with Tarka, the autonomous browser agent, in the user's Chrome. " +
      'Tarka drives the browser itself (clicking, typing, navigating) and returns the final ' +
      'answer, structured data (table/records) and a step summary. The call blocks until the ' +
      'task finishes or times out (default 15 min). If Chrome is idle, the first call may wait ' +
      'up to ~75 s for the extension to reconnect to the bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The goal for Tarka to accomplish in the browser.' },
        effort: { type: 'string', enum: ['auto', 'off', 'low', 'medium', 'high', 'max'], description: "Reasoning effort for Tarka's model. Default: the extension setting." },
        timeoutMs: { type: 'number', description: 'Maximum run duration in ms (default 900000). On timeout the run is stopped and the partial result returned.' },
        tabId: { type: 'number', description: 'Optional existing tab to run in. Default: Tarka opens its own tab.' },
        startUrl: { type: 'string', description: 'Optional URL the new tab opens (default: a search engine). Use it when the task is about a specific page.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'tarka_get_status',
    description: 'Get the current status of the Tarka agent (idle/running/paused, step count, last outcome).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tarka_stop_task',
    description: 'Stop the currently running Tarka task.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tarka_get_history',
    description: 'Get the recent step history (thoughts and actions) of the tracked Tarka run.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 50).' },
      },
    },
  },
];

/** Summarise a run's steps into at most ~10 concise bullets. */
export function summarizeSteps(steps) {
  const relevant = steps.filter((s) => s.type === 'agent_response' || s.type === 'execution_result' || s.type === 'notice');
  const picked = relevant.length <= 10 ? relevant : [
    ...relevant.slice(0, 5),
    { type: 'notice', message: `... ${relevant.length - 8} further steps ...` },
    ...relevant.slice(-3),
  ];
  return picked.map((s) => {
    if (s.type === 'agent_response') {
      const thought = String(s.thought ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const action = s.action?.action ? ` [${s.action.action}]` : '';
      return `- ${thought}${action}`;
    }
    if (s.type === 'execution_result') {
      const msg = String(s.message ?? s.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
      return `- ${s.success === false ? 'FAILED' : 'ok'}: ${msg}`;
    }
    return `- ${String(s.message ?? '').slice(0, 100)}`;
  });
}

/** Build the single text content block for a finished run. */
export function formatRunResult(done) {
  const outcome = done.outcome ?? (done.status === 'idle' ? 'done' : done.status);
  const lines = [];
  lines.push(`Tarka task ${done.runId ?? ''} finished: outcome ${outcome}${done.note ? ` (${done.note})` : ''}`.trim());
  if (done.answer) lines.push('', 'Answer:', done.answer);
  const steps = summarizeSteps(done.steps ?? []);
  if (steps.length) {
    lines.push('', 'Steps taken:');
    lines.push(...steps);
  }
  lines.push('', '```json');
  lines.push(JSON.stringify({
    answer: done.answer ?? '',
    outcome,
    table: done.table ?? null,
    records: done.records ?? null,
    runStats: done.runStats ?? null,
    chatId: done.runId ?? null,
  }, null, 2));
  lines.push('```');
  const isError = outcome === 'failed' || outcome === 'blocked' || outcome === 'stopped';
  return { text: lines.join('\n'), isError };
}

export function createMcpServer({ session, log }) {
  const server = new Server(
    { name: 'tarka-bridge', version: '1.0.0' },
    { capabilities: { tools: {}, logging: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const progressToken = request.params._meta?.progressToken;
    try {
      switch (name) {
        case 'tarka_run_task': {
          const task = String(args?.task ?? '').trim();
          if (!task) throw new McpError(ErrorCode.InvalidParams, 'task is required');
          const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 900_000;
          const runPromise = session.runTask({
            task,
            effort: args?.effort ?? null,
            timeoutMs,
            tabId: args?.tabId ?? null,
            startUrl: typeof args?.startUrl === 'string' && /^https?:\/\//.test(args.startUrl) ? args.startUrl : null,
            progressToken,
            totalSteps: 250,
          });
          // Client cancellation (notifications/cancelled) aborts extra.signal: stop the run.
          const onAbort = () => {
            log('MCP request cancelled - stopping the browser run');
            session.cancelActive();
          };
          extra.signal.addEventListener('abort', onAbort, { once: true });
          let done;
          try {
            done = await runPromise;
          } finally {
            extra.signal.removeEventListener('abort', onAbort);
          }
          const { text, isError } = formatRunResult({ ...done, steps: session.history });
          return { content: [{ type: 'text', text }], isError };
        }
        case 'tarka_get_status': {
          const status = session.statusPayload();
          return { content: [{ type: 'text', text: '```json\n' + JSON.stringify(status, null, 2) + '\n```' }] };
        }
        case 'tarka_stop_task': {
          const res = session.stopActive();
          return { content: [{ type: 'text', text: res.stopped ? `Stop requested for run ${res.stopped}.` : 'No active bridge run to stop.' }] };
        }
        case 'tarka_get_history': {
          const limit = Number(args?.limit) > 0 ? Number(args.limit) : 50;
          const entries = session.historyPayload(limit);
          return { content: [{ type: 'text', text: '```json\n' + JSON.stringify(entries, null, 2) + '\n```' }] };
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      log(`tool ${name} failed: ${err?.message ?? err}`);
      return {
        content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function runMcpServer({ session, log }) {
  const server = createMcpServer({ session, log });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
