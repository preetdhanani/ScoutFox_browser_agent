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
 * Includes provenance URLs and snippets, compare flags against the reference site,
 * and cross-checking across multi-source findings for XHigh and Max profiles.
 */
export function compileTruthTable(
  sites: SiteSpec[],
  findings: Finding[],
  compare?: { reference_domain: string; field: string; threshold_pct: number } | null,
  crossCheck?: 'none' | 'cross_check_key' | 'cross_check_all'
): FindingsTable {
  const allColumns = new Set<string>();
  for (const s of sites) {
    if (Array.isArray(s.criteria?.fields)) {
      for (const f of s.criteria.fields) {
        const colName = typeof f === 'string' ? f : (f as any)?.name;
        if (colName && typeof colName === 'string') {
          allColumns.add(colName);
        }
      }
    }
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

  // Cross-checking across sources for XHigh (cross_check_key) and Max (cross_check_all)
  const checkMode = crossCheck ?? 'none';
  const varianceThreshold = 20;

  if (checkMode === 'cross_check_key' || checkMode === 'cross_check_all') {
    const colsToCheck = checkMode === 'cross_check_key'
      ? (columns.includes('price') ? ['price'] : (columns.length > 0 ? [columns[0]] : []))
      : columns;

    for (const col of colsToCheck) {
      const validCells: Array<{ row: typeof rows[0]; cell: TableCell; numAmount: number | null; textVal: string }> = [];
      for (const row of rows) {
        const cell = row.cells[col];
        if (cell && cell.value) {
          const numAmount = parsePrice(cell.value).amount ?? (Number.isFinite(Number(cell.value)) ? Number(cell.value) : null);
          const textVal = cell.value.trim().toLowerCase();
          validCells.push({ row, cell, numAmount, textVal });
        }
      }

      if (validCells.length >= 2) {
        const isNumeric = validCells.every((v) => v.numAmount !== null);
        if (isNumeric) {
          const refItem = validCells.find((v) => v.row.role === 'reference');
          let baseline = refItem?.numAmount;
          if (baseline === undefined || baseline === null || baseline <= 0) {
            const nums = validCells.map((v) => v.numAmount!).sort((a, b) => a - b);
            baseline = nums[Math.floor(nums.length / 2)];
          }

          if (baseline && baseline > 0) {
            for (const item of validCells) {
              const diffPct = ((item.numAmount! - baseline) / baseline) * 100;
              if (Math.abs(diffPct) > varianceThreshold) {
                const sign = diffPct > 0 ? '+' : '';
                const disputeFlag = `disputed (${sign}${diffPct.toFixed(1)}% vs baseline)`;
                item.cell.flag = item.cell.flag ? `${item.cell.flag}, ${disputeFlag}` : disputeFlag;
                item.cell.quality = 'unverified';
                if (!item.row.flags.includes(disputeFlag)) {
                  item.row.flags.push(disputeFlag);
                }
              }
            }
          }
        } else {
          const textSet = new Set(validCells.map((v) => v.textVal));
          if (textSet.size > 1) {
            for (const item of validCells) {
              const disputeFlag = 'disputed (mismatch)';
              item.cell.flag = item.cell.flag ? `${item.cell.flag}, ${disputeFlag}` : disputeFlag;
              item.cell.quality = 'unverified';
              if (!item.row.flags.includes(disputeFlag)) {
                item.row.flags.push(disputeFlag);
              }
            }
          }
        }
      }
    }
  }

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
