// src/background/agent/prompts.ts
// Prompt construction for LangGraph orchestrator and worker nodes.
// Erasable TypeScript (no enums, no parameter properties).

import type { GoalKind, ModelTier, PolicyMode, StepFailure } from '../graph/state.ts';
import type { EarlierSite, PageSig } from '../graph/workerState.ts';
import { renderFailureMemory } from './failureMemory.ts';
import { clipWithNote, PAGE_TEXT_MORE_HINT } from '../../shared/clip.ts';

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
  goalKind: GoalKind = 'collect',
  // The Settings opt-in for execute_js; missing is off, so the prompt does not offer it.
  options: { allowExecuteJs?: boolean } = {}
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
    ? `${options.allowExecuteJs ? 'execute_js {code} - run JavaScript in the page and get the result (max 2000 chars)\n' : ''}read_network_requests {filter, includeBody, limit} - see recent network requests
browser_batch {steps, stopOnError} - up to 8 click/type/scroll/press_key/wait steps on this page
open_window {url} - open a new browser window\n`
    : '';

  // Answer sites browse while budget remains, so they are offered `subgoal_done` with a prose
  // summary; the record node stores that summary as the site's finalAnswer (worker.ts). Without
  // that, an answer site ended on subgoal_done with no finalAnswer and the panel showed
  // "(The model did not provide an answer.)".
  const stateActions = goalKind === 'collect'
    ? `record_finding {${colList}} - save the values you SEE on this page for the current site, copied word-for-word from the page text (a value you wrote yourself, such as a summary, is dropped); write "not shown" if the page does not say it
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
press_key {key} - Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, PageDown, PageUp, Home, End, Backspace, Delete
wait {amount} - 1 to 5, only while the page is still loading
read_page_text {} - read more text of this page
find_element {query} - search the whole page for elements by plain words when the list has no match; the reply lists matches with ids you can click or type
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
  /** The goal kind of the site. Only a collect site SAVES the columns; the others (answer, do) write them into the answer. */
  goalKind?: 'collect' | 'answer' | 'do';
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
  /** How many characters of the page text the prompt shows (see PAGE_TEXT_BUDGET); a longer text is cut with a note. */
  pageTextBudget?: number;
  elementsText: string;
  priceCandidates?: Array<string | { id?: string; text?: string; value?: number; currency?: string; context?: string }>;
  correction?: string | null;
  netErrors?: string;
  userAnswers?: string[];
  oneShotContext?: string | null;
  evidenceBlock?: string;
  planBlock?: string;
  /** Earlier finished tasks of this session, oldest first (previousTurnsSummary lines). */
  recap?: string[];
  /** The previous research task's findings, oldest first (priorFindingLine lines). Not evidence for this task. */
  priorFindings?: string[];
  /** Domains code refuses to open on this site (cross-site and lasting blocked entries). */
  blocked?: Array<{ domain: string; url: string }>;
  /** Pages visited in this task, all sites; the block shows the last MEMORY_CAPS.visitedLines by lastStep. */
  visited?: Array<{ url: string; title: string; verdict: string; lastStep: number }>;
  /** One entry per finished site of this task. */
  earlierSites?: EarlierSite[];
  /** The characters the trimmable memory blocks may take (see MEMORY_BUDGET); over it, they are trimmed in the design's order. */
  memoryBudget?: number;
}

/**
 * The characters of page text the policy prompt shows, per model tier. A large model takes the whole snapshot text
 * (the content script cuts it at 4500); a small one gets less. A text over the budget is cut with a note that names
 * the full size and read_page_text, so the model never takes the head of a long page for the whole page.
 */
export const PAGE_TEXT_BUDGET: Record<ModelTier, number> = { small: 3000, large: 4500 };

/**
 * The per-section caps of the memory blocks. Each line is cut with a visible note (clipWithNote), so a cut line
 * never reads as the whole text.
 */
export const MEMORY_CAPS = {
  /** One finished task of EARLIER IN THIS SESSION (goal plus the 280-character result). */
  recapEntry: 600,
  /** The notes part of one EARLIER SITES line. */
  earlierSiteNote: 120,
  /** VISITED lines, and the URL and title of each. */
  visitedLines: 10, visitedUrl: 100, visitedTitle: 50,
  /** DO NOT OPEN lines, and the URL of each. */
  blockedLines: 10, blockedUrl: 100,
  /** FINDINGS FROM AN EARLIER TASK: the newest lines shown, the fewest the trim keeps, and the length of each. */
  priorFindingLines: 12, priorFindingMin: 4, priorFindingLine: 160,
} as const;

/**
 * The characters the trimmable memory blocks (EARLIER IN THIS SESSION, FINDINGS FROM AN EARLIER TASK, EARLIER
 * SITES) may take per model tier. DO NOT OPEN and VISITED are never trimmed; their line caps bound them.
 */
export const MEMORY_BUDGET: Record<ModelTier, number> = { small: 1800, large: 3600 };

/** The rendered memory sections; a section with nothing to show is undefined. */
export interface MemorySections {
  recap?: string; priorFindings?: string; blocked?: string; visited?: string; earlierSites?: string;
}

/**
 * The memory blocks of the policy user message. When the trimmable blocks are over the budget, code trims in the
 * design's order (docs/langgraph-design.md "Message shape and token budget"): 1. EARLIER SITES lines are cut to their
 * status part; 2. (the step one-liner fold of the in-run memory window); 3. recap lines of older turns go, the most
 * recent finished turn always stays; 4. older prior-task findings go, down to MEMORY_CAPS.priorFindingMin.
 */
export function renderMemorySections(params: Pick<PolicyUserMessageParams, 'recap' | 'priorFindings' | 'blocked' | 'visited' | 'earlierSites' | 'memoryBudget'>): MemorySections {
  const budget = params.memoryBudget ?? MEMORY_BUDGET.small;
  const inline = { inline: true };

  const recapAll = (params.recap ?? []).map((r) => clipWithNote(r, MEMORY_CAPS.recapEntry, inline));
  const priorAll = (params.priorFindings ?? []).map((f) => clipWithNote(f, MEMORY_CAPS.priorFindingLine, inline));
  const sites = params.earlierSites ?? [];

  let recapShown = recapAll.length;
  let priorShown = Math.min(priorAll.length, MEMORY_CAPS.priorFindingLines);
  let siteNotes = true;

  const renderRecap = (): string | undefined => {
    if (recapShown === 0) return undefined;
    const hidden = recapAll.length - recapShown;
    const note = hidden > 0 ? `\n[${hidden} earlier task${hidden === 1 ? '' : 's'} not shown]` : '';
    return `EARLIER IN THIS SESSION (finished tasks, newest last):${note}\n${recapAll.slice(-recapShown).join('\n')}`;
  };
  const renderPrior = (): string | undefined => {
    if (priorShown === 0) return undefined;
    const hidden = priorAll.length - priorShown;
    const note = hidden > 0 ? `\n[${hidden} older finding${hidden === 1 ? '' : 's'} not shown]` : '';
    return `FINDINGS FROM AN EARLIER TASK (a previous request, not evidence for this task; use them only when the task refers back to them):${note}\n${priorAll.slice(-priorShown).join('\n')}`;
  };
  const renderSites = (): string | undefined => {
    if (sites.length === 0) return undefined;
    const lines = sites.map((s) => {
      const notes = siteNotes && s.notes ? ` - ${clipWithNote(s.notes.replace(/\s+/g, ' ').trim(), MEMORY_CAPS.earlierSiteNote, inline)}` : '';
      return `- ${s.head}${notes}`;
    });
    return `EARLIER SITES:\n${lines.join('\n')}`;
  };
  const size = (): number => [renderRecap(), renderPrior(), renderSites()].reduce((n, b) => n + (b ? b.length + 2 : 0), 0);

  if (size() > budget) siteNotes = false;
  while (size() > budget && recapShown > 1) recapShown--;
  while (size() > budget && priorShown > Math.min(priorAll.length, MEMORY_CAPS.priorFindingMin)) priorShown--;

  const blocked = (params.blocked ?? []).slice(0, MEMORY_CAPS.blockedLines)
    .map((b) => `- ${b.domain}${b.url ? ` (${clipWithNote(b.url, MEMORY_CAPS.blockedUrl, inline)})` : ''}`);
  const visited = [...(params.visited ?? [])]
    .sort((a, b) => a.lastStep - b.lastStep)
    .slice(-MEMORY_CAPS.visitedLines)
    .map((v) => {
      const title = v.title ? ` "${clipWithNote(v.title.replace(/\s+/g, ' ').trim(), MEMORY_CAPS.visitedTitle, inline)}"` : '';
      return `- ${clipWithNote(v.url, MEMORY_CAPS.visitedUrl, inline)}${title} - ${v.verdict}`;
    });

  return {
    recap: renderRecap(),
    priorFindings: renderPrior(),
    blocked: blocked.length > 0 ? `DO NOT OPEN (blocked; code refuses to open these):\n${blocked.join('\n')}` : undefined,
    visited: visited.length > 0 ? `VISITED (last ${MEMORY_CAPS.visitedLines}, all sites, newest last):\n${visited.join('\n')}` : undefined,
    earlierSites: renderSites(),
  };
}

/**
 * The shown and total element counts of an ELEMENTS block, read from the block itself: one line per
 * listed element ("[N] ..."), and, when the list cap cut elements, the marker line that names the
 * omitted count. The wall case (a cap cut) is what the count line exists for, so the prompt can
 * point at find_element without a new parameter threading through every caller.
 */
export function elementWindowCounts(elementsText: string): { shown: number; total: number } {
  const lines = String(elementsText ?? '').split('\n');
  const shown = lines.filter((line) => /^\[\d+\] /.test(line)).length;
  const marker = lines.find((line) => /^\[\+\d+ more interactive elements not listed/.test(line));
  const omitted = marker ? Number((marker.match(/^\[\+(\d+) more/) ?? [])[1] ?? 0) : 0;
  return { shown, total: shown + omitted };
}

export function buildPolicyUserMessage(params: PolicyUserMessageParams): string {
  const parts: string[] = [];
  const memory = renderMemorySections(params);

  parts.push(`TASK: ${params.task}`);
  if (memory.recap) parts.push(memory.recap);
  parts.push(
    `CURRENT SITE (${params.siteIndex} of ${params.totalSites}, ${params.domain}, ${params.role}): ${params.goal}`
  );

  if (params.columns && params.columns.length > 0) {
    // "NEEDED: stars, forks" on an answer site nudged small models to record_finding, a verb that site does not offer
    // (the site then ended "done" with no answer). Same columns, said as what the written answer must cover.
    parts.push(params.goalKind && params.goalKind !== 'collect'
      ? `INCLUDE IN YOUR ANSWER: ${params.columns.join(', ')}`
      : `NEEDED: ${params.columns.join(', ')}`);
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

  for (const block of [memory.priorFindings, memory.blocked, memory.visited, memory.earlierSites]) {
    if (block) parts.push(block);
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

  if (params.planBlock) {
    parts.push(params.planBlock);
  }

  if (params.evidenceBlock) {
    parts.push(params.evidenceBlock);
  }

  const pageText = clipWithNote(params.pageText, params.pageTextBudget ?? PAGE_TEXT_BUDGET.small, { what: 'page text', hint: PAGE_TEXT_MORE_HINT });
  parts.push(`PAGE TEXT:\n"""\n${pageText}\n"""`);
  // When the list cap cut elements, the block opens with the count line that names the wall and the
  // way past it, so the model does not take the listed window for the whole page.
  const counts = elementWindowCounts(params.elementsText);
  const elementsHead = counts.total > counts.shown
    ? `ELEMENTS:\n${counts.shown} of ${counts.total} shown - use find_element {query} to search the elements past this list\n`
    : 'ELEMENTS:\n';
  parts.push(`${elementsHead}${params.elementsText}`);

  if (params.correction) {
    parts.push(`CORRECTION: ${params.correction}`);
  }

  if (params.userAnswers && params.userAnswers.length > 0) {
    for (const ans of params.userAnswers) {
      parts.push(`You asked a question and the user answered: "${ans}". Continue the task using this answer.`);
    }
  }

  if (params.oneShotContext) {
    parts.push(params.oneShotContext);
  }

  parts.push('Reply with the JSON for the next action.');

  return parts.join('\n\n');
}
