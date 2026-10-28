/**
 * Sidepanel Controller Script for ScoutFox AI Agent
 * Connects to Background Agent Engine, renders timeline, session history drawer, plan checklist, progress banner, settings, and backend logs.
 * Employs persistent per-provider API key storage, automatic model fetching, instant key auto-saving, and a smart searchable combobox component.
 */

// Must stay the first import: it sets zod's jitless flag before any module that bundles zod runs (see the file).
import '../src/background/boot/zodJitless.ts';
import { Storage, DEFAULT_SETTINGS, DEFAULT_PROVIDER_CONFIGS } from '../src/shared/storage.ts';
import { extractReadableAnswer } from '../src/shared/answerText.ts';
import { BUILD_STAMP, IS_BUILD } from '../src/shared/build.ts';
import {
  renderActionConfirmationCard,
  renderChallengeHelpCard,
  renderContinueBudgetCard,
  renderProvenanceFindingsTable
} from './cards.js';

import { FOX_MARK } from './brand.js';
import { logEntryHtml, logMatchesFilter, parseLogData, treeStateKey } from './logView.js';

import {
  initCustomProviderDialog,
  providerMeta,
  buildProviderOptions,
  isCustomProviderId,
  CUSTOM_TRIGGER_VALUE,
  CUSTOM_EMPTY_MODELS_TEXT
} from './customProvider.js';

let backgroundPort = null;
let currentSettings = { ...DEFAULT_SETTINGS };
let customProviderDialog = null;

// The TAB this panel is attached to. One session exists per tab (background.ts
// keeps a Map keyed by tabId), so every message this panel sends must say which tab it belongs
// to. The panel has to work this out for itself: a side-panel port reaches the background
// worker with no sender.tab at all, so the worker cannot tell which tab a panel came from.
//
// Chrome only shows a tab-scoped side panel for the ACTIVE tab, so the active tab of this
// panel's own window is, by construction, the tab this document is attached to.
let myTabId = null;

/**
 * Send a message to the background worker, always tagged with this panel's own tabId so it
 * can be routed to the correct per-tab session rather than whichever one happens to exist.
 */
function sendBgMessage(msg, cb) {
  chrome.runtime.sendMessage({ ...msg, tabId: myTabId }, cb);
}
let currentSessionId = null;
let currentActiveLogFilter = 'all';
let rawLogsCache = [];
let apiKeyFetchDebounce = null;
let allFetchedModels = [];
// The provider id the list above was fetched for. The composer's model menu uses it to notice
// that the provider changed since then and fetch the new provider's list before showing it.
let allFetchedModelsProvider = null;

// The authoritative selected model.
//
// This used to be read back out of the hidden <select id="modelSelect">, but that element
// only holds options from the last renderModelOptions() call. Assigning a value with no
// matching <option> silently leaves select.value === '', so switching to a provider whose
// default was not already in the list persisted model: '' and then fell back to whatever
// happened to be first in the hardcoded list. Keep the truth here instead of in the DOM.
let selectedModel = null;
// The Settings picker's "Enter custom model name..." row. It is a UI choice (open the text field),
// never a model id: it must not reach selectedModel, the screen or the storage.
const CUSTOM_MODEL_OPTION = '__custom__';
// True while that text field is open, so the row stays marked as the one chosen.
let customModelFieldOpen = false;
let currentEffort = 'auto';
// The level the user picked. currentEffort is what this model can take of it (the nearest level it
// supports), so switching to a model that supports more brings the pick back.
let preferredEffort = 'auto';
// The levels the chosen model supports (background/llm/effort.ts), and why. Until the background
// answers, every level is offered.
/** Whether the last rendered state was a running or paused run, to notice when one ends. */
let effortRunWasActive = false;
let effortSupport = { levels: ['auto', 'off', 'low', 'medium', 'high', 'max'], note: '' };
// 'auto' runs the task straight through; 'manual' stops at the plan and waits for the
// user's approval before the first action. Persisted as settings.autoApprove.
let approvalMode = 'auto';
// Guards the window between clicking send and the background confirming the task started.
let isSubmittingTask = false;
// Mirrors the engine status the panel last rendered, so the submit guard knows whether
// renderState() has taken ownership of the send button.
let isTaskActive = false;
// The provider and model the live run started with, for the run's model chip. Taken when this
// panel submits the task, or at the first live state a panel opened mid-run sees; cleared when
// the run ends. A model changed in Settings during the run applies to the next run, not this one.
let runModelSnapshot = null;
let portReconnectAttempts = 0;
let portReconnectTimer = null;
// False only for this panel instance's very first connect. Distinguishes opening the panel
// from reconnecting after Chrome reclaimed the service worker.
let hasConnectedBefore = false;
// Terminal state is broadcast more than once for the same run; this keeps the write to one
// per (run, history length) rather than one per broadcast.
const savedSessionIds = new Set();

// Out-of-order render guard. The live port and the GET_AGENT_STATE resync are two independent
// async channels with no ordering guarantee, so a slow resync reply can arrive after a newer
// live push and roll the UI backwards. stateVersion orders them — but it restarts near zero
// whenever Chrome rebuilds the service worker, so it is only comparable within one boot.
// bootId scopes the comparison; a new boot resets the watermark instead of silently discarding
// every update from the fresh worker forever (which would freeze the panel permanently).
let lastRenderedStateVersion = -1;
let lastBootId = null;

// Expand/collapse state for the batched action groups. renderState() rewrites the whole
// timeline on every state broadcast (~7x per step), so this must live OUTSIDE the DOM or a
// group would snap shut the instant the agent did anything.
const turnExpandOverride = new Map(); // turn number -> explicit user choice
const expandedRows = new Set();       // "turn:index" of rows whose reasoning is showing
// Same reason, for the answer audit <details> on a finish card: the key is the turn number as a
// string. Without this a details block the user opened would snap shut on the next broadcast.
const openAuditDetails = new Set();

/**
 * The pictures this panel has fetched, by id: the data URL, and the decoded <img> element itself.
 *
 * The timeline is rebuilt from scratch on every state broadcast, so an <img> inside the rebuilt
 * subtree would decode again on every one of them and the eye would catch a blank frame. Moving
 * an already-decoded element into the new subtree does not decode it again, so the element is
 * kept here and re-attached after each render.
 */
const shotCache = new Map(); // imageId -> { dataUrl: string, img: HTMLImageElement }

/** The ids whose bytes the background said it no longer has, so the panel stops asking. */
const shotGone = new Set();
// Turns whose notes the reader closed although they open by default (an unverified answer).
const closedAuditDetails = new Set();


/**
 * Inline icon set — thin-line SVGs matching the Studio Mono system.
 */
const ICONS = {
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  cross: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  dot: '<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>',
  circle: '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17.3" r="0.6" fill="currentColor" stroke="none"/></svg>',
  complete: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.3 2.3L16 10"/></svg>',
  clock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/></svg>',
  copy: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  search: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  star: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 16.3 6.8 19.3l1-5.9-4.3-4.2 5.9-.8z"/></svg>',
  doc: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="17" y2="13"/><line x1="7" y1="17" x2="13" y2="17"/></svg>',
  globe: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.6-3.8-9s1.3-6.5 3.8-9z"/></svg>',
  eye: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  pointer: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M5 3l6.5 17 2.4-6.6 6.6-2.4z"/></svg>',
  camera: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.2-1.8h5l1.2 1.8h1.8A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="12.5" r="3.2"/></svg>',
  keyboard: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" stroke-linecap="round"/></svg>',
  enter: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 5v6a3 3 0 0 1-3 3H5"/><polyline points="9 10 5 14 9 18"/></svg>',
  scrollIco: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 4 12 8 16 4"/><polyline points="8 20 12 16 16 20"/></svg>',
  back: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 5 4 11 10 17"/><path d="M4 11h10a6 6 0 0 1 6 6v2"/></svg>',
  layers: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 3 21 8 12 13 3 8"/><polyline points="3 13 12 18 21 13"/></svg>',
  ask: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.3 2.5c-.6.2-.9.7-.9 1.3v.4"/><circle cx="12" cy="16.6" r="0.6" fill="currentColor" stroke="none"/></svg>',
  chevron: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>',
  chevronRight: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 5 11 12 5 19"/></svg>',
  chevronDown: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="19 5 13 12 19 19"/></svg>',
  aim: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>',
  // A plan step the harness skipped because no page of its source was ever read. Same 12px box
  // as `check` so the two rows line up; a dash in a ring reads as "not done", never as "done".
  skip: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'
};

/** Entries the Logs tab keeps, the same bound as the worker's log store. */
const MAX_PANEL_LOGS = 500;

/** Which nodes of the log trees are open, by "<entry id>|<path>", so a re-render keeps them. */
const logTreeState = new Map();

const THEME_MODES = ['system', 'light', 'dark'];
const THEME_ICON = {
  system: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
  dark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>'
};
const THEME_LABEL = { system: 'Auto (matches system)', light: 'Light', dark: 'Dark' };

function applyApprovalMode(mode) {
  approvalMode = mode === 'manual' ? 'manual' : 'auto';
  const btn = document.getElementById('btnApprovalMode');
  const icon = document.getElementById('approvalModeIcon');
  if (icon) icon.innerHTML = APPROVAL_ICON[approvalMode];
  if (btn) {
    btn.title = APPROVAL_TITLE[approvalMode];
    btn.setAttribute('aria-label', APPROVAL_TITLE[approvalMode]);
  }
  document.querySelectorAll('#approvalMenu .menu-item').forEach((item) => {
    const checked = item.getAttribute('data-approval') === approvalMode;
    const check = item.querySelector('.menu-check');
    if (check) check.innerHTML = checked ? MENU_CHECK : '';
    item.setAttribute('aria-checked', String(checked));
  });
}

const EFFORT_LABEL = { auto: 'Auto', off: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
const EFFORT_ORDER = ['off', 'low', 'medium', 'high', 'max'];

/** A stored or picked value as a level: the old 'xhigh' is 'max', anything unknown is 'auto'. */
function normalizeEffort(effort) {
  if (effort === 'xhigh') return 'max';
  return EFFORT_LABEL[effort] ? effort : 'auto';
}

/** The supported level nearest to the pick: Off on a model that cannot stop thinking is Low, Max where High is the top is High. */
function nearestSupportedEffort(effort, levels) {
  if (levels.includes(effort)) return effort;
  // A level that thinks never becomes Off: only Off itself, or a model with nothing else, may.
  const thinking = levels.filter((level) => level !== 'auto' && (effort === 'off' || level !== 'off'));
  if (effort === 'auto' || thinking.length === 0) return 'auto';
  const want = EFFORT_ORDER.indexOf(effort);
  return thinking.reduce((best, level) => (Math.abs(EFFORT_ORDER.indexOf(level) - want) < Math.abs(EFFORT_ORDER.indexOf(best) - want) ? level : best), thinking[0]);
}

function setEffort(effort) {
  preferredEffort = normalizeEffort(effort);
  renderEffort();
}

/** The composer's effort button and menu, for the pick and the model's support. */
function renderEffort() {
  const levels = effortSupport.levels && effortSupport.levels.length ? effortSupport.levels : ['auto'];
  currentEffort = nearestSupportedEffort(preferredEffort, levels);
  const onlyAuto = levels.length === 1;
  const btn = document.getElementById('btnEffort');
  if (btn) {
    btn.textContent = EFFORT_LABEL[currentEffort];
    btn.title = onlyAuto
      ? `Effort: ${effortSupport.note || 'this model has no reasoning setting.'}`
      : `Effort: how hard the model thinks before each step (${EFFORT_LABEL[currentEffort]})`;
  }
  document.querySelectorAll('#effortMenu .menu-item').forEach((item) => {
    const level = item.getAttribute('data-effort');
    item.hidden = !levels.includes(level);
    const checked = level === currentEffort;
    const check = item.querySelector('.menu-check');
    if (check) check.innerHTML = checked ? MENU_CHECK : '';
    item.setAttribute('aria-checked', String(checked));
  });
  const note = document.getElementById('effortMenuNote');
  if (note) note.textContent = effortSupport.note || '';
}

/**
 * Asks the background which effort levels the chosen provider and model take. Called whenever the
 * model changes. A late answer for a model that is no longer chosen is dropped.
 */
let effortSupportAsk = 0;
function refreshEffortSupport() {
  const provider = document.getElementById('providerSelect')?.value || currentSettings.provider;
  const model = selectedModel || currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || '';
  const ask = ++effortSupportAsk;
  sendBgMessage({
    action: 'GET_EFFORT_SUPPORT',
    payload: {
      provider,
      model,
      baseUrl: currentSettings.providerConfigs?.[provider]?.baseUrl || (provider === currentSettings.provider ? currentSettings.baseUrl : ''),
      providerConfigs: currentSettings.providerConfigs,
      customProviders: currentSettings.customProviders
    }
  }, (res) => {
    if (ask !== effortSupportAsk || !res || !res.success || !res.support) return;
    effortSupport = res.support;
    renderEffort();
  });
}

/** The model shown in the composer, in step with the badge in the header. Clicking it opens the
    provider's model menu, so the tooltip says both. */
function refreshComposerModel() {
  const el = document.getElementById('composerModel');
  if (!el) return;
  const label = selectedModel || currentSettings.model || 'model';
  el.textContent = label;
  el.title = `Model: ${label}. The models of the chosen provider are one click away.`;
}

/** The approval icon in the composer, the same two glyphs as the menu items. */
const APPROVAL_ICON = {
  auto: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="4 4 12 12 4 20"/><polygon points="11 4 19 12 11 20"/></svg>',
  manual: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a1.5 1.5 0 0 0-3 0v4"/><path d="M15 10V4.5a1.5 1.5 0 0 0-3 0V10"/><path d="M12 10V6a1.5 1.5 0 0 0-3 0v8"/><path d="M9 14l-1.6-2.7a1.5 1.5 0 0 0-2.6 1.5L7.7 18A6 6 0 0 0 13 21h1a6 6 0 0 0 6-6v-3a1.5 1.5 0 0 0-2 0"/></svg>'
};
const APPROVAL_TITLE = {
  auto: 'Automatically approve - the agent runs without asking',
  manual: 'Manually approve - the agent shows its plan first'
};
const MENU_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4.5 12.5 9.5 17.5 19.5 7"/></svg>';

/**
 * Simple toast notification system
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 3000);
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') {
    root.setAttribute('data-theme', mode);
  } else {
    root.removeAttribute('data-theme');
  }
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    btn.innerHTML = THEME_ICON[mode] || THEME_ICON.system;
    btn.title = `Theme: ${THEME_LABEL[mode] || THEME_LABEL.system}`;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Resolve which TAB this panel belongs to BEFORE connecting - the port name and every
  // message sent from here need it to reach the right per-tab session.
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t || [])));
      myTabId = tabs && tabs[0] ? tabs[0].id : null;
    }
  } catch (err) {
    reportClientError('sidepanel:resolve-tab', err);
  }

  // Logs are restored via initPortConnection() -> resyncAgentState() -> GET_AGENT_STATE below,
  // not read directly from storage here. That used to be a second, racing path: the background
  // worker's own restore of persisted logs is async, so a resync landing before it finished got
  // back an empty array and this direct read's result was overwritten with it. The background
  // now awaits its own restore before answering GET_AGENT_STATE (see logger.ts/background.ts),
  // so it is the single, complete, authoritative source and this duplicate is no longer needed.
  await loadSettings();
  initTabs();
  initTimelineInteraction();
  initLogInteractions();
  initPortConnection();
  initEventListeners();
  initCombobox();
  customProviderDialog = initCustomProviderDialog({
    getSettings: () => currentSettings,
    applySettings: (s) => { currentSettings = s; },
    sendBgMessage,
    showToast,
    // Puts a provider id into effect without a synthetic change event (which does not fire on
    // programmatic assignment): rebuilds the options, then loads the provider into the form.
    providerSelected: async (id) => {
      document.getElementById('providerSelect').value = id;
      await applyProviderSelection(id);
    }
  });
  await loadSessionHistory();
  followSavedSessionChanges();
  await fetchDynamicModels(false);
});

/**
 * Keep the History button and list current when ANOTHER panel saves a session.
 *
 * Only the panel that submitted a task saves it, and that is often not the one on screen: when
 * a run moves to a new tab, the submitting panel stays behind, hidden on the old tab, and the
 * panel the user is looking at is a second document that loaded before the save. Reading the
 * list once at startup left it showing "(0)" next to the run it had just finished.
 */
function followSavedSessionChanges() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.saved_sessions) return;
    loadSessionHistory().catch((err) => reportClientError('sidepanel:session-history-sync', err));
  });
}

// Ensure tabs are initialized even if DOMContentLoaded already fired (common in some preview/extension environments)
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initTabs();
}

/**
 * The timeout a provider holds for itself, or 0 when it has none. Mirrors the first two steps of
 * timeoutMsOf (src/background/llm/settings.ts): providerConfigs[id].llmTimeoutMs, then a custom
 * provider's descriptor. When this is set, the engine never reads the global llmTimeoutMs.
 */
function providerOwnTimeoutOf(settings, provider) {
  const configMs = Number(settings?.providerConfigs?.[provider]?.llmTimeoutMs);
  if (configMs > 0) return configMs;
  const customMs = Number(settings?.customProviders?.[provider]?.llmTimeoutMs);
  if (customMs > 0) return customMs;
  return 0;
}

/** The value the LLM Timeout field shows for a provider: the one the engine will use. */
function timeoutShownFor(settings, provider) {
  const own = providerOwnTimeoutOf(settings, provider);
  if (own > 0) return own;
  // A custom provider has no curated default, so its fallback is the global one.
  const isCustom = isCustomProviderId(provider, settings);
  const defaultTimeout = isCustom ? DEFAULT_SETTINGS.llmTimeoutMs : (DEFAULT_PROVIDER_CONFIGS[provider]?.llmTimeoutMs || DEFAULT_SETTINGS.llmTimeoutMs);
  return provider === 'nvidia' ? defaultTimeout : (settings.llmTimeoutMs || defaultTimeout);
}

/**
 * Load settings into form controls with per-provider memory restoration
 */
