/**
 * fakeLlm - a scripted stand-in for the model, for Node tests.
 *
 * The test writes down what the model will say, in order. Every call the code under test makes
 * takes the next reply. A call the script has no reply for THROWS (and is kept in fl.violations),
 * so a run that makes one model call more than the test expected can never give a false green.
 * Every call is recorded (messages, system prompt, schema, signal), so a test can also assert on
 * what the model was shown.
 *
 * Example:
 *   import { fakeLlm } from './helpers/fakeLlm.ts';
 *
 *   const fl = fakeLlm([
 *     '["Open the store page", "Read the price"]',                        // the plan call
 *     JSON.stringify({ action: 'click', element_id: 3 }),                 // step 1
 *     { text: '{"action":"finish","answer":"1.399 EUR"}', delayMs: 20 },  // step 2, a slow reply
 *   ]);
 *   const restore = fl.install(ApiClients);   // replaces ApiClients.generateCompletion
 *   try { await engine.startTask('...', 101); } finally { restore(); }
 *   fl.calls.length;                          // 3
 *   fl.calls[1].messages.at(-1)?.content;     // what the model saw at step 1
 *   fl.assertClean();                         // no call went past the script
 *   fl.assertDrained();                       // and every reply was used
 *
 * A reply (one entry of the script):
 *   a string      the model's text
 *   an object     { text?, reasoning?, delayMs?, error? }
 *                   text       the answer ('' is a valid, empty answer)
 *                   reasoning  the model's thinking. generateCompletion returns it as
 *                              `<think>...</think>` in front of the text (what the parsers strip);
 *                              the chat model puts it in additional_kwargs.reasoning_content
 *                   delayMs    the reply arrives this many milliseconds later (an abort ends the wait)
 *                   error      the call fails: a string becomes new Error(string), an Error is
 *                              thrown as it is. It excludes text and reasoning
 *   a function    called with the recorded call ({ index, messages, systemPrompt, ... }); returns any
 *                 of the above (or a promise of one). Use it to answer by what the model was shown.
 *   fakeLlm(fn) alone answers every call with fn, so there is no script to run out of.
 *
 * Two surfaces share one script and one call log:
 *   fl.generateCompletion(settings, messages, systemPrompt, { signal, json, schema }) -> string
 *     is what today's engine calls. fl.install(ApiClients) puts it in place and returns the
 *     function that puts back what was there.
 *   fl.chatModel() -> a LangChain BaseChatModel. invoke(messages, { signal }) returns an AIMessage.
 *     The system message becomes systemPrompt, and ChatOllama's `format` call option is recorded
 *     as the schema.
 *
 * Abort: a call whose signal is already aborted fails at once and uses NO reply (the request would
 * never have been sent). An abort while a delayed reply is waiting ends the call. Both fail with
 * signal.reason, like fetch: with a plain controller.abort() that is a DOMException named
 * AbortError, which the engine's isUserAbort() recognises. The record says outcome 'aborted'.
 *
 * What is a model failure and what is a test mistake:
 *   Failures a real provider would report (a timeout, a 500, an abort) are the errors you script,
 *   plus the abort above. Test mistakes throw: a call with no reply left, a reply object with an
 *   unknown key, and a reply that has both text and error. A bad entry in a plain script throws
 *   from fakeLlm() or push() at once. A bad answer of a function, an exhausted script, and an
 *   error thrown by a function itself (usually a failed assert about what the model was shown)
 *   are thrown to the code under test and also kept in fl.violations, in case it swallows the
 *   error (the engine's retry loop does). A function that wants a model failure returns { error }.
 *   The one error a function may throw is the call's own abort reason, which is an abort.
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelCallOptions, BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface LlmMessage {
  role: string;
  content: string;
}

/** The object form of a reply. Exactly one of the text side (text, reasoning) or error. */
export interface ReplyObject {
  text?: string;
  reasoning?: string;
  delayMs?: number;
  error?: string | Error;
}
export type ReplySpec = string | ReplyObject;

