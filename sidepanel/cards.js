/**
 * sidepanel/cards.js
 * Specialized Card Renderers for LangGraph HITL approval, action confirmation,
 * and provenance findings table.
 * Designed with Studio Mono tokens and clean HTML generation.
 */

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format timestamp into human readable time
 */
export function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) {
    return String(ts);
  }
}

/** The host name of a URL, or '' when it does not parse. */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

/** One labelled line of the card, or '' when there is no value. */
function confirmRow(label, value) {
  if (!value) return '';
  return `<div class="confirm-row"><span class="confirm-row-label">${escapeHtml(label)}</span><code class="confirm-row-value">${escapeHtml(value)}</code></div>`;
}

/**
 * The action's own data, so the user sees what they approve: the typed text, the code of a script (escaped, monospace,
 * scrolling inside its box) and the steps of a batch. `detail` comes from the risk gate (agent/risk.ts ConfirmDetail).
 */
function renderConfirmDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const parts = [];
  if (typeof detail.typedText === 'string' && detail.typedText) {
    parts.push(`
      <div class="confirm-block">
        <span class="confirm-block-label">Text to type</span>
        <pre class="confirm-code confirm-text">${escapeHtml(detail.typedText)}</pre>
      </div>`);
  }
  if (typeof detail.code === 'string') {
    const total = Number(detail.codeLength) || detail.code.length;
    const cut = total > detail.code.length
      ? `<span class="confirm-code-note">Showing the first ${detail.code.length} of ${total} characters. The rest is not shown but runs too.</span>`
      : '';
    parts.push(`
      <div class="confirm-block">
        <span class="confirm-block-label">JavaScript to run</span>
        <pre class="confirm-code"><code>${escapeHtml(detail.code)}</code></pre>
        ${cut}
      </div>`);
  }
  if (Array.isArray(detail.steps) && detail.steps.length > 0) {
    parts.push(`
      <div class="confirm-block">
        <span class="confirm-block-label">Steps</span>
        <ol class="confirm-steps">${detail.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      </div>`);
  }
  return parts.join('');
}

/**
 * Render Action Confirmation Card (HITL interrupt: confirm_action)
 */
export function renderActionConfirmationCard(confirm) {
  if (!confirm) return '';

  const variant = confirm.variant || 'form';
  const detail = confirm.detail && typeof confirm.detail === 'object' ? confirm.detail : null;
  const actionSummary = confirm.actionSummary || 'Perform browser action';
  const elementLabel = confirm.elementLabel || (detail && detail.elementLabel) || '';
  const reason = confirm.reason || 'This action modifies external state or navigates away.';
  const pageHost = confirm.pageUrl ? hostOf(confirm.pageUrl) : '';
  // Only a navigate hold has a targetDomain, and the engine remembers only that one: "remember" is offered only then,
  // so the checkbox never shows where it would do nothing.
  const targetDomain = confirm.targetDomain || '';

  const variantTitles = {
    purchase: 'Purchase / Checkout Action',
    login: 'Login / Authentication Action',
    submit: 'Form Submission / Deletion',
    form: 'Personal Data Entry',
    navigate: 'External Site Navigation',
    script: 'Run script on this page'
  };

  const title = variantTitles[variant] || 'Confirmation Required';
  const variantClass = String(variant).replace(/[^a-z]/g, '');

  return `
    <div class="approval-card action-confirmation-card variant-${variantClass}">
      <div class="card-header">
        <div class="card-title-group">
          <span class="card-icon">🛡️</span>
          <span class="card-title">${escapeHtml(title)}</span>
        </div>
        <span class="variant-tag tag-${variantClass}">${escapeHtml(variant)}</span>
      </div>

      <div class="card-body">
        <div class="action-summary-box">
          <div class="action-highlight">
            <strong>${escapeHtml(actionSummary)}</strong>
          </div>
          ${confirmRow('Element', elementLabel)}
          ${confirmRow('Link opens', detail && detail.linkHost)}
          ${confirmRow('Form sends to', detail && detail.formActionHost)}
          ${targetDomain ? confirmRow('Target domain', targetDomain) : confirmRow('Page', pageHost)}
        </div>

        ${renderConfirmDetail(detail)}

        <div class="risk-reason-box">
          <span class="reason-label">Risk Policy:</span>
          <span class="reason-text">${escapeHtml(reason)}</span>
        </div>

        ${targetDomain ? `
          <div class="remember-domain-row">
            <label class="checkbox-label" for="chkRememberSite">
              <input type="checkbox" id="chkRememberSite" checked>
              <span>Remember <strong>${escapeHtml(targetDomain)}</strong> for this task</span>
            </label>
          </div>
        ` : ''}
      </div>

      <div class="card-actions">
        <button type="button" class="btn btn-primary btn-sm btn-confirm-allow">
          Allow Action
        </button>
        <button type="button" class="btn btn-danger btn-sm btn-confirm-deny">
          Deny Action
        </button>
      </div>
    </div>
  `;
}

/**
 * Render Provenance Findings Table
 */
