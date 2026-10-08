// src/background/agent/reflectPrompt.ts
// Reflection prompt generation and structured decision parsing for Phase P5c.
// Erasable TypeScript (no enums, no parameter properties).

import type { BlockedSource, Finding, PlanMeta, SiteSpec, SiteSummary } from '../graph/state.ts';

export interface ReflectPromptParams {
  task: string;
  planMeta: PlanMeta;
  siteSummaries: SiteSummary[];
  findings: Finding[];
  blocked: Record<string, BlockedSource>;
  pendingSites: SiteSpec[];
  reserveSteps: number;
  replanCount: number;
  maxReplans: number;
}

export interface CandidateSiteInput {
  name?: string;
  domain: string;
  startUrl?: string;
  goal?: string;
  role?: 'reference' | 'compare' | 'other';
  kind?: 'store' | 'listing' | 'search' | 'page';
  difficulty?: number;
}

export interface ReflectDecision {
  decision: 'continue' | 'replan' | 'stop_early';
  reason: string;
  changes: string;
  dropSites?: string[];
  addSites?: SiteSpec[];
}

const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'edge:',
  'about:',
  'data:',
  'javascript:',
  'file:',
  'blob:',
];

export function buildReflectSystemPrompt(): string {
  return `You are the reflection supervisor of an autonomous browser agent.
Review the gathered progress and decide how to proceed with the remaining plan.
Reply with ONE JSON object.
- decision: "continue" | "stop_early" | "replan"
  - "continue": Proceed with the remaining pending sites as planned.
  - "stop_early": All required goals, findings, or comparison columns have already been found. Stop now to save steps and budget.
  - "replan": An earlier site was blocked or unhelpful, or pending sites should be dropped or replaced with promising alternative sites.
- reason: One short sentence explaining the rationale.
- changes: One short sentence describing what changed (or "" if continue/stop_early).
- drop_sites: Optional array of site IDs to drop (e.g. ["s2"]). ONLY pending sites may be dropped. Finished sites can never be dropped.
- add_sites: Optional array of new candidate sites to add (at most 2), each with { name, domain, startUrl, goal, role, kind, difficulty }.`;
}

export function buildReflectUserMessage(params: ReflectPromptParams): string {
  const parts: string[] = [];

  parts.push(`Original Task: "${params.task}"`);
  parts.push(`Planned Columns: [${(params.planMeta.columns || []).join(', ')}]`);
  parts.push(`Budget: Reserve steps left = ${params.reserveSteps}, Replan count = ${params.replanCount}/${params.maxReplans}`);

  // Completed / Processed sites
  if (params.siteSummaries.length > 0) {
    const summaryLines = params.siteSummaries.map((s) => {
      return `  - Site [${s.siteId}]: status=${s.status}, criteriaMet=${s.criteriaMet}, findings=${s.findings}, stepsUsed=${s.stepsUsed}${s.blockers.length ? `, blockers=[${s.blockers.join('; ')}]` : ''}`;
    });
    parts.push(`Completed / Processed Sites:\n${summaryLines.join('\n')}`);
  } else {
    parts.push(`Completed Sites: none`);
  }

  // Findings collected so far
  if (params.findings.length > 0) {
    const findingLines = params.findings.map((f) => `  - [${f.siteId}] ${f.field}: ${f.valueRaw} (${f.quality})`);
    parts.push(`Collected Findings:\n${findingLines.join('\n')}`);
  } else {
    parts.push(`Collected Findings: none`);
  }

  // Blocked domains
  const blockedKeys = Object.keys(params.blocked || {});
  if (blockedKeys.length > 0) {
    parts.push(`Blocked Domains: ${blockedKeys.join(', ')}`);
  }

  // Pending sites
  if (params.pendingSites.length > 0) {
    const pendingLines = params.pendingSites.map((s) => `  - Site [${s.id}] ${s.name} (${s.domain}): goal="${s.goal}", role=${s.role}`);
    parts.push(`Remaining Pending Sites:\n${pendingLines.join('\n')}`);
  } else {
    parts.push(`Remaining Pending Sites: none`);
  }

  return parts.join('\n\n');
}

/**
 * Validate URL string and verify it does not use a restricted browser scheme.
 */
export function isValidExternalUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    return !RESTRICTED_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Find the highest numeric index among existing site IDs (e.g. s1, s2 -> 2).
 */
export function getHighestSiteIndex(sites: SiteSpec[]): number {
  let highest = 0;
  for (const s of sites) {
    const match = /^s(\d+)$/.exec(s.id);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > highest) highest = idx;
    }
  }
  return highest;
}