/** One call, as recorded. `outcome` is 'pending' until the call settles. */
export interface LlmCall {
  /** 0-based position among all calls of this fake, on either surface. */
  index: number;
  via: 'generateCompletion' | 'chatModel';
  /** generateCompletion only: the settings object it was given (a copy). undefined for the chat model. */
  settings: unknown;
  /** Every message except the system one(s), as { role, content }. Roles are user, assistant or tool. */
  messages: LlmMessage[];
  /** The system prompt ('' when there is none). */
  systemPrompt: string;
  /** options.schema of generateCompletion, or the `format` call option of the chat model. null when absent. */
  schema: object | null;
  /** options.json of generateCompletion (false for the chat model). */
  json: boolean;
  /** The signal the caller passed, by reference (null when none). */
  signal: AbortSignal | null;
  outcome: 'pending' | 'text' | 'error' | 'aborted';
  /**
   * What the call returned, as generateCompletion returns it: the text, with the model's reasoning in
   * front as <think>...</think> when the reply has any. The chat model records the same string, though
   * its AIMessage holds the text alone (the reasoning is in additional_kwargs.reasoning_content).
   */
  reply: string | undefined;
  /** What the call threw. */
  error: unknown;
}

export type ReplyEntry = ReplySpec | ((call: LlmCall) => ReplySpec | Promise<ReplySpec>);
export type LlmScript = ReplyEntry[] | ((call: LlmCall) => ReplySpec | Promise<ReplySpec>);

/** The options of ApiClients.generateCompletion. Other keys are allowed and ignored. */
export interface CompletionOptions {
  signal?: AbortSignal | null;
  json?: boolean;
  schema?: object | null;
  [key: string]: unknown;
}
export type GenerateCompletion = (settings: unknown, messages: LlmMessage[], systemPrompt: string, options?: CompletionOptions) => Promise<string>;

export interface FakeChatCallOptions extends BaseChatModelCallOptions {
  /** ChatOllama's constrained-decoding schema. Recorded as call.schema. */
  format?: object;
}

export interface FakeLlm {
  /** The stand-in for ApiClients.generateCompletion. */
  readonly generateCompletion: GenerateCompletion;
  /** A LangChain chat model over the same script and call log. Each call returns a new one. */
  chatModel(params?: BaseChatModelParams): BaseChatModel<FakeChatCallOptions>;
  /** Put generateCompletion on target (ApiClients). Returns the function that puts back what was there. */
  install(target: { generateCompletion: unknown }): () => void;
  /** Every call so far, in order. */
  readonly calls: LlmCall[];
  /** Replies not used yet (always 0 for a script that is one function). */
  readonly remaining: number;
  /** Add replies at the end of the script, e.g. after a pause. Not for a script that is one function. */
  push(...entries: ReplyEntry[]): void;
  resetCalls(): void;
  /** Test mistakes that were thrown to the code under test (also thrown by assertClean). */
  readonly violations: Error[];
  assertClean(): void;
  /** Throws when replies are left over, i.e. the code under test made fewer calls than the test expected. */
  assertDrained(): void;
}

// ---------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------

interface Answer {
  text: string;
  reasoning: string | undefined;
  delayMs: number;
  error: Error | undefined;
}

const REPLY_KEYS = ['text', 'reasoning', 'delayMs', 'error'];

