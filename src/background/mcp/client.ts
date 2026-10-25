// src/background/mcp/client.ts
// MCP client: drives the LLM tool-calling loop. The LLM chooses tools, the server
// executes them in the browser, results are fed back to the LLM. Loops until finish.
//
// The loop is one awaited chain: startTask resolves when the run ends, so the runner's task
// claim is held for the whole run. Every tool call and result is recorded into the runner's
// history, which is what the side panel's timeline renders from (STATE_UPDATE broadcasts).
import { ScoutFoxMCPServer, type ImageContent } from './server.ts';
import { SCOUTFOX_TOOLS, type ToolDef } from './tools.ts';
import { coordinateSpaceOf, coordinateWords, pictureCaption, type CoordinateSpace } from '../llm/coordinates.ts';
import { Storage } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';
import { extractReadableAnswer } from '../../shared/answerText.ts';
import { describeStep } from '../../shared/stepText.ts';
import { userAbortReason } from '../llm/deadline.ts';
import { visionSupport } from '../llm/vision.ts';
import { normalizeEffort, oneLevelLower, type EffortLevel } from '../llm/effort.ts';
import type { ToolReply } from '../llm/index.ts';
import {
  agentResponseEntry,
  errorEntry,
  executionResultEntry,
  finishEntry,
  mapToolToAction,
  screenshotResultEntry,
  summarizeToolResult,
  userGoalEntry
} from './historyEntries.ts';
import type { ContentBlock } from '../llm/types.ts';
import type { RunRuntime } from '../runner/runtimeRegistry.ts';
import type { HistoryEntry, RunStatus } from '../types.ts';

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /**
   * A plain string, or an array of blocks when the message carries a picture.
   * Only a `role:'user'` message ever carries a picture: a `role:'tool'` message is text only on
   * every provider (see llm/types.ts ContentBlock).
   */
  content: string | ContentBlock[];
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  /** OpenRouter's reasoning_details of an assistant turn: sent back as they came, as OpenRouter asks. */
  reasoning_details?: unknown[];
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

/**
 * What the client needs from the runner to make a run visible: the history rows the panel
 * renders from, the plan checklist, and the run status. Kept narrow so the client never
 * touches runner internals, and so tests can stand in for the runner.
 */
export interface RunRecorder {
  readonly history: HistoryEntry[];
  readonly planSteps: Array<{ text: string; status: string }>;
  readonly autoApprovePlan: boolean;
  recordEntry(entry: HistoryEntry): void;
  setRunStatus(status: RunStatus, pauseReason?: 'user' | 'llm_failure' | 'worker_restart' | null): void;
  setPlanSteps(steps: Array<{ text: string; status: string }>): void;
  setPendingApproval(value: any): void;
  /** Clears the manual-approve card and moves to the next status in one state broadcast. */
  resolvePendingApproval(status: RunStatus, pauseReason?: 'user' | 'llm_failure' | 'worker_restart' | null): void;
}

const PLAN_APPROVED_TEXT = 'Plan approved. Execute the plan step by step.';
const PLAN_REJECTED_TEXT = 'Plan rejected by the user. Stop now: do not run any action.';
const PLAN_PAUSED_TEXT = 'The run was paused while the plan waited for approval. Call update_plan again to ask the user to approve it.';

/** The answer to any tool but update_plan while manual approval waits for a plan. */
export const PLAN_FIRST_TEXT = 'Error: manual approval is on. Call update_plan with your plan first: no other tool runs until the user approves it.';

/** What the model is told when the run has used all its steps. */
/** How much of the model's thinking text one log event keeps. */
const REASONING_LOG_CHARS = 4000;

export const STEP_LIMIT_TEXT = (steps: number) => `STEP LIMIT: you have used all ${steps} steps of this run. Call finish now with what you found so far, and say what is still missing.`;

/**
 * How long the loop waits before each retry of a passing provider failure (a 5xx, a 429, a dropped
 * connection). NVIDIA NIM answered 500 twice and then 429 within 8 s (2026-10-25), so the later
 * waits are long enough for a rate limit to pass.
 */
export const PROVIDER_RETRY_DELAYS_MS = [2000, 6000, 15000, 30000];

/**
 * Whether a provider failure is worth a retry: a server error, a rate limit, or a connection that
 * dropped. A 4xx is a refusal of the request itself and a retry would only repeat it; a timeout
 * already waited the whole deadline.
 */
export function isTransientProviderError(err: any): boolean {
  if (!err || err.scoutfox === 'user' || err.name === 'AbortError' || err.name === 'ProviderTimeoutError') return false;
  const status = Number(err.status);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return err.name === 'TypeError' && /fetch|network/i.test(String(err.message || ''));
}

