// src/background/agent/actionSignature.ts
// The one builder for action signatures. The stuck check, the ban list and the failure memory all
// compare these strings, so every construction site must go through this builder instead of
// formatting its own. The base is verb, element_id and url; verbs without a target get the argument
// that changes meaning appended, so a scroll down, a scroll up, two different typed queries or two
// paged read parts never share a signature.

import type { SiteRun } from '../graph/workerState.ts';

function hash32(str: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return h.toString(16);
}

/**
 * The signature of one page action: 'verb|element_id|url' plus, for the verbs whose arguments
 * change meaning, a fourth field with the scroll direction, the pressed key, a hash of the typed
 * text, a hash of the script code, a hash of the batch steps, or the part number of a paged read.
 */
export function actionSignatureOf(action: any, readPart?: number): string {
  const verb = action?.action ?? '';
  const base = `${verb}|${action?.element_id ?? ''}|${action?.url ?? ''}`;
  let extra = '';
  if (verb === 'scroll') extra = action.direction ?? '';
  else if (verb === 'press_key') extra = action.key ?? '';
  else if (verb === 'type') extra = hash32(action.text ?? '');
  else if (verb === 'execute_js') extra = hash32(action.code ?? '');
  else if (verb === 'browser_batch') extra = hash32(JSON.stringify(action.steps ?? []));
  else if (verb === 'read_page_text' && readPart !== undefined) extra = `part${readPart}`;
  return extra !== '' ? `${base}|${extra}` : base;
}

/**
 * The part number the next full-page read returns: the tracked next part while the page is
 * unchanged since the last read, otherwise 0, because a changed page starts the read over.
 */
export function nextReadPart(siteRun: SiteRun | null | undefined, page: { url?: string; sig?: { textHash?: string } } | null | undefined): number {
  const key = `${page?.url ?? ''}|${page?.sig?.textHash ?? ''}`;
  return siteRun?.readPartKey === key ? (siteRun?.readPartNext ?? 0) : 0;
}