async function loadSettings() {
  currentSettings = await Storage.getSettings();
  applyTheme(currentSettings.theme || 'system');

  const activeProvider = currentSettings.provider || 'openrouter';
  const activeIsCustom = isCustomProviderId(activeProvider, currentSettings);
  const providerCfg = (currentSettings.providerConfigs && currentSettings.providerConfigs[activeProvider]) || (activeIsCustom ? {} : (DEFAULT_PROVIDER_CONFIGS[activeProvider] || {}));

  // The options for user-added providers must exist BEFORE the value is assigned: assigning a
  // <select> a value with no matching <option> silently leaves select.value === ''.
  buildProviderOptions(document.getElementById('providerSelect'), currentSettings.customProviders);

  document.getElementById('providerSelect').value = activeProvider;
  document.getElementById('baseUrlInput').placeholder = activeIsCustom
    ? (providerCfg.baseUrl || '')
    : (DEFAULT_PROVIDER_CONFIGS[activeProvider]?.baseUrl || 'https://openrouter.ai/api/v1');
  document.getElementById('baseUrlInput').value = providerCfg.baseUrl || currentSettings.baseUrl || (DEFAULT_PROVIDER_CONFIGS[activeProvider]?.baseUrl || '');
  document.getElementById('apiKeyInput').value = providerCfg.apiKey || currentSettings.apiKey || '';
  document.getElementById('maxStepsInput').value = currentSettings.maxSteps || DEFAULT_SETTINGS.maxSteps;
  document.getElementById('delayInput').value = currentSettings.actionDelayMs || DEFAULT_SETTINGS.actionDelayMs;
  document.getElementById('ollamaNumPredictInput').value = currentSettings.ollamaNumPredict || DEFAULT_SETTINGS.ollamaNumPredict;
  document.getElementById('llmTimeoutInput').value = timeoutShownFor(currentSettings, activeProvider);
  const effortSelect = document.getElementById('effortDefaultSelect');
  if (effortSelect) {
    effortSelect.value = normalizeEffort(currentSettings.effortDefault || 'medium');
  }
  const effortAdaptiveSelect = document.getElementById('effortAdaptiveSelect');
  if (effortAdaptiveSelect) effortAdaptiveSelect.value = currentSettings.effortAdaptive === false ? 'off' : 'on';
  setEffort(currentSettings.effortDefault || 'medium');
  applyApprovalMode(currentSettings.autoApprove === false ? 'manual' : 'auto');

  // Visibility: Hide Ollama settings if not using Ollama
  const ollamaGroup = document.getElementById('ollamaNumPredictGroup');
  if (ollamaGroup) {
    ollamaGroup.style.display = activeProvider === 'ollama' ? 'flex' : 'none';
  }

  loadResearchSettings(currentSettings.research);

  syncCustomProviderActions(activeProvider);
  updateSelectedModel(providerCfg.model || currentSettings.model);
}

/** The Research section from the stored settings (getSettings already filled the defaults). */
function loadResearchSettings(research) {
  const r = research || DEFAULT_SETTINGS.research;
  const enabled = document.getElementById('researchEnabledSelect');
  if (!enabled) return;
  enabled.value = r.enabled === false ? 'off' : 'on';
  document.getElementById('researchBackendSelect').value = r.backend === 'searxng' ? 'searxng' : 'duckduckgo';
  document.getElementById('searxngUrlInput').value = r.searxngUrl || '';
  syncResearchFields();
}

/** The research fields the current choice uses: no backend when research is off, no URL unless SearXNG. */
function syncResearchFields() {
  const on = document.getElementById('researchEnabledSelect')?.value !== 'off';
  const searxng = document.getElementById('researchBackendSelect')?.value === 'searxng';
  const backend = document.getElementById('researchBackendGroup');
  const urlGroup = document.getElementById('searxngUrlGroup');
  if (backend) backend.style.display = on ? 'flex' : 'none';
  if (urlGroup) urlGroup.style.display = on && searxng ? 'flex' : 'none';
  const hint = document.getElementById('searxngUrlHint');
  const url = (document.getElementById('searxngUrlInput')?.value || '').trim();
  const bad = on && searxng && !/^https?:\/\/[^\s/]+/i.test(url);
  if (hint) {
    hint.classList.toggle('is-error', bad);
    hint.textContent = bad
      ? (url ? 'Enter a full address that starts with https:// or http://.' : 'Enter the address of your SearXNG server. Until then web search has no results.')
      : 'The server must allow the JSON format (search: formats: [html, json]).';
  }
}

/** The Research section as the settings object stores it. */
function researchFromForm() {
  return {
    enabled: document.getElementById('researchEnabledSelect')?.value !== 'off',
    backend: document.getElementById('researchBackendSelect')?.value === 'searxng' ? 'searxng' : 'duckduckgo',
    searxngUrl: (document.getElementById('searxngUrlInput')?.value || '').trim()
  };
}

/** Edit and Delete apply to a user-added provider only; the row stays hidden for the built-ins. */
function syncCustomProviderActions(providerId) {
  const actions = document.getElementById('customProviderActions');
  if (actions) actions.style.display = isCustomProviderId(providerId, currentSettings) ? 'flex' : 'none';
}

/**
 * Update active model label and backing select element. Takes a real model id only; the custom
 * row of the Settings picker goes through pickComboboxModel, which opens the text field instead.
 */
function updateSelectedModel(modelName) {
  if (modelName === CUSTOM_MODEL_OPTION) {
    setCustomModelFieldOpen(true);
    return;
  }
  const labelEl = document.getElementById('modelSelectedLabel');
  const selectEl = document.getElementById('modelSelect');

  selectedModel = modelName || null;

  if (labelEl) labelEl.textContent = modelName || 'Select a model...';
  if (selectEl) {
    // Keep the backing <select> in step for anything that still reads it, adding the option
    // when it is absent so the assignment cannot silently no-op.
    if (modelName && !Array.from(selectEl.options).some(o => o.value === modelName)) {
      const opt = document.createElement('option');
      opt.value = modelName;
      opt.textContent = modelName;
      selectEl.appendChild(opt);
    }
    selectEl.value = modelName || '';
  }
  updateModelBadge(modelName);
  refreshComposerModel();
}

/** Shows or hides the Settings field for a model id typed by hand. */
function setCustomModelFieldOpen(open) {
  const wasOpen = customModelFieldOpen;
  customModelFieldOpen = open;
  const customInput = document.getElementById('modelCustomInput');
  if (!customInput) return;
  customInput.style.display = open ? 'block' : 'none';
  if (open) {
    // A fresh field each time it opens; picking the row again while typing keeps the text.
    if (!wasOpen) customInput.value = '';
    customInput.focus();
  }
}

/**
 * A click on a row of the Settings model picker. The custom row only opens the text field: there
 * is nothing to save until an id is typed there (see commitTypedModel). A listed model is put into
 * effect and saved at once.
 */
async function pickComboboxModel(value) {
  closeComboboxMenu();
  if (value === CUSTOM_MODEL_OPTION) {
    setCustomModelFieldOpen(true);
    return;
  }
  setCustomModelFieldOpen(false);
  updateSelectedModel(value);
  await autoSaveCurrentForm();
}

/** Saves the id typed in the Settings custom field, once there is one. */
async function commitTypedModel() {
  const value = (document.getElementById('modelCustomInput')?.value || '').trim();
  if (!value) return;
  updateSelectedModel(value);
  await autoSaveCurrentForm();
}

/**
 * Render model options into custom searchable combobox menu
 */
function renderModelOptions(modelsList) {
  const selectEl = document.getElementById('modelSelect');
  const optionsContainer = document.getElementById('modelComboboxOptions');
  if (!optionsContainer) return;

  const activeProvider = document.getElementById('providerSelect')?.value || currentSettings.provider;
  const savedModel = currentSettings.providerConfigs?.[activeProvider]?.model || currentSettings.model;
  const currentSelected = (selectEl && selectEl.value) ? selectEl.value : savedModel;

  const combinedList = [...modelsList];
  if (savedModel && savedModel !== CUSTOM_MODEL_OPTION && !combinedList.includes(savedModel)) {
    combinedList.unshift(savedModel);
  }
  // An id typed by hand and not saved yet is still the selected one, so it stays in the list.
  if (currentSelected && currentSelected !== CUSTOM_MODEL_OPTION && !combinedList.includes(currentSelected)) {
    combinedList.unshift(currentSelected);
  }

  if (selectEl) {
    selectEl.innerHTML = '';
    combinedList.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      selectEl.appendChild(opt);
    });
    const customOpt = document.createElement('option');
    customOpt.value = CUSTOM_MODEL_OPTION;
    customOpt.textContent = 'Custom model name…';
    selectEl.appendChild(customOpt);
  }

  if (combinedList.length === 0) {
    // A custom provider with an empty saved list is a real state, not a failed fetch: the picker
    // says so and keeps accepting ids typed by hand.
    const emptySource = Array.isArray(modelsList) && modelsList.length === 0 && providerMeta(activeProvider, currentSettings).isCustom;
    optionsContainer.innerHTML = `<div class="subtext-hint" style="padding: 10px; text-align: center;">${emptySource ? CUSTOM_EMPTY_MODELS_TEXT : 'No matching models found.'}</div>`;
    return;
  }

  const activeModel = currentSelected || savedModel || combinedList[0];

  let html = combinedList.map(modelName => {
    const isSelected = modelName === activeModel;
    return `<div class="combobox-option-item ${isSelected ? 'selected' : ''}" data-value="${escapeHtml(modelName)}">${escapeHtml(modelName)}</div>`;
  }).join('');

  html += `<div class="combobox-option-item custom-option ${customModelFieldOpen ? 'selected' : ''}" data-value="${CUSTOM_MODEL_OPTION}">✏️ Enter custom model name...</div>`;

  optionsContainer.innerHTML = html;

  optionsContainer.querySelectorAll('.combobox-option-item').forEach(item => {
    item.addEventListener('click', () => pickComboboxModel(item.getAttribute('data-value')));
  });

  updateSelectedModel(activeModel);
}

function initCombobox() {
  const trigger = document.getElementById('modelComboboxTrigger');
  const menu = document.getElementById('modelComboboxMenu');
  const searchInput = document.getElementById('modelSearchInside');

  if (trigger && menu) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = menu.style.display === 'flex';
      if (isVisible) {
        closeComboboxMenu();
      } else {
        openComboboxMenu();
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      if (!query) {
        renderModelOptions(allFetchedModels);
      } else {
        const filtered = allFetchedModels.filter(m => m.toLowerCase().includes(query));
        renderModelOptions(filtered);
      }
    });
  }

  document.addEventListener('click', () => {
    closeComboboxMenu();
  });
}

function openComboboxMenu() {
  const menu = document.getElementById('modelComboboxMenu');
  const combobox = document.getElementById('modelCombobox');
  const searchInput = document.getElementById('modelSearchInside');

  if (menu && combobox) {
    const triggerRect = combobox.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerRect.bottom;

    if (spaceBelow < 260 && triggerRect.top > 260) {
      menu.style.top = 'auto';
      menu.style.bottom = '100%';
      menu.style.borderTop = '1px solid var(--accent)';
      menu.style.borderBottom = 'none';
      menu.style.borderTopLeftRadius = '9px';
      menu.style.borderTopRightRadius = '9px';
      menu.style.borderBottomLeftRadius = '0';
      menu.style.borderBottomRightRadius = '0';
      menu.style.boxShadow = '0 -10px 25px rgba(0, 0, 0, 0.25)';
    } else {
      menu.style.top = '100%';
      menu.style.bottom = 'auto';
      menu.style.borderTop = 'none';
      menu.style.borderBottom = '1px solid var(--accent)';
      menu.style.borderTopLeftRadius = '0';
      menu.style.borderTopRightRadius = '0';
      menu.style.borderBottomLeftRadius = '9px';
      menu.style.borderBottomRightRadius = '9px';
      menu.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.25)';
    }

    menu.style.display = 'flex';
    combobox.classList.add('open');
    if (!allFetchedModels || allFetchedModels.length === 0) {
      fetchDynamicModels(false);
    }
    if (searchInput) {
      searchInput.value = '';
      renderModelOptions(allFetchedModels);
      setTimeout(() => searchInput.focus(), 50);
    }
  }
}

function closeComboboxMenu() {
  const menu = document.getElementById('modelComboboxMenu');
  const combobox = document.getElementById('modelCombobox');
  if (menu && combobox) {
    menu.style.display = 'none';
    combobox.classList.remove('open');
  }
}

/**
 * Auto-save active form fields to Storage silently
 */
async function autoSaveCurrentForm() {
  const provider = document.getElementById('providerSelect').value;
  // selectedModel only ever holds a real id (the custom row is not one), checked once more here
  // because this is the one place a model reaches the storage and, from there, the provider.
  const finalModel = (selectedModel && selectedModel !== CUSTOM_MODEL_OPTION) ? selectedModel : '';

  const apiKey = document.getElementById('apiKeyInput').value.trim();
  const baseUrl = document.getElementById('baseUrlInput').value.trim();

  const previousModel = (currentSettings.providerConfigs && currentSettings.providerConfigs[provider]
    && currentSettings.providerConfigs[provider].model) || '';

  // The input's min="5000" is not enforced on read, and the field is in ms - a user typing "1"
  // or "1000" (thinking seconds) would otherwise make every LLM call abort almost immediately.
  const llmTimeoutMs = Math.max(5000, parseInt(document.getElementById('llmTimeoutInput').value, 10) || (DEFAULT_PROVIDER_CONFIGS[provider]?.llmTimeoutMs || DEFAULT_SETTINGS.llmTimeoutMs));

  const newSettings = {
    provider,
    baseUrl,
    apiKey,
    // Guard against writing an empty model over a good one. Even with selectedModel as the
    // source of truth, an empty value here would silently clear the provider's saved choice.
    model: finalModel || previousModel,
    maxSteps: parseInt(document.getElementById('maxStepsInput').value, 10) || DEFAULT_SETTINGS.maxSteps,
    actionDelayMs: parseInt(document.getElementById('delayInput').value, 10) || DEFAULT_SETTINGS.actionDelayMs,
    ollamaNumPredict: parseInt(document.getElementById('ollamaNumPredictInput').value, 10) || DEFAULT_SETTINGS.ollamaNumPredict,
    llmTimeoutMs,
    // Screenshots are always on: there is no user toggle for them.
    screenshots: true,
    effortDefault: document.getElementById('effortDefaultSelect')?.value || currentSettings.effortDefault || 'medium',
    effortAdaptive: (document.getElementById('effortAdaptiveSelect')?.value || 'on') !== 'off',
    research: researchFromForm()
  };

  // A provider with a timeout of its own (a custom provider's, set in its dialog) is read before
  // the global one, so the edit goes there; writing only the global value would change nothing
  // and the field would snap back. NVIDIA's own timeout is written by Storage.saveSettings itself.
  if (provider !== 'nvidia' && providerOwnTimeoutOf(currentSettings, provider) > 0) {
    delete newSettings.llmTimeoutMs;
    newSettings.providerConfigs = {
      [provider]: { ...(currentSettings.providerConfigs?.[provider] || {}), llmTimeoutMs }
    };
    // The dialog shows the descriptor's value; keep it the same number.
    const descriptor = currentSettings.customProviders?.[provider];
    if (descriptor) {
      newSettings.customProviders = { ...currentSettings.customProviders, [provider]: { ...descriptor, llmTimeoutMs } };
    }
  }

  currentSettings = await Storage.saveSettings(newSettings);
  // Show the value that was stored: one below the minimum was raised above, and the field must not
  // keep showing the raw number that was typed.
  document.getElementById('llmTimeoutInput').value = timeoutShownFor(currentSettings, provider);
  updateModelBadge(newSettings.model);
}

/**
 * Fetch dynamic models with storage caching & search filter support
 */
async function fetchDynamicModels(forceRefresh = false) {
  const statusEl = document.getElementById('modelFetchStatus');
  const btnFetch = document.getElementById('btnFetchModels');

  if (statusEl) {
    statusEl.textContent = forceRefresh ? 'Fetching fresh models from API...' : 'Loading cached models...';
  }
  if (btnFetch) btnFetch.disabled = true;

  const tempSettings = {
    provider: document.getElementById('providerSelect').value,
    baseUrl: document.getElementById('baseUrlInput').value.trim(),
    apiKey: document.getElementById('apiKeyInput').value.trim(),
    forceRefresh,
    // The background resolves a user-added provider from the snapshot it is handed (its descriptor
    // carries the protocol and the saved list); it reads no settings of its own for this message.
    providerConfigs: currentSettings.providerConfigs,
    customProviders: currentSettings.customProviders
  };
  const activeMeta = providerMeta(tempSettings.provider, currentSettings);

  return new Promise((resolve) => {
    sendBgMessage({ action: 'FETCH_MODELS', payload: tempSettings }, (res) => {
      if (btnFetch) btnFetch.disabled = false;

      if (res && res.success && Array.isArray(res.models)) {
        allFetchedModels = res.models;
        allFetchedModelsProvider = tempSettings.provider;
        renderModelOptions(allFetchedModels);

        if (statusEl) {
          if (res.models.length > 0) {
            statusEl.textContent = forceRefresh
              ? `Retrieved ${res.models.length} model(s) fresh from API!`
              : `Loaded ${res.models.length} model(s) from local cache (${allFetchedModels.length} total).`;
          } else if (activeMeta.isCustom) {
            statusEl.textContent = CUSTOM_EMPTY_MODELS_TEXT;
          } else {
            statusEl.textContent = 'No models available.';
          }
        }
        resolve(res.models);
      } else {
        if (statusEl) statusEl.textContent = `Could not fetch models (${res?.error || 'Unreachable'}). Using fallbacks.`;
        allFetchedModels = (res && res.models && res.models.length > 0)
          ? res.models
          : (activeMeta.isCustom
            ? activeMeta.savedModels
            : (DEFAULT_PROVIDER_CONFIGS[tempSettings.provider]?.model ? [DEFAULT_PROVIDER_CONFIGS[tempSettings.provider].model] : []));
        allFetchedModelsProvider = tempSettings.provider;
        renderModelOptions(allFetchedModels);
        resolve(allFetchedModels);
      }
    });
  });
}

function updateModelBadge(modelName) {
  // Every model change passes here, so the effort levels follow the model.
  refreshEffortSupport();
  const badge = document.getElementById('currentModelBadge');
  if (badge) {
    badge.textContent = modelName || 'Model';
    // The badge truncates to one line, so the full id has to stay reachable on hover.
    badge.title = modelName || '';
  }
}

function initTabs() {
  const navBtns = document.querySelectorAll('.nav-btn');
  const panels = document.querySelectorAll('.tab-panel');

  if (navBtns.length === 0 || panels.length === 0) {
    console.warn('[Sidepanel] initTabs: Navigation buttons or tab panels not found in DOM.');
    return;
  }

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      if (!targetTab) return;

      navBtns.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPanel = document.getElementById(`tab-${targetTab}`);
      if (targetPanel) {
        targetPanel.classList.add('active');
      } else {
        console.error(`[Sidepanel] Tab panel #${targetTab} not found.`);
      }
    });
  });
}

/**
 * Connection to the background service worker.
 *
 * Chrome terminates MV3 service workers aggressively, which kills this port. Without an
 * onDisconnect handler the panel keeps holding a dead port forever: the agent keeps running
 * and driving the browser, but every STATE_UPDATE and LOG_ENTRY it emits goes nowhere — the
 * timeline freezes and the log pane stays empty. That is exactly the "everything goes blank"
 * failure. So: detect the drop, tell the user, and reconnect with backoff.
 */
function initPortConnection() {
  connectPort();
}

/**
 * Resolves which tab this panel belongs to. Called once at startup and again on
 * every reconnect while the id is still unknown, so a panel that woke up before
 * the tab was queryable does not stay stuck on a bare port name (BUG-21).
 */
async function resolveMyTabId() {
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t || [])));
      const id = tabs && tabs[0] ? tabs[0].id : null;
      if (id !== null && id !== undefined) {
        myTabId = id;
        return id;
      }
    }
  } catch (err) {
    reportClientError('sidepanel:resolve-tab', err);
  }
  return null;
}

