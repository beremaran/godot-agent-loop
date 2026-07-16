import type { ToolResponse } from './utils.js';

/**
 * Observation payloads are duplicated into structuredContent during the MCP
 * compatibility window. Keeping the legacy data block comfortably below this
 * limit prevents an ordinary inspection from consuming an entire context
 * window while leaving room for the structured envelope.
 */
export const OBSERVATION_RESPONSE_LIMIT_BYTES = 256 * 1024;

export interface ObservationResultOptions {
  limitBytes?: number;
  preferredArrayKeys: readonly string[];
  returnedCount: (payload: Record<string, unknown>) => number;
  refinement: string;
  continuation?: string;
  sourceTruncated?: (payload: Record<string, unknown>) => boolean;
}

interface ObservationMetadata extends Record<string, unknown> {
  responseBytes: number;
  limitBytes: number;
  returnedCount: number;
  truncated: boolean;
  refinement: string;
  continuation?: string;
}

/**
 * Produce a compact, byte-measured observation response. Arrays are trimmed
 * from the end in deterministic key order, then oversized strings are clipped
 * as a last resort. Every reduction is disclosed with a concrete refinement or
 * continuation path; callers never receive silent truncation.
 */
export function createBoundedObservationResponse(
  source: Record<string, unknown>,
  options: ObservationResultOptions,
): ToolResponse {
  const limitBytes = options.limitBytes ?? OBSERVATION_RESPONSE_LIMIT_BYTES;
  const payload = structuredClone(source);
  const sourceTruncated = options.sourceTruncated?.(payload) === true;
  const observation: ObservationMetadata = {
    responseBytes: 0,
    limitBytes,
    returnedCount: options.returnedCount(payload),
    truncated: sourceTruncated,
    refinement: options.refinement,
    ...(sourceTruncated && options.continuation ? { continuation: options.continuation } : {}),
  };
  payload.observation = observation;

  let locallyTruncated = false;
  while (serializedBytes(payload) > limitBytes) {
    if (removePreferredArrayItem(payload, options.preferredArrayKeys)) {
      locallyTruncated = true;
      continue;
    }
    if (clipLongestString(payload, Math.max(0, serializedBytes(payload) - limitBytes))) {
      locallyTruncated = true;
      continue;
    }
    break;
  }

  observation.returnedCount = options.returnedCount(payload);
  observation.truncated = sourceTruncated || locallyTruncated;
  if (observation.truncated && options.continuation) observation.continuation = options.continuation;
  stabilizeResponseBytes(payload, observation);

  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

function stabilizeResponseBytes(payload: Record<string, unknown>, metadata: ObservationMetadata): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = serializedBytes(payload);
    if (metadata.responseBytes === bytes) return;
    metadata.responseBytes = bytes;
  }
}

function removePreferredArrayItem(value: unknown, preferredKeys: readonly string[]): boolean {
  for (const preferredKey of preferredKeys) {
    const arrays: unknown[][] = [];
    collectArraysForKey(value, preferredKey, arrays);
    for (let index = arrays.length - 1; index >= 0; index -= 1) {
      if (arrays[index].length > 0) {
        arrays[index].pop();
        return true;
      }
    }
  }
  return false;
}

function collectArraysForKey(value: unknown, preferredKey: string, arrays: unknown[][]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectArraysForKey(item, preferredKey, arrays);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'observation') continue;
    if (key === preferredKey && Array.isArray(item)) arrays.push(item);
    collectArraysForKey(item, preferredKey, arrays);
  }
}

function clipLongestString(value: unknown, excessBytes: number): boolean {
  let owner: Record<string, unknown> | unknown[] | null = null;
  let ownerKey: string | number = '';
  let longest = '';

  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => {
        if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > Buffer.byteLength(longest, 'utf8')) {
          owner = candidate;
          ownerKey = index;
          longest = item;
        } else {
          visit(item);
        }
      });
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === 'observation') continue;
      if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > Buffer.byteLength(longest, 'utf8')) {
        owner = candidate as Record<string, unknown>;
        ownerKey = key;
        longest = item;
      } else {
        visit(item);
      }
    }
  };
  visit(value);
  if (!owner || longest.length === 0) return false;

  const marker = '…[truncated]';
  const targetBytes = Math.max(Buffer.byteLength(marker, 'utf8'), Buffer.byteLength(longest, 'utf8') - Math.max(1, excessBytes));
  let clipped = longest;
  while (clipped.length > 0 && Buffer.byteLength(`${clipped}${marker}`, 'utf8') > targetBytes) {
    clipped = clipped.slice(0, Math.max(0, clipped.length - Math.max(1, Math.ceil(clipped.length / 8))));
  }
  (owner as Record<string | number, unknown>)[ownerKey] = `${clipped}${marker}`;
  return true;
}