export function renderProvenanceFindingsTable(findings = []) {
  if (!Array.isArray(findings) || findings.length === 0) return '';

  const rowsHtml = findings.map((f, idx) => {
    const qualityClass = f.quality === 'verified' ? 'quality-verified' : f.quality === 'single_source' ? 'quality-single' : 'quality-unverified';
    const qualityLabel = f.quality === 'verified' ? 'Verified' : f.quality === 'single_source' ? '1 Source' : 'Unverified';
    const siteName = f.siteId || 'Site';
    const valText = f.valueRaw || f.value || '';
    const snippet = f.evidence?.snippet || '';
    const url = f.url || '';
    const domain = url ? new URL(url, 'https://localhost').hostname : siteName;

    return `
      <tr class="findings-table-row" data-row-id="${escapeHtml(f.id || String(idx))}">
        <td class="col-site" title="${escapeHtml(url)}">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="site-link">${escapeHtml(domain)}</a>
        </td>
        <td class="col-field">${escapeHtml(f.field || '')}</td>
        <td class="col-value"><strong>${escapeHtml(valText)}</strong></td>
        <td class="col-quality">
          <span class="quality-badge ${qualityClass}" title="${escapeHtml(f.checks?.join(', ') || qualityLabel)}">${qualityLabel}</span>
        </td>
      </tr>
      <tr class="findings-detail-row" id="finding-detail-${escapeHtml(f.id || String(idx))}" style="display: none;">
        <td colspan="4">
          <div class="finding-provenance-box">
            ${snippet ? `<div class="snippet-quote">"${escapeHtml(snippet)}"</div>` : ''}
            <div class="provenance-meta">
              <span>Step #${f.step || 1}</span>
              ${f.capturedAt ? `<span>Captured at ${escapeHtml(formatTime(f.capturedAt))}</span>` : ''}
              ${f.pageTitle ? `<span>Page: ${escapeHtml(f.pageTitle)}</span>` : ''}
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="provenance-findings-container">
      <div class="findings-table-header">
        <div class="table-title">
          <span>📊 Findings with Provenance</span>
          <span class="findings-count-badge">${findings.length}</span>
        </div>
        <button type="button" class="btn btn-secondary btn-xs btn-copy-findings-table" title="Copy table as Markdown">
          Copy Table
        </button>
      </div>
      <div class="findings-table-scroll">
        <table class="provenance-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Field</th>
              <th>Value</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Render Challenge Help Card (HITL interrupt: challenge_help)
 */
export function renderChallengeHelpCard(challenge) {
  if (!challenge) return '';

  const domain = challenge.domain || 'Target Site';
  const url = challenge.url || '';
  const reason = challenge.reason || 'Bot protection or security challenge encountered.';

  return `
    <div class="approval-card challenge-help-card">
      <div class="card-header">
        <div class="card-title-group">
          <span class="card-icon">🧩</span>
          <span class="card-title">Security Challenge</span>
        </div>
        <span class="variant-tag tag-challenge">Bot Verification</span>
      </div>

      <div class="card-body">
        <p class="plan-summary-lead">The agent encountered a verification screen on <strong>${escapeHtml(domain)}</strong>:</p>

        <div class="action-summary-box">
          <div class="action-highlight">
            <span>Please complete the captcha or verification challenge in the browser tab.</span>
          </div>
          ${url ? `<div class="action-target-domain">URL: <code>${escapeHtml(url)}</code></div>` : ''}
        </div>

        <div class="risk-reason-box">
          <span class="reason-label">Status:</span>
          <span class="reason-text">${escapeHtml(reason)}</span>
        </div>
      </div>

      <div class="card-actions">
        <button type="button" class="btn btn-primary btn-sm btn-challenge-solved">
          I've Solved It
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-challenge-skip">
          Skip Site
        </button>
      </div>
    </div>
  `;
}

/**
 * Render Continue Budget Card (HITL interrupt: continue_budget)
 */
export function renderContinueBudgetCard(budgetInfo) {
  if (!budgetInfo) return '';

  const domain = budgetInfo.domain || 'this site';
  const stepsUsed = budgetInfo.stepsUsed || 0;
  const reserveBudget = budgetInfo.reserveBudget || 10;

  return `
    <div class="approval-card continue-budget-card">
      <div class="card-header">
        <div class="card-title-group">
          <span class="card-icon">⏱️</span>
          <span class="card-title">Budget Soft Cap Reached</span>
        </div>
        <span class="variant-tag tag-budget">${stepsUsed} Steps</span>
      </div>

      <div class="card-body">
        <p class="plan-summary-lead">The agent has spent <strong>${stepsUsed} steps</strong> on <strong>${escapeHtml(domain)}</strong>.</p>
        <p class="budget-desc">Would you like the agent to continue exploring using reserve budget (+${reserveBudget} steps) or wrap up and proceed with gathered findings?</p>
      </div>

      <div class="card-actions">
        <button type="button" class="btn btn-primary btn-sm btn-budget-continue" data-reserve="${reserveBudget}">
          Continue (+${reserveBudget} steps)
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-budget-finish">
          Finish Site
        </button>
      </div>
    </div>
  `;
}
