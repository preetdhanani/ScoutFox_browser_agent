/**
 * ScoutFox Page Text Extraction and Repeat Run Collapsing
 * Pure text processing functions and scroll-aware body text extraction.
 */

export const PAGE_TEXT_CAP = 4500;
export const PAGE_TEXT_SCAN_LIMIT = 1000000;
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
 * Cuts the text at the cap. A text that is cut ends with a marker line.
 */
export function capPageText(text: string, cap = PAGE_TEXT_CAP, cutEarlier = false): string {
  if (text.length > cap) {
    return `${text.slice(0, cap)}\n[page text truncated at ${cap} characters]`;
  }
  return cutEarlier ? `${text}\n[page text truncated]` : text;
}

/**
 * Collapses the repeated text of a rendered page, then applies the cap.
 */
export function finishPageText(text: string): string {
  const scanned = text.length > PAGE_TEXT_SCAN_LIMIT ? text.slice(0, PAGE_TEXT_SCAN_LIMIT) : text;
  return capPageText(collapseRepeatedRuns(scanned), PAGE_TEXT_CAP, scanned.length < text.length);
}

/**
 * Dedicated scroll-aware body text extraction from document.
 */
export function extractPageTextFromDocument(
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: Window = typeof window !== 'undefined' ? window : (null as unknown as Window)
): string {
  if (!doc) return '';
  const badgeContainer = doc.getElementById ? doc.getElementById('scoutfox-badge-container') : null;
  let prevDisplay = '';
  if (badgeContainer && badgeContainer.style) {
    prevDisplay = badgeContainer.style.display;
    badgeContainer.style.display = 'none';
  }
  try {
    const hostname = (win && win.location && win.location.hostname) || '';
    const rawContentType = Boolean(
      doc.contentType &&
      doc.contentType.startsWith('text/') &&
      doc.contentType !== 'text/html' &&
      doc.contentType !== 'text/xml'
    );
    if (hostname.includes('raw.githubusercontent.com') || rawContentType) {
      const rawText = doc.body ? ((doc.body as HTMLElement).innerText || doc.body.textContent || '') : '';
      return capPageText(rawText.trim());
    }

    const targetedContainer = doc.querySelector('article, main, #readme, .markdown-body, [role="main"]');
    const container = targetedContainer || doc.body;
    if (!container) return '';

    const allTextNodes = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, code, blockquote'));
    let textNodes = allTextNodes;

    const scrollY = win ? win.scrollY : 0;
    const vHeight = (win && win.innerHeight) ? win.innerHeight : 800;

    if (scrollY > 200 && allTextNodes.length > 30) {
      textNodes = allTextNodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom >= -200 && rect.top <= vHeight + 1500;
      });
      if (textNodes.length < 10) {
        textNodes = allTextNodes
          .map((node) => ({ node, dist: Math.abs(node.getBoundingClientRect().top) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 50)
          .map((entry) => entry.node);
      }
    } else {
      textNodes = allTextNodes.slice(0, 90);
    }

    let extractedText = '';
    if (textNodes.length > 0) {
      extractedText = textNodes
        .map((node) => {
          const str = (node.textContent || '').trim().replace(/\s+/g, ' ');
          if (/^h[1-6]$/i.test(node.tagName)) {
            return `\n### ${str}\n`;
          }
          return str;
        })
        .filter((t) => t.length > 3)
        .join('\n');
    }

    if (!extractedText || extractedText.length < 100) {
      extractedText = ((container as HTMLElement).innerText || container.textContent || '').trim();
    }

    return finishPageText(extractedText);
  } catch {
    return capPageText(doc.body ? ((doc.body as HTMLElement).innerText || doc.body.textContent || '') : '', 3000);
  } finally {
    if (badgeContainer && badgeContainer.style) {
      badgeContainer.style.display = prevDisplay;
    }
  }
}
