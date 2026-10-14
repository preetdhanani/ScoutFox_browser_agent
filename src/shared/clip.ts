/**
 * ScoutFox text clipping with a visible note.
 * Every cap on a model-facing text goes through clipWithNote, so a cut text always says that it was cut, how much
 * of it is shown, how long the whole is, and how to see more. A text cut with no sign of it reads as the whole
 * text, and the model then concludes a value is absent when it is only past the cut.
 */

export interface ClipOptions {
  /** What the text is, for the note ("page text", "element text"). */
  what?: string;
  /** How to see more, appended to the note. Must not contain "]" or a line break. */
  hint?: string;
  /** The size of the whole text, when the text given is already a part of a longer one (a window, a scan cut). */
  total?: number;
  /** One-line form for short fields such as a step record: no line break, a short note. */
  inline?: boolean;
}

/** How the model reads more of a page text that was cut, in the content script's snapshot and in the prompt alike. */
export const PAGE_TEXT_MORE_HINT = 'call read_page_text to read the whole page in parts';

/** A trailing block note written by clipWithNote; group 1 is "what", 2 the shown size, 3 the full size. */
const BLOCK_NOTE = /\n\[([^\]\n]*?) truncated: showing (\d+) of (\d+) characters(?: - [^\]\n]*)?\]$/;

/** A cut is moved back to a line break, else a space, if one lies in the last half of the allowed length. */
const MIN_CUT_SHARE = 0.5;

/**
 * Where to cut a text to at most cap characters: just before the last line break that fits, else the last space,
 * else at the cap itself. A boundary in the first half of the cap is not used, so a cut never wastes most of it.
 * With from, the cut is of the text from that index on, and the index returned is in the whole text.
 */
export function cutPoint(text: string, cap: number, from = 0): number {
  if (text.length - from <= cap) return text.length;
  const limit = from + cap;
  const floor = from + Math.floor(cap * MIN_CUT_SHARE);
  const newline = text.lastIndexOf('\n', limit);
  if (newline >= floor) return newline;
  const space = text.lastIndexOf(' ', limit);
  if (space >= floor) return space;
  return limit;
}

/** The note a cut text ends with. */
export function truncationNote(shown: number, total: number, options: ClipOptions = {}): string {
  if (options.inline) return `[truncated, ${shown} of ${total} chars]`;
  const what = options.what || 'text';
  return `[${what} truncated: showing ${shown} of ${total} characters${options.hint ? ` - ${options.hint}` : ''}]`;
}

/**
 * The text cut to at most cap characters at a line boundary, followed by a note with the shown and the full size
 * and the hint. A text that fits is returned unchanged, unless options.total says it is already a part of a longer
 * text. A text that already ends with a note of this helper keeps the full size from that note, and gets one note.
 */
export function clipWithNote(text: string, cap: number, options: ClipOptions = {}): string {
  let body = text;
  let total = options.total ?? text.length;
  const previous = options.inline ? null : text.match(BLOCK_NOTE);
  if (previous) {
    body = text.slice(0, previous.index);
    total = Math.max(options.total ?? 0, Number(previous[3]));
  }
  if (body.length <= cap && total <= body.length) return text;
  const shown = cutPoint(body, cap);
  const kept = body.slice(0, shown).trimEnd();
  return `${kept}${options.inline ? ' ' : '\n'}${truncationNote(kept.length, Math.max(total, body.length), options)}`;
}

/** One part of a text split by splitIntoParts: the characters start (inclusive) to end (exclusive). */
export interface TextPart { start: number; end: number }

/**
 * The text split into parts of at most size characters, each cut at a line boundary (see cutPoint). The line break
 * or space a part was cut at belongs to no part. An empty text is one empty part.
 */
export function splitIntoParts(text: string, size: number): TextPart[] {
  const parts: TextPart[] = [];
  let start = 0;
  while (start < text.length) {
    const end = cutPoint(text, size, start);
    parts.push({ start, end });
    start = end < text.length && /\s/.test(text[end]) ? end + 1 : end;
  }
  return parts.length > 0 ? parts : [{ start: 0, end: 0 }];
}
