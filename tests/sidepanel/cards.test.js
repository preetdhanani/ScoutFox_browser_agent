import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  formatTime,
  renderPlanApprovalCard,
  renderActionConfirmationCard,
  renderProvenanceFindingsTable
} from '../../sidepanel/cards.js';
import { renderGraphStrip } from '../../sidepanel/graphStrip.js';

test('cards: escapeHtml escapes dangerous characters', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml('foo & bar \'baz\''), 'foo &amp; bar &#39;baz&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('cards: renderPlanApprovalCard returns empty string on null', () => {
  assert.equal(renderPlanApprovalCard(null), '');
});

test('cards: renderPlanApprovalCard renders sites, columns, and estimates', () => {
  const approval = {
    planMeta: {
      version: 1,
      sites: [
        { domain: 'store.test', role: 'primary', goal: 'Find product' },
        { domain: 'compare.test', role: 'reseller', goal: 'Check price' },
      ],
      columns: ['price', 'shipping'],
    },
    budgetEstimate: {
      estimatedSteps: '~15-25',
      roughTimeSec: 45,
    },
    budget: {
      workingTotal: 50,
      hardCap: 250,
    },
    effortProfile: {
      level: 'medium',
    },
  };

  const html = renderPlanApprovalCard(approval);
  assert.ok(html.includes('Plan Approval Required'), 'Should show title');
  assert.ok(html.includes('store.test'), 'Should render site domain');
  assert.ok(html.includes('badge-primary'), 'Should render primary badge');
  assert.ok(html.includes('compare.test'), 'Should render reseller site');
  assert.ok(html.includes('column-chip'), 'Should render column chips');
  assert.ok(html.includes('price'), 'Should render price chip');
  assert.ok(html.includes('~15-25'), 'Should render estimated steps');
  assert.ok(html.includes('~45s'), 'Should render rough time');
  assert.ok(html.includes('btn-level-chip active" data-level="medium"'), 'Medium should be active');
  assert.ok(!html.includes('plan-overbudget-banner'), 'Should not show overbudget banner');
});

test('cards: renderPlanApprovalCard shows revision and overbudget warning', () => {
  const approval = {
    planMeta: {
      version: 2,
      sites: [{ domain: 'huge.test', role: 'primary', goal: 'Scrape everything' }],
    },
    budget: {
      workingTotal: 300,
      hardCap: 250,
    },
    effortProfile: {
      level: 'high',
    },
  };

  const html = renderPlanApprovalCard(approval);
  assert.ok(html.includes('Plan Revision #2'), 'Should show revision header');
  assert.ok(html.includes('plan-overbudget-banner'), 'Should display overbudget warning');
  assert.ok(html.includes('exceeding the limit of 250 steps'), 'Should state overbudget limit');
  assert.ok(html.includes('btn-level-chip active" data-level="high"'), 'High should be active');
});

test('cards: renderActionConfirmationCard renders variants and details', () => {
  assert.equal(renderActionConfirmationCard(null), '');

  const confirmPurchase = {
    variant: 'purchase',
    actionSummary: 'Click "Place Order"',
    elementLabel: 'Place Order',
    reason: 'Purchase action detected.',
    targetDomain: 'shop.test',
  };

  const htmlPurchase = renderActionConfirmationCard(confirmPurchase);
  assert.ok(htmlPurchase.includes('Purchase / Checkout Action'), 'Should render purchase title');
  assert.ok(htmlPurchase.includes('tag-purchase'), 'Should render purchase tag');
  assert.ok(htmlPurchase.includes('Place Order'), 'Should render element label');
  assert.ok(htmlPurchase.includes('chkRememberSite'), 'Should render remember site checkbox');
  assert.ok(htmlPurchase.includes('btn-confirm-allow'), 'Should render allow button');
  assert.ok(htmlPurchase.includes('btn-confirm-deny'), 'Should render deny button');

  const confirmNav = {
    variant: 'navigate',
    actionSummary: 'Navigate to external website',
    pageUrl: 'https://external-auth.com/login',
    reason: 'Navigating to domain outside approved list.',
    targetDomain: 'external-auth.com',
  };

  const htmlNav = renderActionConfirmationCard(confirmNav);
  assert.ok(htmlNav.includes('External Site Navigation'), 'Should render navigate title');
  assert.ok(htmlNav.includes('external-auth.com'), 'Should display target domain');
});

test('cards: renderProvenanceFindingsTable renders findings and snippets', () => {
  assert.equal(renderProvenanceFindingsTable([]), '');

  const findings = [
    {
      id: 'f1',
      siteId: 'framework.com',
      url: 'https://frame.work/products/laptop16',
      field: 'price',
      value: '1.599 EUR',
      quality: 'verified',
      step: 4,
      capturedAt: 1727800000000,
      evidence: {
        snippet: 'Framework Laptop 16 starts from 1.599 EUR including VAT.',
      },
      pageTitle: 'Framework Laptop 16 Store',
    },
  ];

  const html = renderProvenanceFindingsTable(findings);
  assert.ok(html.includes('provenance-findings-container'), 'Should contain table container');
  assert.ok(html.includes('frame.work'), 'Should display site domain');
  assert.ok(html.includes('1.599 EUR'), 'Should display price value');
  assert.ok(html.includes('quality-verified'), 'Should display verified badge');
  assert.ok(html.includes('Framework Laptop 16 starts from 1.599 EUR'), 'Should include snippet quote');
  assert.ok(html.includes('Step #4'), 'Should display step number');
  assert.ok(html.includes('btn-copy-findings-table'), 'Should include copy table button');
});

test('graphStrip: renderGraphStrip renders orchestrator and worker tiers', () => {
  const stripOrch = renderGraphStrip({ orchestratorNode: 'alloc' });
  assert.ok(stripOrch.includes('nested-graph-strip'), 'Should render container');
  assert.ok(stripOrch.includes('class="graph-chip active" data-node="alloc"'), 'Alloc chip should be active');
  assert.ok(stripOrch.includes('class="graph-chip past" data-node="plan"'), 'Plan chip should be past');
  assert.ok(!stripOrch.includes('graph-tier-sub'), 'Should not render worker sub-tier when not in worker');

  const stripWorker = renderGraphStrip({
    orchestratorNode: 'site',
    workerNode: 'risk',
    siteDomain: 'shop.test',
  });
  assert.ok(stripWorker.includes('graph-tier-sub'), 'Should render worker sub-tier');
  assert.ok(stripWorker.includes('🌐 shop.test'), 'Should show active site domain');
  assert.ok(stripWorker.includes('class="graph-subchip active" data-subnode="risk"'), 'Risk gate subchip should be active');
});
