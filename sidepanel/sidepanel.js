/**
 * Sidepanel Controller Script for ScoutFox AI Agent
 * Connects to Background Agent Engine, renders timeline, session history drawer, plan checklist, progress banner, settings, and backend logs.
 * Employs persistent model caching to prevent redundant API fetches on sidepanel open.
 */

import { Storage, DEFAULT_SETTINGS } from '../utils/storage.js';

let backgroundPort = null;
let currentSettings = { ...DEFAULT_SETTINGS };
let currentSessionId = null;
let currentActiveLogFilter = 'all';
let rawLogsCache = [];

/**
 * Inline icon set — no emoji, thin-line SVGs matching the Studio Mono system.
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
  aim: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>'
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
  await loadSettings();
  initTabs();
  initPortConnection();
  initEventListeners();
  await loadSessionHistory();
  await fetchDynamicModels(false);
});

/**
 * Load settings into form controls
 */
async function loadSettings() {
  currentSettings = await Storage.getSettings();
  applyTheme(currentSettings.theme || 'system');

  document.getElementById('providerSelect').value = currentSettings.provider || 'gemini';
  document.getElementById('baseUrlInput').value = currentSettings.baseUrl || 'http://localhost:11434';
  document.getElementById('apiKeyInput').value = currentSettings.apiKey || '';
  document.getElementById('maxStepsInput').value = currentSettings.maxSteps || 25;
  document.getElementById('delayInput').value = currentSettings.actionDelayMs || 1000;
  document.getElementById('badgesToggle').checked = currentSettings.showElementBadges !== false;

  updateModelBadge(currentSettings.model);
}

/**
 * Fetch dynamic models with storage caching
 */
async function fetchDynamicModels(forceRefresh = false) {
  const statusEl = document.getElementById('modelFetchStatus');
  const selectEl = document.getElementById('modelSelect');
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
        selectEl.innerHTML = '';
        res.models.forEach(modelName => {
          const opt = document.createElement('option');
          opt.value = modelName;
          opt.textContent = modelName;
          selectEl.appendChild(opt);
        });

        const customOpt = document.createElement('option');
        customOpt.value = '__custom__';
        customOpt.textContent = 'Custom model name…';
        selectEl.appendChild(customOpt);

        if (currentSettings.model && res.models.includes(currentSettings.model)) {
          selectEl.value = currentSettings.model;
        } else if (res.models.length > 0) {
          selectEl.value = res.models[0];
          currentSettings.model = res.models[0];
        }

        if (statusEl) {
          statusEl.textContent = forceRefresh
            ? `Retrieved ${res.models.length} model(s) fresh from API!`
            : `Loaded ${res.models.length} model(s) instantly from local storage cache.`;
        }
        updateModelBadge(selectEl.value);
        resolve(res.models);
      } else {
        if (statusEl) statusEl.textContent = `Could not fetch models (${res?.error || 'Unreachable'}). Using fallbacks.`;
        const fallbacks = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp', 'qwen2.5:14b', 'gpt-4o-mini'];
        selectEl.innerHTML = '';
        fallbacks.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          selectEl.appendChild(opt);
        });
        resolve(fallbacks);
      }
    });
  });
}

