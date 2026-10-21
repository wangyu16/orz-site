/**
 * Site paths (spec §2.1): relative, POSIX, NFC, no empty / `.` / `..`
 * segment, no leading `/`, no NUL, no `\`. Pure string work; no Node.
 */

/** Why a string is not a site path, or null when it is one. */
export function sitePathProblem(p: string): string | null {
  if (p === '') return 'an empty path';
  if (p.includes('\0')) return 'a NUL character';
  if (p.includes('\\')) return 'a backslash';
  if (p.startsWith('/')) return 'an absolute path';
  if (/^[A-Za-z]:/.test(p)) return 'a drive letter';
  if (p !== p.normalize('NFC')) return 'not NFC';
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p)) return 'not valid Unicode';
  for (const seg of p.split('/')) {
    if (seg === '') return 'an empty segment';
    if (seg === '.' || seg === '..') return `a "${seg}" segment`;
  }
  return null;
}

/** Order of paths and keys everywhere in the output: UTF-16 code units (never locale). */
export const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The folder of a site path ('' for the root). */
export const dirOf = (p: string): string => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

/** The last segment. */
export const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * Resolve a relative reference against a folder of the site: a site path, or
 * null when it leaves the root. A leading `/` resolves from the site root.
 * Backslashes count as separators (the kit's file-include reader does so).
 */
export function resolveIn(folder: string, ref: string): string | null {
  const parts = ref.replace(/\\/g, '/').startsWith('/') ? [] : folder.split('/').filter(Boolean);
  for (const seg of ref.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}

/** The relative path from a folder to a site path (for links in generated text). */
export function relativeFrom(folder: string, to: string): string {
  const a = folder.split('/').filter(Boolean);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** Percent-encode each segment of a site path for a URL (RFC 3986 unreserved kept). */
export const encodePath = (p: string): string => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/** Decode a URL path (percent escapes) — or return it as is when malformed. */
export function decodePath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}