/** A message of the conversation, summarized for the log: role, size, the start of its text. */
function messageSummary(message: Message): Record<string, unknown> {
  const text = Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    : String(message.content ?? '');
  const pictures = Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image_url').length : 0;
  return {
    role: message.role,
    chars: text.length,
    text: text.slice(0, 400),
    ...(pictures ? { pictures } : {}),
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call) => call.function.name) } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
  };
}

/** The click tool, with x and y described in the scale the model points with. */
export function clickToolFor(tool: ToolDef, space: CoordinateSpace): ToolDef {
  if (space === 'pixels') return tool;
  const words = coordinateWords(space);
  return {
    ...tool,
    description: 'Click an element by its ID from get_page_elements or find, or at a point of the last take_screenshot picture. Use IDs for links, buttons, checkboxes, tabs. Use x and y only for a target you see on a screenshot: ' + words.rule + '.',
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        x: { type: 'number', description: words.x },
        y: { type: 'number', description: words.y }
      }
    }
  };
}

/** The tool result of a call the loop never ran because the run was paused first. */
export const NOT_RUN_TEXT = 'Not run: the run was paused before this call. Call it again if it is still needed.';

/** How many pictures in the message history keep their bytes. Older ones become this placeholder. */
export const KEPT_PICTURES = 2;

/** What an older picture is replaced with, so the model knows one was there and is gone. */
export const TRIMMED_PICTURE_TEXT = '[an earlier picture of the page was removed to keep the context small]';

/** What every picture becomes when the provider has refused one and the round is retried. */
export const UNSEEN_PICTURE_TEXT = '[a picture of the page was taken, but this model cannot see pictures]';

/**
 * The server's picture block as the LLM layer's content blocks.
 *
 * One user message carries all the pictures of a round, each with its own text label, so the
 * model knows which picture is which. The data URL is built here, at the one hop where the bytes
 * become a wire payload.
 */
export function pictureBlocks(pictures: ImageContent[], space: CoordinateSpace = 'pixels'): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const picture of pictures) {
    blocks.push({
      type: 'text',
      text: pictureCaption(space, picture.imageWidth, picture.imageHeight)
    });
    blocks.push({
      type: 'image_url',
      image_url: { url: `data:${picture.mediaType};base64,${picture.data}` }
    });
  }
  return blocks;
}

/** Whether a message of the history carries a picture. */
export function carriesPicture(message: Message): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'image_url');
}

/**
 * The history with every picture beyond the last `keep` replaced by text.
 *
 * The tool block above each picture message is untouched, so the tool-call pairing the providers
 * validate stays exactly as it was. The message stays a user message with a text-only content
 * array, so no message is added or removed.
 *
 * This is a text-level replacement, so it works for both providers with no provider-specific code.
 */
export function trimPictures(history: Message[], keep = KEPT_PICTURES): Message[] {
  const withPictures = history.filter(carriesPicture);
  if (withPictures.length <= keep) return history;
  const dropped = new Set(withPictures.slice(0, withPictures.length - keep));
  return history.map((message) => {
    if (!dropped.has(message)) return message;
    const text = Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')).join('\n\n')
      : '';
    return { ...message, content: `${text ? `${text}\n\n` : ''}${TRIMMED_PICTURE_TEXT}` };
  });
}

/**
 * The history with every picture removed and its place kept by a line of text. Used when a
 * provider has refused a picture: the round is retried once without any, and the run goes on.
 */
export function stripPictures(history: Message[]): Message[] {
  return history.map((message) => {
    if (!carriesPicture(message)) return message;
    const text = Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')).join('\n\n')
      : '';
    return { ...message, content: `${text ? `${text}\n\n` : ''}${UNSEEN_PICTURE_TEXT}` };
  });
}

/** The error text that means "this model cannot take a picture", in the words providers use. */
export function looksLikeImageRejection(message: string): boolean {
  if (!message) return false;
  const mentionsImage = /image|image_url|vision|multimodal|picture/i.test(message);
  if (!mentionsImage) return false;
  // A 400 or a 422 is a request the provider refused. A 500 or a timeout is not evidence about
  // images, and retrying those as text would hide a real failure.
  return /\b400\b|\b422\b|not support|unsupported|invalid|does not support|cannot.*(?:image|picture)/i.test(message);
}

/**
 * A tool call's arguments as an object. Providers hand them over as a JSON string (OpenAI's
 * convention, which the loop keeps), but an object is accepted too, so no path can lose them.
 */
export function toolArguments(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Malformed arguments happen; the tools tolerate missing fields and the run goes on.
    return {};
  }
}