function connectPort() {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;

  // A panel whose tab id is still unknown re-resolves it before connecting, so
  // the reconnect uses the suffixed port name instead of the bare one the
  // background ignores (BUG-21).
  const doConnect = () => {
    try {
      // The '_fresh'/plain distinction is kept only for the background worker's own connect log
      // line - one session exists per tab now, and reopening the panel on a tab that already has
      // one (running or finished) always reflects it rather than clearing on a "genuine open".
      // Deliberately starting over is CLEAR_HISTORY's job, not a side effect of reconnecting.
      // What actually matters here is tabId, so this panel is routed to ITS OWN tab's session
      // rather than a shared one - riding in the port name itself is simple, synchronous, and
      // available the instant the port is created.
      const base = hasConnectedBefore ? 'scoutfox_sidepanel' : 'scoutfox_sidepanel_fresh';
      hasConnectedBefore = true;
      const portName = myTabId !== null ? `${base}:${myTabId}` : base;
      backgroundPort = chrome.runtime.connect({ name: portName });
    } catch (err) {
      reportClientError('sidepanel:port-connect', err);
      setConnectionBanner(true);
      scheduleReconnect();
      return;
    }

  backgroundPort.onMessage.addListener((msg) => {
    try {
      if (msg.type === 'STATE_UPDATE') {
        receiveState(msg.payload);
      } else if (msg.type === 'LOG_ENTRY') {
        addLogEntry(msg.payload);
      } else if (msg.type === 'PANEL_HANDOFF') {
        followRunToTab(msg.payload);
      }
    } catch (err) {
      reportClientError('sidepanel:port-message', err);
    }
  });

  backgroundPort.onDisconnect.addListener(() => {
    // chrome.runtime.lastError must be read here or Chrome logs an unchecked-error warning.
    const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'service worker terminated';
    backgroundPort = null;
    appendLocalLog('WARN', 'Sidepanel', `[PORT_LOST] Connection to the background worker dropped (${reason}). Reconnecting…`);
    setConnectionBanner(true);
    scheduleReconnect();
  });

  if (portReconnectTimer) {
    clearTimeout(portReconnectTimer);
    portReconnectTimer = null;
  }
  setConnectionBanner(false);
  resyncAgentState();
  };

  if (myTabId === null) {
    void resolveMyTabId().then(() => doConnect());
  } else {
    doConnect();
  }
}

/**
 * Reopen the panel on the tab a task just moved into.
 *
 * Chrome shows a tab-scoped panel only on the tab it was opened for, so the moment the
 * background worker brings a new tab to the front, this panel is hidden and none is showing on
 * the new tab. Only sidePanel.open() can show one there, and only with a user gesture - which
 * this document still has from the Enter/click that submitted the task, for about five seconds.
 * The worker has no gesture at all, which is why it asks here instead of opening it itself.
 *
 * A session can have several panels connected (the one hidden on the tab the run left, for a
 * start), but only the one that submitted the task holds the gesture, so only it acts.
 */
function followRunToTab(payload) {
  if (!payload || typeof payload.tabId !== 'number' || payload.fromTabId !== myTabId) return;
  if (!chrome.sidePanel || !chrome.sidePanel.open) return;
  chrome.sidePanel.open({ tabId: payload.tabId }).catch((err) => {
    appendLocalLog('WARN', 'Sidepanel', `[PANEL_HANDOFF_FAILED] The task moved to tab [${payload.tabId}], but the panel could not follow it there (${err.message}). Click the ScoutFox icon on that tab to see the run.`);
  });
}

function scheduleReconnect() {
  if (portReconnectTimer) return;
  portReconnectAttempts++;
  const delayMs = Math.min(5000, 300 * portReconnectAttempts);
  portReconnectTimer = setTimeout(() => {
    portReconnectTimer = null;
    connectPort();
  }, delayMs);
}

/**
 * Pull authoritative state after every (re)connect. This doubles as the wake-up call that
 * revives a sleeping service worker, and its response is the only confirmation that the
 * round trip actually works — which is why the backoff counter resets here rather than in
 * connectPort(). chrome.runtime.connect() succeeds optimistically even against a dead
 * context, so resetting on connect alone would pin the backoff at its 300ms floor forever.
 */
function resyncAgentState() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  sendBgMessage({ action: 'GET_AGENT_STATE' }, (res) => {
    if (chrome.runtime.lastError) {
      appendLocalLog('WARN', 'Sidepanel', `[RESYNC_FAILED] Background worker did not answer GET_AGENT_STATE (${chrome.runtime.lastError.message}). Will retry.`);
      setConnectionBanner(true);
      scheduleReconnect();
      return;
    }

    portReconnectAttempts = 0;
    setConnectionBanner(false);
    checkWorkerBuild();

    if (res) {
      receiveState(res);
      if (res.logs) {
        rawLogsCache = res.logs;
        renderFilteredLogs();
      }
    }
  });
}

/**
 * Send a control command and REPORT whether it landed.
 *
 * Pause / Stop / New Session were previously fire-and-forget with no callback and no
 * lastError check. If the service worker was asleep or mid-restart the command evaporated
 * silently — the button appeared to work while the agent carried on driving the page. For
 * Stop in particular that is a safety problem, not just a cosmetic one.
 */
function sendControlMessage(action, done) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  sendBgMessage({ action }, (res) => {
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message;
      appendLocalLog('ERROR', 'Sidepanel', `[CONTROL_FAILED] ${action} did not reach the background worker (${msg}).`);
      showTaskError(`"${action.replace(/_/g, ' ').toLowerCase()}" did not reach the agent: ${msg}`);
      scheduleReconnect();
      if (done) done(false);
      return;
    }
    if (res && res.success === false) {
      appendLocalLog('ERROR', 'Sidepanel', `[CONTROL_REJECTED] ${action} was rejected: ${res.error || 'no reason given'}`);
      showTaskError(res.error || `${action} was rejected by the agent.`);
      if (done) done(false);
      return;
    }
    appendLocalLog('INFO', 'Sidepanel', `[CONTROL_OK] ${action} acknowledged.`);
    if (done) done(true);
  });
}

/**
 * Chrome loads this page fresh from disk every time the panel opens, but keeps the old background
 * worker running until the extension is reloaded. After a rebuild the two are different builds,
 * and the panel asks for things the old worker does not know (effort levels, for one). Compare the
 * stamps after every resync and offer the reload. An older worker does not know GET_BUILD either.
 */
let staleWorkerLogged = false;
function checkWorkerBuild() {
  if (!IS_BUILD) return;
  sendBgMessage({ action: 'GET_BUILD' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    const workerBuild = res.success ? res.build : null;
    const stale = workerBuild !== BUILD_STAMP;
    const bar = document.getElementById('updateBanner');
    if (bar) {
      bar.hidden = !stale;
      bar.dataset.workerBuild = stale ? 'stale' : 'same'; // read by the e2e side panel gate
    }
    const reload = document.getElementById('btnReloadExtension');
    if (reload) reload.onclick = () => chrome.runtime.reload();
    if (stale && !staleWorkerLogged) {
      staleWorkerLogged = true;
      appendLocalLog('WARN', 'Sidepanel', `[STALE_WORKER] The panel is build ${BUILD_STAMP}, the background worker is ${workerBuild ? `build ${workerBuild}` : 'an older build'}. Reload ScoutFox to run the new version.`);
    }
  });
}

function setConnectionBanner(isDisconnected) {
  const pill = document.getElementById('statusPill');
  const textEl = document.getElementById('statusText');
  if (!pill) return;
  pill.classList.toggle('reconnecting', isDisconnected);
  if (isDisconnected && textEl) textEl.textContent = 'Reconnecting…';
}

/**
 * Push a log entry generated in the panel itself into the log pane. Failures on this side of
 * the boundary (a dead port, most importantly) cannot reach the background logger, so without
 * this they would leave no trace anywhere — the "logs were empty too" symptom.
 */
