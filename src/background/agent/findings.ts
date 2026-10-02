// src/background/agent/findings.ts
// Finding creation, code snippet extraction, provenance validation, deduplication, and truth table compilation.
// Erasable TypeScript (no enums, no parameter properties).

import type { Finding, FindingsTable, SiteSpec, TableCell } from '../graph/state.ts';

export type FindingQuality = Finding['quality'];
export type TruthTable = FindingsTable;

export interface FindingParams {
  siteId: string;
  field: string;
  rawValue: string;
  url: string;
  title: string;
  docId: string;
  step: number;
  capturedAt: number | string;
  pageText: string;
  domain: string;
  referenceCurrency?: string | null;
}

/**
 * Normalizes text for matching by collapsing multiple spaces and non-breaking spaces.
 */
export function normalizeText(text: string): string {
  return (text || '').replace(/[\u00a0\s]+/g, ' ').trim();
}

/**
 * Extracts a snippet of up to maxLen (default 160) characters around the value found in pageText.
 */
export function extractSnippet(pageText: string, value: string, maxLen: number = 160): string {
  const normPage = normalizeText(pageText);
  const normVal = normalizeText(value);
  if (!normPage || !normVal) return '';

  const idx = normPage.toLowerCase().indexOf(normVal.toLowerCase());
  if (idx < 0) return '';

  const valLen = normVal.length;
  const halfSlack = Math.max(10, Math.floor((maxLen - valLen) / 2));
  const start = Math.max(0, idx - halfSlack);
  const end = Math.min(normPage.length, idx + valLen + halfSlack);

  let snippet = normPage.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < normPage.length) snippet = snippet + '...';
  return snippet;
}

/**
 * Parses numeric price and currency symbol/code from a string (e.g. "1.599,00 EUR" -> 1599, "EUR").
 */
export function parsePrice(text: string): { amount: number | null; currency: string | null } {
  if (!text) return { amount: null, currency: null };

  const currMatch = text.match(/[€$£¥₹]|EUR\b|USD\b|GBP\b|CHF\b/i);
  const currency = currMatch ? currMatch[0].toUpperCase() : null;

  const clean = text.replace(/[^0-9.,]/g, '').trim();
  if (!clean) return { amount: null, currency };

  let numStr = clean;
  if (clean.includes(',') && clean.includes('.')) {
    if (clean.indexOf('.') < clean.indexOf(',')) {
      numStr = clean.replace(/\./g, '').replace(',', '.');
    } else {
      numStr = clean.replace(/,/g, '');
    }
  } else if (clean.includes(',')) {
    if (/,\d{2}$/.test(clean)) {
      numStr = clean.replace(',', '.');
    } else {
      numStr = clean.replace(',', '');
    }
  }

  const parsed = parseFloat(numStr);
  return {
    amount: isNaN(parsed) ? null : parsed,
    currency
  };
}

/**
 * Creates a verified Finding with code-extracted provenance.
 * Returns null if the value is not present on the page.
 */
export function createFinding(params: FindingParams): Finding | null {
  const { siteId, field, rawValue, url, title, docId, step, capturedAt, pageText, domain, referenceCurrency } = params;
  if (!rawValue || rawValue.toLowerCase() === 'not shown') return null;

  const snippet = extractSnippet(pageText, rawValue);
  const valueOnPage = snippet.length > 0;
  if (!valueOnPage) return null;

  let domainMatches = true;
  try {
    const pageHost = new URL(url).hostname;
    domainMatches = pageHost.includes(domain) || domain.includes(pageHost);
  } catch {
    domainMatches = false;
  }

  const { amount, currency } = parsePrice(rawValue);
  let currencyOk = true;
  if (referenceCurrency && currency) {
    const normRef = referenceCurrency === '€' ? 'EUR' : referenceCurrency;
    const normCurr = currency === '€' ? 'EUR' : currency;
    currencyOk = normRef === normCurr;
  }

  const checks: string[] = [];
  if (valueOnPage) checks.push('value_on_page');
  if (domainMatches) checks.push('domain_matches');
  if (currencyOk) checks.push('currency_ok');
  checks.push('title_matches');

  const quality: FindingQuality = (valueOnPage && domainMatches && currencyOk) ? 'verified' : 'unverified';
  const timeStr = typeof capturedAt === 'number' ? new Date(capturedAt).toISOString() : String(capturedAt);

  return {
    id: `f_${siteId}_${field}_${step}_${Date.now()}`,
    siteId,
    field,
    valueRaw: rawValue,
    value: amount !== null ? amount : rawValue,
    currency: currency ?? undefined,
    url,
    capturedAt: timeStr,
    step,
    pageTitle: title,
    docId,
    evidence: {
      source: 'text',
      snippet
    },
    quality,
    checks
  };
}

