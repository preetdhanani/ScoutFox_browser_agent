/**
 * Sidepanel Controller Script for ScoutFox AI Agent
 * Connects to Background Agent Engine, renders timeline, session history drawer, plan checklist, progress banner, settings, and backend logs.
 * Employs persistent per-provider API key storage, automatic model fetching, instant key auto-saving, and a smart searchable combobox component.
 */

import { Storage, DEFAULT_SETTINGS, DEFAULT_PROVIDER_CONFIGS } from '../utils/storage.js';

let backgroundPort = null;
let currentSettings = { ...DEFAULT_SETTINGS };
let currentSessionId = null;
let currentActiveLogFilter = 'all';
let rawLogsCache = [];
let apiKeyFetchDebounce = null;
let allFetchedModels = [];

// The authoritative selected model.
//
// This used to be read back out of the hidden <select id="modelSelect">, but that element
// only holds options from the last renderModelOptions() call. Assigning a value with no
// matching <option> silently leaves select.value === '', so switching to a provider whose
// default was not already in the list persisted model: '' and then fell back to whatever
// happened to be first in the hardcoded list. Keep the truth here instead of in the DOM.
let selectedModel = null;
// Guards the window between clicking send and the background confirming the task started.
let isSubmittingTask = false;
// Mirrors the engine status the panel last rendered, so the submit guard knows whether
// renderState() has taken ownership of the send button.
let isTaskActive = false;
let portReconnectAttempts = 0;
let portReconnectTimer = null;
// False only for this panel instance's very first connect. Distinguishes opening the panel
// from reconnecting after Chrome reclaimed the service worker.
let hasConnectedBefore = false;
// Terminal state is broadcast more than once for the same run; this keeps the write to one
// per (session, history length) rather than one per broadcast.
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
  keyboard: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" stroke-linecap="round"/></svg>',
  enter: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 5v6a3 3 0 0 1-3 3H5"/><polyline points="9 10 5 14 9 18"/></svg>',
  scrollIco: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 4 12 8 16 4"/><polyline points="8 20 12 16 16 20"/></svg>',
  back: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 5 4 11 10 17"/><path d="M4 11h10a6 6 0 0 1 6 6v2"/></svg>',
  code: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/></svg>',
  network: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h10l-3-3M14 8l-3 3"/><path d="M20 16H10l3-3M10 16l3 3"/></svg>',
  layers: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 3 21 8 12 13 3 8"/><polyline points="3 13 12 18 21 13"/></svg>',
  ask: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.3 2.5c-.6.2-.9.7-.9 1.3v.4"/><circle cx="12" cy="16.6" r="0.6" fill="currentColor" stroke="none"/></svg>',
  chevron: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>',
  aim: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>'
};

/**
 * Log filter chips -> the tag prefixes the codebase actually emits.
 *
 * These used to be matched as a literal `[DOM]` / `[LLM]` / `[EXECUTION]` token, but nothing
 * anywhere logs those exact strings — the real tags are [DOM_SNAPSHOT_INPUT], [LLM_RAW_OUTPUT],
 * [ACTION_DISPATCH] and so on. Four of the five chips therefore matched nothing at all and
 * rendered a permanently empty pane. Match on real prefixes instead, case-insensitively.
 */
const LOG_FILTER_KEYWORDS = {
  DOM: ['[DOM', '[SNAPSHOT', '[PAGE', 'DOMCOMPRESSOR'],
  LLM: ['[LLM', '[PLANNER', '[PARSE', '[UNIVERSAL_GUARDRAIL', 'APICLIENT'],
  EXECUTION: ['[ACTION', '[EXEC', '[TASK', '[STEP', '[GUARDRAIL', '[STOPPED', '[PAUSED', '[RESUMED'],
  NETWORK: ['[NET', '[DNR', '[FETCH', '[KEEPALIVE', '[PORT', '[BROADCAST', '[WORKER', '[RESYNC']
};