function updateModelBadge(modelName) {
  const badge = document.getElementById('currentModelBadge');
  if (badge) {
    badge.textContent = modelName || 'Model';
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

function initPortConnection() {
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    backgroundPort = chrome.runtime.connect({ name: 'scoutfox_sidepanel' });

    backgroundPort.onMessage.addListener((msg) => {
      if (msg.type === 'STATE_UPDATE') {
        renderState(msg.payload);
        autoSaveActiveSession(msg.payload);
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'LOG_ENTRY') {
        rawLogsCache.push(msg.payload);
        if (rawLogsCache.length > 300) rawLogsCache.shift();
        renderFilteredLogs();
      }
    });

    chrome.runtime.sendMessage({ action: 'GET_AGENT_STATE' }, (res) => {
      if (res) {
        renderState(res);
        if (res.logs) {
          rawLogsCache = res.logs;
          renderFilteredLogs();
        }
      }
    });
  }
}

function initEventListeners() {
  document.getElementById('btnThemeToggle').addEventListener('click', async () => {
    const current = currentSettings.theme || 'system';
    const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
    currentSettings.theme = next;
    applyTheme(next);
    await Storage.saveSettings({ theme: next });
  });

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
    if (isPaused) {
      chrome.runtime.sendMessage({ action: 'RESUME_TASK' });
    } else {
      chrome.runtime.sendMessage({ action: 'PAUSE_TASK' });
    }
  });

  document.getElementById('btnStop').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_TASK' });
  });

  document.getElementById('btnNewSession').addEventListener('click', () => {
    currentSessionId = null;
    chrome.runtime.sendMessage({ action: 'CLEAR_HISTORY' }, () => {
      const planContainer = document.getElementById('planContainer');
      if (planContainer) planContainer.style.display = 'none';
      renderEmptyState();
    });
  });

  document.getElementById('btnToggleHistory').addEventListener('click', async () => {
    const drawer = document.getElementById('historyDrawer');
    if (drawer.style.display === 'none' || !drawer.style.display) {
      await loadSessionHistory();
      drawer.style.display = 'flex';
    } else {
      drawer.style.display = 'none';
    }
  });

  document.getElementById('btnCloseHistory').addEventListener('click', () => {
    document.getElementById('historyDrawer').style.display = 'none';
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
  });

  document.getElementById('btnFetchModels').addEventListener('click', () => {
    fetchDynamicModels(true);
  });

  document.getElementById('providerSelect').addEventListener('change', () => {
    const provider = document.getElementById('providerSelect').value;
    if (provider === 'ollama') {
      document.getElementById('baseUrlInput').value = 'http://localhost:11434';
    } else if (provider === 'openai') {
      document.getElementById('baseUrlInput').value = 'https://api.openai.com';
    } else if (provider === 'anthropic') {
      document.getElementById('baseUrlInput').value = 'https://api.anthropic.com';
    }
    fetchDynamicModels(true);
  });

  document.getElementById('apiKeyInput').addEventListener('change', () => {
    fetchDynamicModels(true);
  });

  document.getElementById('modelSelect').addEventListener('change', () => {
    const val = document.getElementById('modelSelect').value;
    const customInput = document.getElementById('modelCustomInput');
    if (val === '__custom__') {
      customInput.style.display = 'block';
    } else {
      customInput.style.display = 'none';
      updateModelBadge(val);
    }
  });

  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    const selectVal = document.getElementById('modelSelect').value;
    const customVal = document.getElementById('modelCustomInput').value.trim();
    const finalModel = (selectVal === '__custom__' && customVal) ? customVal : selectVal;

    const newSettings = {
      provider: document.getElementById('providerSelect').value,
      baseUrl: document.getElementById('baseUrlInput').value.trim(),
      apiKey: document.getElementById('apiKeyInput').value.trim(),
      model: finalModel,
      maxSteps: parseInt(document.getElementById('maxStepsInput').value, 10) || 25,
      actionDelayMs: parseInt(document.getElementById('delayInput').value, 10) || 1000,
      showElementBadges: document.getElementById('badgesToggle').checked
    };

    await Storage.saveSettings(newSettings);
    currentSettings = newSettings;
    updateModelBadge(finalModel);
    alert(`Settings saved! Active model: ${finalModel}`);
  });

  document.querySelectorAll('.sample-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      document.getElementById('taskInput').value = prompt;
      startTask();
    });
  });
}

function startTask() {
  const prompt = document.getElementById('taskInput').value.trim();
  if (!prompt) return;

  currentSessionId = `session_${Date.now()}`;

  chrome.runtime.sendMessage({ action: 'START_TASK', payload: { prompt } }, (res) => {
    if (res && res.success) {
      document.getElementById('taskInput').value = '';
      const emptyState = document.getElementById('emptyState');
      if (emptyState) emptyState.style.display = 'none';
      document.getElementById('controlBar').style.display = 'flex';
    } else if (res && res.error) {
      alert(`Error starting task: ${res.error}`);
    }
  });
}