function appendLocalLog(level, module, message) {
  try {
    addLogEntry({
      id: `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString(),
      level,
      kind: 'system',
      module,
      message,
      data: null
    });
  } catch (_) { /* log pane may not exist yet during boot */ }
  console.warn(`[${module}]`, message);
}

/**
 * Forward panel-side exceptions to the background log so nothing fails invisibly.
 */
function reportClientError(source, err) {
  const message = (err && err.message) || String(err);
  appendLocalLog('ERROR', 'Sidepanel', `[${source}] ${message}`);
  try {
    sendBgMessage({
      action: 'CLIENT_ERROR',
      payload: { source, message, stack: (err && err.stack) || null }
    }, () => { void chrome.runtime.lastError; });
  } catch (_) {
    // Extension context invalidated — the local log above is the only record, by design.
  }
}

window.addEventListener('error', (event) => reportClientError('window.onerror', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => reportClientError('unhandledrejection', event.reason));

function initEventListeners() {
  document.getElementById('btnThemeToggle').addEventListener('click', async () => {
    const current = currentSettings.theme || 'system';
    const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
    currentSettings.theme = next;
    applyTheme(next);
    await Storage.saveSettings({ theme: next });
  });

  const historyToggle = document.getElementById('btnToggleHistory');
  const historyDrawer = document.getElementById('historyDrawer');
  const historyClose = document.getElementById('btnCloseHistory');

  if (historyToggle && historyDrawer) {
    historyToggle.addEventListener('click', async () => {
      const willOpen = historyDrawer.style.display === 'none';
      historyDrawer.style.display = willOpen ? 'flex' : 'none';
      historyToggle.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) await loadSessionHistory();
    });
  }

  if (historyClose && historyDrawer) {
    historyClose.addEventListener('click', () => {
      historyDrawer.style.display = 'none';
      if (historyToggle) historyToggle.setAttribute('aria-expanded', 'false');
    });
  }

  document.getElementById('btnStartTask').addEventListener('click', startTask);
  document.getElementById('taskInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      startTask();
    }
  });

  document.getElementById('btnPause').addEventListener('click', () => {
    const btn = document.getElementById('btnPause');
    const isPaused = btn.textContent.trim().includes('Resume');
    sendControlMessage(isPaused ? 'RESUME_TASK' : 'PAUSE_TASK');
  });

  document.getElementById('btnStop').addEventListener('click', () => {
    sendControlMessage('STOP_TASK');
  });



  // API Key visibility toggle
  const btnToggleKey = document.getElementById('btnToggleKey');
  if (btnToggleKey) {
    btnToggleKey.addEventListener('click', () => {
      const input = document.getElementById('apiKeyInput');
      if (input) {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btnToggleKey.title = isPassword ? 'Hide API Key' : 'Show API Key';
      }
    });
  }

  // Composer approval mode: one icon, two choices, like the reference's menu.
  const approvalBtn = document.getElementById('btnApprovalMode');
  const approvalMenu = document.getElementById('approvalMenu');
  const effortBtn = document.getElementById('btnEffort');
  const effortMenu = document.getElementById('effortMenu');
  const modelBtn = document.getElementById('composerModel');
  const modelMenu = document.getElementById('modelMenu');

  const setMenuOpen = (menu, btn, open) => {
    if (!menu || !btn) return;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  const closeComposerMenus = () => {
    setMenuOpen(approvalMenu, approvalBtn, false);
    setMenuOpen(effortMenu, effortBtn, false);
    setMenuOpen(modelMenu, modelBtn, false);
  };

  if (approvalBtn && approvalMenu) {
    approvalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = approvalMenu.hidden;
      closeComposerMenus();
      setMenuOpen(approvalMenu, approvalBtn, willOpen);
    });
    approvalMenu.querySelectorAll('.menu-item').forEach((item) => {
      item.addEventListener('click', async () => {
        applyApprovalMode(item.getAttribute('data-approval') || 'auto');
        closeComposerMenus();
        await Storage.saveSettings({ autoApprove: approvalMode === 'auto' });
      });
    });
  }

  if (effortBtn && effortMenu) {
    effortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = effortMenu.hidden;
      closeComposerMenus();
      setMenuOpen(effortMenu, effortBtn, willOpen);
    });
    effortMenu.querySelectorAll('.menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        setEffort(item.getAttribute('data-effort') || 'auto');
        closeComposerMenus();
      });
    });
  }

  // Model menu: the models of the chosen provider, scrollable, opened from the model name.
  if (modelBtn && modelMenu) {
    const modelSearch = document.getElementById('modelMenuSearch');
    const modelCustom = document.getElementById('modelMenuCustom');
    const listEl = document.getElementById('modelMenuList');

    // The same list the Settings picker shows, with every id the provider serves. The saved id
    // is kept at the top even when the endpoint itself no longer mentions it.
    const modelsForMenu = () => {
      const provider = document.getElementById('providerSelect')?.value || currentSettings.provider;
      const list = allFetchedModels.slice();
      const saved = currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || '';
      for (const id of [saved, selectedModel]) {
        if (id && id !== CUSTOM_MODEL_OPTION && !list.includes(id)) list.unshift(id);
      }
      return list;
    };

    const renderComposerModels = (list) => {
      if (!listEl) return;
      const provider = document.getElementById('providerSelect')?.value || currentSettings.provider;
      const active = selectedModel || currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || '';
      if (!list || list.length === 0) {
        listEl.innerHTML = '<div class="menu-empty">No models found for this provider.</div>';
        return;
      }
      listEl.innerHTML = list.map((name) => {
        const checked = name === active;
        return `<button type="button" class="menu-item" role="menuitemradio" aria-checked="${checked}" data-model="${escapeHtml(name)}"><span class="menu-label">${escapeHtml(name)}</span><span class="menu-check" aria-hidden="true">${checked ? MENU_CHECK : ''}</span></button>`;
      }).join('');
      listEl.querySelectorAll('.menu-item').forEach((item) => {
        item.addEventListener('click', async () => {
          updateSelectedModel(item.getAttribute('data-model'));
          closeComposerMenus();
          await autoSaveCurrentForm();
        });
      });
    };

    const applyCustomModel = async () => {
      const value = (modelCustom?.value || '').trim();
      if (!value) return;
      setCustomModelFieldOpen(false);
      updateSelectedModel(value);
      closeComposerMenus();
      if (modelCustom) modelCustom.value = '';
      await autoSaveCurrentForm();
    };

    modelBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const willOpen = modelMenu.hidden;
      closeComposerMenus();
      if (!willOpen) return;
      setMenuOpen(modelMenu, modelBtn, true);
      if (modelSearch) modelSearch.value = '';
      // The list belongs to one provider; a provider switch anywhere in the settings makes the
      // cached list wrong, so it is fetched again for the provider that is active now.
      if (allFetchedModelsProvider !== (document.getElementById('providerSelect')?.value || currentSettings.provider)) {
        if (listEl) listEl.innerHTML = '<div class="menu-empty">Loading models...</div>';
        await fetchDynamicModels(false);
        if (!modelMenu.hidden) renderComposerModels(modelsForMenu());
      } else {
        renderComposerModels(modelsForMenu());
      }
    });

    if (modelSearch) {
      modelSearch.addEventListener('click', (e) => e.stopPropagation());
      modelSearch.addEventListener('input', () => {
        const query = modelSearch.value.toLowerCase().trim();
        const source = modelsForMenu();
        renderComposerModels(query ? source.filter((m) => m.toLowerCase().includes(query)) : source);
      });
    }

    if (modelCustom) {
      modelCustom.addEventListener('click', (e) => e.stopPropagation());
      modelCustom.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          applyCustomModel();
        }
      });
    }
    document.getElementById('modelMenuCustomApply')?.addEventListener('click', applyCustomModel);
  }

  document.addEventListener('click', closeComposerMenus);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeComposerMenus();
  });

  // New chat: clears the run history of this tab, the same action the drawer's delete uses.
  const newChatBtn = document.getElementById('btnNewChat');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      sendBgMessage({ action: 'CLEAR_HISTORY' }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : res.error;
          appendLocalLog('ERROR', 'Sidepanel', `[NEW_CHAT_FAILED] ${errMsg}`);
          showTaskError(errMsg || 'Could not start a new chat.');
          return;
        }
        currentSessionId = null;
        // CLEAR_HISTORY resets the runner's version counter, so the next broadcast is lower
        // than the watermark this panel holds. Drop the watermark or that state is ignored.
        lastRenderedStateVersion = -1;
        const input = document.getElementById('taskInput');
        if (input) {
          input.value = '';
          input.focus();
        }
        const timeline = document.getElementById('timeline');
        if (timeline) renderEmptyState(timeline);
      });
    });
  }

  // A model id typed in the Settings custom field: saved like the base URL (debounced while
  // typing, at once on change or blur), and only once it is not empty.
  const modelCustomInput = document.getElementById('modelCustomInput');
  if (modelCustomInput) {
    let modelCustomDebounce = null;
    const commitNow = () => {
      if (modelCustomDebounce) clearTimeout(modelCustomDebounce);
      modelCustomDebounce = null;
      return commitTypedModel();
    };
    modelCustomInput.addEventListener('input', () => {
      if (modelCustomDebounce) clearTimeout(modelCustomDebounce);
      modelCustomDebounce = setTimeout(commitNow, 400);
    });
    modelCustomInput.addEventListener('change', commitNow);
    modelCustomInput.addEventListener('blur', commitNow);
  }

  // Auto-save for all number inputs and toggles
  ['maxStepsInput', 'delayInput', 'ollamaNumPredictInput', 'llmTimeoutInput', 'effortDefaultSelect', 'effortAdaptiveSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', autoSaveCurrentForm);
    }
  });
  // The Research section saves on change like the fields above, and shows only the fields it uses.
  ['researchEnabledSelect', 'researchBackendSelect', 'searxngUrlInput'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { syncResearchFields(); autoSaveCurrentForm(); });
    if (id === 'searxngUrlInput') el.addEventListener('input', syncResearchFields);
  });
  // The default effort is also the composer's effort from now on, as it is when the panel opens.
  const effortDefaultSelect = document.getElementById('effortDefaultSelect');
  if (effortDefaultSelect) {
    effortDefaultSelect.addEventListener('change', () => setEffort(effortDefaultSelect.value || 'medium'));
  }

  document.querySelectorAll('.log-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.log-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentActiveLogFilter = chip.getAttribute('data-filter');
      renderFilteredLogs();
    });
  });

  document.getElementById('btnDownloadLogs').addEventListener('click', () => {
    const text = rawLogsCache.map(log => `[${log.timestamp}] [${log.level}] [${log.module}] ${log.message}${log.data ? `\nPayload: ${log.data}` : ''}`).join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scoutfox-logs-${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btnCopyLogs').addEventListener('click', () => {
    // Plain text, one line per entry, no leading/trailing air. Copy what the reader sees.
    const entries = rawLogsCache.map(log => {
      const time = log.timestamp || '';
      const level = log.level || 'INFO';
      const mod = log.module || 'System';
      const msg = log.message || '';
      const payload = log.data ? `\n  ${String(log.data)}` : '';
      return `[${time}] [${level}] [${mod}] ${msg}${payload}`;
    }).join('\n');
    navigator.clipboard.writeText(entries).then(() => {
      const copyBtn = document.getElementById('btnCopyLogs');
      copyBtn.innerHTML = `${ICONS.check} Copied`;
      setTimeout(() => copyBtn.innerHTML = `${ICONS.copy} Copy`, 2000);
    });
  });

  document.getElementById('btnClearLogs').addEventListener('click', () => {
    rawLogsCache = [];
    document.getElementById('logOutput').textContent = '// Logs cleared.';
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(['agent_logs_history'], () => {
        if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      });
    }

    // The background worker keeps its own in-memory copy of every log entry and rewrites
    // agent_logs_history from it on the very next log call, regardless of the storage.remove
    // above. Without telling the worker too, cleared logs silently came back.
    sendControlMessage('CLEAR_LOGS', (ok) => {
      if (!ok) {
        appendLocalLog('WARN', 'Sidepanel', '[CLEAR_LOGS_INCOMPLETE] The background worker did not confirm the clear - it may still hold these logs in memory and rewrite them on its next log event.');
      }
    });
  });

  document.getElementById('btnFetchModels').addEventListener('click', () => {
    fetchDynamicModels(true);
  });

  // Auto-fetch models & auto-save settings on API Key input / paste / blur
  let apiKeyInputDebounce = null;
  let isPastingKey = false;
  const onApiKeyInput = () => {
    if (isPastingKey) return;
    if (apiKeyInputDebounce) clearTimeout(apiKeyInputDebounce);
    apiKeyInputDebounce = setTimeout(async () => {
      await autoSaveCurrentForm();
      const key = document.getElementById('apiKeyInput').value.trim();
      if (key.length >= 8) {
        fetchDynamicModels(true);
      }
    }, 400);
  };

  const onApiKeyChange = async () => {
    if (apiKeyInputDebounce) clearTimeout(apiKeyInputDebounce);
    await autoSaveCurrentForm();
    const key = document.getElementById('apiKeyInput').value.trim();
    if (key.length >= 8) {
      fetchDynamicModels(true);
    }
  };

  const onApiKeyBlur = () => {
    if (apiKeyInputDebounce) clearTimeout(apiKeyInputDebounce);
    autoSaveCurrentForm();
  };

  document.getElementById('apiKeyInput').addEventListener('input', onApiKeyInput);
  document.getElementById('apiKeyInput').addEventListener('change', onApiKeyChange);
  document.getElementById('apiKeyInput').addEventListener('blur', onApiKeyBlur);

  let baseUrlDebounce = null;
  const debouncedAutoSaveBaseUrl = () => {
    if (baseUrlDebounce) clearTimeout(baseUrlDebounce);
    baseUrlDebounce = setTimeout(() => {
      autoSaveCurrentForm();
    }, 400);
  };
  const immediateAutoSaveBaseUrl = () => {
    if (baseUrlDebounce) clearTimeout(baseUrlDebounce);
    autoSaveCurrentForm();
  };
  document.getElementById('baseUrlInput').addEventListener('input', debouncedAutoSaveBaseUrl);
  document.getElementById('baseUrlInput').addEventListener('change', immediateAutoSaveBaseUrl);
  document.getElementById('baseUrlInput').addEventListener('blur', immediateAutoSaveBaseUrl);
  document.getElementById('llmTimeoutInput')?.addEventListener('change', autoSaveCurrentForm);
  document.getElementById('llmTimeoutInput')?.addEventListener('blur', autoSaveCurrentForm);
  document.getElementById('apiKeyInput').addEventListener('paste', () => {
    isPastingKey = true;
    if (apiKeyInputDebounce) clearTimeout(apiKeyInputDebounce);
    apiKeyInputDebounce = setTimeout(async () => {
      isPastingKey = false;
      await autoSaveCurrentForm();
      const key = document.getElementById('apiKeyInput').value.trim();
      if (key.length >= 8) {
        fetchDynamicModels(true);
      }
    }, 200);
  });

  // Switch per-provider memory when provider dropdown changes
  document.getElementById('providerSelect').addEventListener('change', async () => {
    const provider = document.getElementById('providerSelect').value;
    if (provider === CUSTOM_TRIGGER_VALUE) {
      // The trigger is not a provider: put the previous selection back and open the Add dialog.
      document.getElementById('providerSelect').value = currentSettings.provider || 'openrouter';
      if (customProviderDialog) customProviderDialog.open('add');
      return;
    }
    await applyProviderSelection(provider);
  });

  document.getElementById('btnEditCustomProvider')?.addEventListener('click', () => {
    if (customProviderDialog && isCustomProviderId(currentSettings.provider, currentSettings)) {
      customProviderDialog.open('edit', currentSettings.provider);
    }
  });

  document.getElementById('btnDeleteCustomProvider')?.addEventListener('click', async () => {
    const id = currentSettings.provider;
    if (!isCustomProviderId(id, currentSettings)) return;
    const descriptor = currentSettings.customProviders[id];
    const sessions = await Storage.getSessions();
    const usedBy = sessions.filter((s) => s && s.provider === id).length;
    const suffix = usedBy > 0 ? ` ${usedBy} saved session(s) used it; their history stays.` : '';
    if (!window.confirm(`Delete ${descriptor.displayName || id}? Its key and model list are removed.${suffix}`)) return;
    const settingsAfter = await Storage.deleteCustomProvider(id);
    if (settingsAfter) currentSettings = settingsAfter;
    await loadSettings();
    // The picker may still hold the deleted provider's ids; the healed provider's own list
    // (usually a cache hit) replaces them.
    await fetchDynamicModels(false);
    const fellBack = currentSettings.provider !== id && descriptor.id === id;
    const healedName = providerMeta(currentSettings.provider, currentSettings).displayName;
    showToast(`Provider ${descriptor.displayName || id} deleted.${fellBack ? ` The panel fell back to ${healedName}.` : ''}`);
  });

  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    await autoSaveCurrentForm();
    showToast(`Settings saved! Provider [${currentSettings.provider}] configured.`);
  });

  document.querySelectorAll('.sample-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      document.getElementById('taskInput').value = prompt;
      startTask();
    });
  });
}

/**
 * Put one provider into effect: load its saved URL, key, model and timeout into the form, update
 * the settings object, autosave, and refresh the model list. The body of the provider-change
 * handler, also called after a custom provider is added or deleted so the form follows without a
 * synthetic change event.
 */
async function applyProviderSelection(provider) {
  const activeIsCustom = isCustomProviderId(provider, currentSettings);
  const providerConfigs = currentSettings.providerConfigs || DEFAULT_PROVIDER_CONFIGS;
  const savedCfg = activeIsCustom ? (providerConfigs[provider] || {}) : (providerConfigs[provider] || DEFAULT_PROVIDER_CONFIGS[provider] || {});

  const ollamaGroup = document.getElementById('ollamaNumPredictGroup');
  if (ollamaGroup) {
    ollamaGroup.style.display = provider === 'ollama' ? 'flex' : 'none';
  }

  // The dropdown options may have changed (a provider was added or deleted), so rebuild them here
  // as well; the assignment below needs its option to exist.
  buildProviderOptions(document.getElementById('providerSelect'), currentSettings.customProviders);
  document.getElementById('providerSelect').value = provider;
  syncCustomProviderActions(provider);

  const baseUrlToSet = savedCfg.baseUrl || (activeIsCustom ? '' : (DEFAULT_PROVIDER_CONFIGS[provider] ? DEFAULT_PROVIDER_CONFIGS[provider].baseUrl : ''));
  document.getElementById('baseUrlInput').placeholder = activeIsCustom
    ? (savedCfg.baseUrl || '')
    : (DEFAULT_PROVIDER_CONFIGS[provider]?.baseUrl || 'https://openrouter.ai/api/v1');
  document.getElementById('baseUrlInput').value = baseUrlToSet;
  document.getElementById('apiKeyInput').value = savedCfg.apiKey || '';

  const modelToSet = savedCfg.model || (activeIsCustom ? '' : (DEFAULT_PROVIDER_CONFIGS[provider] ? DEFAULT_PROVIDER_CONFIGS[provider].model : currentSettings.model));
  setCustomModelFieldOpen(false);
  updateSelectedModel(modelToSet);

  const timeoutToSet = timeoutShownFor({ ...currentSettings, providerConfigs }, provider);
  document.getElementById('llmTimeoutInput').value = timeoutToSet;

  // Update settings object
  currentSettings.provider = provider;
  currentSettings.baseUrl = baseUrlToSet;
  currentSettings.apiKey = savedCfg.apiKey || '';
  currentSettings.model = modelToSet;
  // The global timeout follows the field only for a provider that reads it; a provider's own
  // value must not leak into the global one the other providers use.
  if (provider !== 'nvidia' && providerOwnTimeoutOf({ ...currentSettings, providerConfigs }, provider) === 0) {
    currentSettings.llmTimeoutMs = timeoutToSet;
  }

  await autoSaveCurrentForm();

  const shouldRefresh = provider === 'ollama' || provider === 'nvidia' || activeIsCustom || (savedCfg.apiKey && savedCfg.apiKey.length > 5);
  await fetchDynamicModels(shouldRefresh);
}

async function startTask() {
  const btn = document.getElementById('btnStartTask');
  const prompt = document.getElementById('taskInput').value.trim();
  if (!prompt) return;

  // A custom endpoint has no default model to fall back on, so an empty model would be sent as
  // an empty string. Fail here, at the button, with the fix named.
  const activeProviderId = currentSettings.provider || 'openrouter';
  const activeMeta = providerMeta(activeProviderId, currentSettings);
  if (activeMeta.isCustom && !(currentSettings.providerConfigs?.[activeProviderId]?.model || currentSettings.model)) {
    showToast(`Pick a model for ${activeMeta.displayName} in Settings first: a custom endpoint has no default to fall back on.`);
    return;
  }

  // Claim synchronously, before the first await. renderState() does disable this button, but
  // only once a running STATE_UPDATE has made the round trip, and both the click handler and
  // the Enter key land here directly. The engine guards this too; this half is what stops the
  // duplicate message being sent at all, and gives immediate visual feedback.
  if (isSubmittingTask) return;
  isSubmittingTask = true;
  if (btn) btn.disabled = true;

  try {
    await startTaskInner(prompt);
  } finally {
    isSubmittingTask = false;
    // renderState() owns the button from here: it re-disables while the task runs, and
    // re-enables when it ends. Only release it if the task never got that far.
    if (btn && !isTaskActive) btn.disabled = false;
  }
}

/** The provider and model the settings hold now, as the run chip names them. */
function currentRunModel() {
  const provider = currentSettings.provider || 'openrouter';
  return {
    provider,
    model: currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || ''
  };
}

async function startTaskInner(prompt) {
  // Auto-sync form state into Storage before launching task
  await autoSaveCurrentForm();
  runModelSnapshot = currentRunModel();

  currentSessionId = `session_${Date.now()}`;

  appendLocalLog('INFO', 'Sidepanel', `[TASK_SUBMIT] Sending task to background worker: "${prompt}"`);

  sendBgMessage({ action: 'START_TASK', payload: { prompt, effort: currentEffort, autoApprove: approvalMode !== 'manual' } }, (res) => {
    // Without this check a failed wake-up leaves res undefined and the whole submission
    // vanishes with no alert, no log and no UI change — the task simply never starts.
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message;
      appendLocalLog('ERROR', 'Sidepanel', `[TASK_SUBMIT_FAILED] Background worker did not accept the task (${msg}). Reconnecting and retrying is usually enough.`);
      showTaskError(`Could not reach the background worker: ${msg}`);
      scheduleReconnect();
      return;
    }

    if (res && res.success) {
      document.getElementById('taskInput').value = '';
      const emptyState = document.getElementById('emptyState');
      if (emptyState) emptyState.style.display = 'none';
      document.getElementById('controlBar').style.display = 'flex';
      appendLocalLog('INFO', 'Sidepanel', `[TASK_ACCEPTED] Running against tab [${res.tabId}] — ${res.tabUrl || 'unknown URL'}`);
    } else {
      const msg = (res && res.error) || 'The background worker returned no response.';
      appendLocalLog('ERROR', 'Sidepanel', `[TASK_SUBMIT_FAILED] ${msg}`);
      showTaskError(msg);
    }
  });
}

/**
 * Surface a task-level failure in the timeline rather than a modal alert(), which the user
 * has to dismiss and which leaves no record of what went wrong.
 */
function showTaskError(message) {
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  const card = document.createElement('div');
  card.className = 'result-badge error';
  card.style.cssText = 'margin-top: 8px; padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; align-items: flex-start;';
  card.innerHTML = `${ICONS.warning}<span><strong>Could not start task:</strong><br>${escapeHtml(message)}</span>`;
  timeline.appendChild(card);
  timeline.scrollTop = timeline.scrollHeight;
}

async function loadSessionHistory() {
  const sessions = await Storage.getSessions();
  const historyBtn = document.getElementById('btnToggleHistory');
  // Icon only, like the rest of the header. The count stays in the tooltip: a number in the
  // button overflowed the header at 320px.
  if (historyBtn) {
    historyBtn.title = `Recent tasks (${sessions.length})`;
    historyBtn.setAttribute('aria-label', `Recent tasks (${sessions.length})`);
  }

  const listContainer = document.getElementById('historySessionsList');
  if (!listContainer) return;

  if (sessions.length === 0) {
    listContainer.innerHTML = `<div class="subtext-hint" style="padding: 10px; text-align: center;">No saved sessions yet.</div>`;
    return;
  }

  listContainer.innerHTML = sessions.map(session => {
    const isSelected = session.id === currentSessionId;
    return `
      <div class="history-session-item ${isSelected ? 'active' : ''}" data-id="${escapeHtml(session.id)}" tabindex="0" role="button">
        <div class="history-item-info">
          <span class="history-item-title">${escapeHtml(session.task || 'Untitled Session')}</span>
          <span class="history-item-meta">${escapeHtml(session.timestamp || '')} • ${escapeHtml(session.model || '')}</span>
        </div>
        <button class="btn-delete-session" data-delete-id="${escapeHtml(session.id)}">${ICONS.trash}</button>
      </div>
    `;
  }).join('');

  listContainer.querySelectorAll('.history-session-item').forEach(item => {
    const open = (e) => {
      if (e.target.closest('.btn-delete-session')) return;
      loadSelectedSession(item.getAttribute('data-id'));
    };
    item.addEventListener('click', open);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
    });
  });

  listContainer.querySelectorAll('.btn-delete-session').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deleteId = btn.getAttribute('data-delete-id');
      await Storage.deleteSession(deleteId);
      await loadSessionHistory();
    });
  });
}

/**
 * Every engine state this panel gets, from the port or from a resync, goes through here.
 *
 * A panel that did not submit the run itself (opened while it was going, or after it ended)
 * has no session id for it, so it takes one here, before the first render: the id is part of
 * the finish card's identity, and taking it later would make the card land a second time.
 */
function receiveState(state) {
  if (!state) return;
  if (!currentSessionId && state.task && Array.isArray(state.history) && state.history.length > 0) {
    currentSessionId = `session_${Date.now()}`;
  }
  // Read before the render, which forgets the run's model once the run has ended.
  const runModel = runModelSnapshot || currentRunModel();
  renderState(state);
  autoSaveActiveSession(state, runModel);
}

/**
 * What tells one run apart from another in the same tab: its own goal row (the run number, the
 * prompt and the time it was typed). Two panels that save the same run agree on it, which a
 * per-panel session id cannot do.
 */
function runKeyOf(task, history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.type === 'user_goal') return `${e.turn}|${e.prompt}|${e.timestamp || ''}`;
  }
  return `task|${task || ''}`;
}

/**
 * The saved entry a run belongs to. The run's own entry if any panel saved it already (so a
 * second panel updates it instead of adding a copy), else this panel's id, unless that id names
 * a different run (a session the user opened from the list), which must not be overwritten.
 */
function sessionIdForRun(sessions, runKey) {
  const same = sessions.find((s) => s && runKeyOf(s.task, s.history) === runKey);
  if (same) return { id: same.id, saved: same };
  const own = sessions.find((s) => s && s.id === currentSessionId);
  if (currentSessionId && !own) return { id: currentSessionId, saved: null };
  return { id: `session_${Date.now()}`, saved: null };
}

/**
 * Persist a run once it reaches a terminal state.
 *
 * Only terminal states are saved, so a run is written once rather than on every one of the
 * ~7 state broadcasts per step. The panel still OPENS on a clean timeline (the worker clears
 * history on a fresh connect); this is what makes that previous run recoverable afterwards
 * instead of simply lost.
 */
async function autoSaveActiveSession(state, runModel = currentRunModel()) {
  if (!state) return;

  const TERMINAL = ['idle', 'stopped', 'complete', 'completed', 'error'];
  if (!TERMINAL.includes(state.status)) return;
  if (!state.task) return;
  if (!Array.isArray(state.history) || state.history.length === 0) return;
  const runKey = runKeyOf(state.task, state.history);
  const writeKey = runKey + ':' + state.history.length;
  if (savedSessionIds.has(writeKey)) return;

  savedSessionIds.add(writeKey);

  try {
    const { id, saved } = sessionIdForRun(await Storage.getSessions(), runKey);
    // Already saved in full (by another panel, or before this panel was reopened): nothing new.
    if (saved && Array.isArray(saved.history) && saved.history.length === state.history.length) return;
    await Storage.saveSession({
      id,
      task: state.task,
      timestamp: new Date().toLocaleString(),
      model: runModel.model || '',
      provider: runModel.provider || '',
      history: state.history,
      planSteps: state.planSteps || []
    });
    await loadSessionHistory();
  } catch (err) {
    reportClientError('sidepanel:session-save', err);
  }
}

async function loadSelectedSession(sessionId) {
  const sessions = await Storage.getSessions();
  const target = sessions.find(s => s.id === sessionId);
  if (!target) return;

  currentSessionId = target.id;
  const drawer = document.getElementById('historyDrawer');
  if (drawer) drawer.style.display = 'none';
  const toggle = document.getElementById('btnToggleHistory');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');

  renderState({
    status: 'idle',
    stepCount: target.history.length,
    task: target.task,
    history: target.history,
    planSteps: target.planSteps || []
  });

  await loadSessionHistory();
}

function renderEmptyState() {
  const timeline = document.getElementById('timeline');
  if (timeline) {
    timeline.innerHTML = `
      <div class="empty-state" id="emptyState">
        <div class="empty-glyph" aria-hidden="true">
          ${FOX_MARK}
        </div>
        <h3>What would you like to automate?</h3>
        <p>Enter a task below. ScoutFox will read the page, index elements, and execute browser actions step-by-step.</p>
        <div class="sample-prompts">
          <span class="sample-chip" data-prompt="Search Google for open-source AI browser frameworks">${ICONS.search} Search Google for AI agents</span>
          <span class="sample-chip" data-prompt="Find top trending repositories on GitHub for python">${ICONS.star} Top Python GitHub repos</span>
          <span class="sample-chip" data-prompt="Summarize the main articles on news.ycombinator.com">${ICONS.doc} Summarize Hacker News</span>
        </div>
      </div>
    `;
    document.querySelectorAll('.sample-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const prompt = chip.getAttribute('data-prompt');
        document.getElementById('taskInput').value = prompt;
        startTask();
      });
    });
  }
}

/**
 * Render Agent Execution State into UI
 */
function renderState(state) {
  if (!state) return;

  if (typeof state.stateVersion === 'number') {
    if (state.bootId && state.bootId !== lastBootId) {
      if (lastBootId !== null) {
        appendLocalLog('WARN', 'Sidepanel', '[WORKER_RESTARTED] The background worker was restarted by Chrome. Re-syncing the panel to the new instance.');
      }
      lastBootId = state.bootId;
      lastRenderedStateVersion = -1;
    }
    if (state.stateVersion <= lastRenderedStateVersion) return; // stale/duplicate
    lastRenderedStateVersion = state.stateVersion;
  }

  const { status, stepCount, history, planSteps, currentPhase, pendingQuestion, pendingApproval, pendingConfirm, pendingChallengeHelp, pendingContinueBudget, findings } = state;
  const isDisconnected = backgroundPort === null;

  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const controlBar = document.getElementById('controlBar');
  const btnPause = document.getElementById('btnPause');
  const processingBanner = document.getElementById('processingBanner');
  const processingPhaseText = document.getElementById('processingPhaseText');
  const progressBarFill = document.getElementById('progressBarFill');
  const taskInput = document.getElementById('taskInput');
  const btnStartTask = document.getElementById('btnStartTask');

  if (statusPill && statusText) {
    statusPill.className = `status-indicator ${status}${isDisconnected ? ' reconnecting' : ''}`;
    statusText.textContent = isDisconnected
      ? 'Reconnecting…'
      : status.charAt(0).toUpperCase() + status.slice(1);
  }

  if (status === 'running' || status === 'paused') {
    if (processingBanner) {
      processingBanner.style.display = 'flex';
      processingBanner.classList.toggle('paused', status === 'paused');
    }
    // A pause with no card of its own says why (a Resume button with no reason looks like the agent stopped by itself).
    if (processingPhaseText) processingPhaseText.textContent = pendingApproval
      ? 'Waiting for your approval'
      : (pauseReasonText(state) || currentPhase || `Processing step ${stepCount}...`);
    
    const maxSteps = (state.budget && state.budget.hardCap) || currentSettings.maxSteps || DEFAULT_SETTINGS.maxSteps;
    const workingSteps = (state.budget && state.budget.workingTotal) || maxSteps;
    const currentSteps = (state.budget && state.budget.used) || stepCount || 1;
    const pct = Math.min(100, Math.round((currentSteps / Math.max(1, workingSteps)) * 100));
    if (progressBarFill) {
      progressBarFill.style.width = `${pct}%`;
      // A hold at the plan is not progress through the steps; the bar would claim 4% of a run
      // that has not executed anything yet.
      if (progressBarFill.parentElement) progressBarFill.parentElement.style.display = pendingApproval ? 'none' : '';
    }

    isTaskActive = true;
    // The plan card is the only decision while it is up: Cancel there ends the run, so the
    // control bar would only repeat it.
    if (controlBar) controlBar.style.display = pendingApproval ? 'none' : 'flex';
    if (taskInput) taskInput.disabled = true;
    if (btnStartTask) btnStartTask.disabled = true;
    const approvalBtn = document.getElementById('btnApprovalMode');
    const effortBtn = document.getElementById('btnEffort');
    const modelBtn = document.getElementById('composerModel');
    if (approvalBtn) approvalBtn.disabled = true;
    if (effortBtn) effortBtn.disabled = true;
    if (modelBtn) modelBtn.disabled = true;
    if (!runModelSnapshot) runModelSnapshot = currentRunModel();

    if (btnPause) {
      // The plan card owns the decision while it is up: Resume would only re-enter the loop
      // without an approval, so it is replaced by Approve/Cancel on the card.
      btnPause.style.display = pendingApproval ? 'none' : '';
      if (status === 'paused') {
        btnPause.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`;
      } else {
        btnPause.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`;
      }
    }
  } else {
    isTaskActive = false;
    if (processingBanner) processingBanner.style.display = 'none';
    if (controlBar) controlBar.style.display = 'none';
    if (taskInput) taskInput.disabled = false;
    if (btnStartTask) btnStartTask.disabled = false;
    const approvalBtn = document.getElementById('btnApprovalMode');
    const effortBtn = document.getElementById('btnEffort');
    const modelBtn = document.getElementById('composerModel');
    if (approvalBtn) approvalBtn.disabled = false;
    if (effortBtn) effortBtn.disabled = false;
    if (modelBtn) modelBtn.disabled = false;
    runModelSnapshot = null;
  }

  // New chat clears the run history, which would strand a plan hold that is still waiting for
  // an answer. It is only available between runs.
  const newChatBtn = document.getElementById('btnNewChat');
  if (newChatBtn) {
    newChatBtn.disabled = isTaskActive;
    newChatBtn.title = isTaskActive ? 'Stop the task before starting a new chat' : 'New chat';
  }



  // A run that ended may have learned that its model refuses the reasoning fields (or which values
  // it accepts): ask again, so the composer offers what the next run will really send.
  if (effortRunWasActive && status !== 'running' && status !== 'paused') refreshEffortSupport();
  effortRunWasActive = status === 'running' || status === 'paused';
  const processingEffortBadge = document.getElementById('processingEffortBadge');
  if (processingEffortBadge) {
    if (status === 'running' || status === 'paused') {
      // The chip names the model's reasoning level, and only when one is sent: not for Auto and
      // not for a model that takes none.
      const activeEffort = state.effort?.level || (currentEffort !== 'auto' ? currentEffort : null);
      if (activeEffort && activeEffort !== 'auto' && effortSupport.levels.length > 1 && !pendingApproval) {
        processingEffortBadge.textContent = `${EFFORT_LABEL[normalizeEffort(activeEffort)] || activeEffort}`;
        processingEffortBadge.title = 'How hard the model thinks before each step';
        processingEffortBadge.style.display = 'inline-block';
      } else {
        processingEffortBadge.style.display = 'none';
      }
    } else {
      processingEffortBadge.style.display = 'none';
    }
  }

  // The run shows which provider and model it uses (featere/custom-endpoint A6.3): what the
  // settings held when the task started, kept for the whole run. A user-added provider appears
  // under its display name, exactly as it does in the picker.
  const processingModelChip = document.getElementById('processingModelChip');
  if (processingModelChip) {
    if (status === 'running' || status === 'paused') {
      const run = runModelSnapshot || currentRunModel();
      const runProvider = providerMeta(run.provider, currentSettings);
      const runModel = run.model;
      if (runProvider.exists && runModel && !pendingApproval) {
        processingModelChip.textContent = `${runProvider.displayName} · ${runModel}`;
        processingModelChip.style.display = 'inline-block';
      } else {
        processingModelChip.style.display = 'none';
      }
    } else {
      processingModelChip.style.display = 'none';
    }
  }

  const timeline = document.getElementById('timeline');
  if (timeline) {
    if ((!history || history.length === 0) && !pendingApproval && !pendingConfirm && !pendingChallengeHelp && !pendingContinueBudget) {
      renderEmptyState();
      return;
    }

    // Keep the scroll pinned to the bottom only if the user was already there, so
    // expanding a row mid-run does not yank the view away from them.
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    const finishArrived = noteFinishCard(status, history);
    timeline.innerHTML = renderTurns(history, status, currentPhase, pendingQuestion, pendingApproval, pendingConfirm, pendingChallengeHelp, pendingContinueBudget, findings, state.effortProfile, planSteps);
    attachShotSlots();
    if (nearBottom) scrollTimelineToLatest(timeline, finishArrived);
  }
}

/**
 * Puts the pictures into the slots the render just created.
 *
 * A picture that is cached is moved in from its element, which decodes nothing. A picture that is
 * not cached yet is fetched once, decoded off-screen, and only then attached, so it never appears
 * half-drawn. A picture the background no longer has (the registry keeps the last few, and a
 * reloaded session has none) says so in a muted line, exactly like a session reloaded after the
 * bytes were dropped: honest, and never a broken <img>.
 */
function attachShotSlots() {
  const slots = document.querySelectorAll('#timeline .act-shot-slot');
  for (const slot of slots) {
    const imageId = slot.getAttribute('data-shot') || '';
    if (!imageId) continue;
    const cached = shotCache.get(imageId);
    if (cached) {
      attachShotPicture(slot, cached.img, cached.dataUrl);
      continue;
    }
    if (shotGone.has(imageId)) {
      slot.innerHTML = '<span class="act-shot-gone">picture no longer kept</span>';
      continue;
    }
    void loadShotPicture(imageId, slot);
  }
}

/** Puts one decoded picture (or its placeholder) into one slot. */
function attachShotPicture(slot, img, dataUrl) {
  const width = Number(slot.getAttribute('data-w')) || img.naturalWidth || 4;
  const height = Number(slot.getAttribute('data-h')) || img.naturalHeight || 3;
  // The box keeps the picture's shape from the stored size, so the layout does not jump when the
  // bytes arrive. A ratio that would collapse is left to the image's own size.
  if (width > 0 && height > 0) slot.style.aspectRatio = `${width} / ${height}`;
  slot.innerHTML = '';
  img.width = width;
  img.height = height;
  img.alt = 'The page as the agent saw it';
  img.className = 'act-shot-img';
  img.setAttribute('data-src', dataUrl);
  slot.appendChild(img);
}

/** Fetches one picture by id, decodes it, and hands it to the slot. */
async function loadShotPicture(imageId, slot) {
  const dataUrlFor = (data, mediaType) => (String(data).startsWith('data:')
    ? String(data)
    : `data:${mediaType || 'image/jpeg'};base64,${data}`);
  const answer = await new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    try {
      sendBgMessage({ action: 'GET_SCREENSHOT', payload: { imageId } }, (resp) => finish(chrome.runtime.lastError ? null : resp));
    } catch (_) {
      finish(null);
    }
    setTimeout(() => finish(null), 3000);
  });
  if (!answer || !answer.success || !answer.data) {
    shotGone.add(imageId);
    if (slot.isConnected) slot.innerHTML = '<span class="act-shot-gone">picture no longer kept</span>';
    return;
  }
  const dataUrl = dataUrlFor(answer.data, answer.mediaType);
  const img = new Image();
  img.src = dataUrl;
  try {
    await img.decode();
  } catch (_) {
    // The bytes came back but they are not a picture the browser can decode. That is not the
    // same as "the session dropped it", and saying so would be a wrong explanation.
    shotGone.add(imageId);
    if (slot.isConnected) slot.innerHTML = '<span class="act-shot-gone">picture could not be shown</span>';
    return;
  }
  shotCache.set(imageId, { dataUrl, img });
  // The slot may be gone by now: the timeline re-rendered while the picture was loading. The
  // cache keeps it, and the next render attaches it.
  if (slot.isConnected) attachShotPicture(slot, img, dataUrl);
}

/**
 * Where the panel lands when the newest finish card appears.
 *
 * Following the bottom is right while a run is live, but a finish card can be taller than the
 * panel (a long answer with a table). Ending at its bottom then hides its title, its subtitle and
 * the start of "What could not be verified", and the reader first sees the middle of the answer.
 * So when the card's top would be scrolled out of view, the panel lands on the top of the card
 * instead. The card's top is visible at the bottom scroll position exactly when the card fits
 * (with the gap and the padding below it), so short cards end at the bottom as they always did.
 *
 * `cardTop` is the card's offset inside the scrolled content. `margin` is the air kept above the
 * card: less than the gap to the group above it, so no sliver of that group shows.
 */
const FINISH_LANDING_MARGIN = 8;

function finishLandingTop({ cardTop, viewHeight, scrollHeight, margin = FINISH_LANDING_MARGIN }) {
  const bottom = Math.max(0, scrollHeight - viewHeight);
  const cardStart = Math.max(0, cardTop - margin);
  return cardStart >= bottom ? scrollHeight : cardStart;
}

// The finish card the panel has already dealt with (landed on, or left alone because the reader
// was scrolled up). renderState runs on every broadcast: the landing must happen once per card,
// or a reader who scrolled down through a long answer would be thrown back to its top.
let seenFinishKey = null;

/** Identity of the newest finish entry: the session, its place in the history and the answer length. */
function finishCardKey(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && (list[i].type === 'finish' || list[i].type === 'partial_result')) {
      return `${currentSessionId}|${i}|${String(list[i].answer == null ? '' : list[i].answer).length}`;
    }
  }
  return null;
}

/** True once for each finish card, when it first shows up in a render of a run that is no longer live. */
function noteFinishCard(status, history) {
  if (status === 'running' || status === 'paused') return false;
  const key = finishCardKey(history);
  if (key === null || key === seenFinishKey) return false;
  seenFinishKey = key;
  return true;
}

/** The scroll step of renderState, for a reader who was at the bottom. Today: follow the bottom. */
function scrollTimelineToLatest(timeline, finishArrived) {
  const lastTurn = timeline.lastElementChild;
  const card = finishArrived && lastTurn && lastTurn.querySelector ? lastTurn.querySelector('.finish-card') : null;
  if (!card) {
    timeline.scrollTop = timeline.scrollHeight;
    return;
  }
  const cardTop = card.getBoundingClientRect().top - timeline.getBoundingClientRect().top + timeline.scrollTop;
  timeline.scrollTop = finishLandingTop({ cardTop, viewHeight: timeline.clientHeight, scrollHeight: timeline.scrollHeight });
}

/**
 * Batched action rendering.
 *
 * A session is a sequence of turns. Each turn is: the goal you typed, a collapsible group of
 * one-line action rows showing what the agent actually did, then the answer. While a turn runs
 * its group is open so you can watch; once it finishes the group collapses to a single summary
 * line so a long session stays readable. Reasoning hides behind each row until you click it.
 */

/** Split flat history into turns. A turn starts at each user_goal entry. */
function buildTurns(history) {
  const turns = [];
  let cur = null;
  (history || []).forEach((item, idx) => {
    if (item.type === 'user_goal') {
      cur = {
        turn: item.turn || turns.length + 1,
        goal: item.prompt,
        entries: [],
        answer: null,
        audit: null,
        failed: false,
        timestamp: item.timestamp || null,
        isNewRun: !!item.isNewRun
      };
      turns.push(cur);
      return;
    }
    if (!cur) {
      cur = { turn: turns.length + 1, goal: null, entries: [], answer: null, audit: null, failed: false, timestamp: null, isNewRun: false };
      turns.push(cur);
    }
    if (item.type === 'agent_response' && item.action) {
      cur.entries.push({ kind: 'action', idx, action: item.action, thought: item.thought || '', outcome: null });
    } else if (item.type === 'execution_result') {
      // Attach the outcome to the action row it belongs to.
      for (let i = cur.entries.length - 1; i >= 0; i--) {
        if (cur.entries[i].kind === 'action' && !cur.entries[i].outcome) {
          cur.entries[i].outcome = item;
          break;
        }
      }
      if (item.success === false) {
        cur.failed = true;
        cur.failedSteps = (cur.failedSteps || 0) + 1;
      }
    } else if (item.type === 'error') {
      cur.entries.push({ kind: 'fault', idx, content: item.content });
      cur.failed = true;
    } else if (item.type === 'user_answer') {
      cur.entries.push({ kind: 'answer', idx, content: item.content });
    } else if (item.type === 'finish') {
      cur.answer = item.answer;
      cur.answerUnconfirmed = !!item.unconfirmed;
      // How the run went, as the model said it with finish. Absent on a plain-text reply and on
      // runs saved before finish had it: those keep the older card (failed step -> Failed).
      cur.outcome = Object.prototype.hasOwnProperty.call(OUTCOME_CARD, item.outcome) ? item.outcome : null;
      // The supporting material of a structured answer, shown in its own section.
      cur.evidence = item.evidence || '';
      // Written by the engine's answer audit (agent/answerAudit.ts). Absent on older runs and on
      // saved sessions from before the audit existed: those render exactly as they always did.
      cur.audit = item.audit || null;
      cur.table = item.table || null;
      cur.findings = item.findings || null;
      cur.runStats = item.runStats || null;
    } else if (item.type === 'partial_result') {
      // The run ended before it finished (a Stop, the step cap, a blocked site, a stop-early, unusable
      // model replies). It has an answer slot like a finish, but renderFinishCard never calls it Done.
      cur.answer = item.answer;
      cur.partial = true;
      cur.partialReason = typeof item.reason === 'string' ? item.reason : '';
      cur.audit = item.audit || null;
      cur.table = item.table || null;
      cur.findings = item.findings || null;
      cur.runStats = item.runStats || null;
    }
  });
  return turns;
}

/** The first sentence of a text (or its first line), without a closing colon, at most 140 characters. Plain text: escape it before it goes into HTML. */
function firstSentence(text) {
  const t = String(text == null ? '' : text).trim();
  const line = t.split('\n')[0] || '';
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(line);
  const sentence = (m ? m[0] : line).replace(/[:\s]+$/, '').trim();
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

/** One-line human description of an action: icon, verb, and the thing it acted on. */
function describeAction(action, outcome) {
  const label = (outcome && outcome.label) || '';
  const quote = (t) => `<em>${escapeHtml(String(t).length > 44 ? String(t).slice(0, 43) + '…' : String(t))}</em>`;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; } };

  switch (action.action) {
    case 'navigate':      return { icon: ICONS.globe, text: `Opened ${quote(host(action.url || ''))}` };
    case 'read_page': {
      const part = Number.isInteger(action.part) && action.part > 1 ? ` (part ${escapeHtml(String(action.part))})` : '';
      return { icon: ICONS.eye, text: action.element_id !== undefined && action.element_id !== null ? `Read the text of ${label ? quote(label) : `element ${escapeHtml(String(action.element_id))}`}${part}` : `Read page text${part}` };
    }
    // A row of a session saved before read_page replaced it.
    case 'read_page_text':return { icon: ICONS.eye, text: 'Read page text' };
    case 'click':         return {
      icon: ICONS.pointer,
      // A coordinate click has no element and no label, and "Clicked element undefined" is what
      // the old wording would have said. The pixels are the picture's pixels, and the user is
      // looking at that same picture in the thumbnail, so the wording says so.
      text: label
        ? `Clicked ${quote(label)}`
        : (action.x !== undefined && action.x !== null
          ? `Clicked at (${escapeHtml(String(action.x))}, ${escapeHtml(String(action.y))}) in the picture`
          : `Clicked element ${escapeHtml(String(action.element_id))}`)
    };
    case 'take_screenshot': return { icon: ICONS.camera, text: 'Looked at the page' };
    case 'type':          return { icon: ICONS.keyboard, text: `${action.mode === 'append' ? 'Appended' : 'Typed'} ${quote(action.text || '')}${label ? ` into ${quote(label)}` : ''}` };
    case 'scroll': {
      // The engine measures a scroll: the row says what really moved, or that nothing did.
      const measured = /^(Scrolled .+? (?:down|up) \d+px|Did not move: [^.]*)/.exec(String((outcome && outcome.message) || ''));
      return { icon: ICONS.scrollIco, text: measured ? escapeHtml(measured[1]) : `Scrolled ${escapeHtml(action.direction || 'down')}` };
    }
    case 'go_back':       return { icon: ICONS.back, text: 'Went back' };
    case 'go_forward':    return { icon: ICONS.back, text: 'Went forward' };
    case 'get_page_elements': return { icon: ICONS.pointer, text: 'Listed the clickable elements' };
    case 'find_elements': return { icon: ICONS.search, text: `Searched elements for ${quote(action.query || '')}` };
    // Research outside the tab: the row says what was searched, and what was read from where.
    case 'web_search':    return { icon: ICONS.search, text: `Searched the web: ${quote(action.query || '')}` };
    case 'fetch_url': {
      const file = (() => { try { return decodeURIComponent(new URL(action.url).pathname.split('/').filter(Boolean).pop() || ''); } catch (_) { return ''; } })();
      const name = label || file || host(action.url || '');
      const part = Number.isInteger(action.part) && action.part > 1 ? ` (part ${escapeHtml(String(action.part))})` : '';
      return { icon: ICONS.doc, text: `Read ${quote(name)} (${escapeHtml(host(action.url || ''))})${part}` };
    }
    case 'ask_user':      return { icon: ICONS.ask, text: `Asked ${quote(action.question || 'a question')}` };
    case 'press_key': {
      const names = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
      const mods = Array.isArray(action.modifiers) ? action.modifiers.map((m) => names[m] || String(m)) : [];
      const key = action.key === 'select_all' ? 'Select all' : String(action.key || 'a key');
      return { icon: ICONS.keyboard, text: `Pressed ${quote([...mods, key].join('+'))}` };
    }
    case 'wait':          return { icon: ICONS.clock, text: `Waited ${escapeHtml(String(action.amount || 1))}s` };
    case 'finish':
      // A finish the engine's answer audit sent back is not a finish: the run went on. Say so, and why.
      return outcome && outcome.finishRefused
        ? { icon: ICONS.warning, text: 'Finish not accepted', detail: firstSentence(outcome.error) }
        : { icon: ICONS.complete, text: 'Gave the final answer' };
    case 'record_finding': {
      // The model's own words (field names and values): quote() escapes them.
      if (action.field) {
        const value = action.value == null ? '' : (typeof action.value === 'string' ? action.value : JSON.stringify(action.value));
        return { icon: ICONS.doc, text: value ? `Saved ${quote(action.field)}: ${quote(value)}` : `Saved ${quote(action.field)}` };
      }
      const fields = action.values && typeof action.values === 'object' ? Object.keys(action.values) : [];
      return { icon: ICONS.doc, text: fields.length ? `Saved ${fields.map(quote).join(', ')}` : 'Saved a finding' };
    }
    default:              return { icon: ICONS.dot, text: escapeHtml(action.action || 'Acted') };
  }
}

/**
 * Should this turn's group be open? Explicit user choice always wins. Otherwise: open while
 * the turn is live so you can watch it, and open if it ended without producing an answer so
 * the reason is visible. A turn that finished successfully collapses, even if some individual
 * action failed along the way — recovering from a failed click is normal, not a bad outcome.
 */
function isTurnExpanded(turn, isLive, incomplete) {
  if (turnExpandOverride.has(turn.turn)) return turnExpandOverride.get(turn.turn);
  // A run that ended before it finished stays open too: the steps are how it got there.
  return isLive || incomplete || !!turn.partial;
}

/**
 * Answer audit display: the finish card, its "what could not be verified" block, the plan rows.
 *
 * The engine audits every final answer against the pages it really read (agent/answerAudit.ts)
 * and attaches the result to the finish history entry as `audit`:
 *   { verdict: 'verified' | 'partial' | 'unverified', opened: [{host, url}], notOpened: [host],
 *     notes: [{code, severity: 'lie' | 'gap' | 'soft', text}], sendBacks: number }
 * The panel only DISPLAYS that verdict. It never re-judges an answer, and it never turns a worse
 * verdict into a better one. Everything below is a pure string builder so it can be tested
 * without a DOM (tests/sidepanelAudit.test.js).
 *
 * Escaping: the notes are written by code, but the URLs and hosts come from pages on the open
 * web and the answer comes from the model, so every string goes through escapeHtml and none is
 * ever put into the page raw. A URL only becomes a link when it starts with http:// or https://.
 */
const PLAN_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'];
const AUDIT_VERDICTS = ['verified', 'partial', 'unverified'];
const NOTE_SEVERITY_RANK = { lie: 0, gap: 1, soft: 2 };
// Spoken label for the coloured dot in front of a note (colour alone must not carry the meaning).
const NOTE_SEVERITY_LABEL = { lie: 'Problem', gap: 'Gap', soft: 'Note' };

const AUDIT_SUBTITLE = {
  unverified: 'Some parts of this answer could not be checked against the pages ScoutFox read.',
  partial: 'Not every source was checked.'
};
const UNCONFIRMED_NOTICE = 'The model replied in plain text instead of finishing the task.';
// How many unchecked sources the subtitle of a partial answer names before it says "and N more".
const SUBTITLE_SOURCES = 3;

/**
 * The subtitle of a partial answer. It names the sources that were never opened, because that is
 * the one thing a reader wants to know at a glance ("Not every source was checked: shop-b.test.").
 * Returns HTML: the names come from the task text and from web pages, so each one is escaped here.
 * With no name to give it keeps the general sentence.
 */
function partialSubtitle(notOpened) {
  if (!notOpened.length) return AUDIT_SUBTITLE.partial;
  const names = notOpened.slice(0, SUBTITLE_SOURCES).map(escapeHtml).join(', ');
  const more = notOpened.length - SUBTITLE_SOURCES;
  return `Not every source was checked: ${names}${more > 0 ? ` and ${more} more` : ''}.`;
}

function hostOfUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

/**
 * Makes sure an `audit` from the history is safe to render: right types, no duplicates, notes
 * sorted worst first. Returns null when there is no audit object at all (the entry is then
 * rendered exactly as before the audit existed). An audit with a verdict this build does not know
 * is shown as 'unverified': a newer engine may add verdicts, and an unknown one must never be
 * shown as a green "Done".
 */
function normalizeAudit(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (v) => (Array.isArray(v) ? v : []);

  const seenPages = new Set();
  const opened = [];
  list(raw.opened).forEach((p) => {
    if (!p || typeof p !== 'object') return;
    const url = typeof p.url === 'string' ? p.url : '';
    const host = (typeof p.host === 'string' && p.host) || hostOfUrl(url);
    const key = url || host;
    if (!key || seenPages.has(key)) return;
    seenPages.add(key);
    opened.push({ host, url });
  });

  const notOpened = [...new Set(list(raw.notOpened).filter((h) => typeof h === 'string' && h).map(String))];

  const notes = list(raw.notes)
    .filter((n) => n && typeof n === 'object' && n.text != null && String(n.text) !== '')
    .map((n, i) => ({
      code: typeof n.code === 'string' ? n.code : '',
      severity: Object.prototype.hasOwnProperty.call(NOTE_SEVERITY_RANK, n.severity) ? n.severity : 'soft',
      text: String(n.text),
      order: i
    }))
    .sort((a, b) => NOTE_SEVERITY_RANK[a.severity] - NOTE_SEVERITY_RANK[b.severity] || a.order - b.order)
    .map(({ code, severity, text }) => ({ code, severity, text }));

  const sendBacks = Number.isFinite(raw.sendBacks) ? Math.max(0, Math.floor(raw.sendBacks)) : 0;

  return {
    verdict: AUDIT_VERDICTS.includes(raw.verdict) ? raw.verdict : 'unverified',
    opened,
    notOpened,
    notes,
    sendBacks
  };
}

/** A URL is only made clickable when it is plainly http(s). Anything else is shown as text. */
function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

function renderAuditPage(page) {
  const host = page.host ? `<span class="audit-host">${escapeHtml(page.host)}</span>` : '';
  let url = '';
  if (page.url) {
    url = isHttpUrl(page.url)
      ? `<a class="audit-url" href="${escapeHtml(page.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.url)}</a>`
      : `<span class="audit-url">${escapeHtml(page.url)}</span>`;
  }
  return `<li class="audit-page">${host}${url}</li>`;
}

function renderAuditNotes(notes) {
  return `<ul class="audit-notes">${notes.map((n) =>
    `<li class="audit-note" data-code="${escapeHtml(n.code)}"><span class="audit-dot ${n.severity}" role="img" aria-label="${NOTE_SEVERITY_LABEL[n.severity]}"></span><span>${escapeHtml(n.text)}</span></li>`
  ).join('')}</ul>`;
}

/**
 * The native <details> under (or above) the answer.
 *   mode 'attention' (unverified, partial): "What could not be verified" - the notes, the sources
 *        that were never opened, and the pages that were read.
 *   mode 'verified': a quiet "Checked against N pages" line that opens to the pages and soft notes.
 * Returns '' when there is nothing to open, and then a verified card still gets the plain line.
 */
function renderAuditDetails(audit, turnNo, mode) {
  const attention = mode === 'attention';
  const pageCount = audit.opened.length;
  const summaryText = attention
    ? 'What could not be verified'
    : `Checked against ${pageCount} page${pageCount === 1 ? '' : 's'}`;

  const sections = [];
  const label = (text) => `<div class="audit-label">${text}</div>`;
  if (!attention && pageCount) {
    sections.push(`<div>${label('Pages read')}<ul class="audit-pages">${audit.opened.map(renderAuditPage).join('')}</ul></div>`);
  }
  if (audit.notes.length) {
    sections.push(`<div>${attention ? '' : label('Notes')}${renderAuditNotes(audit.notes)}</div>`);
  }
  if (attention) {
    if (audit.notOpened.length) {
      sections.push(`<div>${label('Not opened')}<div class="audit-plain">${audit.notOpened.map(escapeHtml).join(', ')}</div></div>`);
    }
    sections.push(`<div>${label('Pages read')}${pageCount
      ? `<ul class="audit-pages">${audit.opened.map(renderAuditPage).join('')}</ul>`
      : '<div class="audit-plain">No pages were read.</div>'}</div>`);
  }
  if (audit.sendBacks > 0) {
    sections.push(`<div class="audit-meta">Sent back to the model ${audit.sendBacks} time${audit.sendBacks === 1 ? '' : 's'} before the final answer.</div>`);
  }

  const cls = `audit ${attention ? 'attention' : 'verified'}`;
  if (!sections.length) {
    // Nothing to open (a verified answer that read no page and has no notes): keep the line, drop the toggle.
    return attention ? '' : `<div class="${cls}"><div class="audit-line">${summaryText}</div></div>`;
  }
  const key = escapeHtml(String(turnNo));
  // An unverified answer shows what is wrong with it without a click, unless the reader closed it.
  const byDefault = attention && audit.verdict === 'unverified' && !closedAuditDetails.has(String(turnNo));
  const isOpen = openAuditDetails.has(String(turnNo)) || byDefault;
  return `<details class="${cls}" data-audit-key="${key}"${isOpen ? ' open' : ''}><summary class="audit-summary"><span class="audit-chev">${ICONS.chevron}</span><span>${summaryText}</span></summary><div class="audit-body">${sections.join('')}</div></details>`;
}

/**
 * The card of a finish that says how the run went (the finish tool's `outcome`). The title follows
 * the outcome, never whether a step failed on the way: a run can fail a step and still answer
 * (a blocked search, then the answer from another source), and a run can fail nothing and still
 * not do the task (a button that does nothing). A failed step is a quiet note under the title.
 */
const OUTCOME_CARD = {
  done: { title: 'Done', cls: '', icon: 'complete' },
  partial: { title: 'Partly done', cls: 'partial', icon: 'warning' },
  blocked: { title: 'Could not finish', cls: 'blocked', icon: 'warning' }
};

function failedStepsNote(count) {
  const n = Number(count) || 0;
  return n > 0 ? `${n} step${n === 1 ? '' : 's'} failed along the way.` : '';
}

/**
 * The finish card. Verdict decides the card:
 *   unverified -> danger card "Unconfirmed answer"     partial -> warning card "Partial answer"
 *   verified   -> today's green "Done" plus a quiet "Checked against N pages" line
 *   no audit   -> today's card, byte for byte ("Done", or "Unconfirmed answer" for a freeform reply)
 * The old `unconfirmed` flag (the model never called finish, ScoutFox inferred the end from a plain
 * reply) is a separate fact and stays visible next to a verdict: it turns a green or amber card
 * red, and it adds one line saying why. A verified-but-unconfirmed answer keeps the title
 * "Unconfirmed answer": its content was checked, but the model never said it was done.
 *
 * A step that failed is the third fact. A run whose click never reached the page and that said
 * so in the answer still did not do the task: a green "Done" next to "the click failed" is the
 * one thing a user must never be shown, because it is the green tick on a run that did nothing.
 */
function renderFinishCard(turn, findings = null) {
  if (turn.partial) return renderPartialCard(turn, findings);
  const audit = normalizeAudit(turn.audit);
  const unconfirmed = !!turn.answerUnconfirmed;
  // With an audit the card already says all of it (title, subtitle, the notes below): the stored answer keeps the
  // warning line and the notes section the engine wrote into it, for copying, but they are not shown a second time.
  const raw = audit ? withoutEngineNotes(turn.answer) : turn.answer;
  // The safety net for answers that are still a JSON object: the engine pulls the readable part
  // out before it stores the answer, but a session saved by an older build still holds the raw
  // JSON, and a wall of braces is not something to show a person. The engine's own answer is
  // left exactly as it is.
  const extracted = extractReadableAnswer(raw);
  const shown = extracted.text;
  // If the answer is a failure marker (MOCK-FAIL: ...), the task did not actually succeed even
  // though the model called finish. Show it as a failed answer, not as green "Done".
  const isFailedAnswer = /^MOCK-FAIL:/i.test(String(shown || ''));
  // A step of this turn failed. The run reported it and ended, so the card is a red one: the
  // user has to see that the task did not go through, not a green tick.
  const hadFailedStep = !!turn.failed;
  const body = `<div class="finish-body">${formatMarkdownText(shown)}</div>`;
  // The supporting material of a structured answer, in a section the reader opens. It is shown
  // only when there is something to show, and never in place of the answer.
  const evidenceText = extracted.evidence || turn.evidence || '';
  const evidenceHtml = evidenceText
    ? `<details class="audit verified answer-evidence"><summary class="audit-summary"><span class="audit-chev">${ICONS.chevron}</span><span>Evidence</span></summary><div class="audit-body"><div class="audit-plain">${escapeHtml(evidenceText)}</div></div></details>`
    : '';

  const allFindings = (findings && findings.length > 0) ? findings : (turn.findings || (turn.table && turn.table.rows ? turn.table.rows : []));
  const hasEmbeddedTable = hasMarkdownBlocks(shown) && String(shown).includes('|');
  const findingsHtml = (allFindings && allFindings.length > 0 && !hasEmbeddedTable) ? renderProvenanceFindingsTable(allFindings) : '';

  if (!audit && turn.outcome && !isFailedAnswer) {
    const card = OUTCOME_CARD[turn.outcome];
    const note = failedStepsNote(turn.failedSteps);
    const classes = ['finish-card', card.cls, note ? 'has-sub' : ''].filter(Boolean).join(' ');
    const subHtml = note ? `<div class="finish-subs"><div class="finish-sub">${escapeHtml(note)}</div></div>` : '';
    return `<div class="${classes}"><div class="finish-title">${ICONS[card.icon]} ${card.title}</div>${subHtml}${body}${evidenceHtml}${findingsHtml}</div>`;
  }

  if (!audit) {
    if (isFailedAnswer || hadFailedStep) {
      return `<div class="finish-card failed"><div class="finish-title">${ICONS.warning} Failed</div>${body}${evidenceHtml}${findingsHtml}</div>`;
    }
    return unconfirmed
      ? `<div class="finish-card unconfirmed"><div class="finish-title">${ICONS.warning} Unconfirmed answer</div>${body}${evidenceHtml}${findingsHtml}</div>`
      : `<div class="finish-card"><div class="finish-title">${ICONS.complete} Done</div>${body}${evidenceHtml}${findingsHtml}</div>`;
  }

  let title;
  let icon;
  const classes = ['finish-card'];
  const subs = [];
  if (audit.verdict === 'unverified') {
    title = 'Unverified answer'; icon = ICONS.warning;
    classes.push('unverified');
    subs.push(AUDIT_SUBTITLE.unverified);
  } else if (audit.verdict === 'partial') {
    title = 'Partial answer'; icon = ICONS.warning;
    classes.push('partial');
    subs.push(partialSubtitle(audit.notOpened));
  } else if (hadFailedStep) {
    // A step failed, so the task did not go through. A verified answer is a claim about the
    // answer, not about the run: the run still failed, and the card says so.
    title = 'Failed'; icon = ICONS.warning;
    classes.push('failed');
  } else if (unconfirmed) {
    title = 'Unconfirmed answer'; icon = ICONS.warning;
  } else {
    title = 'Done'; icon = ICONS.complete;
  }
  if (unconfirmed) {
    classes.push('unconfirmed');
    subs.push(UNCONFIRMED_NOTICE);
  }
  if (subs.length) classes.push('has-sub');

  const subHtml = subs.length
    ? `<div class="finish-subs">${subs.map((s) => `<div class="finish-sub">${s}</div>`).join('')}</div>`
    : '';
  const attention = audit.verdict !== 'verified';
  const details = renderAuditDetails(audit, turn.turn, attention ? 'attention' : 'verified');
  // The caveat goes above a doubtful answer, so it is seen before the answer is read, and below a
  // checked one, where it is only a receipt.
  return `<div class="${classes.join(' ')}"><div class="finish-title">${icon} ${title}</div>${subHtml}${attention ? details : ''}${body}${evidenceHtml}${findingsHtml}${attention ? '' : details}</div>`;
}

/**
 * The card of a run that ended before it finished (a partial_result entry). It is never "Done" and
 * never has the complete icon: the title says how the run ended, the card has the amber edge of a
 * partial answer, and the subtitle says why. The engine writes the why as the first paragraph of
 * the answer ("Task was stopped by user.", "Stopped early: ...", "Site domain x is blocked ...");
 * it moves to the subtitle so it is not said twice. When that paragraph is the table, or a long
 * text, the subtitle is a fixed sentence for the reason and the whole answer stays in the body.
 */
const PARTIAL_TITLE = {
  stopped: 'Stopped by you',
  max_steps: 'Stopped at the step limit',
  interrupted: 'Interrupted'
};
const PARTIAL_SUBTITLE = {
  stopped: 'The run was stopped before it finished.',
  max_steps: 'The run used all its steps before it finished.',
  partial: 'A site could not be read, so not every source was checked.',
  stopped_early: 'The run stopped before every planned site was checked.',
  model_unusable: 'The model replies could not be used, so the run stopped early.',
  interrupted: 'Chrome restarted the background worker, so the run could not go on.'
};
const PARTIAL_SUBTITLE_FALLBACK = 'The run ended before it finished.';
// A first paragraph longer than this, or with a line break, is an answer, not a reason line.
const PARTIAL_REASON_MAX = 200;

function splitPartialReason(answer) {
  const text = String(answer == null ? '' : answer).trim();
  const at = text.indexOf('\n\n');
  const first = (at >= 0 ? text.slice(0, at) : text).trim();
  const looksLikeReason = first && !first.includes('\n') && !first.startsWith('|') && first.length <= PARTIAL_REASON_MAX;
  return looksLikeReason
    ? { reason: first, rest: at >= 0 ? text.slice(at + 2).trim() : '' }
    : { reason: '', rest: text };
}

function renderPartialCard(turn, findings = null) {
  const audit = normalizeAudit(turn.audit);
  const reasonCode = turn.partialReason || '';
  const title = PARTIAL_TITLE[reasonCode] || 'Not finished';
  const { reason, rest } = splitPartialReason(turn.answer);
  const subtitle = reason ? escapeHtml(reason) : (PARTIAL_SUBTITLE[reasonCode] || PARTIAL_SUBTITLE_FALLBACK);
  const shown = audit ? withoutEngineNotes(rest) : rest;
  const body = shown ? `<div class="finish-body">${formatMarkdownText(shown)}</div>` : '';

  const allFindings = (findings && findings.length > 0) ? findings : (turn.findings || (turn.table && turn.table.rows ? turn.table.rows : []));
  const hasEmbeddedTable = hasMarkdownBlocks(shown) && String(shown).includes('|');
  const findingsHtml = (allFindings && allFindings.length > 0 && !hasEmbeddedTable) ? renderProvenanceFindingsTable(allFindings) : '';

  // An unverified audit turns the edge red, as on any other card (the .unverified rule comes after .partial).
  const classes = ['finish-card', 'partial', 'has-sub'];
  if (audit && audit.verdict === 'unverified') classes.push('unverified');
  const details = audit ? renderAuditDetails(audit, turn.turn, audit.verdict === 'verified' ? 'verified' : 'attention') : '';
  return `<div class="${classes.join(' ')}"><div class="finish-title">${ICONS.warning} ${title}</div><div class="finish-subs"><div class="finish-sub">${subtitle}</div></div>${details}${body}${findingsHtml}</div>`;
}

// What the engine writes into an annotated answer (annotateAnswer in agent/answerAudit.ts): one warning line on top, and a
// section at the end. Both repeat what the finish card shows from the audit.
const ENGINE_BANNERS = [
  'WARNING - UNVERIFIED ANSWER: parts of this answer are not backed by any page ScoutFox read. See the notes at the end.',
  'PARTIAL ANSWER: not every source was checked. See the notes at the end.'
];
const ENGINE_SECTION = '\n\n---\nVerification notes (written by ScoutFox, not by the model)';

function withoutEngineNotes(answer) {
  let text = String(answer == null ? '' : answer);
  const at = text.indexOf(ENGINE_SECTION);
  if (at >= 0) text = text.slice(0, at);
  const lead = text.replace(/^\s+/, '');
  const banner = ENGINE_BANNERS.find((b) => lead.startsWith(b));
  return banner ? lead.slice(banner.length).replace(/^\s+/, '') : text;
}

/**
 * Why the run is paused, in one line, for a pause that has no card of its own: the question, confirmation, challenge and
 * budget holds each draw their own card (renderTurns), so this says nothing for them. '' when the run is not paused.
 * `pauseReason` comes from the runner: 'user' (the Pause button), 'llm_failure' (the model request failed, the error is in
 * the timeline), 'worker_restart' (the browser restarted the extension's worker, or a run that was cut off with no Pause pending); anything else is unknown, said honestly.
 */
function pauseReasonText(state) {
  if (!state || state.status !== 'paused') return '';
  if (state.pendingQuestion || state.pendingApproval || state.pendingConfirm || state.pendingChallengeHelp || state.pendingContinueBudget) return '';
  switch (state.pauseReason) {
    case 'user': return 'Paused by you. Press Resume to continue.';
    case 'llm_failure': return 'Paused: the model request failed (see the error above). Press Resume to try again.';
    case 'worker_restart': return 'Paused: the extension restarted. Press Resume to continue.';
    default: return 'Paused. Press Resume to continue.';
  }
}

/** Plan progress. Only 'completed' counts as done: a skipped step is not progress. */
function planCounts(planSteps) {
  const steps = Array.isArray(planSteps) ? planSteps : [];
  return {
    done: steps.filter((s) => s && s.status === 'completed').length,
    skipped: steps.filter((s) => s && s.status === 'skipped').length,
    total: steps.length
  };
}

/**
 * The plan checklist rows. A 'skipped' step (its source was never read) gets its own icon and a
 * " - not checked" suffix and is NOT struck through: struck through means done, and it is not.
 */
function renderPlanRows(planSteps) {
  return `<div class="act-plan">${(planSteps || []).map((st) => {
    const status = PLAN_STATUSES.includes(st.status) ? st.status : 'pending';
    if (status === 'skipped') {
      return `<div class="act-plan-row skipped"><span>${ICONS.skip}</span><span>${escapeHtml(st.text)}<span class="plan-skip-note"> - not checked</span></span></div>`;
    }
    const ic = status === 'completed' ? ICONS.check : status === 'in_progress' ? ICONS.dot : ICONS.circle;
    return `<div class="act-plan-row ${status}"><span>${ic}</span><span>${escapeHtml(st.text)}</span></div>`;
  }).join('')}</div>`;
}

/**
 * The manual-approve hold: the plan the model proposed, with the two decisions. Shown only
 * while state.pendingApproval is set (manual mode); auto mode never renders it.
 */
function renderPlanApprovalCard(pendingApproval) {
  const steps = Array.isArray(pendingApproval?.plan) ? pendingApproval.plan : [];
  if (steps.length === 0) return '';
  return `<div class="plan-approval-card">
    <div class="plan-approval-head">
      <span class="plan-approval-icon">${ICONS.layers}</span>
      <div class="plan-approval-copy">
        <div class="plan-approval-title">Here is my plan</div>
        <div class="plan-approval-lead">Approve it and ScoutFox will start working.</div>
      </div>
    </div>
    <ol class="plan-approval-steps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <div class="plan-approval-actions">
      <button type="button" class="btn btn-secondary btn-xs" data-plan-decision="reject">Cancel</button>
      <button type="button" class="btn btn-primary btn-xs" data-plan-decision="approve">Approve plan</button>
    </div>
  </div>`;
}

function renderTurns(history, status, currentPhase, pendingQuestion, pendingApproval = null, pendingConfirm = null, pendingChallengeHelp = null, pendingContinueBudget = null, findings = null, effortProfile = null, planSteps = null) {
  const turns = buildTurns(history);
  const busy = status === 'running' || status === 'paused';
  const isErrorEnded = status === 'error' || status === 'stopped';
  // While the plan card is up it IS the plan: the checklist under it would list the same steps
  // twice and count "step 1 of N" for a run that has not started.
  const progressPlan = pendingApproval ? null : planSteps;

  if (turns.length === 0 && (pendingApproval || pendingConfirm || pendingChallengeHelp || pendingContinueBudget)) {
    turns.push({ turn: 1, goal: null, entries: [], answer: null, audit: null, failed: false, timestamp: null, isNewRun: false });
  }

  // If the run ended with an error/stopped but no finish card was produced, add a synthetic one
  // to the last turn: "Failed" with the error when there is one, else the "Stopped by you" card.
  if (isErrorEnded && turns.length > 0) {
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn.answer && !lastTurn.partial) {
      const fault = lastTurn.entries.filter((e) => e.kind === 'fault').pop();
      if (status === 'stopped' && !fault) {
        lastTurn.answer = PARTIAL_SUBTITLE.stopped;
        lastTurn.partial = true;
        lastTurn.partialReason = 'stopped';
      } else {
        lastTurn.answer = fault
          ? `The run ended with an error: ${fault.content}.`
          : 'The run ended with an error.';
        lastTurn.failed = true;
      }
    }
  }

  return turns.map((turn, ti) => {
    const isLast = ti === turns.length - 1;
    const isLive = busy && isLast;
    const count = turn.entries.filter(e => e.kind === 'action').length;
    // "Did not finish" means no answer was produced — not merely that one action failed.
    const incomplete = !isLive && !turn.answer && turn.entries.length > 0;
    const open = isTurnExpanded(turn, isLive, incomplete);

    // Header doubles as the progress indicator.
    let headline;
    if (isLive) {
      // Only 'completed' is progress; a skipped step must never move the counter.
      const { done, total } = planCounts(progressPlan);
      headline = total
        ? `Working · step ${Math.min(done + 1, total)} of ${total} · ${count} action${count === 1 ? '' : 's'}`
        : `Working · ${count} action${count === 1 ? '' : 's'}`;
    } else {
      headline = `${count} action${count === 1 ? '' : 's'}${incomplete ? ' · did not finish' : ''}`;
    }

    const rows = turn.entries.map((e) => {
      if (e.kind === 'fault') {
        return `<div class="act-row fault"><span class="act-ico">${ICONS.warning}</span><span class="act-text">${escapeHtml(e.content)}</span></div>`;
      }
      if (e.kind === 'answer') {
        return `<div class="act-row answer"><span class="act-ico">${ICONS.keyboard}</span><span class="act-text">You answered: <em>${escapeHtml(e.content)}</em></span></div>`;
      }
      const d = describeAction(e.action, e.outcome);
      const key = `${turn.turn}:${e.idx}`;
      const shown = expandedRows.has(key);
      const refused = !!(e.outcome && e.outcome.finishRefused);
      // A refused finish is not a failed action (no red cross): it is the engine's answer check saying "not yet".
      const bad = !!(e.outcome && e.outcome.success === false) && !refused;
      // Only a live turn pulses: a turn that ended (and the finish that ended it) has no result coming.
      const pending = isLive && !e.outcome && !(e.action.action === 'finish' && turn.answer);
      const why = e.thought
        ? `<div class="act-why" ${shown ? '' : 'hidden'}>${escapeHtml(e.thought)}</div>`
        : '';
      const state = bad ? `<span class="act-state bad">${ICONS.cross}</span>`
                  : pending ? '<span class="act-state live"></span>'
                  : '';
      const detail = d.detail ? `<span class="act-detail">${escapeHtml(d.detail)}</span>` : '';
      // A step that took a picture gets a slot for it. The slot holds no <img> in the rendered
      // HTML: after the innerHTML write, the already-decoded element is moved in (see
      // attachShotSlots), so a re-render costs no decode and the picture does not flicker.
      const shot = e.outcome && e.outcome.imageId
        ? `<div class="act-shot-slot" data-shot="${escapeHtml(String(e.outcome.imageId))}" data-w="${escapeHtml(String(e.outcome.imageWidth || 0))}" data-h="${escapeHtml(String(e.outcome.imageHeight || 0))}"></div>`
        : '';
      return `<div class="act-item">
          <div class="act-row${bad ? ' bad' : ''}${refused ? ' refused' : ''}${e.thought ? ' has-why' : ''}" data-row="${key}" ${e.thought ? 'role="button" tabindex="0"' : ''}>
            <span class="act-ico">${d.icon}</span>
            <span class="act-text">${d.text}${detail}</span>
            ${state}
          </div>${why}${shot}
        </div>`;
    }).join('');

    // The checklist is a live-progress view, so a finished turn hides it - except the last turn
    // when a step was skipped. That is the one fact about a finished run the plan still has to
    // say ("idealo.de - not checked"). The plan belongs to the current run only (the background
    // replaces it per run), so no earlier turn ever shows it.
    const showPlan = Array.isArray(progressPlan) && progressPlan.length > 0
      && (isLive || (isLast && planCounts(progressPlan).skipped > 0));
    const planDetail = showPlan ? renderPlanRows(progressPlan) : '';

    const phase = (isLive && currentPhase)
      ? `<div class="act-phase">${escapeHtml(currentPhase)}</div>`
      : '';

    // The agent called ask_user and is waiting - give the user an actual way to answer, right
    // where the question was asked, instead of leaving them stuck at a generic Resume button
    // with no way to say anything back.
    const answerPrompt = (isLive && status === 'paused' && pendingQuestion)
      ? `<div class="ask-user-prompt">
          <div class="ask-user-question">${ICONS.ask} ${escapeHtml(pendingQuestion)}</div>
          <div class="ask-user-input-row">
            <input type="text" class="ask-user-input form-input" placeholder="Type your answer..." />
            <button class="ask-user-send btn btn-primary btn-xs" type="button">Send</button>
          </div>
        </div>`
      : '';

    const confirmPrompt = (isLive && status === 'paused' && pendingConfirm)
      ? renderActionConfirmationCard(pendingConfirm)
      : '';

    // Like the other holds, the plan card belongs to the live turn only: under every turn it
    // would repeat its Approve/Cancel buttons for runs that are long over.
    const planPrompt = (isLive && pendingApproval)
      ? renderPlanApprovalCard(pendingApproval)
      : '';

    const challengePrompt = (isLive && status === 'paused' && pendingChallengeHelp)
      ? renderChallengeHelpCard(pendingChallengeHelp)
      : '';

    const budgetPrompt = (isLive && status === 'paused' && pendingContinueBudget)
      ? renderContinueBudgetCard(pendingContinueBudget)
      : '';

    const sessionDivider = (turn.turn > 1 || turn.isNewRun)
      ? `<div class="session-divider">
          <span class="session-tag">⚡ Run #${turn.turn}</span>
          ${turn.timestamp ? `<span class="session-time">${escapeHtml(turn.timestamp)}</span>` : ''}
        </div>`
      : '';

    return `<div class="turn">
      ${sessionDivider}
      ${turn.goal ? `<div class="user-goal-card"><span class="goal-label">Goal</span>${escapeHtml(turn.goal)}</div>` : ''}
      ${planPrompt}
      ${confirmPrompt ? confirmPrompt : ''}
      ${challengePrompt ? challengePrompt : ''}
      ${budgetPrompt ? budgetPrompt : ''}
      ${count || turn.entries.length || planDetail ? `<div class="act-group${open ? ' open' : ''}">
        <button class="act-head" data-turn="${turn.turn}" aria-expanded="${open}">
          <span class="act-chev">${ICONS.chevron}</span>
          <span class="act-head-text">${headline}</span>
        </button>
        <div class="act-body" ${open ? '' : 'hidden'}>${planDetail}${rows}${phase}${answerPrompt}</div>
      </div>` : ''}
      ${turn.answer ? renderFinishCard(turn, isLast ? findings : null) : ''}
    </div>`;
  }).join('');
}

/**
 * One delegated listener for the whole timeline. Bound once at startup, so it survives the
 * innerHTML rewrites that renderState performs on every state broadcast.
 */
function initTimelineInteraction() {
  const timeline = document.getElementById('timeline');
  if (!timeline) return;

  const toggle = (target) => {
    const head = target.closest('.act-head');
    if (head) {
      const turn = Number(head.getAttribute('data-turn'));
      const group = head.parentElement;
      const nowOpen = !group.classList.contains('open');
      turnExpandOverride.set(turn, nowOpen);
      group.classList.toggle('open', nowOpen);
      head.setAttribute('aria-expanded', String(nowOpen));
      const body = group.querySelector('.act-body');
      if (body) body.hidden = !nowOpen;
      return true;
    }
    const row = target.closest('.act-row.has-why');
    if (row) {
      const key = row.getAttribute('data-row');
      const why = row.parentElement.querySelector('.act-why');
      if (!why) return true;
      const show = why.hidden;
      why.hidden = !show;
      if (show) expandedRows.add(key); else expandedRows.delete(key);
      return true;
    }
    return false;
  };

  const sendAnswer = (promptEl) => {
    const input = promptEl.querySelector('.ask-user-input');
    const btn = promptEl.querySelector('.ask-user-send');
    const answer = (input && input.value || '').trim();
    if (!answer) { if (input) input.focus(); return; }
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    sendBgMessage({ action: 'ANSWER_QUESTION', payload: { answer } }, (res) => {
      if (chrome.runtime.lastError || (res && res.success === false)) {
        const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : res.error;
        appendLocalLog('ERROR', 'Sidepanel', `[ANSWER_FAILED] ${errMsg}`);
        showTaskError(errMsg || 'Could not send your answer to the agent.');
        if (input) input.disabled = false;
        if (btn) btn.disabled = false;
      }
      // On success the next STATE_UPDATE broadcast replaces this prompt with the recorded
      // answer row - nothing further to do here.
    });
  };

  timeline.addEventListener('click', (e) => {
    const sendBtn = e.target.closest('.ask-user-send');
    if (sendBtn) { sendAnswer(sendBtn.closest('.ask-user-prompt')); return; }

    // The manual-approve plan card: Approve releases the hold, Cancel ends the run.
    const planBtn = e.target.closest('[data-plan-decision]');
    if (planBtn) {
      const decision = planBtn.getAttribute('data-plan-decision');
      const card = planBtn.closest('.plan-approval-card');
      if (card) card.querySelectorAll('[data-plan-decision]').forEach((b) => { b.disabled = true; });
      sendBgMessage({ action: 'APPROVE_PLAN', payload: { decision } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          if (card) card.querySelectorAll('[data-plan-decision]').forEach((b) => { b.disabled = false; });
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to send the plan decision.');
        }
      });
      return;
    }

    // The add-domain card of a plan revision: Allow runs the new site, Deny continues without it.
    const allowBtn = e.target.closest('.btn-confirm-allow');
    if (allowBtn) {
      allowBtn.disabled = true;
      const card = allowBtn.closest('.action-confirmation-card');
      const rememberChk = card ? card.querySelector('#chkRememberSite') : null;
      const remember = rememberChk && rememberChk.checked ? 'site' : undefined;
      sendBgMessage({ action: 'CONFIRM_ACTION', payload: { decision: 'approve', remember } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          allowBtn.disabled = false;
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to confirm action.');
        }
      });
      return;
    }

    const denyBtn = e.target.closest('.btn-confirm-deny');
    if (denyBtn) {
      denyBtn.disabled = true;
      sendBgMessage({ action: 'CONFIRM_ACTION', payload: { decision: 'reject' } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          denyBtn.disabled = false;
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to reject action.');
        }
      });
      return;
    }

    const solvedBtn = e.target.closest('.btn-challenge-solved');
    if (solvedBtn) {
      solvedBtn.disabled = true;
      sendBgMessage({ action: 'RESOLVE_CHALLENGE', payload: { action: 'resolved' } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          solvedBtn.disabled = false;
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to resolve challenge.');
        }
      });
      return;
    }

    const skipChallengeBtn = e.target.closest('.btn-challenge-skip');
    if (skipChallengeBtn) {
      skipChallengeBtn.disabled = true;
      sendBgMessage({ action: 'RESOLVE_CHALLENGE', payload: { action: 'skip' } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          skipChallengeBtn.disabled = false;
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to skip challenge.');
        }
      });
      return;
    }

    const continueBtn = e.target.closest('.btn-budget-continue');
    if (continueBtn) {
      continueBtn.disabled = true;
      const additionalSteps = parseInt(continueBtn.getAttribute('data-reserve'), 10) || 10;
      sendBgMessage({ action: 'CONTINUE_BUDGET', payload: { action: 'continue', additionalSteps } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          continueBtn.disabled = false;
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to continue budget.');
        }
      });
      return;
    }

    const finishBudgetBtn = e.target.closest('.btn-budget-finish');
    if (finishBudgetBtn) {
      finishBudgetBtn.disabled = true;
      sendBgMessage({ action: 'CONTINUE_BUDGET', payload: { action: 'finish' } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          finishBudgetBtn.disabled = false;
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to finish site.');
        }
      });
      return;
    }

    const copyBtn = e.target.closest('.btn-copy-findings-table');
    if (copyBtn) {
      const container = copyBtn.closest('.provenance-findings-container');
      const table = container ? container.querySelector('.provenance-table') : null;
      if (table) {
        let md = '| Source | Field | Value | Status |\n| --- | --- | --- | --- |\n';
        const rows = table.querySelectorAll('tbody tr.findings-table-row');
        rows.forEach(r => {
          const cells = Array.from(r.querySelectorAll('td')).map(td => td.textContent.trim().replace(/\|/g, '\\|'));
          if (cells.length >= 4) {
            md += `| ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cells[3]} |\n`;
          }
        });
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(md).then(() => {
            showToast('Findings copied to clipboard!');
          }).catch(() => {
            showToast('Failed to copy findings.');
          });
        }
      }
      return;
    }

    const findingRow = e.target.closest('.findings-table-row');
    if (findingRow && !e.target.closest('a')) {
      const rowId = findingRow.getAttribute('data-row-id');
      const detailRow = document.getElementById(`finding-detail-${rowId}`);
      if (detailRow) {
        const isVisible = detailRow.style.display !== 'none';
        detailRow.style.display = isVisible ? 'none' : 'table-row';
      }
      return;
    }

    toggle(e.target);
  });
  // A <details> toggle event does not bubble, so listen in the capture phase. The open state is
  // kept in openAuditDetails because renderState rewrites the timeline on every broadcast.
  timeline.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || !d.matches || !d.matches('details.audit')) return;
    const key = d.getAttribute('data-audit-key');
    if (d.open) {
      openAuditDetails.add(key);
      closedAuditDetails.delete(key);
    } else {
      openAuditDetails.delete(key);
      closedAuditDetails.add(key);
    }
  }, true);
  timeline.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('ask-user-input')) {
      e.preventDefault();
      sendAnswer(e.target.closest('.ask-user-prompt'));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (toggle(e.target)) e.preventDefault();
    }
  });
}

