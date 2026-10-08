/**
 * The Anthropic SDK's credential chain stays off in the extension, because in the worker it cannot work.
 *
 * @anthropic-ai/sdk can read its credentials from config files, a profile or a token exchange, and for that it
 * imports node:fs and node:path. In the worker bundle Vite turns those into empty modules (the 7 allowed warnings
 * in vite.config.mjs). The chain starts only for a client that has neither an apiKey nor an authToken, and every
 * ChatAnthropic of ours has a key, so the empty modules are never used. This test runs the real code to show it:
 *
 *   - a call through our Anthropic path and through the AgentRouter path (which also uses ChatAnthropic) touches the
 *     file system zero times, and
 *   - a client built without a key does touch it (the control: the spy can see the chain).
 *
 * It runs in a child process, because the file system spy must be in place before the SDK is loaded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const url = (rel: string) => JSON.stringify(pathToFileURL(`${ROOT}${rel}`).href);

interface Result { touched: string[]; text: string }

function run(scenario: 'anthropic' | 'agent_router' | 'keyless-client'): Result {
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    // Everything is loaded first, so the spy counts what a call does and not what loading a module does.
    const { generateCompletion } = await import(${url('src/background/llm/index.ts')});
    const { redirectFetch, startSlowServer } = await import(${url('tests/helpers/slowServer.ts')});
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const cleanup = [];
    const t = { after: (fn) => cleanup.push(fn) };
    const server = await startSlowServer(t, { holdMs: 0, replyText: 'hello' });
    redirectFetch(t, { 'https://api.anthropic.com': server.base });

    const touched = [];
    const spy = (target, names, label) => {
      for (const name of names) {
        const original = target[name];
        if (typeof original !== 'function') continue;
        target[name] = function (...args) { touched.push(label + name); return original.apply(this, args); };
      }
    };
    spy(fs, ['readFileSync', 'readFile', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'openSync', 'accessSync', 'mkdirSync', 'writeFileSync', 'realpathSync'], 'fs.');
    spy(fs.promises, ['readFile', 'stat', 'lstat', 'access', 'readdir', 'mkdir', 'writeFile', 'open', 'realpath'], 'fs.promises.');
    syncBuiltinESMExports();

    let text = '';
    if (${JSON.stringify(scenario)} === 'anthropic') {
      text = await generateCompletion({ provider: 'anthropic', apiKey: 'sk-ant-test-123', model: 'claude-3-5-sonnet-20241022' }, [{ role: 'user', content: 'hi' }], 'system');
    } else if (${JSON.stringify(scenario)} === 'agent_router') {
      text = await generateCompletion({ provider: 'agent_router', apiKey: 'sk-test-123', baseUrl: server.base, model: 'claude-3-5-sonnet' }, [{ role: 'user', content: 'hi' }], 'system');
    } else {
      new Anthropic({ dangerouslyAllowBrowser: true });
    }
    // The chain, when it runs, starts in the constructor and reads a file within a few ticks. The control waits for it (up to 5 s), the others give it 300 ms.
    if (${JSON.stringify(scenario)} === 'keyless-client') for (let waited = 0; !touched.length && waited < 5000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    else await new Promise((resolve) => setTimeout(resolve, 300));
    process.stdout.write(JSON.stringify({ touched: touched.slice(0, 20), text }) + '\\n', () => process.exit(0));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, HOME: '/nonexistent-home-for-scoutfox-test', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' } });
  assert.equal(child.status, 0, `the child process failed: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').pop() as string) as Result;
}

test('control: an Anthropic client with no key starts its credential chain and touches the file system', () => {
  const { touched } = run('keyless-client');
  assert.ok(touched.length > 0, 'the spy saw nothing, so the two tests below prove nothing (did the SDK change?)');
});

test('a call through the Anthropic path touches the file system zero times', () => {
  const { touched, text } = run('anthropic');
  assert.equal(text, 'hello');
  assert.deepEqual(touched, []);
});

test('a call through the AgentRouter path (ChatAnthropic on /v1/messages) touches the file system zero times', () => {
  const { touched, text } = run('agent_router');
  assert.equal(text, 'hello');
  assert.deepEqual(touched, []);
});