async function loadSessionHistory() {
  const sessions = await Storage.getSessions();
  const historyBtn = document.getElementById('btnToggleHistory');
  if (historyBtn) historyBtn.innerHTML = `${ICONS.clock} History (${sessions.length})`;

  const listContainer = document.getElementById('historySessionsList');
  if (!listContainer) return;

  if (sessions.length === 0) {
    listContainer.innerHTML = `<div class="subtext-hint" style="padding: 10px; text-align: center;">No saved sessions yet.</div>`;
    return;
  }

  listContainer.innerHTML = sessions.map(session => {
    const isSelected = session.id === currentSessionId;
    return `
      <div class="history-session-item ${isSelected ? 'active' : ''}" data-id="${session.id}">
        <div class="history-item-info">
          <span class="history-item-title">${escapeHtml(session.task || 'Untitled Session')}</span>
          <span class="history-item-meta">${session.timestamp || ''} • ${session.model || ''}</span>
        </div>
        <button class="btn-delete-session" data-delete-id="${session.id}">${ICONS.trash}</button>
      </div>
    `;
  }).join('');

  listContainer.querySelectorAll('.history-session-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-delete-session')) return;
      const sessionId = item.getAttribute('data-id');
      loadSelectedSession(sessionId);
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

async function autoSaveActiveSession(state) {
  if (!state || !state.task || !state.history || state.history.length === 0) return;

  if (!currentSessionId) {
    currentSessionId = `session_${Date.now()}`;
  }

  const sessionObj = {
    id: currentSessionId,
    task: state.task,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    date: new Date().toLocaleDateString(),
    history: state.history,
    planSteps: state.planSteps || [],
    model: currentSettings.model || 'Model'
  };

  await Storage.saveSession(sessionObj);
  const sessions = await Storage.getSessions();
  const historyBtn = document.getElementById('btnToggleHistory');
  if (historyBtn) historyBtn.innerHTML = `${ICONS.clock} History (${sessions.length})`;
}

async function loadSelectedSession(sessionId) {
  const sessions = await Storage.getSessions();
  const target = sessions.find(s => s.id === sessionId);
  if (!target) return;

  currentSessionId = target.id;
  document.getElementById('historyDrawer').style.display = 'none';

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
  const { status, stepCount, history, planSteps, currentPhase } = state;

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
    statusPill.className = `status-indicator ${status}`;
    statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  }

  renderPlanChecklist(planSteps);

  if (status === 'running' || status === 'paused') {
    if (processingBanner) processingBanner.style.display = 'flex';
    if (processingPhaseText) processingPhaseText.textContent = currentPhase || `Processing step ${stepCount}...`;
    
    const maxSteps = currentSettings.maxSteps || 25;
    const pct = Math.min(100, Math.round(((stepCount || 1) / maxSteps) * 100));
    if (progressBarFill) progressBarFill.style.width = `${pct}%`;

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

    let html = '';
    history.forEach(item => {
      if (item.type === 'user_goal') {
        html += `<div class="user-goal-card"><span class="goal-label">Goal</span>${escapeHtml(item.prompt)}</div>`;
      } else if (item.type === 'step_start') {
        html += `
          <div class="timeline-card">
            <div class="timeline-header">
              <span class="step-badge">Step ${item.step}</span>
              <span>${escapeHtml(item.pageTitle || item.url || '')}</span>
            </div>
        `;
      } else if (item.type === 'agent_response') {
        if (item.thought) {
          html += `<div class="thought-text">${escapeHtml(item.thought)}</div>`;
        }
        if (item.action) {
          const actionStr = formatActionPill(item.action);
          html += `<div class="action-pill">${actionStr}</div>`;
        }
      } else if (item.type === 'execution_result') {
        const cls = item.success ? 'success' : 'error';
        html += `
            <div class="result-badge ${cls}">${item.success ? ICONS.check : ICONS.cross} ${escapeHtml(item.message || item.error || '')}</div>
          </div>
        `;
      } else if (item.type === 'error') {
        html += `
          <div class="result-badge error" style="margin-top: 8px; padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; align-items: flex-start;">
            ${ICONS.warning}<span><strong>Error Diagnostic:</strong><br>${escapeHtml(item.content)}</span>
          </div>
        `;
      } else if (item.type === 'finish') {
        html += `
          <div class="finish-card">
            <div class="finish-title">${ICONS.complete} Task Complete</div>
            <div class="finish-body">${formatMarkdownText(item.answer)}</div>
          </div>
        `;
      }
    });

    timeline.innerHTML = html;
    timeline.scrollTop = timeline.scrollHeight;
  }
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
    const msg = (log.message || '') + (log.module || '');
    return msg.includes(`[${currentActiveLogFilter}]`) || log.module.includes(currentActiveLogFilter);
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