/** Whether the log list is scrolled to (near) its end, so a new entry may keep it there. */
function logsAtBottom(logOutput) {
  return logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 40;
}

const LOGS_WAITING_HTML = '<div class="subtext-hint log-empty">Nothing logged yet. Start a task and every model call and step appears here.</div>';

/** The whole Logs tab, for a filter change or a resync. Open trees stay open (logTreeState). */
function renderFilteredLogs() {
  const logOutput = document.getElementById('logOutput');
  if (!logOutput) return;
  const stick = logsAtBottom(logOutput);
  const filtered = (rawLogsCache || []).filter((log) => logMatchesFilter(log, currentActiveLogFilter));
  if (filtered.length === 0) {
    logOutput.innerHTML = rawLogsCache && rawLogsCache.length
      ? '<div class="subtext-hint log-empty">No entries for this filter yet.</div>'
      : LOGS_WAITING_HTML;
    return;
  }
  logOutput.innerHTML = filtered.map((log) => logEntryHtml(log, { state: logTreeState })).join('');
  if (stick) logOutput.scrollTop = logOutput.scrollHeight;
}

/**
 * One live entry: kept, and appended to the view when the filter shows it. Appending (not a full
 * re-render) keeps open trees open and does not move a reader who scrolled up.
 */
function addLogEntry(entry) {
  if (!entry) return;
  rawLogsCache.push(entry);
  if (rawLogsCache.length > MAX_PANEL_LOGS) rawLogsCache.shift();
  const logOutput = document.getElementById('logOutput');
  if (!logOutput || !logMatchesFilter(entry, currentActiveLogFilter)) return;
  const stick = logsAtBottom(logOutput);
  if (!logOutput.querySelector('.log-entry')) logOutput.innerHTML = '';
  logOutput.insertAdjacentHTML('beforeend', logEntryHtml(entry, { state: logTreeState }));
  while (logOutput.children.length > MAX_PANEL_LOGS) logOutput.firstElementChild.remove();
  if (stick) logOutput.scrollTop = logOutput.scrollHeight;
}

