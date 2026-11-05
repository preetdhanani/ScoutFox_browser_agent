/**
 * The context meter of the composer: a small ring that fills with how much of the model's context
 * window the current chat uses, and the card it opens (the bar, the numbers and Compact).
 *
 * Pure: the functions take the runner's context state (AgentRunner.contextState, sent with every
 * STATE_UPDATE) and return markup, so the tests read exactly what the panel draws. sidepanel.js
 * puts the markup in place and wires the clicks.
 */
import { formatTokens } from '../src/shared/tokens.ts';

/** Where the window comes from, in the card's words. */
export const WINDOW_SOURCE_TEXT = {
  user: 'set by you',
  provider: 'from the provider',
  estimate: 'estimate',
  default: 'default'
};

/** The line of the card that says what the meter counts. */
export const CHAIN_NOTE = 'Earlier answers of this chat are sent with each new request.';

/** From this share of the window on the ring is amber, and from HIGH_AT red. */
export const WARN_AT = 70;
export const HIGH_AT = 90;

/** The radius and the length of the ring's arc (a 16 px ring drawn in a 16-unit box). */
const RING_R = 6;
const RING_LENGTH = 2 * Math.PI * RING_R;

/** The share of the window that is used, 0 to 100. */
export function percentOf(used, window) {
  const u = Number(used) || 0;
  const w = Number(window) || 0;
  if (u <= 0 || w <= 0) return 0;
  return Math.min(100, (u / w) * 100);
}

/** The share as the panel writes it: "0%", "<1%", "12%". */
export function percentText(pct) {
  if (!(pct > 0)) return '0%';
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

/** The colour step of a share: ok, warn (amber, from 70%) or high (red, from 90%). */
export function levelOf(pct) {
  if (pct >= HIGH_AT) return 'high';
  if (pct >= WARN_AT) return 'warn';
  return 'ok';
}

/**
 * What the ring and the card show, from the runner's context state.
 *
 * @param {object|null} context  getState().context, or null (an older worker, a saved session)
 * @param {{busy?: boolean, readOnly?: boolean, model?: string, pending?: boolean}} options
 *   busy: a task is running or paused; readOnly: a saved session from Recent tasks is shown;
 *   pending: this panel sent COMPACT_CHAT and waits for the answer
 */
export function meterView(context, { busy = false, readOnly = false, model = '', pending = false } = {}) {
  const c = context || {};
  const windowTokens = Number(c.window) > 0 ? Number(c.window) : 262144;
  const used = readOnly ? 0 : Math.max(0, Number(c.used) || 0);
  const pct = percentOf(used, windowTokens);
  const level = levelOf(pct);
  const windowText = formatTokens(windowTokens);
  const sourceText = WINDOW_SOURCE_TEXT[c.windowSource] || WINDOW_SOURCE_TEXT.default;
  const compacting = !readOnly && (!!c.compacting || pending);
  const hasEarlierTurn = !!c.hasEarlierTurn;
  let compactOff = '';
  if (readOnly) compactOff = 'A saved chat cannot be compacted. Start a new chat or open the live one.';
  else if (compacting) compactOff = 'The chat is being compacted.';
  else if (busy) compactOff = 'Stop the task before you compact the chat.';
  else if (!hasEarlierTurn) compactOff = 'There is no earlier turn to compact.';
  return {
    pct,
    pctText: percentText(pct),
    level,
    used,
    usedText: formatTokens(used),
    windowText,
    sourceText,
    model: String(model || ''),
    estimated: !readOnly && !!c.estimated && used > 0,
    summarizedTurns: Number(c.summarizedTurns) || 0,
    compacting,
    canCompact: !compactOff,
    compactTitle: compactOff || 'Summarize this chat, so later requests start from the summary',
    ringDisabled: readOnly,
    label: readOnly
      ? 'Context: not counted for a saved chat'
      : `Context: ${percentText(pct)} of ${windowText} used`
  };
}

/** The ring: a track and an arc that fills clockwise from the top, coloured by its level. */
export function ringSvg(view) {
  const filled = view.pct > 0 ? Math.max(view.pct, 4) : 0;
  const arc = (RING_LENGTH * filled) / 100;
  return `<svg class="ctx-ring ctx-${view.level}" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">`
    + `<circle class="ctx-ring-track" cx="8" cy="8" r="${RING_R}" fill="none" stroke-width="2.25"/>`
    + `<circle class="ctx-ring-arc" cx="8" cy="8" r="${RING_R}" fill="none" stroke-width="2.25" stroke-linecap="round"`
    + ` stroke-dasharray="${arc.toFixed(2)} ${RING_LENGTH.toFixed(2)}" transform="rotate(-90 8 8)"${filled ? '' : ' hidden'}/>`
    + '</svg>';
}

/** Text for HTML. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** The card the ring opens: the model and its window, the bar of this chat, the note, Compact, and the way to Settings. */
export function contextCardHtml(view) {
  const width = view.pct > 0 ? Math.max(view.pct, 1.5) : 0;
  const summarized = view.summarizedTurns > 0
    ? ` ${view.summarizedTurns} earlier turn${view.summarizedTurns === 1 ? ' is' : 's are'} sent as a summary.`
    : '';
  return `<div class="ctx-head">
      <span class="ctx-title">Context${view.model ? ` · <span class="ctx-model">${esc(view.model)}</span>` : ''}</span>
      <span class="ctx-window">${esc(view.windowText)}, ${esc(view.sourceText)}</span>
    </div>
    <div class="ctx-usage">
      <div class="ctx-usage-row">
        <span class="ctx-usage-label">This chat</span>
        <span class="ctx-usage-value">${esc(view.usedText)} of ${esc(view.windowText)} · ${esc(view.pctText)}</span>
      </div>
      <div class="ctx-bar" role="progressbar" aria-label="Context used by this chat" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(view.pct)}">
        <span class="ctx-bar-fill ctx-${view.level}" style="width:${width.toFixed(1)}%"></span>
      </div>
      ${view.estimated ? '<div class="ctx-estimated">Estimated</div>' : ''}
    </div>
    <p class="ctx-note">${esc(CHAIN_NOTE)}${esc(summarized)}</p>
    <div class="ctx-actions">
      <button type="button" class="ctx-compact" data-ctx="compact"${view.canCompact ? '' : ' disabled'} title="${esc(view.compactTitle)}">${view.compacting ? 'Compacting…' : 'Compact chat'}</button>
      <button type="button" class="ctx-link" data-ctx="settings">Set the window in Settings</button>
    </div>`;
}

/**
 * The line under the Settings field: the window a run would use and where it comes from, and what
 * the field takes. `window` is GET_CONTEXT_WINDOW's answer ({ tokens, source }), or null.
 */
export function contextWindowHint(window, provider) {
  const now = window && Number(window.tokens) > 0
    ? `Now ${formatTokens(window.tokens)} (${WINDOW_SOURCE_TEXT[window.source] || WINDOW_SOURCE_TEXT.default}). `
    : '';
  const fallback = provider === 'ollama'
    ? 'Empty uses what Ollama reports for the model. For Ollama this number is also num_ctx, the window Ollama is started with.'
    : "Empty uses the provider's number, else 256K.";
  return `${now}Takes 200000, 200K or 1M. ${fallback}`;
}
