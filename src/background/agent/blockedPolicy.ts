// src/background/agent/blockedPolicy.ts
// Detection of challenge / error pages and execution of blocked ladder escalation.
// Erasable TypeScript (no enums, no parameter properties).

import type { PageVerdict } from '../graph/state.ts';
import RULES from '../../../shared/challenge-rules.json' with { type: 'json' };

export interface VerdictInput {
  url: string;
  title: string;
  pageText?: string;
  elementCount?: number;
}

export type BlockedRung = 'reload' | 'search' | 'alternate_entry' | 'ask_user' | 'mark';

export interface LadderContext {
  tabId: number;
  searchQuery?: string;
  domain: string;
  browser: {
    navigate: (tabId: number, url: string) => Promise<any>;
    reload?: (tabId: number) => Promise<any>;
    reloadTab?: (tabId: number) => Promise<any>;
    tabInfo: (tabId: number) => Promise<any>;
    waitForTabComplete?: (tabId: number, timeoutMs: number) => Promise<any>;
  };
  sleep?: (ms: number) => Promise<void>;
}

export interface LadderResult {
  actionTaken: BlockedRung;
  shouldExitBlocked: boolean;
  reason: string;
}

/**
 * Evaluates whether a webpage is ok, a bot challenge, or an error page.
 */
export function evaluatePageVerdict(input: VerdictInput): PageVerdict {
  const { url = '', title = '', pageText = '', elementCount = 0 } = input;
  const lowerUrl = url.toLowerCase();
  const lowerTitle = title.toLowerCase();
  const lowerText = pageText.toLowerCase();

  // 1. Challenge Checks
  const titleChallenge = RULES.challenge.titlePatterns.some((pattern) => {
    return new RegExp(pattern, 'i').test(lowerTitle);
  });
  if (titleChallenge) return 'challenge';

  const urlChallenge = RULES.challenge.urlPatterns.some((pattern) => {
    return new RegExp(pattern, 'i').test(lowerUrl);
  });
  if (urlChallenge) return 'challenge';

  if (elementCount <= RULES.challenge.maxElementsForBodyMatch) {
    const bodyChallenge = RULES.challenge.bodyPatterns.some((pattern) => {
      return new RegExp(pattern, 'i').test(lowerText);
    });
    if (bodyChallenge) return 'challenge';
  }

  // 2. Error Page Checks
  const prefixError = RULES.errorPage.urlPrefixes.some((p) => lowerUrl.startsWith(p));
  if (prefixError) return 'error_page';

  if (lowerText.length < RULES.errorPage.maxTextLengthForTitleMatch) {
    const titleError = RULES.errorPage.titlePatterns.some((pattern) => {
      return new RegExp(pattern, 'i').test(lowerTitle);
    });
    if (titleError) return 'error_page';
  }

  if (lowerText.length < RULES.errorPage.maxTextLengthForBlankPage && elementCount === 0) {
    return 'error_page';
  }

  return 'ok';
}

/**
 * Executes one rung of the blocked site escalation ladder based on hit count.
 * For Medium: hit 1 -> reload; hit 2 -> mark blocked.
 * For High: hit 1 -> reload; hit 2 -> search; hit 3 -> mark blocked.
 */
export async function executeBlockedLadder(
  hitCount: number,
  rungs: BlockedRung[],
  verdict: PageVerdict,
  ctx: LadderContext
): Promise<LadderResult> {
  const sleep = ctx.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rungIndex = Math.min(hitCount - 1, rungs.length - 1);
  const rung = rungs[rungIndex] || 'mark';

  if (rung === 'reload') {
    if (verdict === 'challenge') {
      // Wait 6s to see if challenge self-resolves
      await sleep(6000);
      const info = await ctx.browser.tabInfo(ctx.tabId).catch(() => null);
      if (info?.title && evaluatePageVerdict({ url: info.url || '', title: info.title, elementCount: 5 }) === 'ok') {
        return {
          actionTaken: 'reload',
          shouldExitBlocked: false,
          reason: 'Challenge passed during initial wait.'
        };
      }
    }

    if (ctx.browser.reload) {
      await ctx.browser.reload(ctx.tabId).catch(() => {});
    } else if (ctx.browser.reloadTab) {
      await ctx.browser.reloadTab(ctx.tabId).catch(() => {});
    } else {
      const current = await ctx.browser.tabInfo(ctx.tabId).catch(() => null);
      if (current?.url) await ctx.browser.navigate(ctx.tabId, current.url).catch(() => {});
    }

    if (ctx.browser.waitForTabComplete) {
      await ctx.browser.waitForTabComplete(ctx.tabId, 8000).catch(() => {});
    }
    if (verdict === 'challenge') {
      await sleep(3000);
    }

    return {
      actionTaken: 'reload',
      shouldExitBlocked: false,
      reason: `Reloaded tab after ${verdict}.`
    };
  }

  if (rung === 'search') {
    const query = ctx.searchQuery || ctx.domain;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await ctx.browser.navigate(ctx.tabId, searchUrl);
    if (ctx.browser.waitForTabComplete) {
      await ctx.browser.waitForTabComplete(ctx.tabId, 8000).catch(() => {});
    }

    return {
      actionTaken: 'search',
      shouldExitBlocked: false,
      reason: `Navigated to search for "${query}".`
    };
  }

  // rung === 'mark'
  return {
    actionTaken: 'mark',
    shouldExitBlocked: true,
    reason: `Site domain ${ctx.domain} is blocked after repeated challenges or errors.`
  };
}
