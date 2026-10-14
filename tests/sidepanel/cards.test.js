import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  formatTime,
  renderPlanApprovalCard,
  renderReplanApprovalCard,
  renderActionConfirmationCard,
  renderChallengeHelpCard,
  renderContinueBudgetCard,
  renderProvenanceFindingsTable
} from '../../sidepanel/cards.js';
import { renderGraphStrip } from '../../sidepanel/graphStrip.js';
import fs from 'node:fs';

const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');

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

// replan-domain-auto-approved: a revision that adds a domain gets its own card.

test('cards: renderReplanApprovalCard returns empty string on null', () => {
  assert.equal(renderReplanApprovalCard(null), '');
});

test('cards: renderReplanApprovalCard names the added domain and the reason, with Allow and Deny', () => {
  const html = renderReplanApprovalCard({
    kind: 'approve_plan',
    planMeta: { version: 2, sites: [{ id: 's3', domain: 'altshop.test', goal: 'Find the price' }] },
    addedDomains: ['altshop.test'],
    replanReason: 'The competitor shop is unreachable, try the alternate shop',
  });
  assert.ok(html.includes('replan-approval-card'), 'own card class');
  assert.ok(html.includes('The agent wants to add'), 'the ticket wording');
  assert.ok(html.includes('altshop.test'), 'the added domain');
  assert.ok(html.includes('The competitor shop is unreachable, try the alternate shop'), 'the replan reason');
  assert.ok(html.includes('btn-approve-replan'), 'Allow button');
  assert.ok(html.includes('btn-deny-replan'), 'Deny button');
  assert.ok(html.includes('Allow'), 'Allow label');
  assert.ok(html.includes('Deny'), 'Deny label');
});

test('cards: renderReplanApprovalCard escapes the domain and reason and falls back without them', () => {
  const html = renderReplanApprovalCard({
    kind: 'approve_plan',
    planMeta: { version: 2, sites: [] },
    addedDomains: ['<script>alert(1)</script>'],
    replanReason: '',
  });
  assert.ok(!html.includes('<script>alert(1)'), 'no raw markup from the domain');
  assert.ok(html.includes('&lt;script&gt;'), 'the domain, escaped');
});

test('cards: renderActionConfirmationCard renders variants and details', () => {
  assert.equal(renderActionConfirmationCard(null), '');

  // A purchase hold never carries a targetDomain (the risk gate sets one only for navigation), and the worker
  // remembers only a hold's targetDomain, so this card has no remember checkbox: it would do nothing.
  const confirmPurchase = {
    variant: 'purchase',
    actionSummary: 'Click "Place Order"',
    elementLabel: 'Place Order',
    pageUrl: 'https://shop.test/checkout',
    reason: 'Purchase action detected.',
  };

  const htmlPurchase = renderActionConfirmationCard(confirmPurchase);
  assert.ok(htmlPurchase.includes('Purchase / Checkout Action'), 'Should render purchase title');
  assert.ok(htmlPurchase.includes('tag-purchase'), 'Should render purchase tag');
  assert.ok(htmlPurchase.includes('Place Order'), 'Should render element label');
  assert.ok(!htmlPurchase.includes('chkRememberSite'), 'No remember checkbox on a hold without a targetDomain');
  assert.ok(htmlPurchase.includes('shop.test'), 'Should still show the page host');
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
  assert.ok(htmlNav.includes('chkRememberSite'), 'A navigate hold with a targetDomain keeps the remember checkbox');
});

// safety/confirm-card-blind-approval: the card shows what the user approves.

test('cards: an execute_js card shows the full code, escaped, in a scrollable monospace block under its own title', () => {
  const code = `document.querySelector('form').innerHTML = "<img src=x onerror=alert(1)>"; return '</pre><b>x</b>' && 1 < 2;`;
  const html = renderActionConfirmationCard({
    variant: 'script',
    actionSummary: 'Run JavaScript on this page',
    pageUrl: 'https://shop.test/items',
    reason: 'Executing arbitrary JavaScript code on the page.',
    detail: { verb: 'execute_js', code, codeLength: code.length },
  });
  assert.ok(html.includes('Run script on this page'), 'own title');
  assert.ok(!html.includes('Personal Data Entry'), 'not the form title');
  assert.ok(html.includes('<pre class="confirm-code"><code>'), 'code block');
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  assert.ok(html.includes(escaped), 'the whole code, escaped');
  assert.ok(!html.includes('<img src=x'), 'no raw markup from the code');
  assert.ok(!html.includes('</pre><b>'), 'the code cannot close its block');
  assert.ok(!html.includes('chkRememberSite'), 'no remember checkbox: it would do nothing for a script');
  assert.ok(!html.includes('confirm-code-note'), 'no cut note when the whole code is shown');
});

test('cards: code over the cap says how much is not shown', () => {
  const code = 'x'.repeat(2000);
  const html = renderActionConfirmationCard({
    variant: 'script',
    actionSummary: 'Run JavaScript on this page',
    detail: { verb: 'execute_js', code, codeLength: 2600 },
  });
  assert.ok(html.includes('confirm-code-note'), 'a visible note');
  assert.match(html, /first 2000 of 2600 characters/);
});

