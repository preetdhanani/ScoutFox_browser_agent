/**
 * customProvider.js - the Add/Edit dialog for user-added model providers ("Custom endpoint").
 *
 * A custom provider is a provider: it is stored in the same settings, offered in the same dropdown,
 * and called through the same LLM path as the eight built-ins (see featere/custom-endpoint/PRD.md).
 * The descriptor (id, display name, protocol, base URL, model list, key mode) lives in
 * settings.customProviders; the API key lives in providerConfigs[id].apiKey like every credential.
 *
 * The dialog holds ONE state object (section 3 of prototype.md): nothing is written to storage
 * until Add/Save, an in-flight Test or model fetch is invalidated by a generation counter instead
 * of being aborted (a chrome.runtime message cannot be aborted), and the URL preview is produced
 * by the same functions the background sender uses, so the preview is never a lie.
 *
 * The pure helpers (providerMeta, buildProviderOptions, isCustomProviderId, describePrivateHttpHost)
 * are exported for the tests; the page wiring happens once through initCustomProviderDialog.
 */
import {
  saveCustomProvider,
  DEFAULT_SETTINGS,
  DEFAULT_PROVIDER_CONFIGS,
  BUILTIN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN
} from '../src/shared/storage.ts';
import { customChatUrl, customModelsUrl, endpointHostOf, endpointOriginOf } from '../src/background/llm/settings.ts';

/** The dropdown value that opens the Add dialog. Never a real provider id. */
export const CUSTOM_TRIGGER_VALUE = '__custom_provider__';

/** The honest empty state of the model picker, word for word from the mock. */
export const CUSTOM_EMPTY_MODELS_TEXT = 'No models will be shown in the selector. Unlisted IDs can still be sent directly.';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** True when the id names a provider the user added (a built-in id never is, even if a stale entry existed). */
export function isCustomProviderId(providerId, settings) {
  if (!providerId || typeof providerId !== 'string') return false;
  if ((BUILTIN_PROVIDER_IDS).includes(providerId)) return false;
  return Boolean(settings && settings.customProviders && settings.customProviders[providerId]);
}

/**
 * One view of a provider for the whole settings form: where its saved URL, key, model and timeout
 * come from, and what each field falls back to when empty. This is the resolver that covers both
 * sources (built-in registry and custom descriptors), so the form code never branches on isCustom
 * to read DEFAULT_PROVIDER_CONFIGS for an id that has no entry there.
 */
export function providerMeta(providerId, settings) {
  const s = settings || {};
  const custom = s.customProviders && s.customProviders[providerId];
  const cfg = (s.providerConfigs && s.providerConfigs[providerId]) || {};
  if (custom) {
    return {
      isCustom: true,
      exists: true,
      displayName: custom.displayName || providerId,
      baseUrl: cfg.baseUrl || custom.baseUrl || '',
      apiKey: cfg.apiKey || '',
      savedModel: cfg.model || '',
      savedModels: Array.isArray(custom.models) ? custom.models : [],
      baseUrlPlaceholder: custom.baseUrl || '',
      defaultModel: '',
      // A custom provider has no curated default of its own; its per-provider timeout (set in the
      // dialog) wins through timeoutMsOf, then the global, then the built-in default.
      defaultTimeout: custom.llmTimeoutMs || DEFAULT_SETTINGS.llmTimeoutMs
    };
  }
  const builtin = DEFAULT_PROVIDER_CONFIGS[providerId] || null;
  return {
    isCustom: false,
    exists: Boolean(builtin),
    displayName: providerId,
    baseUrl: cfg.baseUrl || (builtin ? builtin.baseUrl : ''),
    apiKey: cfg.apiKey || '',
    savedModel: cfg.model || '',
    savedModels: [],
    baseUrlPlaceholder: builtin ? builtin.baseUrl : 'https://openrouter.ai/api/v1',
    defaultModel: builtin ? builtin.model : '',
    defaultTimeout: (builtin && builtin.llmTimeoutMs) || DEFAULT_SETTINGS.llmTimeoutMs
  };
}