/** A test mistake in the fake itself. */
class FakeLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeLlmError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks one reply and turns it into an answer. Throws a FakeLlmError for a mistake. */
function toAnswer(spec: unknown, where: string): Answer {
  if (typeof spec === 'string') return { text: spec, reasoning: undefined, delayMs: 0, error: undefined };
  if (!isObject(spec)) {
    throw new FakeLlmError(`fakeLlm: ${where} is ${spec === null ? 'null' : typeof spec}, not a reply - use a string, or an object like { text, reasoning, delayMs, error }`);
  }
  for (const key of Object.keys(spec)) {
    if (!REPLY_KEYS.includes(key)) throw new FakeLlmError(`fakeLlm: ${where} has an unknown key "${key}"; a reply object has ${REPLY_KEYS.join(', ')}`);
  }
  const { text, reasoning, delayMs = 0, error } = spec;
  if (text !== undefined && typeof text !== 'string') throw new FakeLlmError(`fakeLlm: ${where}: text must be a string`);
  if (reasoning !== undefined && typeof reasoning !== 'string') throw new FakeLlmError(`fakeLlm: ${where}: reasoning must be a string`);
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) throw new FakeLlmError(`fakeLlm: ${where}: delayMs must be a number of milliseconds, 0 or more (got ${String(delayMs)})`);
  if (error !== undefined && typeof error !== 'string' && !(error instanceof Error)) throw new FakeLlmError(`fakeLlm: ${where}: error must be a string or an Error`);
  if (error !== undefined && (text !== undefined || reasoning !== undefined)) {
    throw new FakeLlmError(`fakeLlm: ${where} has both error and text/reasoning - a reply is either an answer or a failure`);
  }
  if (error === undefined && text === undefined && reasoning === undefined) {
    throw new FakeLlmError(`fakeLlm: ${where} has neither text nor error - give it { text: '...' } or { error: '...' } (text: '' is an empty answer)`);
  }
  return {
    text: text ?? '',
    reasoning,
    delayMs,
    error: typeof error === 'string' ? new Error(error) : error,
  };
}

/** What generateCompletion returns: the text, with the thinking in front as <think> tags. */
function asString(answer: Answer): string {
  if (answer.reasoning === undefined) return answer.text;
  const thinking = `<think>${answer.reasoning}</think>`;
  return answer.text === '' ? thinking : `${thinking}\n${answer.text}`;
}

/** Waits ms, and ends early (with signal.reason, like fetch) when the signal aborts. */
function wait(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A deep copy of plain data; anything structuredClone cannot copy is kept by reference. */
function copy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function preview(messages: LlmMessage[]): string {
  const last = messages.at(-1)?.content ?? '';
  return JSON.stringify(last.length > 80 ? `${last.slice(0, 80)}...` : last);
}

// ---------------------------------------------------------------------------------------------
// The chat model
// ---------------------------------------------------------------------------------------------

type CallInput = Pick<LlmCall, 'via' | 'settings' | 'messages' | 'systemPrompt' | 'schema' | 'json' | 'signal'>;
type Run = (input: CallInput) => Promise<Answer>;

const ROLES: Record<string, string> = { human: 'user', ai: 'assistant', system: 'system', tool: 'tool' };

function textOf(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content : message.text;
}

class FakeChatModel extends BaseChatModel<FakeChatCallOptions> {
  #run: Run;

  constructor(run: Run, params: BaseChatModelParams = {}) {
    super(params);
    this.#run = run;
  }

  _llmType(): string {
    return 'fake-llm';
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const system = messages.filter((m) => m.type === 'system');
    const rest = messages.filter((m) => m.type !== 'system');
    const answer = await this.#run({
      via: 'chatModel',
      settings: undefined,
      messages: rest.map((m) => ({ role: ROLES[m.type] ?? m.type, content: textOf(m) })),
      systemPrompt: system.map(textOf).join('\n'),
      schema: options.format ?? null,
      json: false,
      signal: options.signal ?? null,
    });
    if (answer.error) throw answer.error;
    const message = new AIMessage({
      content: answer.text,
      additional_kwargs: answer.reasoning === undefined ? {} : { reasoning_content: answer.reasoning },
    });
    return { generations: [{ text: answer.text, message }] };
  }
}

// ---------------------------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------------------------

