/**
 * Small deterministic helpers: SHA-256 of bytes (WebCrypto, present in Node
 * ≥ 20 and every browser), canonical JSON (sorted keys, two-space indents, a
 * final LF — spec §3.7), UTF-8.
 */
import { byCodeUnits } from './paths.js';

const encoder = new TextEncoder();
export const utf8 = (s: string): Uint8Array => encoder.encode(s);

/** Lower-case hex SHA-256 of bytes or of a string's UTF-8. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A value with every object's keys sorted by UTF-16 code units (arrays keep their order). */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort(byCodeUnits)) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** Canonical JSON: sorted keys, two-space indents, a final LF. */
export const canonicalJson = (v: unknown): string => `${JSON.stringify(sortKeys(v), null, 2)}\n`;

/** Byte equality. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
