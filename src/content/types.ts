/**
 * Protocol types for Content Script <-> Background communication (Phase P3).
 */

export interface ResolvePointRequest {
  docId: string;
  element_id: number;
}

export interface ResolvePointSuccess {
  success: true;
  point: { x: number; y: number };
  tag: string;
  role?: string;
  text?: string;
}

export interface ResolvePointFailure {
  success: false;
  obscuredBy?: string;
  stale?: boolean;
  error: string;
}

export type ResolvePointResponse = ResolvePointSuccess | ResolvePointFailure;

export interface EffectProbeBaseline {
  url: string;
  mutCount: number;
  value: string;
  activeTag: string;
  activeId?: string;
}

export type EffectType = 'url_changed' | 'dom_changed' | 'value_set' | 'focus_changed' | 'none';

export interface EffectProbeResponse {
  success: boolean;
  effect: EffectType;
  error?: string;
}

export interface WaitDomQuietResponse {
  success: boolean;
  quiet: boolean;
  elapsedMs: number;
}

export interface ClearBadgesResponse {
  success: boolean;
}