test('cards: a type card shows the full typed text, the element label, and where a link or form goes', () => {
  const text = 'Max Mustermann, Hauptstrasse 12, 10115 Berlin <b>not bold</b> and a long tail to pass 20 chars';
  const html = renderActionConfirmationCard({
    variant: 'form',
    actionSummary: 'Type into "Address"',
    elementLabel: 'Address',
    pageUrl: 'https://shop.test/account',
    reason: 'Typing personal data into an address input field.',
    detail: { verb: 'type', typedText: text, formActionHost: 'forms.other-site.test' },
  });
  assert.ok(html.includes(text.replace(/</g, '&lt;').replace(/>/g, '&gt;')), 'the full typed text, escaped');
  assert.ok(!html.includes('<b>not bold</b>'), 'typed text is not markup');
  assert.ok(html.includes('Address'), 'element label');
  assert.ok(html.includes('forms.other-site.test'), 'form action host');

  const link = renderActionConfirmationCard({
    variant: 'purchase',
    actionSummary: 'Click "Buy now"',
    elementLabel: 'Buy now',
    pageUrl: 'https://shop.test/items/42',
    detail: { verb: 'click', linkHost: 'pay.other.test' },
  });
  assert.ok(link.includes('pay.other.test'), 'link host');
});

test('cards: a batch card lists its steps, escaped', () => {
  const html = renderActionConfirmationCard({
    variant: 'submit',
    actionSummary: 'Batch (2 steps)',
    detail: { verb: 'browser_batch', steps: ['Type "<i>hi</i>" into "Comment"', 'Click "Post"'] },
  });
  assert.ok(html.includes('Click &quot;Post&quot;'));
  assert.ok(html.includes('&lt;i&gt;hi&lt;/i&gt;'));
  assert.ok(!html.includes('<i>hi</i>'));
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

test('cards: renderChallengeHelpCard renders challenge details and action buttons', () => {
  assert.equal(renderChallengeHelpCard(null), '');

  const challenge = {
    domain: 'cloudflare-protected.test',
    url: 'https://cloudflare-protected.test/verify',
    reason: 'Cloudflare captcha challenge detected.',
  };

  const html = renderChallengeHelpCard(challenge);
  assert.ok(html.includes('challenge-help-card'), 'Should have challenge-help-card class');
  assert.ok(html.includes('cloudflare-protected.test'), 'Should display domain');
  assert.ok(html.includes('tag-challenge'), 'Should have challenge tag');
  assert.ok(html.includes('btn-challenge-solved'), 'Should have solved button');
  assert.ok(html.includes('btn-challenge-skip'), 'Should have skip button');
});

test('cards: renderContinueBudgetCard renders budget steps and action buttons', () => {
  assert.equal(renderContinueBudgetCard(null), '');

  const budgetInfo = {
    domain: 'heavy-catalog.test',
    stepsUsed: 50,
    reserveBudget: 15,
  };

  const html = renderContinueBudgetCard(budgetInfo);
  assert.ok(html.includes('continue-budget-card'), 'Should have continue-budget-card class');
  assert.ok(html.includes('50 steps'), 'Should display steps used');
  assert.ok(html.includes('heavy-catalog.test'), 'Should display domain');
  assert.ok(html.includes('+15 steps'), 'Should display reserve budget');
  assert.ok(html.includes('btn-budget-continue'), 'Should have continue button');
  assert.ok(html.includes('btn-budget-finish'), 'Should have finish button');
});

test('cards: the confirm detail styles use theme tokens only, and long code scrolls inside its box', () => {
  const start = CSS.indexOf('/* Confirm card: what the user approves */');
  const end = CSS.indexOf('/* End confirm card detail */');
  assert.ok(start !== -1 && end > start, 'the confirm detail block exists');
  const block = CSS.slice(start, end);
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsl/i.test(block), 'no fixed colour: both themes get every colour');
  for (const variable of [...new Set([...block.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))].filter((n) => !n.startsWith('--font'))) {
    assert.ok(CSS.split(`${variable}:`).length - 1 >= 3, `${variable} is defined in all three theme blocks`);
  }
  const code = block.slice(block.indexOf('.confirm-code {'), block.indexOf('}', block.indexOf('.confirm-code {')));
  assert.match(code, /overflow:\s*auto;/);
  assert.match(code, /max-height:/);
  assert.match(code, /white-space:\s*pre;/);
  assert.match(code, /font-family:\s*var\(--font-mono\)/);

  // Every class the new markup uses has a rule.
  const html = [
    renderActionConfirmationCard({ variant: 'script', actionSummary: 's', pageUrl: 'https://a.test/', detail: { verb: 'execute_js', code: 'x', codeLength: 3000 } }),
    renderActionConfirmationCard({ variant: 'form', actionSummary: 's', elementLabel: 'E', detail: { verb: 'type', typedText: 't', linkHost: 'l.test', formActionHost: 'f.test' } }),
    renderActionConfirmationCard({ variant: 'submit', actionSummary: 's', detail: { verb: 'browser_batch', steps: ['a'] } }),
  ].join('');
  const classes = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  for (const name of classes) {
    // Buttons are styled elsewhere; a variant or tag without its own rule keeps the base card and tag look.
    if (/^(btn|btn-[a-z-]+|variant-[a-z]+|tag-[a-z]+)$/.test(name)) continue;
    assert.ok(CSS.includes(`.${name}`), `.${name} has no rule`);
  }
});
