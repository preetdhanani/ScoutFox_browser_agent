// src/background/agent/prompts.ts
// Prompt construction for LangGraph orchestrator and worker nodes.
// Erasable TypeScript (no enums, no parameter properties).

import type { GoalKind, ModelTier, PolicyMode, StepFailure } from '../graph/state.ts';
import type { PageSig } from '../graph/workerState.ts';
import { renderFailureMemory } from './failureMemory.ts';

export interface PlanUserMessageParams {
  task: string;
  tabTitle?: string;
  tabUrl?: string;
  earlierSessionGoal?: string;
  earlierSessionAnswer?: string;
}

export function buildPlanSystemPrompt(mode: 'initial' | 'revise' = 'initial'): string {
  if (mode === 'revise') {
    return `You revise the plan of a web task after a site ended. Reply with ONE JSON object.
- drop: ids of pending sites to remove.
- add: new sites, with the same fields as in a plan (domain, url, goal, role, kind, difficulty, required_fields, done_when, check). At most 2.
- order: ids of the pending sites in the new order. Name new sites "new1", "new2".
- reason: one short sentence.
Only pending sites can change. Keep the sites the user named, unless they are blocked.`;
  }

  return `You plan web tasks for a browser agent. Read the task and reply with ONE JSON object.
- task_kind: "research" if the user wants facts collected from one or more websites (prices, specs, dates);
  "action" if the user wants something done on a website (click, fill in, buy, sign up);
  "answer" if the user wants the current page read, summarized or explained, or asks about earlier results.
- columns: for research, the values to collect per site, snake_case, at most 5.
  For prices use "price", "shipping", "delivery". Otherwise [].
- search_query: 2 to 6 words that describe the thing to find, without site names.
- compare: if the task compares a value with one site ("flag prices more than 5% away from the official store"),
  reference_domain = that site, field = the column, threshold_pct = the number. Otherwise "", "" and 0.
- sites: research: one entry per website to check, in the order to visit.
  action: one entry per step, 1 to 6 short steps, in order. answer: one entry for the current page.
  domain = like "idealo.de". url = a start URL if you know it, else "". goal = one short sentence.
  role = "reference" for the site the others are compared with, "compare" for the others, else "other".
  kind = "store" (a shop), "listing" (price comparison or list), "search" (search results), "page" (one page or one step).
  difficulty = 1 easy, 2 normal, 3 hard (many pages, bot checks, heavy scripts).
  required_fields = the columns this site must give; [] means only the first column.
  done_when = "all_required", "any" (one field is enough), or "predicate" (an action step with a check).
  check = for an action step, how to see that it worked: type "url_contains", "text_present" or
  "element_text_present" with a value; else type "none" and value "".
Include every website the user names. Do not add websites the user did not ask for,
unless the task asks you to find sources.`;
}

export function buildPlanUserMessage(params: PlanUserMessageParams): string {
  const parts = [`Task: ${params.task}`];
  if (params.tabTitle || params.tabUrl) {
    parts.push(`Current tab: ${params.tabTitle || ''} (${params.tabUrl || ''})`);
  }
  if (params.earlierSessionGoal) {
    parts.push(
      `Earlier in this session:\n- Asked: "${params.earlierSessionGoal}"\n  Result: ${params.earlierSessionAnswer || ''}`
    );
  }
  return parts.join('\n');
}

export function buildPolicySystemPrompt(
  mode: PolicyMode,
  tier: ModelTier = 'small',
  columns: string[] = [],
  priceLike: boolean = false,
  goalKind: GoalKind = 'collect'
): string {
  const identity = 'You are ScoutFox, a browser agent that controls one browser tab.';

  if (mode === 'extract') {
    const colList = columns.length > 0 ? columns.join(', ') : (priceLike ? 'price, shipping, delivery' : 'value');
    return `${identity}
The current page may show the values for the current site. Reply with ONE JSON object.
Actions:
record_finding {${colList}} - copy the values exactly as the page shows them.
  Pick the price from PRICE CANDIDATES. Pick the offer for the exact product in the goal
  (the cheapest if there are several). Write "not shown" if the page does not say it.
mark_not_found {reason} - this site does not have the product
continue_browsing {reason} - the values are not on this page; keep searching this site
scroll {direction} - "down" or "up" to see more of this page
read_page_text {} - read more text of this page
ask_user {question} - only if you cannot continue without the user`;
  }

  if (mode === 'harvest') {
    const colList = columns.length > 0 ? columns.join(', ') : (priceLike ? 'price, shipping, delivery' : 'value');
    return `${identity}
The step budget for this site is almost used up. Save what this page shows now. Reply with ONE JSON object.
Actions:
record_finding {${colList}} - save the values you SEE on this page; write "not shown" if the page does not say it
mark_not_found {reason} - this site does not have the thing you look for
scroll {direction} - "down" or "up" to see more of this page
read_page_text {} - read more text of this page
ask_user {question} - only if you cannot continue without the user`;
  }

  if (mode === 'answer') {
    return `${identity}
Answer the user's task from the current page and the findings. Reply with ONE JSON object.
Actions:
finish {answer} - the full answer for the user, plain text or a short Markdown list
scroll {direction} - see more of the page
read_page_text {} - read more text of this page
ask_user {question} - only if you cannot answer without the user`;
  }

  // mode === 'browse'
  const colList = columns.length > 0 ? columns.join(', ') : (priceLike ? 'price, shipping, delivery' : 'value');
  const largeActions = tier === 'large'
    ? `execute_js {code} - run JavaScript in the page and get the result (max 2000 chars)
read_network_requests {filter, includeBody, limit} - see recent network requests
browser_batch {steps, stopOnError} - up to 8 click/type/scroll/press_key/wait steps on this page
open_window {url} - open a new browser window\n`
    : '';

  const stateActions = goalKind === 'collect'
    ? `record_finding {${colList}} - save the values you SEE on this page for the current site; write "not shown" if the page does not say it
mark_not_found {reason} - this site does not have the thing you look for
mark_blocked {reason} - this site cannot be used (login wall, region lock)\n`
    : `subgoal_done {summary, evidence} - the current step is done; evidence = exact text on the page that proves it\n`;

  return `${identity}
You get the task, the current site and its goal, your progress and the current page (text and numbered elements).
Reply with ONE JSON object: the single next action.
Actions:
click {element_id} - click element [element_id]
type {element_id, text, submit} - replace the text in field [element_id]; submit true presses Enter after typing
scroll {direction} - "down" or "up"
navigate {url} - open a full https:// URL
go_back {} / go_forward {} - browser history back / forward
press_key {key} - Enter, Escape, Tab, ArrowDown, ArrowUp, PageDown, PageUp, Backspace, Space
wait {seconds} - 1 to 5, only while the page is still loading
read_page_text {} - read more text of this page
ask_user {question} - only if you cannot continue without the user
${stateActions}${largeActions}Rules:
1. Work only on the CURRENT SITE and its goal. Code moves you to the next site when it is done.
2. Use only element_id numbers from the current element list.
3. Never click CAPTCHA or "verify you are human" boxes.
4. Never repeat an action from ALREADY TRIED AND FAILED. If an action did not change the page, try something different.
5. Never type passwords, card numbers or one-time codes. Fields marked (user only) are for the user.`;
}