export class ScoutFoxMCPClient {
  private server: ScoutFoxMCPServer;
  private runtime: RunRuntime;
  private runner: RunRecorder;
  private messageHistory: Message[] = [];
  private isRunning = false;
  private step = 0;
  private planCursor = 0;
  private currentPageUrl = '';
  private currentPageTitle = '';
  /** True once a picture has reached the history this run, so a provider refusal is a picture refusal. */
  private sawPicture = false;
  /** The user's own instructions from Settings, read once per task and put ahead of the system prompt. */
  private systemInstructions = '';
  /**
   * Which loop is the live one. Pause then Resume while a model call is in flight would otherwise
   * leave the old loop running next to the new one; every loop checks its generation and leaves
   * the moment a newer one exists.
   */
  private loopGeneration = 0;
  /** Cancels the model request in flight on Pause or Stop. One per loop. */
  private loopAbort: AbortController | null = null;
  /** True once a plan was approved this task (or the mode needs none): manual approval gates every tool before it. */
  private planApproved = false;
  /** How many model calls this task made, for the log ("Model call 3"). */
  private modelCalls = 0;
  /** How hard the model thinks, as the user chose it for this task (llm/effort.ts). Never the step count. */
  private effort: EffortLevel = 'auto';
  /** Whether a tool of the last round failed: the next round gets the full effort. */
  private roundHadFailure = false;
  // Resolves the manual-approve hold: true when the user approves the plan, false when they
  // cancel or the run is stopped while the card is up.
  private planApprovalResolve: ((approved: boolean) => void) | null = null;

  constructor(runtime: RunRuntime, runner: RunRecorder) {
    this.runtime = runtime;
    this.runner = runner;
    this.server = new ScoutFoxMCPServer();
    this.server.setRuntime(runtime);
  }

  /**
   * Replaces the capture path of the server, so a test or the harness can stand in for Chrome.
   * The client owns its server, so this is the one seam a test has into the tool execution.
   */
  setScreenshotDeps(factory: Parameters<ScoutFoxMCPServer['setScreenshotDeps']>[0]) {
    this.server.setScreenshotDeps(factory);
  }

  /** The bytes of one picture this run took, for the panel's thumbnail. */
  async getScreenshot(imageId: string): Promise<{ data: string; mediaType: string } | null> {
    return this.server.getScreenshot(imageId);
  }

  /**
   * Runs one task. `startPaused` is a Pause that landed while the task was being claimed: the
   * turn is set up, and the loop waits for resume() instead of starting.
   */
  async startTask(userPrompt: string, { startPaused = false, effort = 'auto' }: { startPaused?: boolean; effort?: EffortLevel | string } = {}) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.effort = normalizeEffort(effort);
    this.roundHadFailure = false;
    this.messageHistory = [];
    this.step = 0;
    this.planCursor = 0;
    this.sawPicture = false;
    this.planApproved = false;
    this.modelCalls = 0;

