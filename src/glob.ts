/**
 * Globs (spec §3.6), orz-site's own tiny matcher so the output never depends
 * on another package's version: `*` any characters but `/`, `**` any depth,
 * `?` one character but `/`; a pattern ending in `/` means that folder and
 * everything under it. No negation, no braces, no character classes; every
 * other character matches itself. Matched against whole site paths.
 */

/** Why a pattern is not a glob orz-site accepts, or null. */
export function globProblem(pattern: string): string | null {
  if (pattern === '') return 'an empty pattern';
  if (pattern.startsWith('!')) return 'negation (!) is not supported';
  if (/[{}[\]]/.test(pattern)) return 'braces and character classes are not supported';
  if (pattern.startsWith('/')) return 'patterns are relative to the site root (no leading /)';
  if (pattern.includes('\\')) return 'use / as the separator';
  return null;
}

const cache = new Map<string, RegExp>();

/** The regular expression of a glob. */
export function globRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const p = pattern.endsWith('/') ? `${pattern}**` : pattern;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } // `**/`: zero or more folders
        else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`, 'u');
  cache.set(pattern, out);
  return out;
}

/** True when the site path matches one of the globs. */
export const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((g) => globRegExp(g).test(path));