export function fakeLlm(script: LlmScript = []): FakeLlm {
  const calls: LlmCall[] = [];
  const violations: Error[] = [];
  const always = typeof script === 'function' ? script : undefined;
  const queue: ReplyEntry[] = [];
  let scripted = 0;

  /** Test setup: a plain reply is checked now, so a typo fails at the line that wrote it. */
  const enqueue = (entries: ReplyEntry[]) => {
    entries.forEach((entry, i) => {
      if (typeof entry !== 'function') toAnswer(entry, `reply ${queue.length + i + 1} of the script`);
    });
    queue.push(...entries);
    scripted += entries.length;
  };
  if (!always) enqueue(script as ReplyEntry[]);

  /** A test mistake met while a call runs: kept, and thrown to the code under test. */
  const violation = (message: string): FakeLlmError => {
    const error = new FakeLlmError(message);
    violations.push(error);
    return error;
  };

  const next = async (call: LlmCall): Promise<Answer> => {
    let entry: ReplyEntry | undefined = always;
    if (!entry) {
      entry = queue.shift();
      if (entry === undefined) {
        throw violation(
          `fakeLlm: call ${call.index + 1} (${call.via}, last message ${preview(call.messages)}) has no scripted reply - ` +
            `the script has only ${scripted} reply(ies). Add a reply to the script, or use a function that answers every call`
        );
      }
    }
    let spec: ReplySpec;
    if (typeof entry === 'function') {
      try {
        spec = await entry(call);
      } catch (error) {
        // Thrown by the test's own function, mostly a failed assert about what the model was shown.
        // The code under test may swallow it (the retry loop takes the next reply), so keep it here.
        // A function that waited on the signal and failed with its reason is an abort, and run() says so.
        if (!(call.signal?.aborted && error === call.signal.reason)) violations.push(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    } else {
      spec = entry;
    }
    try {
      return toAnswer(spec, `the reply for call ${call.index + 1}`);
    } catch (error) {
      violations.push(error as Error);
      throw error;
    }
  };

  const run: Run = async (input) => {
    const call: LlmCall = { ...input, index: calls.length, outcome: 'pending', reply: undefined, error: undefined };
    calls.push(call);
    try {
      // A request that was cancelled before it started never reaches the model, so it uses no reply.
      call.signal?.throwIfAborted();
      const answer = await next(call);
      if (answer.delayMs > 0) await wait(answer.delayMs, call.signal);
      call.signal?.throwIfAborted();
      if (answer.error) throw answer.error;
      call.reply = asString(answer);
      call.outcome = 'text';
      return answer;
    } catch (error) {
      call.error = error;
      call.outcome = call.signal?.aborted && error === call.signal.reason ? 'aborted' : 'error';
      throw error;
    }
  };

  const generateCompletion: GenerateCompletion = async (settings, messages, systemPrompt, options = {}) => {
    const answer = await run({
      via: 'generateCompletion',
      settings: copy(settings),
      messages: copy(messages),
      systemPrompt,
      schema: options.schema ?? null,
      json: options.json === true,
      signal: options.signal ?? null,
    });
    return asString(answer);
  };

  return {
    generateCompletion,
    chatModel: (params) => new FakeChatModel(run, params),
    install: (target) => {
      const previous = target.generateCompletion;
      target.generateCompletion = generateCompletion;
      return () => {
        target.generateCompletion = previous;
      };
    },
    calls,
    get remaining() {
      return queue.length;
    },
    push: (...entries) => {
      if (always) throw new Error('fakeLlm: push() needs a script that is a list of replies, but this fake answers every call with one function');
      enqueue(entries);
    },
    resetCalls: () => {
      calls.length = 0;
    },
    violations,
    assertClean: () => {
      if (violations.length > 0) {
        throw new Error(`fakeLlm: ${violations.length} test mistake(s) were thrown to the code under test:\n${violations.map((v) => `  - ${v.message}`).join('\n')}`);
      }
    },
    assertDrained: () => {
      if (queue.length > 0) {
        throw new Error(`fakeLlm: ${queue.length} scripted reply(ies) were never used - the code under test made ${calls.length} call(s), fewer than the test expected`);
      }
    },
  };
}
