/**
 * sidepanel/graphStrip.js
 * Two-tier Nested Live Graph Status Indicator for LangGraph execution.
 * Throttled by requestAnimationFrame to eliminate flicker during rapid node transitions.
 */

import { escapeHtml } from './cards.js';

let pendingRaf = null;
let lastRenderedKey = null;

const ORCHESTRATOR_PHASES = [
  { id: 'plan', label: 'Plan' },
  { id: 'alloc', label: 'Alloc' },
  { id: 'sched', label: 'Sched' },
  { id: 'site', label: 'Site Worker' },
  { id: 'summary', label: 'Summary' },
  { id: 'reflect', label: 'Reflect' },
  { id: 'compile', label: 'Compile' },
  { id: 'finalize', label: 'Finalize' },
];

const WORKER_NODES = [
  { id: 'open', label: 'Open' },
  { id: 'perceive', label: 'Perceive' },
  { id: 'meter', label: 'Meter' },
  { id: 'policy', label: 'Policy' },
  { id: 'risk', label: 'Risk Gate' },
  { id: 'execute', label: 'Execute' },
  { id: 'verify', label: 'Verify' },
  { id: 'recover', label: 'Recover' },
  { id: 'record', label: 'Record' },
];

/**
 * Generate HTML string for nested live graph view
 */
export function renderGraphStrip(graphLocation = {}, runStats = null, effortProfile = null) {
  const orchNode = graphLocation.orchestratorNode || 'plan';
  const workerNode = graphLocation.workerNode;
  const siteDomain = graphLocation.siteDomain || '';
  const phase = graphLocation.phase || orchNode;

  // Build Tier 1: Orchestrator breadcrumb chips
  const orchChipsHtml = ORCHESTRATOR_PHASES.map((p) => {
    const isActive = orchNode === p.id;
    const isPast = ORCHESTRATOR_PHASES.findIndex(x => x.id === orchNode) > ORCHESTRATOR_PHASES.findIndex(x => x.id === p.id);
    const cls = isActive ? 'graph-chip active' : isPast ? 'graph-chip past' : 'graph-chip';
    return `<span class="${cls}" data-node="${p.id}">${escapeHtml(p.label)}</span>`;
  }).join('<span class="chip-arrow">›</span>');

  // Build Tier 2: Worker nodes (only visible when in site worker)
  let workerChipsHtml = '';
  if (workerNode || orchNode === 'site') {
    const activeWorker = workerNode || 'open';
    const chips = WORKER_NODES.map((w) => {
      const isActive = activeWorker === w.id;
      const cls = isActive ? 'graph-subchip active' : 'graph-subchip';
      return `<span class="${cls}" data-subnode="${w.id}">${escapeHtml(w.label)}</span>`;
    }).join('<span class="subchip-arrow">›</span>');

    workerChipsHtml = `
      <div class="graph-tier-sub">
        ${siteDomain ? `<span class="site-chip" title="Active Site Domain">🌐 ${escapeHtml(siteDomain)}</span>` : ''}
        <div class="subchips-list">${chips}</div>
      </div>
    `;
  }

  return `
    <div class="nested-graph-strip">
      <div class="graph-tier-main">
        <span class="graph-tier-label">Graph:</span>
        <div class="chips-list">${orchChipsHtml}</div>
      </div>
      ${workerChipsHtml}
    </div>
  `;
}

/**
 * Updates a DOM container using requestAnimationFrame throttling
 */
export function updateLiveGraphView(containerElement, graphLocation, runStats, effortProfile) {
  if (!containerElement) return;

  const currentKey = `${graphLocation?.orchestratorNode || ''}:${graphLocation?.workerNode || ''}:${graphLocation?.siteDomain || ''}:${graphLocation?.phase || ''}`;
  if (currentKey === lastRenderedKey) return;

  if (pendingRaf) {
    cancelAnimationFrame(pendingRaf);
  }

  pendingRaf = requestAnimationFrame(() => {
    lastRenderedKey = currentKey;
    containerElement.innerHTML = renderGraphStrip(graphLocation, runStats, effortProfile);
    pendingRaf = null;
  });
}
