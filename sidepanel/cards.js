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

/**
 * Render Plan Approval Card (HITL interrupt: approve_plan)
 */
export function renderPlanApprovalCard(approval, planSteps = [], effortProfile = null) {
  if (!approval) return '';

  const planMeta = approval.planMeta || {};
  const version = planMeta.version || 1;
  const isRevision = version > 1;
  const sites = planMeta.sites || [];
  const columns = planMeta.columns || [];
  const budgetEstimate = approval.budgetEstimate || {};
  const budget = approval.budget || {};

  const estimatedSteps = budgetEstimate.estimatedSteps || (sites.length > 0 ? `~${sites.length * 8}-${sites.length * 12}` : '~15-25');
  const roughTime = budgetEstimate.roughTimeSec ? `~${budgetEstimate.roughTimeSec}s` : (sites.length > 0 ? `~${sites.length * 20}s` : '~45-60s');

  const activeLevel = approval.effortProfile?.level || effortProfile?.level || 'medium';
  const hardCap = budget.hardCap || 250;
  const workingTotal = budget.workingTotal || 0;
  const isOverBudget = workingTotal > hardCap;

  const sitesHtml = sites.map((site, idx) => {
    const roleBadgeClass = site.role === 'primary' ? 'badge-primary' : site.role === 'reseller' ? 'badge-info' : 'badge-neutral';
    const siteDomain = site.domain || site.url || site.name || `site-${idx + 1}`;
    return `
      <div class="plan-card-site-row">
        <div class="site-header-col">
          <span class="site-domain"><strong>${escapeHtml(siteDomain)}</strong></span>
          <span class="plan-role-badge ${roleBadgeClass}">${escapeHtml(site.role || 'target')}</span>
        </div>
        <div class="site-goal-col">
          <span class="site-goal-text">${escapeHtml(site.goal || 'Extract information')}</span>
        </div>
      </div>
    `;
  }).join('');

  const columnsHtml = columns.length > 0
    ? `<div class="plan-card-columns">
         <span class="columns-label">Target Fields:</span>
         ${columns.map(c => `<span class="column-chip">${escapeHtml(c)}</span>`).join('')}
       </div>`
    : '';

  const overBudgetWarningHtml = isOverBudget
    ? `<div class="plan-overbudget-banner">
         <span class="warn-icon">⚠️</span>
         <span>Plan requires ${workingTotal} steps, exceeding the limit of ${hardCap} steps.</span>
       </div>`
    : '';

  return `
    <div class="approval-card plan-approval-card" data-version="${version}">
      <div class="card-header">
        <div class="card-title-group">
          <span class="card-icon">📋</span>
          <span class="card-title">${isRevision ? `Plan Revision #${version}` : 'Plan Approval Required'}</span>
        </div>
        <span class="version-badge">v${version}</span>
      </div>

      <div class="card-body">
        <p class="plan-summary-lead">The agent generated an execution plan for your review:</p>

        <div class="plan-sites-container">
          ${sitesHtml}
        </div>

        ${columnsHtml}

        <div class="plan-estimates-row">
          <div class="estimate-item">
            <span class="estimate-label">Estimated Steps</span>
            <span class="estimate-value">${escapeHtml(estimatedSteps)}</span>
          </div>
          <div class="estimate-item">
            <span class="estimate-label">Estimated Time</span>
            <span class="estimate-value">${escapeHtml(roughTime)}</span>
          </div>
          <div class="estimate-item">
            <span class="estimate-label">Total Sites</span>
            <span class="estimate-value">${sites.length}</span>
          </div>
        </div>

        <div class="plan-level-picker">
          <span class="picker-label">Effort Level:</span>
          <div class="level-chips-group" role="radiogroup">
            <button type="button" class="btn-level-chip ${activeLevel === 'low' ? 'active' : ''}" data-level="low">Low (1x)</button>
            <button type="button" class="btn-level-chip ${activeLevel === 'medium' ? 'active' : ''}" data-level="medium">Medium (2x)</button>
            <button type="button" class="btn-level-chip ${activeLevel === 'high' ? 'active' : ''}" data-level="high">High (3x)</button>
          </div>
        </div>

        ${overBudgetWarningHtml}
      </div>

      <div class="card-actions">
        <button type="button" class="btn btn-primary btn-sm btn-approve-plan" data-level="${activeLevel}">
          Approve Plan
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-stop-plan">
          Cancel &amp; Stop
        </button>
      </div>
    </div>
  `;
}

/**
 * Render Action Confirmation Card (HITL interrupt: confirm_action)
 */
export function renderActionConfirmationCard(confirm) {
  if (!confirm) return '';

  const variant = confirm.variant || 'form';
  const actionSummary = confirm.actionSummary || 'Perform browser action';
  const elementLabel = confirm.elementLabel ? `"${confirm.elementLabel}"` : '';
  const reason = confirm.reason || 'This action modifies external state or navigates away.';
  const pageUrl = confirm.pageUrl || '';
  const targetDomain = confirm.targetDomain || (pageUrl ? new URL(pageUrl, 'https://localhost').hostname : '');

  const variantTitles = {
    purchase: 'Purchase / Checkout Action',
    login: 'Login / Authentication Action',
    submit: 'Form Submission / Deletion',
    form: 'Personal Data Entry',
    navigate: 'External Site Navigation'
  };

  const title = variantTitles[variant] || 'Confirmation Required';

  const showRememberCheckbox = variant === 'navigate' || !!targetDomain;

  return `
    <div class="approval-card action-confirmation-card variant-${variant}">
      <div class="card-header">
        <div class="card-title-group">
          <span class="card-icon">🛡️</span>
          <span class="card-title">${escapeHtml(title)}</span>
        </div>
        <span class="variant-tag tag-${variant}">${escapeHtml(variant)}</span>
      </div>

      <div class="card-body">
        <div class="action-summary-box">
          <div class="action-highlight">
            <strong>${escapeHtml(actionSummary)}</strong>
            ${elementLabel ? `<span class="target-element">${escapeHtml(elementLabel)}</span>` : ''}
          </div>
          ${targetDomain ? `<div class="action-target-domain">Target domain: <code>${escapeHtml(targetDomain)}</code></div>` : ''}
        </div>

        <div class="risk-reason-box">
          <span class="reason-label">Risk Policy:</span>
          <span class="reason-text">${escapeHtml(reason)}</span>
        </div>

        ${showRememberCheckbox ? `
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