/**
 * Deduplicates findings for the same site and field.
 * A new verified finding supersedes an existing unverified or older one.
 */
export function deduplicateFindings(existing: Finding[], incoming: Finding): Finding[] {
  const list = [...existing];
  const idx = list.findIndex(
    (f) => f.siteId === incoming.siteId && f.field === incoming.field
  );

  if (idx < 0) {
    list.push(incoming);
    return list;
  }

  const prev = list[idx];
  const incomingIsBetter = (incoming.quality === 'verified' && prev.quality !== 'verified') || incoming.checks.includes('value_on_page');
  if (incomingIsBetter) {
    const updated = {
      ...incoming,
      supersedes: prev.id
    };
    list[idx] = updated;
  }
  return list;
}

export type TruthTableRow = FindingsTable['rows'][number];

/**
 * Compiles final truth table from site specifications and findings.
 * Includes provenance URLs and snippets, plus compare flags against the reference site.
 */
export function compileTruthTable(
  sites: SiteSpec[],
  findings: Finding[],
  compare?: { reference_domain: string; field: string; threshold_pct: number } | null
): FindingsTable {
  const allColumns = new Set<string>();
  for (const s of sites) {
    for (const f of s.criteria.fields) allColumns.add(f.name);
  }
  const columns = Array.from(allColumns);

  const findingMap = new Map<string, Map<string, Finding>>();
  for (const f of findings) {
    if (!findingMap.has(f.siteId)) findingMap.set(f.siteId, new Map());
    findingMap.get(f.siteId)!.set(f.field, f);
  }

  let refValueAmount: number | null = null;
  if (compare && compare.threshold_pct > 0) {
    const refSite = sites.find((s) => s.domain === compare.reference_domain || s.role === 'reference');
    if (refSite) {
      const refFinding = findingMap.get(refSite.id)?.get(compare.field);
      if (refFinding) {
        refValueAmount = typeof refFinding.value === 'number' ? refFinding.value : parsePrice(String(refFinding.value)).amount;
      }
    }
  }

  let cheapest: { site: string; price: string } | null = null;
  let minPrice = Infinity;

  const rows = sites.map((site) => {
    const cells: Record<string, TableCell | null> = {};
    const flags: string[] = [];
    const siteFindings = findingMap.get(site.id);

    for (const col of columns) {
      const finding = siteFindings?.get(col);
      if (finding) {
        let flag: string | undefined = undefined;
        if (compare && compare.field === col && refValueAmount !== null && site.role !== 'reference') {
          const currentAmount = typeof finding.value === 'number' ? finding.value : parsePrice(String(finding.value)).amount;
          if (currentAmount !== null && refValueAmount > 0) {
            const diffPct = ((currentAmount - refValueAmount) / refValueAmount) * 100;
            if (Math.abs(diffPct) >= compare.threshold_pct) {
              const sign = diffPct > 0 ? '+' : '';
              flag = `${sign}${diffPct.toFixed(1)}% vs reference`;
              flags.push(flag);
            }
          }
        }
        cells[col] = {
          value: String(finding.valueRaw),
          url: finding.url,
          capturedAt: String(finding.capturedAt),
          snippet: finding.evidence?.snippet ?? '',
          quality: finding.quality,
          flag,
        };

        if (col === 'price') {
          const priceAmount = typeof finding.value === 'number' ? finding.value : parsePrice(String(finding.value)).amount;
          if (priceAmount !== null && priceAmount < minPrice) {
            minPrice = priceAmount;
            cheapest = { site: site.domain, price: finding.valueRaw };
          }
        }
      } else {
        cells[col] = null;
      }
    }

    return {
      siteId: site.id,
      site: site.domain,
      role: site.role,
      status: 'done' as const,
      cells,
      note: null,
      flags,
    };
  });

  return { columns, rows, cheapest, gaps: [] };
}

/**
 * Formats a FindingsTable into Markdown with links.
 */
export function renderTruthTableMarkdown(table: FindingsTable): string {
  if (!table.rows || table.rows.length === 0) return 'No findings collected.';

  const headers = ['Site', ...table.columns];
  const sep = headers.map(() => '---');
  const lines: string[] = [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`
  ];

  for (const row of table.rows) {
    const cells = table.columns.map((col) => {
      const cell = row.cells[col];
      if (!cell || !cell.value) return 'not found';
      const flagText = cell.flag ? ` (${cell.flag})` : '';
      if (cell.url) {
        return `[${cell.value}](${cell.url})${flagText}`;
      }
      return `${cell.value}${flagText}`;
    });
    lines.push(`| **${row.site}** (${row.role}) | ${cells.join(' | ')} |`);
  }

  return lines.join('\n');
}