/** The clicks of the Logs tab: open and close a tree node, show a long string, copy an entry. */
function initLogInteractions() {
  const logOutput = document.getElementById('logOutput');
  if (!logOutput) return;
  logOutput.addEventListener('click', (event) => {
    const toggle = event.target.closest('.jt-toggle');
    if (toggle) {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      const children = toggle.nextElementSibling;
      if (children) children.hidden = !open;
      const entryId = toggle.closest('.jt')?.getAttribute('data-entry') || '';
      logTreeState.set(treeStateKey(entryId, toggle.getAttribute('data-path') || ''), open);
      return;
    }
    const more = event.target.closest('.jt-more');
    if (more) {
      const open = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', String(open));
      const full = more.previousElementSibling;
      const shortText = full?.previousElementSibling;
      if (full) full.hidden = !open;
      if (shortText) shortText.hidden = open;
      more.textContent = open ? 'show less' : (more.getAttribute('data-label') || 'show all');
      return;
    }
    const copy = event.target.closest('.log-copy');
    if (copy) {
      const log = rawLogsCache.find((entry) => String(entry.id) === copy.getAttribute('data-id'));
      const details = log ? parseLogData(log.data) : null;
      if (details === null) return;
      navigator.clipboard.writeText(typeof details === 'string' ? details : JSON.stringify(details, null, 2)).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1500);
      }).catch(() => {});
    }
  });
}

