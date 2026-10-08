// src/background/agent/failureMemory.ts
// Step failure tracking, deduplication, retry bounding, and banned repeats enforcement.
// Erasable TypeScript (no enums, no parameter properties).

import type { StepFailure } from '../graph/state.ts';

export interface NewFailure {
  step?: number;
  verb: string;
  target?: string;
  elementId?: number;
  url?: string;
  signature: string;
  kind: StepFailure['kind'];
  detail: string;
}

export const MAX_FAILURE_RECORDS = 6;

export function signatureOfFailure(f: StepFailure): string {
  const elem = f.action.elementId !== undefined ? f.action.elementId : (f.action.label?.match(/^\[(\d+)\]/)?.[1] ?? '');
  return `${f.action.verb}|${elem}|${f.action.url ?? ''}`;
}

/**
 * Records a failure into the site's failure memory.
 * Deduplicates by action verb + elementId/url + kind (increments count), keeps newest 6 failures.
 * Flags whether the signature should now be banned if count exceeds retriesPerAction.
 */
export function recordFailure(
  existing: StepFailure[],
  incoming: NewFailure,
  retriesPerAction: number = 1
): { failures: StepFailure[]; shouldBan: boolean; failure: StepFailure } {
  const list = [...existing];
  const parsedElem = incoming.signature ? parseInt(incoming.signature.split('|')[1], 10) : NaN;
  const resolvedElemId = incoming.elementId !== undefined ? incoming.elementId : (!Number.isNaN(parsedElem) ? parsedElem : undefined);
  const incomingSig = incoming.signature || `${incoming.verb}|${resolvedElemId ?? ''}|${incoming.url ?? ''}`;

  const idx = list.findIndex(
    (f) => signatureOfFailure(f) === incomingSig && f.kind === incoming.kind
  );

  let failure: StepFailure;
  if (idx >= 0) {
    const prev = list[idx];
    failure = {
      ...prev,
      count: prev.count + 1,
      detail: incoming.detail || prev.detail,
      step: incoming.step ?? prev.step
    };
    list.splice(idx, 1);
    list.unshift(failure);
  } else {
    failure = {
      step: incoming.step ?? 1,
      kind: incoming.kind,
      action: {
        verb: incoming.verb,
        elementId: resolvedElemId,
        url: incoming.url,
        label: incoming.target
      },
      url: incoming.url || '',
      detail: incoming.detail,
      count: 1
    };
    list.unshift(failure);
  }

  const trimmed = list.slice(0, MAX_FAILURE_RECORDS);
  const shouldBan = failure.count > retriesPerAction;

  return {
    failures: trimmed,
    shouldBan,
    failure
  };
}

/**
 * Checks whether an action signature is in the banned list.
 */
export function isSignatureBanned(bannedList: string[], signature: string): boolean {
  if (!signature || !Array.isArray(bannedList)) return false;
  return bannedList.includes(signature);
}

/**
 * Formats the ALREADY TRIED AND FAILED ON THIS SITE block for model prompts.
 * Example:
 * - click [88] "Framework Laptop 16 DIY" -> covered: "Cookie-Einstellungen" dialog (x3, blocked by ScoutFox)
 */
export function renderFailureMemory(failures: StepFailure[], bannedList: string[] = []): string {
  if (!failures || failures.length === 0) return '';

  const lines = failures.map((f) => {
    const sig = signatureOfFailure(f);
    const isBanned = bannedList.includes(sig);
    const countPart = f.count > 1 ? ` (x${f.count}${isBanned ? ', blocked by ScoutFox' : ''})` : (isBanned ? ' (blocked by ScoutFox)' : '');
    const targetDesc = f.action.label ? ` ${f.action.label}` : (f.action.elementId !== undefined ? ` [${f.action.elementId}]` : (f.action.url ? ` ${f.action.url}` : ''));
    return `- ${f.action.verb}${targetDesc} -> ${f.kind}: ${f.detail}${countPart}`;
  });

  return lines.join('\n');
}