    try {
      await this.beginTurn(userPrompt);
      if (startPaused) {
        this.isRunning = false;
        return;
      }
      await this.runLoop(this.newLoop());
    } catch (err: any) {
      // A failure before the loop even started (no tab, no snapshot) must still end the run.
      Logger.error('MCP Client', 'Error starting the task', err);
      if (this.isRunning) await this.onRunError(err?.message || String(err));
    }
  }

  private async beginTurn(userPrompt: string) {
    // The tab's title and URL come from the tabs API; the page preview comes from the same
    // get_page_text call the server serves. The tool result is a content envelope, not the
    // snapshot itself, so the text is read out of content[0].
    const tabId = this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId;
    const info = tabId ? await this.runtime.browser.tabInfo(tabId) : null;
    this.currentPageTitle = info?.title || '';
    this.currentPageUrl = info?.url || '';

    const result = await this.callTool('get_page_text', {});
    const previewText = result.text || '';

    const settings = await Storage.getSettings();
    this.systemInstructions = (settings.systemInstructions || '').trim();
    // The scale this model points with on a picture: the tool text asks for it and the server reads it.
    this.coordinateSpace = coordinateSpaceOf(settings);
    this.server.setCoordinateSpace(this.coordinateSpace);

    // A model its provider reports as text-only (Ollama's capabilities) is never sent a picture
    // and never offered the camera. 'unknown' (a cloud model, a failed probe) keeps the tool; a
    // refusal is then handled by the retry in callProviderWithTools.
    if (await visionSupport(settings).catch(() => 'unknown') === 'no') this.server.setVisionUnavailable();

    // Screenshots are always on: take one picture of the page as it opens, before the model is
    // asked to act, and put it in the first turn, so the model reads the page's look as well as
    // its text. The server's capture refuses on pages it cannot read (chrome://, etc.), so this is
    // best-effort and never blocks the run.
    let opening: ImageContent | undefined;
    if (tabId && !this.server.isVisionUnavailable()) {
      try {
        const shot = await this.callTool('take_screenshot', {});
        if (shot.image && !shot.isError) opening = shot.image;
      } catch (_) {
        // A page that cannot be photographed falls back to text only. The model can still act.
      }
    }

    this.messageHistory.push(
      { role: 'system', content: this.buildSystemPrompt() },
      {
        role: 'user',
        content: `TASK: ${userPrompt}\n\nCURRENT PAGE: ${this.currentPageTitle}\n${this.currentPageUrl}\n\nPage preview:\n${previewText.slice(0, 2000) || '(empty)'}`
      }
    );
    if (opening) {
      this.messageHistory.push({ role: 'user', content: pictureBlocks([opening], this.coordinateSpace) });
      this.sawPicture = true;
    }

    // The turn is one higher than the user_goals the session already has, so a follow-up task
    // in the same tab starts its own turn in the timeline.
    const turn = this.runner.history.filter((h) => h.type === 'user_goal').length + 1;
    this.runner.recordEntry(userGoalEntry(turn, userPrompt));
  }

  private buildSystemPrompt(): string {
    // The tools are not listed here: every provider path already sends them (native tool
    // definitions, or the prompt path's own tool list), and a second copy cost about 1,400 prompt
    // tokens on every call.
    const coords = coordinateWords(this.coordinateSpace);
    const userRules = this.systemInstructions ? `USER INSTRUCTIONS (from Settings, follow them):\n${this.systemInstructions}\n\n` : '';
    return `${userRules}You are ScoutFox, an AI browser agent controlling a Chrome tab.

CURRENT CONTEXT:
- Active tab: ${this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId}
- Page URL: ${this.currentPageUrl}
- Page title: ${this.currentPageTitle}

RULES (MANDATORY):
1. PLAN FIRST for multi-step tasks: Call update_plan with your plan before ANY other tool.
   - Simple tasks (summarize, single click, single extract): skip planning, act directly
   - Complex tasks (multi-site, multi-step, conditional): MUST call update_plan first
${this.runner.autoApprovePlan ? '' : '   - MANUAL APPROVAL IS ON: call update_plan before any other tool even for a simple task; the user must approve the plan before you act.'}

2. ALWAYS CALL A TOOL BEFORE RESPONDING WITH TEXT (turn_answer_start rule).
   - No "I'll help you..." without a tool call
   - No explanatory text without a tool call

3. ELEMENT INTERACTION:
   - Use get_page_elements to see clickable items with IDs [1], [2], [3]...
   - Use find {query} to search elements by description when list is long
   - ONLY use element IDs returned by get_page_elements or find

4. READING vs ACTING:
   - If answer is on current page: call get_page_text, then finish
   - If action needed: call click/type/scroll/navigate, then continue
   - navigate, and a click or a type that opens a new page, return the new page's text with the
     result. Do not call get_page_text again for that page: read the result and act on it
   - To search, type the query with submit=true (it presses Enter) instead of clicking a search button

5. SAFETY:
   - Never type passwords, card numbers, OTP codes
   - Never click, type into or try to solve a bot check, CAPTCHA or "verify you are human" box,
     and do not wait for one to pass. Call finish at once and tell the user the page is behind a
     bot check that a person has to pass
   - If user declines an action: DO NOT workaround, respect the decision
   - Stay on the current site unless navigate is explicitly needed

6. COMPLETION:
   - Call finish {answer} when task is done
   - Answer should be complete and directly address the user's task
   - The answer is read by a person: write human-readable prose or markdown, never raw JSON
   - Never wrap the answer in a JSON object ({"summary": ...}, {"answer": ...}): put the prose
     straight into the answer field of finish

7. SEEING THE PAGE:
   - Take a screenshot when the text does not tell you what you need: is a control disabled,
     is something covering the page, what does the layout look like, where is a target with no text
   - A screenshot shows the VISIBLE viewport. Scroll first if you need further down the page
   - After a screenshot you may click at a point of it (click {x, y}): ${coords.rule}
   - A coordinate outside that picture, or from an older picture, is refused: take a new one
   - Prefer element IDs. Use coordinates only for what you can see but cannot find by ID

WORKFLOW EXAMPLES:

Example 1 - Summarize (answer task):
  User: "Summarize this paper"
  -> get_page_text -> finish {answer: "..."}

Example 2 - Click & Download (action task):
  User: "Click View PDF and download"
  -> find "View PDF" -> click [id] -> finish

Example 3 - Multi-step (planning required):
  User: "Find cheapest Framework laptop across 3 sites"
  -> update_plan {plan: ["Search site1", "Search site2", "Search site3", "Compare prices"]}
  -> (user approves) -> navigate (returns the page text) -> navigate -> ... -> finish

Example 4 - Look at the page (visual task):
  User: "Click the green Download button"
  -> take_screenshot -> ${coords.example} -> finish`;
  }

  /**
   * The awaited tool loop. One LLM round per iteration: execute every tool call of the round
   * sequentially, feed all results back, then ask again. Exits when the run completes, errors,
   * or is stopped - never leaves a second loop running behind the first.
   */
  /** Starts a new loop generation with its own abort controller, and returns the generation. */
  private newLoop(): number {
    this.loopAbort = new AbortController();
    this.loopGeneration += 1;
    return this.loopGeneration;
  }

  /** Whether the loop of this generation may go on: the run is live and no newer loop exists. */
  private isLive(generation: number): boolean {
    return this.isRunning && generation === this.loopGeneration;
  }

  private async runLoop(generation: number): Promise<void> {
    try {
      while (this.isLive(generation)) {
        const settings = await Storage.getSettings();
        // The step budget of Settings: at the limit the model gets one last round with only
        // finish, so the run ends with what it found instead of spinning on.
        const maxSteps = Number(settings.maxSteps) > 0 ? Number(settings.maxSteps) : 250;
        const atLimit = this.step >= maxSteps;
        if (atLimit) this.messageHistory.push({ role: 'user', content: STEP_LIMIT_TEXT(maxSteps) });
        const response = await this.callProviderWithTools(settings, atLimit, this.effortForRound(settings, atLimit));
        if (!this.isLive(generation)) return;
        if (atLimit && !response.tool_calls?.some((call) => call.function.name === 'finish')) {
          await this.onTaskComplete(response.text?.trim() || `The run stopped at its limit of ${maxSteps} steps before the task was done.`);
          return;
        }
        // At the limit only the finish runs, even when the model also asked for more.
        if (atLimit) response.tool_calls = response.tool_calls!.filter((call) => call.function.name === 'finish');
        // A Stop or Pause during the model call lands here: the runner has already broadcast
        // its state, so the loop exits without recording or completing anything.
        if (!this.isLive(generation)) return;

        const calls = response.tool_calls;
        if (calls && calls.length > 0) {
          this.messageHistory.push({ role: 'assistant', content: '', tool_calls: calls, ...(response.reasoningDetails ? { reasoning_details: response.reasoningDetails } : {}) });
          this.roundHadFailure = false;
          const results: Message[] = [];
          const pictures: ImageContent[] = [];
          let interrupted = false;
          for (const toolCall of calls) {
            // Every tool call gets a reply, even one a Pause kept from running: an assistant
            // tool_calls message with a missing reply is a 400 on the OpenAI family after Resume.
            if (interrupted || !this.isLive(generation)) {
              interrupted = true;
              results.push({ role: 'tool', tool_call_id: toolCall.id, content: NOT_RUN_TEXT });
              continue;
            }
            const outcome = await this.executeToolCall(toolCall);
            if (outcome.done) return; // finish handled: the run is complete
            results.push({ role: 'tool', tool_call_id: toolCall.id, content: outcome.content });
            if (outcome.image) pictures.push(outcome.image);
            if (outcome.interrupted) interrupted = true;
          }
          // The pictures follow the WHOLE tool block, in one user message. A user message inside
          // the block would break the tool-call pairing that OpenAI-compatible servers and
          // Ollama's chat template both validate.
          if (pictures.length > 0) results.push({ role: 'user', content: pictureBlocks(pictures, this.coordinateSpace) });
          this.messageHistory.push(...results);
          if (interrupted) return;
        } else if (response.text) {
          // A plain-text reply completes the run (the model ignored the tools). Its text is
          // pushed first, so a resumed or audited run still sees what the model said.
          this.messageHistory.push({ role: 'assistant', content: response.text });
          await this.onTaskComplete(response.text);
          return;
        } else {
          await this.onRunError('The model returned neither a tool call nor text.');
          return;
        }
      }
    } catch (err: any) {
      // A Pause or Stop cancels the request in flight; that rejection is not an error of the run.
      if (!this.isLive(generation)) return;
      Logger.error('MCP Client', 'Error in tool loop', err);
      await this.onRunError(err?.message || String(err));
    }
  }

  /**
   * The effort of the next model call. The chosen level goes to the first call, to the call after
   * a failed tool and to the step-limit call; with "Save thinking on routine steps" on (the
   * default), the routine calls in between get one level less, never below Low. Off and Auto are
   * sent as chosen.
   */
  private effortForRound(settings: any, atLimit: boolean): EffortLevel {
    const full = this.modelCalls === 0 || atLimit || this.roundHadFailure;
    if (full || settings?.effortAdaptive === false) return this.effort;
    return oneLevelLower(this.effort);
  }

  private async callProviderWithTools(settings: any, finishOnly = false, effort: EffortLevel = this.effort): Promise<ToolReply> {
    const signal = this.loopAbort?.signal;
    let timeoutRetried = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callProviderOnce(settings, finishOnly, effort);
      } catch (err: any) {
        // A hosted model that never answered is most often a request stuck in its queue: one more
        // try, at once. A second timeout is the provider's real answer and ends the run.
        if (err?.name === 'ProviderTimeoutError' && !timeoutRetried && !signal?.aborted) {
          timeoutRetried = true;
          Logger.warn('MCP Client', `${err.message} Trying once more.`);
          continue;
        }
        const delay = PROVIDER_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || signal?.aborted || !isTransientProviderError(err)) throw err;
        Logger.warn('MCP Client', `The provider failed (${err?.message || err}); retry ${attempt + 1} of ${PROVIDER_RETRY_DELAYS_MS.length} in ${delay / 1000}s`);
        await this.runtime.clock.sleep(delay, signal);
        if (signal?.aborted) throw err;
      }
    }
  }

  /** One model call, logged with what was sent and what came back (or why it failed). */
  private async callProviderOnce(settings: any, finishOnly: boolean, effort: EffortLevel): Promise<ToolReply> {
    this.modelCalls += 1;
    const round = this.modelCalls;
    const model = String(settings.model || '');
    const started = Date.now();
    const request = {
      messageCount: this.messageHistory.length,
      messages: this.messageHistory.map(messageSummary),
      tools: (finishOnly ? SCOUTFOX_TOOLS.filter((tool) => tool.name === 'finish') : this.offeredTools()).map((tool) => tool.name)
    };
    try {
      const reply = await this.requestModel(settings, finishOnly, effort);
      const calls = reply.tool_calls || [];
      const said = calls.length
        ? `chose ${calls.map((call) => call.function.name).join(', ')}`
        : 'answered in text';
      Logger.event('llm', 'Model', `Model call ${round} (${model}): ${said}`, {
        round,
        provider: settings.provider,
        model,
        durationMs: Date.now() - started,
        request,
        // The effort as chosen and as sent: the dialect, the level and the very fields, or null
        // when the model takes none (a custom endpoint, a model that cannot reason, Auto).
        effort: { chosen: this.effort, round: effort, sent: reply.effortSent ?? null },
        ...(reply.reasoning ? { reasoning: reply.reasoning.slice(0, REASONING_LOG_CHARS) } : {}),
        response: calls.length
          ? { tool_calls: calls.map((call) => ({ id: call.id, name: call.function.name, arguments: toolArguments(call.function.arguments) })) }
          : { text: reply.text || '' }
      });
      return reply;
    } catch (err: any) {
      if (!this.loopAbort?.signal.aborted) {
        Logger.event('llm', 'Model', `Model call ${round} (${model}) failed: ${String(err?.message || err).slice(0, 200)}`, {
          round, provider: settings.provider, model, durationMs: Date.now() - started, request, error: String(err?.message || err)
        // One attempt: the loop may retry it. A run that really ends on it is logged as an error by onRunError.
        }, 'WARN');
      }
      throw err;
    }
  }

  private async requestModel(settings: any, finishOnly: boolean, effort: EffortLevel): Promise<ToolReply> {
    const { callProviderWithTools } = await import('../llm/index.ts');
    const tools = finishOnly ? SCOUTFOX_TOOLS.filter((tool) => tool.name === 'finish') : this.offeredTools();
    const signal = this.loopAbort?.signal;
    // The trim happens here, where the payload is built: the last two pictures keep their bytes
    // and older ones become text, so a long run does not re-send every picture on every round.
    const history = trimPictures(this.messageHistory);
    try {
      return await callProviderWithTools(settings.provider, settings, history, '', {
        tools,
        toolChoice: 'auto',
        signal,
        effort
      });
    } catch (err: any) {
      // A provider that refuses a picture must not end the run. Strip the pictures, stop
      // offering the tool, and retry this round once on the text path.
      if (signal?.aborted || !this.sawPicture || !looksLikeImageRejection(err?.message || String(err))) throw err;
      Logger.info('MCP Client', `The provider refused the picture; retrying this round without it: ${err?.message || err}`);
      this.sawPicture = false;
      this.server.setVisionUnavailable();
      this.messageHistory = stripPictures(this.messageHistory);
      const retryHistory = trimPictures(this.messageHistory);
      return await callProviderWithTools(settings.provider, settings, retryHistory, '', {
        tools: finishOnly ? tools : this.offeredTools(),
        toolChoice: 'auto',
        signal,
        effort
      });
    }
  }

  /**
   * The tools the model is offered, which is the whole list. Screenshots are always on now:
   * every page load gets a picture taken automatically, and the model can call take_screenshot
   * itself whenever it wants another look. A provider that already refused a picture still loses
   * the tool for the run via `isVisionUnavailable`.
   */
  private offeredTools(): any[] {
    const tools = this.server.isVisionUnavailable() ? SCOUTFOX_TOOLS.filter((tool) => tool.name !== 'take_screenshot') : SCOUTFOX_TOOLS;
    return tools.map((tool) => (tool.name === 'click' ? clickToolFor(tool, this.coordinateSpace) : tool));
  }

  /** The scale the model of this run points with. Set at the start of every turn. */
  private coordinateSpace: CoordinateSpace = 'pixels';

  /**
   * One tool call of the LLM: record it, execute it, record the result. Returns the tool's
   * result text for the message history, or done:true when the run ended with this call.
   *
   * The picture a tool produced travels separately from the text: the text goes into the tool
   * message, and the picture is collected by the loop and sent in a user message after the whole
   * tool block (see pictureBlocks).
   */
  private async executeToolCall(toolCall: ToolCall): Promise<{ done: boolean; interrupted?: boolean; content: string; image?: ImageContent; table?: { columns: string[]; rows: string[][] } }> {
    const args = toolArguments(toolCall.function.arguments);
    const name = toolCall.function.name;
    const tabId = this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId;
    const sentence = describeStep(name, args, this.server.elementLabel(tabId, args.element_id));
    const started = Date.now();
    /** The step in the log: the sentence, and the tool, its arguments and its result as details. */
    const logStep = (ok: boolean, text: string, extra: Record<string, unknown> = {}) => {
      if (!ok) this.roundHadFailure = true;
      Logger.event('tool', 'Agent', ok ? sentence : `${sentence} - failed: ${text.replace(/^Error:\s*/, '').slice(0, 160)}`, {
        step: this.step,
        tool: name,
        arguments: args,
        result: { ok, text },
        durationMs: Date.now() - started,
        ...extra
      }, ok ? 'INFO' : 'WARN');
    };

    this.step += 1;
    const action = mapToolToAction(name, args);
    if (action) {
      this.runner.recordEntry(agentResponseEntry(this.step, String(args.reason || ''), action, JSON.stringify(toolCall)));
    }

    if (name === 'update_plan') {
      const plan = Array.isArray(args.plan) ? args.plan.map(String) : [];
      const content = await this.handlePlanApproval(plan);
      logStep(!content.startsWith('Error') && content !== PLAN_REJECTED_TEXT, content);
      return { done: false, content };
    }

    // Manual approval holds every tool until a plan is approved: the prompt asks for that, and
    // this is what makes it true when a model skips the plan.
    if (!this.runner.autoApprovePlan && !this.planApproved) {
      this.runner.recordEntry(executionResultEntry(this.step, false, PLAN_FIRST_TEXT));
      logStep(false, PLAN_FIRST_TEXT);
      return { done: false, content: PLAN_FIRST_TEXT };
    }

    // A screenshot the model asks for when it is not offered is answered with the honest reason,
    // never with a picture the provider would then refuse again.
    if (name === 'take_screenshot' && this.server.isVisionUnavailable()) {
      const text = 'Error: this model cannot see pictures, so the screenshot was not taken. Use get_page_text instead.';
      this.runner.recordEntry(executionResultEntry(this.step, false, text));
      logStep(false, text);
      return { done: false, content: text };
    }

    const result = await this.callTool(name, args);
    // Paused or stopped mid-tool: the runner already broadcast it. The action may have happened,
    // so its result still goes into the history, and the loop leaves after this block.
    if (!this.isRunning) return { done: false, interrupted: true, content: result.text || NOT_RUN_TEXT, image: result.image };

    const resultText = result.text || '';
    const ok = !result.isError;
    logStep(ok, resultText, {
      page: { url: this.currentPageUrl },
      ...(result.image ? { picture: { width: result.image.imageWidth, height: result.image.imageHeight, mediaType: result.image.mediaType } } : {})
    });
    if (name === 'take_screenshot') {
      this.runner.recordEntry(screenshotResultEntry(this.step, ok, summarizeToolResult(resultText), result.image));
    } else if (name === 'render_table') {
      this.runner.recordEntry(executionResultEntry(this.step, ok, summarizeToolResult(resultText), result.table));
    } else {
      this.runner.recordEntry(executionResultEntry(this.step, ok, summarizeToolResult(resultText)));
    }
    this.advancePlanChecklist(ok);
    if (result.image) this.sawPicture = true;

    if (resultText.startsWith('TASK_COMPLETE:')) {
      await this.onTaskComplete(resultText.slice('TASK_COMPLETE:'.length).trim(), result.table);
      return { done: true, content: resultText, image: result.image, table: result.table };
    }
    return { done: false, content: resultText, image: result.image, table: result.table };
  }

  private async callTool(name: string, args: any): Promise<{ text: string; image?: ImageContent; table?: { columns: string[]; rows: string[][] }; isError?: boolean }> {
    // The server answers with the outcome already split: the text the model reads, and at most
    // one picture that the loop puts in a user message after the tool block.
    return await this.server.callTool(name, args);
  }

  /**
   * update_plan: the plan becomes the panel's checklist. In auto mode the run continues at once.
   * In manual mode the plan card goes up and the loop waits for APPROVE_PLAN: the promise below
   * is resolved by handleApprovePlan(), or by stop() when the run is stopped while waiting.
   */
  private async handlePlanApproval(plan: string[]): Promise<string> {
    this.runner.setPlanSteps(plan.map((text) => ({ text, status: 'pending' })));
    this.planCursor = 0;

    // Nothing to approve: an empty plan is not a hold, just continue like auto mode. Under manual
    // approval an empty plan approves nothing, so the tools stay held.
    if (this.runner.autoApprovePlan) return PLAN_APPROVED_TEXT;
    if (plan.length === 0) return 'Error: the plan is empty. Call update_plan with the steps you will take, so the user can approve them.';

    this.runner.setPendingApproval({ plan: plan.slice() });
    this.runner.setRunStatus('paused');
    const approved = await new Promise<boolean>((resolve) => {
      this.planApprovalResolve = resolve;
    });
    this.planApprovalResolve = null;

    // A Stop (or a pause) while the card was up: release it without touching the status the
    // runner already broadcast. After a Resume the model is told to ask again.
    if (!this.isRunning) {
      this.runner.setPendingApproval(null);
      return PLAN_PAUSED_TEXT;
    }

    if (!approved) {
      this.isRunning = false;
      this.runner.resolvePendingApproval('stopped');
      this.runner.recordEntry(finishEntry('Plan cancelled. No actions were run.'));
      return PLAN_REJECTED_TEXT;
    }
    this.planApproved = true;
    this.runner.resolvePendingApproval('running');
    return PLAN_APPROVED_TEXT;
  }

  /** Mark the plan step this tool was working on as done (a simple index-based mapping). */
  private advancePlanChecklist(ok: boolean) {
    const steps = this.runner.planSteps;
    if (!ok || !Array.isArray(steps) || steps.length === 0) return;
    const at = Math.min(this.planCursor, steps.length - 1);
    if (steps[at]?.status === 'completed') return;
    steps[at] = { ...steps[at], status: 'completed' };
    this.planCursor = Math.min(this.planCursor + 1, steps.length);
  }

  /** The panel's APPROVE_PLAN decision: releases the manual-approve hold. */
  handleApprovePlan(approved: boolean) {
    const resolve = this.planApprovalResolve;
    this.planApprovalResolve = null;
    resolve?.(approved);
  }

  private async onTaskComplete(answer: string, table?: { columns: string[]; rows: string[][] }) {
    this.isRunning = false;
    // A model that answers with a JSON object instead of prose would show a wall of braces in
    // the panel. The readable part is pulled out here, where the answer is stored, so every
    // reader of the history sees the sentence the model meant.
    const readable = extractReadableAnswer(answer);
    Logger.event('agent', 'Agent', `Finished after ${this.step} step${this.step === 1 ? '' : 's'}: ${readable.text.replace(/\s+/g, ' ').slice(0, 160)}`, {
      steps: this.step, modelCalls: this.modelCalls, answer: readable.text, ...(table ? { table } : {})
    });
    this.runner.recordEntry(finishEntry(readable.text, readable.evidence, table));
    this.runner.setRunStatus('idle');
  }

  private async onRunError(message: string) {
    this.isRunning = false;
    Logger.event('agent', 'Agent', `The run failed: ${message.slice(0, 200)}`, { steps: this.step, modelCalls: this.modelCalls, error: message }, 'ERROR');
    this.runner.recordEntry(errorEntry(message));
    this.runner.setRunStatus('error');
  }

  /** Stop or Pause: the loop exits at its next check; a plan card up at the time is released. */
  stop() {
    this.isRunning = false;
    this.loopAbort?.abort(userAbortReason('user_pause_or_stop'));
    this.planApprovalResolve?.(false);
    this.planApprovalResolve = null;
  }

  /** Resume after a pause: re-enter the loop from the message history still held. */
  resume() {
    if (this.isRunning) return;
    this.isRunning = true;
    void this.runLoop(this.newLoop());
  }
}