/**
 * The model's answer as HTML: text with a little markdown on top.
 *
 * Two renderers live behind this one function.
 *   legacy - **bold** and "- item" bullets on pre-wrapped text. It is what the panel always did and
 *            it is still what an answer gets when it has no heading and no table, byte for byte
 *            (tests/sidepanelMarkdown.test.js holds a copy of the old function as an oracle).
 *   blocks - used only when the answer has an ATX heading ("## Prices found") or a pipe table.
 *            Without it those showed as raw "##" and as rows of "|", which a sans-serif font makes
 *            look like a capital I. It renders headings, pipe tables, bullet and numbered lists with
 *            a hanging indent (a wrapped line lines up under its own text, not under the bullet) and
 *            plain paragraphs.
 *
 * Safety, the rule for both: every character of model text goes through escapeHtml BEFORE any
 * markup exists, and every tag and attribute in the output is written here, from constants. The
 * only text that reaches a class name is a fixed alignment letter or a heading level. Links are
 * not rendered at all (the legacy renderer never did, and an answer without headings must not
 * change), so a "[x](javascript:...)" or a bare URL is just text.
 *
 * Cost: one pass over the lines, and every scan below is linear. A 500-row table and a 50 000
 * character line render in a few milliseconds.
 */
function formatMarkdownText(text) {
  if (!text) return '';
  const source = String(text);
  const blocks = parseMarkdownBlocks(source);
  return blocks ? renderMarkdownBlocks(blocks) : legacyMarkdown(source);
}