const THEME_MODES = ['system', 'light', 'dark'];
const THEME_ICON = {
  system: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
  dark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>'
};
const THEME_LABEL = { system: 'Auto (matches system)', light: 'Light', dark: 'Dark' };

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
  // Logs are restored via initPortConnection() -> resyncAgentState() -> GET_AGENT_STATE below,
  // not read directly from storage here. That used to be a second, racing path: the background
  // worker's own restore of persisted logs is async, so a resync landing before it finished got
  // back an empty array and this direct read's result was overwritten with it. The background
  // now awaits its own restore before answering GET_AGENT_STATE (see logger.js/background.js),
  // so it is the single, complete, authoritative source and this duplicate is no longer needed.
  await loadSettings();
  initTabs();
  initTimelineInteraction();
  initPortConnection();
  initEventListeners();
  initCombobox();
  await loadSessionHistory();
  await fetchDynamicModels(false);
});

/**
 * Load settings into form controls with per-provider memory restoration
 */
async function loadSettings() {
  currentSettings = await Storage.getSettings();
  applyTheme(currentSettings.theme || 'system');

  const activeProvider = currentSettings.provider || 'openrouter';
  const providerCfg = (currentSettings.providerConfigs && currentSettings.providerConfigs[activeProvider]) || DEFAULT_PROVIDER_CONFIGS[activeProvider] || {};

  document.getElementById('providerSelect').value = activeProvider;
  document.getElementById('baseUrlInput').value = providerCfg.baseUrl || currentSettings.baseUrl || '';
  document.getElementById('apiKeyInput').value = providerCfg.apiKey || currentSettings.apiKey || '';
  document.getElementById('maxStepsInput').value = currentSettings.maxSteps || 25;
  document.getElementById('delayInput').value = currentSettings.actionDelayMs || 1000;
  document.getElementById('ollamaNumPredictInput').value = currentSettings.ollamaNumPredict || 8192;
  document.getElementById('badgesToggle').checked = currentSettings.showElementBadges !== false;

  updateSelectedModel(providerCfg.model || currentSettings.model);
}

/**
 * Update active model label and backing select element
 */
function updateSelectedModel(modelName) {
  const labelEl = document.getElementById('modelSelectedLabel');
  const selectEl = document.getElementById('modelSelect');
  const customInput = document.getElementById('modelCustomInput');

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

  if (modelName === '__custom__') {
    if (customInput) customInput.style.display = 'block';
  } else {
    if (customInput) customInput.style.display = 'none';
  }
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
  if (savedModel && savedModel !== '__custom__' && !combinedList.includes(savedModel)) {
    combinedList.unshift(savedModel);
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
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom model name…';
    selectEl.appendChild(customOpt);
  }

  if (combinedList.length === 0 && savedModel !== '__custom__') {
    optionsContainer.innerHTML = `<div class="subtext-hint" style="padding: 10px; text-align: center;">No matching models found.</div>`;
    return;
  }

  const activeModel = currentSelected || savedModel || combinedList[0];

  let html = combinedList.map(modelName => {
    const isSelected = modelName === activeModel;
    return `<div class="combobox-option-item ${isSelected ? 'selected' : ''}" data-value="${escapeHtml(modelName)}">${escapeHtml(modelName)}</div>`;
  }).join('');

  html += `<div class="combobox-option-item custom-option ${activeModel === '__custom__' ? 'selected' : ''}" data-value="__custom__">✏️ Enter custom model name...</div>`;

  optionsContainer.innerHTML = html;

  optionsContainer.querySelectorAll('.combobox-option-item').forEach(item => {
    item.addEventListener('click', async () => {
      const val = item.getAttribute('data-value');
      updateSelectedModel(val);
      closeComboboxMenu();
      await autoSaveCurrentForm();
    });
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
  const customVal = document.getElementById('modelCustomInput').value.trim();
  const finalModel = (selectedModel === '__custom__' && customVal) ? customVal : (selectedModel || '');

  const apiKey = document.getElementById('apiKeyInput').value.trim();
  const baseUrl = document.getElementById('baseUrlInput').value.trim();

  const previousModel = (currentSettings.providerConfigs && currentSettings.providerConfigs[provider]
    && currentSettings.providerConfigs[provider].model) || '';

  const newSettings = {
    provider,
    baseUrl,
    apiKey,
    // Guard against writing an empty model over a good one. Even with selectedModel as the
    // source of truth, an empty value here would silently clear the provider's saved choice.
    model: finalModel || previousModel,
    maxSteps: parseInt(document.getElementById('maxStepsInput').value, 10) || 25,
    actionDelayMs: parseInt(document.getElementById('delayInput').value, 10) || 1000,
    ollamaNumPredict: parseInt(document.getElementById('ollamaNumPredictInput').value, 10) || 8192,
    showElementBadges: document.getElementById('badgesToggle').checked
  };

  currentSettings = await Storage.saveSettings(newSettings);
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
    forceRefresh
  };

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'FETCH_MODELS', payload: tempSettings }, (res) => {
      if (btnFetch) btnFetch.disabled = false;

      if (res && res.success && res.models && res.models.length > 0) {
        allFetchedModels = res.models;
        renderModelOptions(allFetchedModels);

        if (statusEl) {
          statusEl.textContent = forceRefresh
            ? `Retrieved ${res.models.length} model(s) fresh from API!`
            : `Loaded ${res.models.length} model(s) from local cache (${allFetchedModels.length} total).`;
        }
        resolve(res.models);
      } else {
        if (statusEl) statusEl.textContent = `Could not fetch models (${res?.error || 'Unreachable'}). Using fallbacks.`;
        allFetchedModels = ['anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.3-70b-instruct', 'google/gemini-2.0-flash-001', 'deepseek/deepseek-r1', 'qwen2.5:14b', 'gpt-4o-mini'];
        renderModelOptions(allFetchedModels);
        resolve(allFetchedModels);
      }
    });
  });
}