/** The option elements this module appended, across every select it ever touched. A WeakSet: an
 * option removed from the DOM by other means is collectable, and no select is misidentified. */
const appendedDynamicOptions = new WeakSet();

/**
 * Append the dynamic options of the custom providers to the dropdown: one option per provider,
 * then the "Custom endpoint…" trigger, which always stays last. EVERY previously appended option
 * is removed first (tracked in appendedDynamicOptions, so a provider deleted from the settings
 * loses its option too), then the current list is appended. The caller assigns select.value
 * AFTER this, since an option that is not in the DOM would make the assignment silently no-op.
 *
 * Removal is feature-detected (`opt.remove`): the real DOM has it, and the fake elements of the
 * DOM-level tests do not, where stale duplicates are harmless because every assertion reads
 * values, not option counts.
 */
export function buildProviderOptions(selectEl, customProviders) {
  if (!selectEl) return;
  for (const opt of Array.from(selectEl.options || [])) {
    if (appendedDynamicOptions.has(opt) && typeof opt.remove === 'function') opt.remove();
  }
  const providers = Object.values(customProviders || {})
    .sort((a, b) => {
      // By display name, in plain codepoint order: locale collation rules differ per runtime and
      // would make the dropdown order depend on the machine's ICU build.
      const an = String(a.displayName || a.id).toLowerCase();
      const bn = String(b.displayName || b.id).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.displayName || p.id} (custom)`;
    if (typeof selectEl.appendChild === 'function') selectEl.appendChild(opt);
    appendedDynamicOptions.add(opt);
  }
  const trigger = document.createElement('option');
  trigger.value = CUSTOM_TRIGGER_VALUE;
  trigger.textContent = 'Custom endpoint…';
  if (typeof selectEl.appendChild === 'function') selectEl.appendChild(trigger);
  appendedDynamicOptions.add(trigger);
}

/** One line under the Base URL field: the exact URLs the background will send, both of them. */
export function previewUrls(protocol, baseUrl) {
  return {
    chat: customChatUrl(protocol, baseUrl),
    models: customModelsUrl(protocol, baseUrl)
  };
}

/** The inline note for a plain-HTTP base URL that is not a local or private address. */
export function describePrivateHttpHost(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl || '').trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  const host = parsed.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return null;
  if (/^10\./.test(host)) return null;
  if (/^192\.168\./.test(host)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (host.endsWith('.local')) return null;
  return 'Plain HTTP sends the request unencrypted. Use https:// when the server supports it.';
}

/** The first error the id field can show, or null when the id is usable so far. */
export function validateProviderIdInput(id, existingIds) {
  const value = String(id || '').trim();
  if (!value) return 'Provider ID is required.';
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(value)) {
    return 'Provider ID must be lowercase letters, digits and dashes, starting with a letter, up to 32 characters.';
  }
  if ((BUILTIN_PROVIDER_IDS).includes(value)) {
    return `"${value}" is a built-in provider and cannot be replaced. Choose another ID.`;
  }
  if (existingIds && existingIds.includes(value)) {
    return `A provider with the ID "${value}" already exists.`;
  }
  return null;
}

function el(id) {
  return document.getElementById(id);
}

/**
 * Wire the dialog once. The deps keep this module decoupled from sidepanel.js internals:
 *   getSettings()            the live settings object the panel holds
 *   applySettings(s)         replaces the panel's currentSettings object
 *   sendBgMessage(msg, cb)   the panel's tab-tagged message sender
 *   showToast(text)          the panel's toast
 *   providerSelected(id)     puts a provider id into effect: rebuilds the options, loads the
 *                            provider into the form, autosaves, and refreshes the model list
 */
export function initCustomProviderDialog(deps) {
  const state = {
    mode: 'add',
    providerId: null,
    protocol: 'openai',
    models: [],
    handAdded: [],
    savedAtOpen: [],
    keyMode: 'apiKey',
    generation: 0,
    editingOrigin: null,
    nameTouched: false
  };

  const ids = () => Array.from(Object.keys((deps.getSettings() || {}).customProviders || {}));

  function open(mode, providerId) {
    const settings = deps.getSettings() || {};
    state.mode = mode;
    state.providerId = providerId || null;
    state.generation++;
    state.handAdded = [];

    const descriptor = mode === 'edit' ? (settings.customProviders || {})[providerId] : null;
    const cfg = mode === 'edit' ? ((settings.providerConfigs || {})[providerId] || {}) : {};
    state.protocol = descriptor ? descriptor.protocol : 'openai';
    state.keyMode = descriptor ? (descriptor.keyMode || 'apiKey') : 'apiKey';
    state.models = descriptor && Array.isArray(descriptor.models) ? [...descriptor.models] : [];
    state.savedAtOpen = [...state.models];
    state.editingOrigin = descriptor ? endpointOriginOf(descriptor.baseUrl) : null;
    // A3: an empty display name follows the host of the Base URL as it is typed; a name that was
    // saved or typed is never overwritten by the auto value.
    state.nameTouched = Boolean(descriptor && descriptor.displayName);

    el('cpTitle').textContent = mode === 'edit' ? 'Edit custom provider' : 'Custom model API';
    el('cpIdInput').value = descriptor ? descriptor.id : '';
    el('cpIdInput').disabled = mode === 'edit';
    el('cpNameInput').value = descriptor ? (descriptor.displayName || '') : '';
    el('cpBaseUrlInput').value = descriptor ? (descriptor.baseUrl || '') : (cfg.baseUrl || '');
    el('cpApiKeyInput').value = cfg.apiKey || '';
    el('cpModelAddInput').value = '';
    el('cpTimeoutInput').value = descriptor && descriptor.llmTimeoutMs ? String(descriptor.llmTimeoutMs) : '';
    el('cpError').style.display = 'none';
    el('cpError').textContent = '';
    el('cpTestStatus').textContent = '';
    el('cpFetchStatus').textContent = '';
    el('cpKeyClearedNote').style.display = 'none';
    el('btnCpSave').textContent = mode === 'edit' ? 'Save changes' : 'Add provider';
    syncProtocol();
    renderModelRows();
    syncPreview();
    el('cpOverlay').style.display = 'flex';
    el('cpIdInput').focus();
  }

  function close() {
    state.generation++;
    el('cpOverlay').style.display = 'none';
  }

  function isOpen() {
    return el('cpOverlay').style.display !== 'none';
  }

  function syncProtocol() {
    const openai = state.protocol === 'openai';
    el('cpProtocolOpenai').setAttribute('aria-checked', openai ? 'true' : 'false');
    el('cpProtocolAnthropic').setAttribute('aria-checked', openai ? 'false' : 'true');
    el('cpProtocolOpenai').classList.toggle('selected', openai);
    el('cpProtocolAnthropic').classList.toggle('selected', !openai);
  }

  function draftBaseUrl() {
    return el('cpBaseUrlInput').value.trim();
  }

  function syncPreview() {
    const base = draftBaseUrl();
    const preview = el('cpPreview');
    if (!base) {
      preview.innerHTML = '<span class="cp-preview-line">Pick a protocol and type a base URL to see the exact request URLs.</span>';
    } else {
      const urls = previewUrls(state.protocol, base);
      preview.innerHTML =
        `<span class="cp-preview-line">Chat request: <code>${escapeHtml(urls.chat)}</code></span>` +
        `<span class="cp-preview-line">Model list: <code>${escapeHtml(urls.models)}</code></span>`;
    }
    const httpNote = describePrivateHttpHost(base);
    el('cpHttpWarning').style.display = httpNote ? 'block' : 'none';
    el('cpHttpWarning').textContent = httpNote || '';

    // The origin rule, shown where the user can still react to it: an edit that changes the
    // endpoint origin will clear the stored key on save.
    if (state.mode === 'edit' && state.editingOrigin) {
      const nextOrigin = endpointOriginOf(base);
      const note = el('cpKeyClearedNote');
      if (nextOrigin && nextOrigin !== state.editingOrigin) {
        note.textContent = 'The host changed, so the key will be removed on save. Paste it again to send it to the new host.';
        note.style.display = 'block';
        return;
      }
      note.style.display = 'none';
    }
  }

  function renderModelRows() {
    const list = el('cpModelsList');
    if (!state.models.length) {
      list.innerHTML = `<div class="cp-model-empty">${escapeHtml(CUSTOM_EMPTY_MODELS_TEXT)}</div>`;
      return;
    }
    list.innerHTML = state.models.map((model, index) => {
      const addedByHand = state.handAdded.includes(model);
      return (
        `<div class="cp-model-row" data-index="${index}">` +
        `<code class="cp-model-id">${escapeHtml(model)}</code>` +
        (addedByHand ? '<span class="cp-model-tag">Added by hand</span>' : '') +
        `<button type="button" class="cp-model-remove" data-model="${escapeHtml(model)}" title="Remove ${escapeHtml(model)}" aria-label="Remove ${escapeHtml(model)}">×</button>` +
        `</div>`
      );
    }).join('');
    list.querySelectorAll('.cp-model-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const model = btn.getAttribute('data-model');
        state.models = state.models.filter((m) => m !== model);
        state.handAdded = state.handAdded.filter((m) => m !== model);
        renderModelRows();
      });
    });
  }

  function addModelFromInput() {
    const input = el('cpModelAddInput');
    const raw = input.value.trim();
    if (!raw) return;
    if (/[\n\t\r]/.test(raw)) {
      showFormError('A model id cannot contain a line break.');
      return;
    }
    if (state.models.includes(raw)) {
      showFormError(`"${raw}" is already in the list.`);
      return;
    }
    state.models.push(raw);
    if (!state.handAdded.includes(raw)) state.handAdded.push(raw);
    input.value = '';
    clearFormError();
    renderModelRows();
    input.focus();
  }

  /** The synthetic settings snapshot the FETCH and TEST messages carry for this draft. */
  function draftPayload(forceRefresh) {
    const id = (el('cpIdInput').value || '').trim();
    const baseUrl = draftBaseUrl();
    const apiKey = el('cpApiKeyInput').value.trim();
    const descriptor = {
      id: id || 'draft',
      displayName: el('cpNameInput').value.trim() || id || 'draft',
      protocol: state.protocol,
      baseUrl,
      models: state.models,
      keyMode: state.keyMode
    };
    return {
      provider: id || 'draft',
      baseUrl,
      apiKey,
      model: state.models[0] || '',
      forceRefresh: !!forceRefresh,
      customProviders: { [descriptor.id]: descriptor },
      providerConfigs: { [descriptor.id]: { baseUrl, apiKey, model: state.models[0] || '' } }
    };
  }

  function messagePromise(msg) {
    return new Promise((resolve) => {
      try {
        deps.sendBgMessage(msg, (res) => resolve(res || { success: false, error: 'No answer from the background worker.' }));
      } catch (err) {
        resolve({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async function fetchModels() {
    const generation = state.generation;
    const btn = el('btnCpFetchModels');
    btn.disabled = true;
    el('cpFetchStatus').textContent = 'Fetching models…';
    const startedAt = Date.now();
    const res = await messagePromise({ action: 'FETCH_MODELS', payload: draftPayload(true) });
    btn.disabled = false;
    if (generation !== state.generation) return;
    if (res.success && Array.isArray(res.models) && res.models.length > 0) {
      // D4: a fetch merges with what the user already saved (and with ids added by hand) instead of
      // silently replacing it; the status line says how much was new.
      const merged = [...res.models];
      for (const model of state.savedAtOpen) {
        if (!merged.includes(model)) merged.push(model);
      }
      for (const model of state.handAdded) {
        if (!merged.includes(model)) merged.push(model);
      }
      const newCount = res.models.filter((m) => !state.savedAtOpen.includes(m) && !state.handAdded.includes(m)).length;
      state.models = merged;
      const filtered = res.filteredCount ? ` (${res.filteredCount} non-chat id(s) hidden)` : '';
      el('cpFetchStatus').textContent = newCount > 0
        ? `${newCount} new id(s) from the endpoint merged with your saved list (${merged.length} total, ${Date.now() - startedAt}ms)${filtered}. Review, remove, or add ids.`
        : `The endpoint listed the ids you already saved (${merged.length} total, ${Date.now() - startedAt}ms)${filtered}. Review, remove, or add ids.`;
      renderModelRows();
      clearFormError();
    } else if (res.success) {
      el('cpFetchStatus').textContent = 'The endpoint returned no chat models. Add ids by hand.';
      renderModelRows();
    } else if (res.status && (res.status === 404 || res.status === 405)) {
      el('cpFetchStatus').textContent = 'This endpoint has no model list. Add ids by hand, and Test still works.';
    } else {
      const reason = res.error || 'Unreachable';
      el('cpFetchStatus').textContent = `Could not fetch models: ${reason.length > 120 ? `${reason.slice(0, 120)}…` : reason} You can still add by hand.`;
      renderModelRows();
    }
  }

  async function runTest() {
    const generation = state.generation;
    const btn = el('btnCpTest');
    const status = el('cpTestStatus');
    const startedAt = Date.now();
    btn.disabled = true;
    status.textContent = 'Testing…';
    const list = await messagePromise({ action: 'FETCH_MODELS', payload: draftPayload(true) });
    btn.disabled = false;
    if (generation !== state.generation) return;
    if (list.success && Array.isArray(list.models) && list.models.length > 0) {
      status.textContent = `Endpoint answered: ${list.models.length} model(s) via the model list (${Date.now() - startedAt}ms).`;
      return;
    }
    // The model list is unavailable or empty: one minimal chat call decides, exactly as a run would.
    // A chat call needs a model id; with none, say so instead of reporting a misleading failure.
    if (!state.models.length) {
      status.textContent = `The endpoint could not be asked for a model list (${(list.error || 'no models listed').slice(0, 80)}), and no model id is set for a test chat call. Add an id and Test again.`;
      btn.disabled = false;
      return;
    }
    const probe = await messagePromise({ action: 'TEST_PROVIDER', payload: draftPayload(false) });
    if (generation !== state.generation) return;
    if (probe.success) {
      status.textContent = `Model list unavailable (${(list.error || 'no models listed').slice(0, 80)}), but a chat call succeeded (${probe.latencyMs}ms). The endpoint works; add model ids by hand.`;
    } else {
      const reason = probe.error || 'Unknown failure';
      status.textContent = `Test failed: ${reason.length > 160 ? `${reason.slice(0, 160)}…` : reason} The full text is in the Logs tab.`;
    }
  }

  function showFormError(text, action) {
    const box = el('cpError');
    box.textContent = text;
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cp-error-action';
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      box.appendChild(btn);
    }
    box.style.display = 'block';
  }

  function clearFormError() {
    const box = el('cpError');
    box.textContent = '';
    box.style.display = 'none';
  }

  async function submit() {
    const settings = deps.getSettings() || {};
    const input = {
      id: el('cpIdInput').value,
      displayName: el('cpNameInput').value,
      protocol: state.protocol,
      baseUrl: draftBaseUrl(),
      models: state.models,
      apiKey: el('cpApiKeyInput').value.trim(),
      keyMode: state.keyMode,
      llmTimeoutMs: parseInt(el('cpTimeoutInput').value, 10) || undefined
    };
    const idError = validateProviderIdInput(input.id, state.mode === 'edit' ? ids().filter((x) => x !== state.providerId) : ids());
    if (idError && state.mode === 'add') {
      // A clash with an existing id comes with the one-click way out: the first free "<id>-N".
      const existing = ids();
      const clash = /already exists/.test(idError);
      let suggestion = null;
      if (clash) {
        for (let n = 2; n < 100; n++) {
          const candidate = `${input.id.trim()}-${n}`;
          if (!existing.includes(candidate)) {
            suggestion = candidate;
            break;
          }
        }
      }
      showFormError(idError, suggestion ? {
        label: `Use "${suggestion}"`,
        onClick: () => {
          el('cpIdInput').value = suggestion;
          clearFormError();
          el('cpNameInput').focus();
        }
      } : undefined);
      return;
    }
    if (!input.baseUrl) {
      showFormError('Base URL is required, for example https://gateway.example/v1.');
      return;
    }
    if (state.mode === 'edit' && idError) {
      showFormError(idError);
      return;
    }
    const result = await saveCustomProvider(input);
    if (!result.ok) {
      showFormError(result.error);
      return;
    }
    deps.applySettings(result.settings);
    close();
    try {
      await deps.providerSelected(result.provider.id);
      const verb = state.mode === 'edit' ? 'updated' : 'added';
      const cleared = result.keyCleared ? ' The host changed, so the key was removed. Paste it again to send it to the new host.' : '';
      deps.showToast(`Provider ${result.provider.displayName || result.provider.id} ${verb}.${cleared}`);
    } catch (err) {
      deps.showToast(`Provider saved, but the form did not switch to it: ${err instanceof Error ? err.message : err}`);
    }
  }

  function onProtocolPick(protocol) {
    state.protocol = protocol;
    syncProtocol();
    syncPreview();
  }

  el('cpProtocolOpenai').addEventListener('click', () => onProtocolPick('openai'));
  el('cpProtocolAnthropic').addEventListener('click', () => onProtocolPick('anthropic'));
  el('cpProtocolOpenai').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      onProtocolPick('anthropic');
      el('cpProtocolAnthropic').focus();
    }
  });
  el('cpProtocolAnthropic').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      onProtocolPick('openai');
      el('cpProtocolOpenai').focus();
    }
  });

  el('cpBaseUrlInput').addEventListener('input', () => {
    // A3.1: an untouched display name follows the host of the base URL as it is typed; A3.2: a
    // name the user typed or saved is never overwritten by the auto value.
    const host = endpointHostOf(draftBaseUrl());
    const nameInput = el('cpNameInput');
    if (!state.nameTouched && host) nameInput.value = host;
    syncPreview();
  });
  el('cpNameInput').addEventListener('input', () => {
    state.nameTouched = el('cpNameInput').value.trim() !== '';
    clearFormError();
  });
  el('cpIdInput').addEventListener('input', () => clearFormError());
  el('btnCpAddModel').addEventListener('click', addModelFromInput);
  el('cpModelAddInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addModelFromInput();
    }
  });
  el('btnCpFetchModels').addEventListener('click', fetchModels);
  el('btnCpTest').addEventListener('click', runTest);
  el('btnCpSave').addEventListener('click', submit);
  el('btnCpCancel').addEventListener('click', close);
  el('cpToggleKey').addEventListener('click', () => {
    const input = el('cpApiKeyInput');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    el('cpToggleKey').title = hidden ? 'Hide API Key' : 'Show/Hide API Key';
  });
  el('cpOverlay').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  return {
    open,
    close,
    isOpen,
    /** For the tests: the current draft without touching the DOM beyond what open() filled in. */
    draft: () => ({
      mode: state.mode,
      providerId: state.providerId,
      protocol: state.protocol,
      models: [...state.models],
      keyMode: state.keyMode,
      baseUrl: draftBaseUrl()
    }),
    submit,
    fetchModels,
    runTest,
    syncPreview
  };
}
