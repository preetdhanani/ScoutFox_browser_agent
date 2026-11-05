/**
 * Pure text helpers shared by the content script (page reads) and the service worker (fetch_url):
 * whitespace normalising, collapsing repeated runs, and the stateless paging of a long text.
 * No DOM and no chrome APIs, so both sides (and the tests) can import it.
 */
import { splitIntoParts } from './clip.ts';

export const REPEAT_MIN_RUN = 4;
export const REPEAT_MAX_UNIT_WORDS = 64;
export const REPEAT_MAX_PASSES = 4;

export const HAS_LETTER = /\p{L}/u;
export const PRICE_LIKE = /[€$£¥₹]\s?\d|\d\s?(?:[€$£¥₹]|EUR\b|USD\b|GBP\b|CHF\b|CAD\b|AUD\b|Euro\b)/i;
export const DELIVERY_LIKE = /\b(?:shipping|shipment\w*|deliver\w*|arriv\w*|versand\w*|liefer\w*|werktag\w*|business days?|working days?|porto)\b/i;

/**
 * One pass: finds runs of REPEAT_MIN_RUN or more identical units and replaces them with
 * concise summaries or collapses.
 */
export function collapseRepeatedRunsOnce(text: string): string {
  const matchLead = text.match(/^\s*/);
  const lead = matchLead ? matchLead[0] : '';
  const words: string[] = [];
  const gaps: string[] = [];
  for (const [, word, gap] of text.matchAll(/(\S+)(\s*)/g)) {
    words.push(word);
    gaps.push(gap);
  }
  const n = words.length;
  if (n < REPEAT_MIN_RUN) return text;
  const shapes = words.map((word) => word.replace(/\d+/g, '#'));

  const sameShape = (a: number, b: number, size: number) => {
    for (let t = 0; t < size; t++) {
      if (shapes[a + t] !== shapes[b + t]) return false;
    }
    return true;
  };

  const unitText = (start: number, size: number) => {
    let out = '';
    for (let t = 0; t < size; t++) {
      out += words[start + t] + (t < size - 1 ? gaps[start + t] : '');
    }
    return out;
  };

  const runAt = (i: number) => {
    let best = { size: 0, count: 0 };
    let skip = 0;
    const longest = Math.min(REPEAT_MAX_UNIT_WORDS, Math.floor((n - i) / REPEAT_MIN_RUN));
    for (let size = 1; size <= longest; size++) {
      let count = 1;
      while (i + (count + 1) * size <= n && sameShape(i, i + count * size, size)) count++;
      if (count < REPEAT_MIN_RUN) continue;
      if (!HAS_LETTER.test(unitText(i, size))) {
        skip = Math.max(skip, size * count);
      } else if (size * count > best.size * best.count) {
        best = { size, count };
      }
    }
    return { ...best, skip };
  };

  const out = [lead];
  let i = 0;
  while (i < n) {
    const { size, count, skip } = runAt(i);
    if (size === 0) {
      const stay = Math.max(1, skip);
      for (let t = 0; t < stay; t++) out.push(words[i + t], gaps[i + t]);
      i += stay;
      continue;
    }

    const end = i + size * count;
    const first = unitText(i, size);
    let identical = true;
    for (let u = 1; u < count && identical; u++) {
      identical = unitText(i + u * size, size) === first;
    }

    let summary: string | null = null;
    if (identical) {
      summary = `${first} (repeated ${count} times)`;
    } else if (!PRICE_LIKE.test(first) && !DELIVERY_LIKE.test(first)) {
      summary = `${first} ... ${unitText(end - size, size)} (${count} similar entries)`;
    }

    let runLength = words[end - 1].length;
    for (let t = i; t < end - 1; t++) runLength += words[t].length + gaps[t].length;
    if (summary !== null && summary.length < runLength) {
      out.push(summary, gaps[end - 1]);
    } else {
      for (let t = i; t < end; t++) out.push(words[t], gaps[t]);
    }
    i = end;
  }
  return out.join('');
}

/**
 * Runs of repeated units become summaries, collapsing cycles across multiple passes.
 */
export function collapseRepeatedRuns(text: string): string {
  let current = text;
  for (let pass = 0; pass < REPEAT_MAX_PASSES; pass++) {
    const next = collapseRepeatedRunsOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * The visible text with its whitespace normalised: one space inside a line, no blank lines, nothing at the ends.
 * innerText separates table cells with a tab; they are kept apart as " | ", so a row still shows its columns.
 */
export function normalizePageText(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .map((line) => line.split('\t').map((cell) => cell.replace(/[\s\u00a0]+/g, ' ').trim()).filter(Boolean).join(' | '))
    .filter(Boolean)
    .join('\n');
}

/** The size of one part of a paged read_page: the whole page text is read in parts of at most this many characters. */
export const PAGE_TEXT_PART = 3000;

/** One part of a paged read: its text, the note that says where it is, and how many parts there are. */
export interface PageTextPart { text: string; note: string; last: boolean; count: number; number: number; start: number; end: number }

/**
 * Part `number` (1-based) of the text split into PAGE_TEXT_PART parts at line boundaries. Stateless: the same
 * number always gives the same part of the same text. The note always states the position and the size
 * ("part 2 of 4, chars 3001-6000 of 11234"), and either how to read the next part or that this is the end.
 * A number past the last part is clamped by the caller's check (see partCount); here it is clamped to the end.
 */
export function pageTextPart(text: string, number: number, nextTool = 'read_page'): PageTextPart {
  const parts = splitIntoParts(text, PAGE_TEXT_PART);
  const i = Math.min(Math.max(0, Math.floor(number) - 1), parts.length - 1);
  const { start, end } = parts[i];
  const last = i === parts.length - 1;
  const next = last ? 'end of the text' : `next: ${nextTool} with part ${i + 2}`;
  const chars = text.length === 0 ? '0 chars' : `chars ${start + 1}-${end} of ${text.length}`;
  return { text: text.slice(start, end), note: `part ${i + 1} of ${parts.length}, ${chars}, ${next}`, last, count: parts.length, number: i + 1, start, end };
}

/** How many parts a paged read of this text has. */
export function partCount(text: string): number {
  return splitIntoParts(text, PAGE_TEXT_PART).length;
}