/**
 * Parse and sanitize the LLM's reflection response.
 */
export function parseReflectResponse(
  rawText: string,
  existingSites: SiteSpec[],
  maxSites = 8
): ReflectDecision {
  let parsed: any;
  try {
    const cleaned = (rawText || '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      parsed = JSON.parse(cleaned);
    }
  } catch {
    return {
      decision: 'continue',
      reason: 'Failed to parse reflection JSON, continuing existing plan.',
      changes: '',
    };
  }

  const rawDecision = String(parsed.decision || '').toLowerCase().trim();
  const decision: 'continue' | 'replan' | 'stop_early' =
    rawDecision === 'stop_early' ? 'stop_early' : rawDecision === 'replan' ? 'replan' : 'continue';

  const reason = String(parsed.reason || parsed.explanation || '').trim() || 'Reflection step completed.';
  const changes = String(parsed.changes || '').trim();

  if (decision !== 'replan') {
    return {
      decision,
      reason,
      changes,
    };
  }

  // Sanitizing dropSites: only sites that exist and are not yet executed can be dropped.
  // We identify pending sites by filtering out sites that are completed in caller or by spec.
  const rawDrop: any[] = Array.isArray(parsed.drop_sites)
    ? parsed.drop_sites
    : Array.isArray(parsed.dropSites)
    ? parsed.dropSites
    : Array.isArray(parsed.drop)
    ? parsed.drop
    : [];

  const existingIds = new Set(existingSites.map((s) => s.id));
  const validDropSites = rawDrop
    .map((id) => String(id).trim())
    .filter((id) => existingIds.has(id));

  // Sanitizing addSites
  const rawAdd: any[] = Array.isArray(parsed.add_sites)
    ? parsed.add_sites
    : Array.isArray(parsed.addSites)
    ? parsed.addSites
    : Array.isArray(parsed.add)
    ? parsed.add
    : [];

  let nextIndex = getHighestSiteIndex(existingSites);
  const sanitizedAddSites: SiteSpec[] = [];
  const currentTotal = existingSites.length - validDropSites.length;

  for (const raw of rawAdd) {
    if (currentTotal + sanitizedAddSites.length >= maxSites) {
      break; // Clamp to max sites
    }

    if (!raw || typeof raw !== 'object') continue;

    const domain = String(raw.domain || '').toLowerCase().trim();
    if (!domain || domain.includes('/') || domain.includes(' ')) continue;

    let startUrl: string | undefined = undefined;
    if (raw.startUrl || raw.url) {
      const candidateUrl = String(raw.startUrl || raw.url).trim();
      if (isValidExternalUrl(candidateUrl)) {
        startUrl = candidateUrl;
      }
    }

    nextIndex += 1;
    const siteId = `s${nextIndex}`;

    const rawFields = raw.required_fields || raw.requiredFields || raw.fields || raw.criteria?.fields;
    let fields: Array<{ name: string; required: boolean }>;
    if (Array.isArray(rawFields) && rawFields.length > 0) {
      fields = rawFields.map((f: any) => ({
        name: typeof f === 'string' ? f.toLowerCase().replace(/[^a-z0-9_]/g, '_') : String(f.name || 'value').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        required: f.required !== false,
      }));
    } else {
      const refSite = existingSites.find((s) => s.role === 'reference') || existingSites[0];
      fields = refSite?.criteria?.fields && refSite.criteria.fields.length > 0
        ? refSite.criteria.fields
        : [{ name: 'value', required: true }];
    }

    const newSite: SiteSpec = {
      id: siteId,
      name: String(raw.name || domain).trim(),
      domain,
      goal: String(raw.goal || `Investigate ${domain}`).trim(),
      goalKind: 'collect',
      role: raw.role === 'reference' ? 'reference' : 'compare',
      kind: (raw.kind === 'listing' || raw.kind === 'search' || raw.kind === 'page') ? raw.kind : 'store',
      difficulty: (raw.difficulty === 1 || raw.difficulty === 2 || raw.difficulty === 3) ? raw.difficulty : 1,
      namedByUser: false,
      criteria: {
        fields,
        doneWhen: 'all_required',
      },
      ...(startUrl ? { startUrl } : {}),
    };

    sanitizedAddSites.push(newSite);
  }

  return {
    decision: 'replan',
    reason,
    changes: changes || `Dropped ${validDropSites.length} site(s), added ${sanitizedAddSites.length} site(s).`,
    dropSites: validDropSites,
    addSites: sanitizedAddSites,
  };
}