function updateModelBadge(modelName) {
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

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      navBtns.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`tab-${targetTab}`).classList.add('active');
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

function connectPort() {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;

  try {
    // Tell the worker whether this is a genuine panel open or an automatic reconnect. Only
    // the first connection of this panel instance may clear the previous session; every
    // later one is recovering from the worker being reclaimed and must preserve the run.
    const portName = hasConnectedBefore ? 'scoutfox_sidepanel' : 'scoutfox_sidepanel_fresh';
    hasConnectedBefore = true;
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
        renderState(msg.payload);
        autoSaveActiveSession(msg.payload);
      } else if (msg.type === 'LOG_ENTRY') {
        rawLogsCache.push(msg.payload);
        if (rawLogsCache.length > 300) rawLogsCache.shift();
        renderFilteredLogs();
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

  chrome.runtime.sendMessage({ action: 'GET_AGENT_STATE' }, (res) => {
    if (chrome.runtime.lastError) {
      appendLocalLog('WARN', 'Sidepanel', `[RESYNC_FAILED] Background worker did not answer GET_AGENT_STATE (${chrome.runtime.lastError.message}). Will retry.`);
      setConnectionBanner(true);
      scheduleReconnect();
      return;
    }

    portReconnectAttempts = 0;
    setConnectionBanner(false);

    if (res) {
      renderState(res);
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

  chrome.runtime.sendMessage({ action }, (res) => {
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
  rawLogsCache.push({
    timestamp: new Date().toLocaleTimeString(),
    level,
    module,
    message,
    data: null
  });
  if (rawLogsCache.length > 300) rawLogsCache.shift();
  try { renderFilteredLogs(); } catch (_) { /* log pane may not exist yet during boot */ }
  console.warn(`[${module}]`, message);
}

/**
 * Forward panel-side exceptions to the background log so nothing fails invisibly.
 */
function reportClientError(source, err) {
  const message = (err && err.message) || String(err);
  appendLocalLog('ERROR', 'Sidepanel', `[${source}] ${message}`);
  try {
    chrome.runtime.sendMessage({
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



  document.querySelectorAll('.log-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.log-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentActiveLogFilter = chip.getAttribute('data-filter');
      renderFilteredLogs();
    });
  });

  document.getElementById('btnCopyLogs').addEventListener('click', () => {
    const outputText = document.getElementById('logOutput').textContent;
    navigator.clipboard.writeText(outputText).then(() => {
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
  const autoFetchAndSaveOnKeyInput = async () => {
    const key = document.getElementById('apiKeyInput').value.trim();
    await autoSaveCurrentForm();
    if (key.length >= 8) {
      if (apiKeyFetchDebounce) clearTimeout(apiKeyFetchDebounce);
      apiKeyFetchDebounce = setTimeout(() => {
        fetchDynamicModels(true);
      }, 500);
    }
  };

  document.getElementById('apiKeyInput').addEventListener('input', autoFetchAndSaveOnKeyInput);
  document.getElementById('apiKeyInput').addEventListener('change', autoFetchAndSaveOnKeyInput);
  document.getElementById('apiKeyInput').addEventListener('blur', autoSaveCurrentForm);
  document.getElementById('baseUrlInput').addEventListener('blur', autoSaveCurrentForm);
  document.getElementById('apiKeyInput').addEventListener('paste', () => {
    setTimeout(async () => {
      await autoSaveCurrentForm();
      fetchDynamicModels(true);
    }, 200);
  });

  // Switch per-provider memory when provider dropdown changes
  document.getElementById('providerSelect').addEventListener('change', async () => {
    const provider = document.getElementById('providerSelect').value;
    const providerConfigs = currentSettings.providerConfigs || DEFAULT_PROVIDER_CONFIGS;
    const savedCfg = providerConfigs[provider] || DEFAULT_PROVIDER_CONFIGS[provider] || {};

    document.getElementById('baseUrlInput').value = savedCfg.baseUrl || '';
    document.getElementById('apiKeyInput').value = savedCfg.apiKey || '';

    const modelToSet = savedCfg.model || (DEFAULT_PROVIDER_CONFIGS[provider] ? DEFAULT_PROVIDER_CONFIGS[provider].model : currentSettings.model);
    updateSelectedModel(modelToSet);

    // Update settings object
    currentSettings.provider = provider;
    currentSettings.baseUrl = savedCfg.baseUrl || '';
    currentSettings.apiKey = savedCfg.apiKey || '';
    currentSettings.model = modelToSet;

    await autoSaveCurrentForm();

    const hasKeyOrOllama = provider === 'ollama' || (savedCfg.apiKey && savedCfg.apiKey.length > 5);
    await fetchDynamicModels(hasKeyOrOllama);
  });

  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    await autoSaveCurrentForm();
    alert(`Settings saved! Provider [${currentSettings.provider}] configured with model [${currentSettings.model}].`);
  });

  document.querySelectorAll('.sample-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      document.getElementById('taskInput').value = prompt;
      startTask();
    });
  });
}

async function startTask() {
  const btn = document.getElementById('btnStartTask');
  const prompt = document.getElementById('taskInput').value.trim();
  if (!prompt) return;

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

async function startTaskInner(prompt) {
  // Auto-sync form state into Storage before launching task
  await autoSaveCurrentForm();

  currentSessionId = `session_${Date.now()}`;

  appendLocalLog('INFO', 'Sidepanel', `[TASK_SUBMIT] Sending task to background worker: "${prompt}"`);

  chrome.runtime.sendMessage({ action: 'START_TASK', payload: { prompt } }, (res) => {
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
  // The word is wrapped so it can be dropped at narrow panel widths, leaving the clock and
  // the count. Without that the button pushes the status pill past the header edge at 320px.
  if (historyBtn) {
    historyBtn.innerHTML = `${ICONS.clock}<span class="history-toggle-label">History</span> (${sessions.length})`;
    historyBtn.title = `Saved sessions (${sessions.length})`;
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
      <div class="history-session-item ${isSelected ? 'active' : ''}" data-id="${session.id}" tabindex="0" role="button">
        <div class="history-item-info">
          <span class="history-item-title">${escapeHtml(session.task || 'Untitled Session')}</span>
          <span class="history-item-meta">${session.timestamp || ''} • ${session.model || ''}</span>
        </div>
        <button class="btn-delete-session" data-delete-id="${session.id}">${ICONS.trash}</button>
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
 * Persist a run once it reaches a terminal state.
 *
 * Only terminal states are saved, so a run is written once rather than on every one of the
 * ~7 state broadcasts per step. The panel still OPENS on a clean timeline (the worker clears
 * history on a fresh connect); this is what makes that previous run recoverable afterwards
 * instead of simply lost.
 */
async function autoSaveActiveSession(state) {
  if (!state) return;

  const TERMINAL = ['idle', 'stopped', 'complete', 'completed', 'error'];
  if (!TERMINAL.includes(state.status)) return;
  if (!state.task) return;
  if (!Array.isArray(state.history) || state.history.length === 0) return;
  if (!currentSessionId) return;
  if (savedSessionIds.has(currentSessionId + ':' + state.history.length)) return;

  savedSessionIds.add(currentSessionId + ':' + state.history.length);

  try {
    await Storage.saveSession({
      id: currentSessionId,
      task: state.task,
      timestamp: new Date().toLocaleString(),
      model: currentSettings.model || '',
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
        <div class="empty-icon-tile">${ICONS.aim}</div>
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

  const { status, stepCount, history, planSteps, currentPhase } = state;
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

  const sandboxBadge = document.getElementById('sandboxBadge');
  if (sandboxBadge) {
    if (state.scoutFoxGroupId) {
      sandboxBadge.classList.remove('hidden');
    } else {
      sandboxBadge.classList.add('hidden');
    }
  }

  // The standalone plan card is folded into the action-group header now — one element
  // instead of two. The full checklist still shows inside the expanded group while running.
  const planContainerEl = document.getElementById('planContainer');
  if (planContainerEl) planContainerEl.style.display = 'none';

  if (status === 'running' || status === 'paused') {
    if (processingBanner) processingBanner.style.display = 'flex';
    if (processingPhaseText) processingPhaseText.textContent = currentPhase || `Processing step ${stepCount}...`;
    
    const maxSteps = currentSettings.maxSteps || 25;
    const pct = Math.min(100, Math.round(((stepCount || 1) / maxSteps) * 100));
    if (progressBarFill) progressBarFill.style.width = `${pct}%`;

    isTaskActive = true;
    if (controlBar) controlBar.style.display = 'flex';
    if (taskInput) taskInput.disabled = true;
    if (btnStartTask) btnStartTask.disabled = true;

    if (btnPause) {
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
  }

  const timeline = document.getElementById('timeline');
  if (timeline) {
    if (!history || history.length === 0) {
      renderEmptyState();
      return;
    }

    // Keep the scroll pinned to the bottom only if the user was already there, so
    // expanding a row mid-run does not yank the view away from them.
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    timeline.innerHTML = renderTurns(history, status, planSteps, currentPhase);
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  }
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
        failed: false,
        timestamp: item.timestamp || null,
        isNewRun: !!item.isNewRun
      };
      turns.push(cur);
      return;
    }
    if (!cur) {
      cur = { turn: turns.length + 1, goal: null, entries: [], answer: null, failed: false, timestamp: null, isNewRun: false };
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
      if (item.success === false) cur.failed = true;
    } else if (item.type === 'error') {
      cur.entries.push({ kind: 'fault', idx, content: item.content });
      cur.failed = true;
    } else if (item.type === 'finish') {
      cur.answer = item.answer;
    }
  });
  return turns;
}

/** One-line human description of an action: icon, verb, and the thing it acted on. */
function describeAction(action, outcome) {
  const label = (outcome && outcome.label) || '';
  const quote = (t) => `<em>${escapeHtml(String(t).length > 44 ? String(t).slice(0, 43) + '…' : String(t))}</em>`;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; } };

  switch (action.action) {
    case 'navigate':      return { icon: ICONS.globe, text: `Opened ${quote(host(action.url || ''))}` };
    case 'read_page_text':return { icon: ICONS.eye, text: 'Read page text' };
    case 'click':         return { icon: ICONS.pointer, text: label ? `Clicked ${quote(label)}` : `Clicked element ${escapeHtml(String(action.element_id))}` };
    case 'type':          return { icon: ICONS.keyboard, text: `Typed ${quote(action.text || '')}${label ? ` into ${quote(label)}` : ''}` };
    case 'scroll':        return { icon: ICONS.scrollIco, text: `Scrolled ${escapeHtml(action.direction || 'down')}` };
    case 'go_back':       return { icon: ICONS.back, text: 'Went back' };
    case 'go_forward':    return { icon: ICONS.back, text: 'Went forward' };
    case 'execute_js':    return { icon: ICONS.code, text: 'Ran JavaScript' };
    case 'read_network_requests': return { icon: ICONS.network, text: 'Checked network activity' };
    case 'browser_batch': return { icon: ICONS.layers, text: `Ran ${(action.steps || []).length} actions in one batch` };
    case 'ask_user':      return { icon: ICONS.ask, text: `Asked ${quote(action.question || 'a question')}` };
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
  return isLive || incomplete;
}

function renderTurns(history, status, planSteps, currentPhase) {
  const turns = buildTurns(history);
  const busy = status === 'running' || status === 'paused';

  return turns.map((turn, ti) => {
    const isLast = ti === turns.length - 1;
    const isLive = busy && isLast;
    const count = turn.entries.filter(e => e.kind === 'action').length;
    // "Did not finish" means no answer was produced — not merely that one action failed.
    const incomplete = !isLive && !turn.answer && turn.entries.length > 0;
    const open = isTurnExpanded(turn, isLive, incomplete);

    // Header doubles as the progress indicator, which is why the separate plan card is gone.
    let headline;
    if (isLive) {
      const done = (planSteps || []).filter(s => s.status === 'completed').length;
      const total = (planSteps || []).length;
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
      const d = describeAction(e.action, e.outcome);
      const key = `${turn.turn}:${e.idx}`;
      const shown = expandedRows.has(key);
      const bad = e.outcome && e.outcome.success === false;
      const pending = !e.outcome;
      const why = e.thought
        ? `<div class="act-why" ${shown ? '' : 'hidden'}>${escapeHtml(e.thought)}</div>`
        : '';
      const state = bad ? `<span class="act-state bad">${ICONS.cross}</span>`
                  : pending ? '<span class="act-state live"></span>'
                  : '';
      return `<div class="act-item">
          <div class="act-row${bad ? ' bad' : ''}${e.thought ? ' has-why' : ''}" data-row="${key}" ${e.thought ? 'role="button" tabindex="0"' : ''}>
            <span class="act-ico">${d.icon}</span>
            <span class="act-text">${d.text}</span>
            ${state}
          </div>${why}
        </div>`;
    }).join('');

    const planDetail = (isLive && planSteps && planSteps.length)
      ? `<div class="act-plan">${planSteps.map(st => {
          const ic = st.status === 'completed' ? ICONS.check : st.status === 'in_progress' ? ICONS.dot : ICONS.circle;
          return `<div class="act-plan-row ${st.status}"><span>${ic}</span><span>${escapeHtml(st.text)}</span></div>`;
        }).join('')}</div>`
      : '';

    const phase = (isLive && currentPhase)
      ? `<div class="act-phase">${escapeHtml(currentPhase)}</div>`
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
      ${count || turn.entries.length ? `<div class="act-group${open ? ' open' : ''}">
        <button class="act-head" data-turn="${turn.turn}" aria-expanded="${open}">
          <span class="act-chev">${ICONS.chevron}</span>
          <span class="act-head-text">${headline}</span>
        </button>
        <div class="act-body" ${open ? '' : 'hidden'}>${planDetail}${rows}${phase}</div>
      </div>` : ''}
      ${turn.answer ? `<div class="finish-card"><div class="finish-title">${ICONS.complete} Done</div><div class="finish-body">${formatMarkdownText(turn.answer)}</div></div>` : ''}
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

  timeline.addEventListener('click', (e) => { toggle(e.target); });
  timeline.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (toggle(e.target)) e.preventDefault();
    }
  });
}

function renderPlanChecklist(planSteps) {
  const planContainer = document.getElementById('planContainer');
  const planItemsList = document.getElementById('planItemsList');
  const planProgressPill = document.getElementById('planProgressPill');

  if (!planContainer || !planItemsList) return;

  if (!planSteps || planSteps.length === 0) {
    planContainer.style.display = 'none';
    return;
  }

  planContainer.style.display = 'flex';
  const completedCount = planSteps.filter(s => s.status === 'completed').length;
  if (planProgressPill) planProgressPill.textContent = `${completedCount}/${planSteps.length} Done`;

  planItemsList.innerHTML = planSteps.map((step) => {
    let icon = ICONS.circle;
    let cls = 'pending';
    if (step.status === 'completed') {
      icon = ICONS.check;
      cls = 'completed';
    } else if (step.status === 'in_progress') {
      icon = ICONS.dot;
      cls = 'in_progress';
    }

    return `
      <div class="plan-item ${cls}">
        <span class="plan-icon">${icon}</span>
        <span>${escapeHtml(step.text)}</span>
      </div>
    `;
  }).join('');
}

function renderFilteredLogs() {
  const logOutput = document.getElementById('logOutput');
  if (!logOutput) return;

  if (!rawLogsCache || rawLogsCache.length === 0) {
    logOutput.textContent = '// Waiting for backend system logs...';
    return;
  }

  const filtered = rawLogsCache.filter(log => {
    if (currentActiveLogFilter === 'all') return true;
    const keywords = LOG_FILTER_KEYWORDS[currentActiveLogFilter];
    if (!keywords) return true;
    // Coalesce BOTH fields — an entry with an undefined module used to throw inside
    // .filter(), which killed the whole render and froze the log pane permanently.
    const haystack = `${log.message || ''} ${log.module || ''}`.toUpperCase();
    return keywords.some(k => haystack.includes(k));
  });

  if (filtered.length === 0) {
    logOutput.textContent = `// No logs match category filter: [${currentActiveLogFilter}]`;
    return;
  }

  const formattedLines = filtered.map(log => {
    const time = log.timestamp || '';
    const level = log.level || 'INFO';
    const mod = log.module || 'System';
    const msg = log.message || '';
    const dataStr = log.data ? `\n   Payload: ${log.data}` : '';
    if (msg.includes('[NEW_SESSION_RUN]')) {
      return `\n════════════════════════════════════════════════════════════════\n[${time}] [${level}] [${mod}] ${msg}${dataStr}\n════════════════════════════════════════════════════════════════`;
    }
    return `[${time}] [${level}] [${mod}] ${msg}${dataStr}`;
  }).join('\n\n');

  logOutput.textContent = formattedLines;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function formatActionPill(actionObj) {
  const { action, element_id, text, url, direction, answer, question } = actionObj;
  switch (action) {
    case 'click':
      return `click → [${element_id}]`;
    case 'type':
      return `type → [${element_id}] "${escapeHtml(text || '')}"`;
    case 'scroll':
      return `scroll → ${direction || 'down'}`;
    case 'navigate':
      return `navigate → ${escapeHtml(url || '')}`;
    case 'finish':
      return `finish → ${escapeHtml(answer || '')}`;
    case 'ask_user':
      return `ask → "${escapeHtml(question || '')}"`;
    default:
      return `${action} ${element_id ? `[${element_id}]` : ''}`;
  }
}

function formatMarkdownText(text) {
  if (!text) return '';
  let str = escapeHtml(text);
  str = str.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  str = str.replace(/^[\s]*[-*]\s+(.*)$/gm, '• $1');
  return str;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