/** True when the answer has a heading or a table, that is, when the blocks renderer takes over. */
function hasMarkdownBlocks(text) {
  return !!text && parseMarkdownBlocks(String(text)) !== null;
}

// ---- legacy renderer -------------------------------------------------------------------------

/**
 * An inline code span: one backtick, text on one line, one backtick. A double or triple backtick
 * (a fence) is not one, so ```x``` stays as it was written. It runs on ESCAPED text, so the span's
 * content is already safe, and it is never bolded: `**x**` shows the stars.
 */
const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;

const markdownBold = (escaped) => escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

/** Escaped text with its `code` spans rendered, and `rest` applied to the text between them. */
function withCodeSpans(escaped, rest) {
  let out = '';
  let at = 0;
  for (const match of escaped.matchAll(INLINE_CODE)) {
    out += rest(escaped.slice(at, match.index)) + `<code class="md-code">${match[1]}</code>`;
    at = match.index + match[0].length;
  }
  return out + rest(escaped.slice(at));
}

/** Escape first, then `code` spans and **bold** around them. Both renderers build their inline text with this. */
function markdownInline(text) {
  return withCodeSpans(escapeHtml(text), markdownBold);
}

function legacyMarkdown(text) {
  return legacyBullets(markdownInline(text));
}

const WHITESPACE_RUN = /\s*/y;
const isLineTerminator = (code) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

/**
 * str.replace(/^[\s]*[-*]\s+(.*)$/gm, '• $1'), the line the panel always had, without its cost.
 * That regex is quadratic on a long run of blank lines (every line start of the run scans the rest
 * of the run again: 50 000 newlines took almost 3 seconds). Same matches, same quirks - the match
 * may start at a blank line and eat it, and \s+ may span lines - found in one pass: when an
 * attempt at a line start fails, every later line start inside the same whitespace run fails the
 * same way, so the scan jumps past that run. tests/sidepanelMarkdown.test.js checks it against
 * the regex on a large random corpus.
 */
function legacyBullets(str) {
  const n = str.length;
  let out = '';
  let copied = 0;
  let at = 0;
  while (at <= n) {
    WHITESPACE_RUN.lastIndex = at;
    WHITESPACE_RUN.test(str);
    const afterRun = WHITESPACE_RUN.lastIndex;
    const mark = str.charCodeAt(afterRun);
    let scanFrom = afterRun;
    if (mark === 45 || mark === 42) {
      WHITESPACE_RUN.lastIndex = afterRun + 1;
      WHITESPACE_RUN.test(str);
      const textStart = WHITESPACE_RUN.lastIndex;
      if (textStart > afterRun + 1) {
        let end = textStart;
        while (end < n && !isLineTerminator(str.charCodeAt(end))) end++;
        out += str.slice(copied, at) + '• ' + str.slice(textStart, end);
        copied = end;
        scanFrom = end;
      }
    }
    // Next candidate: the line start after the first line terminator at or beyond scanFrom.
    let next = scanFrom;
    while (next < n && !isLineTerminator(str.charCodeAt(next))) next++;
    if (next >= n) break;
    at = next + 1;
  }
  return out + str.slice(copied);
}

// ---- blocks renderer -------------------------------------------------------------------------

// A table wider than this is not a table: it stays text. It bounds the DOM a hostile row can make.
const MARKDOWN_MAX_COLUMNS = 40;
// A cell this short is kept on one line. Without it the table layout squeezes a narrow column by
// breaking "shop-a.test" after its hyphen and "1.389,00 EUR" at its space, and the long column next
// to it keeps the room. A longer cell wraps at its spaces.
const MARKDOWN_SHORT_CELL = 16;
const MARKDOWN_MAX_LIST_DEPTH = 3;
const isSpaceCode = (code) => code === 32 || code === 9;

/** "## Title" -> { level: 2, text: 'Title' }. Up to three spaces of indent, 1 to 6 hashes, a space, a title. */
function matchHeading(line) {
  let at = 0;
  while (at < 3 && line.charCodeAt(at) === 32) at++;
  let level = 0;
  while (level < 7 && line.charCodeAt(at + level) === 35) level++;
  if (level < 1 || level > 6 || !isSpaceCode(line.charCodeAt(at + level))) return null;
  let title = line.slice(at + level).trim();
  // An optional closing run of hashes ("## Title ##") belongs to the syntax, not to the title.
  let end = title.length;
  while (end > 0 && title.charCodeAt(end - 1) === 35) end--;
  if (end < title.length && (end === 0 || isSpaceCode(title.charCodeAt(end - 1)))) title = title.slice(0, end).trim();
  return title ? { level, text: title } : null;
}

/** "  - item", "* item", "• item", "3. item" -> { depth, ordered, marker, number, text }. The marker needs a space and the item a text. */
function matchListItem(line) {
  let at = 0;
  let indent = 0;
  for (; at < line.length; at++) {
    const code = line.charCodeAt(at);
    if (code === 32) indent++;
    else if (code === 9) indent += 4;
    else break;
  }
  const first = line.charCodeAt(at);
  let marker = '';
  let ordered = false;
  let number = 0;
  let end = at;
  if (first === 45 || first === 42 || first === 8226) {
    marker = '•';
    end = at + 1;
  } else if (first >= 48 && first <= 57) {
    let digits = at;
    while (digits < line.length && digits - at < 9 && line.charCodeAt(digits) >= 48 && line.charCodeAt(digits) <= 57) digits++;
    const close = line.charCodeAt(digits);
    if (close === 46 || close === 41) {
      marker = line.slice(at, digits + 1);
      ordered = true;
      number = Number(line.slice(at, digits));
      end = digits + 1;
    }
  }
  if (!marker || !isSpaceCode(line.charCodeAt(end))) return null;
  const text = line.slice(end).trim();
  if (!text) return null;
  return { depth: Math.min(MARKDOWN_MAX_LIST_DEPTH, Math.floor(indent / 2)), ordered, marker, number, text };
}

/** Does the line hold a pipe that is not written "\|"? */
function hasUnescapedPipe(line) {
  let from = 0;
  for (;;) {
    const at = line.indexOf('|', from);
    if (at < 0) return false;
    if (at === 0 || line.charCodeAt(at - 1) !== 92) return true;
    from = at + 1;
  }
}

/**
 * The cells of one table row. The outer pipes are optional; "\|" is a pipe inside a cell. A pipe
 * splits a cell wherever it is written, also inside backticks (GitHub does the same): a model that
 * wants a pipe in a cell has to escape it. Cells are trimmed.
 */
function splitTableRow(line) {
  let row = line.trim();
  if (row.charCodeAt(0) === 124) row = row.slice(1);
  const last = row.length - 1;
  if (last >= 0 && row.charCodeAt(last) === 124 && !(last > 0 && row.charCodeAt(last - 1) === 92)) row = row.slice(0, last);
  const cells = [];
  let parts = [];
  let start = 0;
  let from = 0;
  for (;;) {
    const at = row.indexOf('|', from);
    if (at < 0) {
      parts.push(row.slice(start));
      cells.push(parts.join('').trim());
      return cells;
    }
    if (at > start && row.charCodeAt(at - 1) === 92) {
      parts.push(row.slice(start, at - 1), '|');
    } else {
      parts.push(row.slice(start, at));
      cells.push(parts.join('').trim());
      parts = [];
    }
    start = at + 1;
    from = at + 1;
  }
}

const TABLE_DELIMITER_LINE = /^[ \t|:-]+$/;
const TABLE_DELIMITER_CELL = /^:?-+:?$/;

/**
 * A pipe table starting at lines[at]: a header row, then a delimiter row ("|---|:--:|") with the
 * same number of cells, then body rows until a blank line, a heading, a list item or a line
 * without a pipe. Both of the first two rows must hold a pipe, so "---" under a title is not a
 * table. Returns { block, next } or null.
 *
 * Body rows are made to fit the header: a short row is padded with empty cells and the cells
 * beyond the last column are joined into it with " | ", so a stray cell is never dropped (GitHub
 * drops them). Alignment colons in the delimiter row become a class on the cells.
 */
function matchTable(lines, at) {
  const headerLine = lines[at];
  const delimiterLine = lines[at + 1];
  if (delimiterLine === undefined || !TABLE_DELIMITER_LINE.test(delimiterLine)) return null;
  if (!hasUnescapedPipe(headerLine) || !hasUnescapedPipe(delimiterLine)) return null;
  const head = splitTableRow(headerLine);
  const marks = splitTableRow(delimiterLine);
  if (head.length !== marks.length || head.length > MARKDOWN_MAX_COLUMNS) return null;
  if (!marks.every((mark) => TABLE_DELIMITER_CELL.test(mark))) return null;
  const aligns = marks.map((mark) => {
    const left = mark.charCodeAt(0) === 58;
    const right = mark.charCodeAt(mark.length - 1) === 58;
    return left && right ? 'c' : right ? 'r' : '';
  });

  const columns = head.length;
  const rows = [];
  let next = at + 2;
  for (; next < lines.length; next++) {
    const line = lines[next];
    if (!line.trim() || matchHeading(line) || !hasUnescapedPipe(line)) break;
    if (line.trim().charCodeAt(0) !== 124 && matchListItem(line)) break;
    const cells = splitTableRow(line);
    if (cells.length > columns) cells.splice(columns - 1, cells.length - columns + 1, cells.slice(columns - 1).join(' | '));
    while (cells.length < columns) cells.push('');
    rows.push(cells);
  }
  return { block: { type: 'table', aligns, head, rows }, next };
}

/**
 * Splits an answer into blocks, or returns null when it has no heading and no table (the legacy
 * renderer then takes the text as it is). Blocks: heading, table, list (items with their
 * continuation lines), paragraph (consecutive non-blank lines, single line breaks kept).
 * A blank line ends a paragraph or a list.
 */
function parseMarkdownBlocks(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = null;
  let list = null;
  let special = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      paragraph = null;
      list = null;
      continue;
    }
    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading.level, text: heading.text });
      paragraph = null;
      list = null;
      special = true;
      continue;
    }
    const table = i + 1 < lines.length ? matchTable(lines, i) : null;
    if (table) {
      blocks.push(table.block);
      paragraph = null;
      list = null;
      special = true;
      i = table.next - 1;
      continue;
    }
    const item = matchListItem(line);
    // A numbered item interrupts a paragraph only as "1." (so "In 2019. It rained" stays prose).
    if (item && (!paragraph || !item.ordered || item.number === 1 || list)) {
      if (!list || list.ordered !== item.ordered) {
        list = { type: 'list', ordered: item.ordered, items: [] };
        blocks.push(list);
      }
      list.items.push({ depth: item.depth, marker: item.marker, lines: [item.text] });
      paragraph = null;
      continue;
    }
    if (list) {
      // A line that follows an item and starts nothing else continues that item.
      list.items[list.items.length - 1].lines.push(line.trim());
      continue;
    }
    if (!paragraph) {
      paragraph = { type: 'paragraph', lines: [] };
      blocks.push(paragraph);
    }
    paragraph.lines.push(line);
  }
  return special ? blocks : null;
}

function markdownTableInline(text) {
  return withCodeSpans(escapeHtml(text), (part) => markdownBold(
    part.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="site-link">$1</a>')
  ));
}

function renderMarkdownTable(table) {
  const cell = (tag, text, index) => {
    const classes = [];
    if (table.aligns[index]) classes.push(`md-al-${table.aligns[index]}`);
    if (text && text.length <= MARKDOWN_SHORT_CELL) classes.push('md-nw');
    const attributes = `${classes.length ? ` class="${classes.join(' ')}"` : ''}${tag === 'th' ? ' scope="col"' : ''}`;
    return `<${tag}${attributes}>${markdownTableInline(text)}</${tag}>`;
  };
  const head = `<thead><tr>${table.head.map((text, i) => cell('th', text, i)).join('')}</tr></thead>`;
  const body = table.rows.length
    ? `<tbody>${table.rows.map((row) => `<tr>${row.map((text, i) => cell('td', text, i)).join('')}</tr>`).join('')}</tbody>`
    : '';
  // The wrapper scrolls sideways, so a wide table stays inside the card. It can take the keyboard
  // focus because a scrollable area that cannot be focused cannot be scrolled without a mouse.
  return `<div class="md-table-wrap" role="region" aria-label="Table" tabindex="0"><table class="md-table">${head}${body}</table></div>`;
}

function renderMarkdownBlocks(blocks) {
  const html = blocks.map((block) => {
    if (block.type === 'heading') {
      return `<div class="md-h md-h${block.level}" role="heading" aria-level="${block.level}">${markdownInline(block.text)}</div>`;
    }
    if (block.type === 'table') return renderMarkdownTable(block);
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) =>
        `<li class="md-li${item.depth ? ` md-d${item.depth}` : ''}"><span class="md-mark" aria-hidden="true">${escapeHtml(item.marker)}</span><span class="md-li-text">${markdownInline(item.lines.join('\n'))}</span></li>`
      ).join('');
      return `<${tag} class="md-list" role="list">${items}</${tag}>`;
    }
    return `<div class="md-p">${markdownInline(block.lines.join('\n'))}</div>`;
  }).join('');
  return `<div class="md-doc">${html}</div>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Exported only so tests/sidepanelAudit.test.js can call the pure renderers. The page itself
// never imports this file; the export list does not change how it loads in the browser.
export {
  buildTurns, renderTurns, renderFinishCard, renderAuditDetails, renderPlanRows, normalizeAudit,
  planCounts, pauseReasonText, escapeHtml, initTimelineInteraction, openAuditDetails, closedAuditDetails, describeAction, firstSentence, withoutEngineNotes,
  partialSubtitle, renderState, receiveState, loadSelectedSession, finishLandingTop, finishCardKey, noteFinishCard, scrollTimelineToLatest,
  formatMarkdownText, hasMarkdownBlocks, legacyBullets, splitTableRow,
  attachShotSlots, attachShotPicture, shotCache, shotGone,
  loadSettings, autoSaveCurrentForm, openComboboxMenu, closeComboboxMenu, updateSelectedModel,
  pickComboboxModel, initEventListeners
};