export interface PolicyUserMessageParams {
  task: string;
  siteIndex: number;
  totalSites: number;
  domain: string;
  role: string;
  goal: string;
  columns?: string[];
  usedSteps: number;
  allocSteps: number;
  meterMode: 'normal' | 'warn' | 'harvest' | 'end';
  findingsLines?: string[];
  failures?: StepFailure[];
  bannedSignatures?: string[];
  recentSteps?: string[];
  diffLine?: string | null;
  pageTitle: string;
  pageUrl: string;
  pageType: string;
  scrollY: number;
  pageText: string;
  elementsText: string;
  priceCandidates?: Array<string | { id?: string; text?: string; value?: number; currency?: string; context?: string }>;
  correction?: string | null;
}

export function buildPolicyUserMessage(params: PolicyUserMessageParams): string {
  const parts: string[] = [];

  parts.push(`TASK: ${params.task}`);
  parts.push(
    `CURRENT SITE (${params.siteIndex} of ${params.totalSites}, ${params.domain}, ${params.role}): ${params.goal}`
  );

  if (params.columns && params.columns.length > 0) {
    parts.push(`NEEDED: ${params.columns.join(', ')}`);
  }

  if (params.meterMode === 'warn') {
    parts.push(`BUDGET: ${params.usedSteps} of ${params.allocSteps} steps used on this site. Save what you find soon.`);
  } else if (params.meterMode === 'harvest') {
    const left = Math.max(1, params.allocSteps - params.usedSteps);
    parts.push(`BUDGET: Only ${left} steps left on this site: save what this page shows now.`);
  }

  if (params.findingsLines && params.findingsLines.length > 0) {
    parts.push(`FINDINGS:\n${params.findingsLines.join('\n')}`);
  }

  if (params.failures && params.failures.length > 0) {
    const renderedFailures = renderFailureMemory(params.failures, params.bannedSignatures || []);
    if (renderedFailures) {
      parts.push(`ALREADY TRIED AND FAILED ON THIS SITE:\n${renderedFailures}`);
    }
  }

  if (params.recentSteps && params.recentSteps.length > 0) {
    parts.push(`RECENT STEPS:\n${params.recentSteps.slice(-5).join('\n')}`);
  }

  if (params.diffLine) {
    parts.push(`PAGE CHANGE: ${params.diffLine}`);
  }

  parts.push(`CURRENT PAGE: "${params.pageTitle}" - ${params.pageUrl} (${params.pageType})`);
  parts.push(`Scroll Position: Y=${params.scrollY}px`);

  if (params.priceCandidates && params.priceCandidates.length > 0) {
    const rendered = params.priceCandidates.map((c) => {
      if (typeof c === 'string') return c;
      const val = c.value !== undefined ? ` (${c.currency ?? ''}${c.value})` : '';
      const ctx = c.context ? ` - "${c.context}"` : '';
      return `${c.id || ''} ${c.text || ''}${val}${ctx}`.trim();
    });
    parts.push(`PRICE CANDIDATES:\n${rendered.join('\n')}`);
  }

  parts.push(`PAGE TEXT:\n"""\n${params.pageText.slice(0, 3000)}\n"""`);
  parts.push(`ELEMENTS:\n${params.elementsText}`);

  if (params.correction) {
    parts.push(`CORRECTION: ${params.correction}`);
  }

  parts.push('Reply with the JSON for the next action.');

  return parts.join('\n\n');
}
