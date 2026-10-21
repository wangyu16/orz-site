/**
 * `orz-site.json` (spec §3): parse, validate (unknown keys are errors), apply
 * defaults. The config format (`format: 1`) is independent of the package
 * version. The published JSON Schema is `schema/site-1.json`; this validator
 * is the one the builder runs (no schema library: Node and the browser parse
 * the same way with no dependency), and a test keeps the two in agreement.
 */
import { globProblem } from './glob.js';
import { sitePathProblem } from './paths.js';
import { KINDS, type Finding, type Kind, type Naming, type SiteConfig } from './types.js';
import { VERSION } from './version.js';

/** The config file's name at the site root. */
export const CONFIG_FILE = 'orz-site.json';
/** The config formats this orz-site reads. */
export const CONFIG_FORMAT = 1;
/** The schema URL `init` writes into `$schema`. */
export const SCHEMA_URL = `https://cdn.jsdelivr.net/npm/orz-site@${VERSION.split('.').slice(0, 2).join('.')}/schema/site-1.json`;

/** The defaults of every key but `format` and `carriers` (§3.2). */
export function defaultConfig(): SiteConfig {
  return {
    format: 1,
    carriers: {},
    delivery: 'cdn',
    inline: [],
    naming: 'family',
    baseUrl: null,
    includes: { allowedHosts: [], network: true, missing: 'error' },
    links: { missing: 'error' },
    exclude: [],
    texts: true,
    index: { mode: 'auto', title: null, theme: null, lang: 'en' },
    sitemap: true,
    notFound: null,
  };
}

const TOP_KEYS = ['$schema', 'format', 'carriers', 'delivery', 'inline', 'naming', 'baseUrl', 'includes', 'links', 'exclude', 'texts', 'index', 'sitemap', 'notFound'] as const;
const INCLUDE_KEYS = ['allowedHosts', 'network', 'missing'] as const;
const LINK_KEYS = ['missing'] as const;
const INDEX_KEYS = ['mode', 'title', 'theme', 'lang'] as const;
/** An exact npm version (no range). */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const LANG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a naming template is not valid (§3.3), or null. */
export function templateProblem(t: string): string | null {
  const stems = t.split('{stem}').length - 1;
  if (stems !== 1) return 'must hold {stem} exactly once';
  const rest = t.replace('{stem}', '');
  if (!/^[A-Za-z0-9._-]*$/.test(rest)) return 'may hold only {stem} and the characters A-Z a-z 0-9 . _ -';
  if (!t.endsWith('.html')) return 'must end in .html';
  return null;
}

/** The result of {@link validateConfig}. */
export interface ConfigResult { config: SiteConfig | null; findings: Finding[] }

/**
 * Validate a parsed `orz-site.json` (any JSON value) and fill in the
 * defaults. Every problem is a finding with the key named; the config is
 * null when any is an error. A non-family `naming` that is valid is still
 * refused in 0.1 (`naming-needs-kit`, §4.2 option C): it needs the kit's
 * `twinLinks` option (K1), which ships later.
 */
export function validateConfig(raw: unknown, file = CONFIG_FILE): ConfigResult {
  const findings: Finding[] = [];
  const bad = (key: string, message: string, code = 'bad-config'): void => { findings.push({ code, message: `${key}: ${message}`, path: file, target: key }); };
  if (!isObject(raw)) {
    bad('(root)', 'the config must be a JSON object');
    return { config: null, findings };
  }
  const c = defaultConfig();
  const unknown = (obj: Record<string, unknown>, known: readonly string[], prefix: string): void => {
    for (const k of Object.keys(obj)) {
      if (!known.includes(k)) {
        findings.push({ code: 'unknown-key', message: `${prefix}${k}: not a key of orz-site.json format ${CONFIG_FORMAT} (known: ${known.join(', ')}); a misspelt key must not change what is published`, path: file, target: `${prefix}${k}` });
      }
    }
  };

  // format first: a newer format explains every unknown key after it
  if (!('format' in raw)) bad('format', `required (write "format": ${CONFIG_FORMAT})`);
  else if (typeof raw.format !== 'number' || !Number.isInteger(raw.format) || raw.format < 1) bad('format', `must be the integer ${CONFIG_FORMAT}`);
  else if (raw.format > CONFIG_FORMAT) {
    findings.push({ code: 'newer-config', message: `format ${raw.format} is newer than this orz-site ${VERSION} reads (format ${CONFIG_FORMAT}): install a newer orz-site`, path: file, target: 'format', next: { tool: 'npm', command: 'install', args: ['orz-site@latest'] } });
    return { config: null, findings };
  }
  unknown(raw, TOP_KEYS, '');

  if ('$schema' in raw && typeof raw.$schema !== 'string') bad('$schema', 'must be a string (a URL)');

  if ('carriers' in raw) {
    const v = raw.carriers;
    if (!isObject(v)) bad('carriers', 'must be an object of kind → exact version, e.g. { "md": "1.0.2" }');
    else {
      unknown(v, KINDS, 'carriers.');
      for (const k of KINDS) {
        if (!(k in v)) continue;
        const ver = v[k];
        if (typeof ver !== 'string' || !EXACT_VERSION.test(ver)) bad(`carriers.${k}`, `must be an exact version such as "1.0.0" (no range), got ${JSON.stringify(ver)}`);
        else c.carriers[k] = ver;
      }
    }
  }
  if ('delivery' in raw) {
    if (raw.delivery !== 'cdn' && raw.delivery !== 'inline') bad('delivery', 'must be "cdn" or "inline"');
    else c.delivery = raw.delivery;
  }
  const globs = (key: string, v: unknown): string[] | null => {
    if (!Array.isArray(v)) { bad(key, 'must be a list of globs'); return null; }
    const out: string[] = [];
    v.forEach((g, i) => {
      if (typeof g !== 'string') { bad(`${key}[${i}]`, 'must be a string'); return; }
      const p = globProblem(g);
      if (p) bad(`${key}[${i}]`, `${JSON.stringify(g)}: ${p}`);
      else out.push(g);
    });
    return out;
  };
  if ('inline' in raw) { const g = globs('inline', raw.inline); if (g) c.inline = g; }
  if ('exclude' in raw) { const g = globs('exclude', raw.exclude); if (g) c.exclude = g; }

  if ('naming' in raw) {
    const v = raw.naming;
    if (v === 'family') c.naming = 'family';
    else if (!isObject(v)) bad('naming', 'must be "family" or an object of per-kind templates, e.g. { "md": "{stem}.html" }');
    else {
      unknown(v, KINDS, 'naming.');
      const n: { md?: string; slides?: string; paged?: string } = {};
      let valid = true;
      for (const k of KINDS) {
        if (!(k in v)) continue;
        const t = v[k];
        const p = typeof t !== 'string' ? 'must be a string' : templateProblem(t);
        if (p) { bad(`naming.${k}`, `${JSON.stringify(t)} ${p}`); valid = false; } else n[k] = t as string;
      }
      if (valid) {
        c.naming = n;
        findings.push({
          code: 'naming-needs-kit',
          message: `naming: a non-family naming (${JSON.stringify(n)}) needs the kit's twinLinks option (K1, spec §13), which ships with carriers 1.1; orz-site ${VERSION} builds with "naming": "family" only (FC-18 twins: x.md → x.md.html)`,
          path: file,
          target: 'naming',
        });
      }
    }
  }
  if ('baseUrl' in raw) {
    const v = raw.baseUrl;
    if (v !== null) {
      const p = baseUrlProblem(v);
      if (p) bad('baseUrl', p); else c.baseUrl = v as string;
    }
  }
  if ('includes' in raw) {
    const v = raw.includes;
    if (!isObject(v)) bad('includes', 'must be an object');
    else {
      unknown(v, INCLUDE_KEYS, 'includes.');
      if ('allowedHosts' in v) {
        if (!Array.isArray(v.allowedHosts)) bad('includes.allowedHosts', 'must be a list of host names');
        else v.allowedHosts.forEach((h, i) => {
          if (typeof h !== 'string' || !HOST.test(h)) bad(`includes.allowedHosts[${i}]`, `${JSON.stringify(h)}: a lower-case host name, optionally with :port (no scheme, no path)`);
          else c.includes.allowedHosts.push(h);
        });
      }
      if ('network' in v) { if (typeof v.network !== 'boolean') bad('includes.network', 'must be true or false'); else c.includes.network = v.network; }
      if ('missing' in v) { if (v.missing !== 'error' && v.missing !== 'warn') bad('includes.missing', 'must be "error" or "warn"'); else c.includes.missing = v.missing; }
    }
  }
  if ('links' in raw) {
    const v = raw.links;
    if (!isObject(v)) bad('links', 'must be an object');
    else {
      unknown(v, LINK_KEYS, 'links.');
      if ('missing' in v) { if (v.missing !== 'error' && v.missing !== 'warn') bad('links.missing', 'must be "error" or "warn"'); else c.links.missing = v.missing; }
    }
  }
  if ('texts' in raw) { if (typeof raw.texts !== 'boolean') bad('texts', 'must be true or false'); else c.texts = raw.texts; }
  if ('sitemap' in raw) { if (typeof raw.sitemap !== 'boolean') bad('sitemap', 'must be true or false'); else c.sitemap = raw.sitemap; }
  if ('index' in raw) {
    const v = raw.index;
    if (!isObject(v)) bad('index', 'must be an object');
    else {
      unknown(v, INDEX_KEYS, 'index.');
      if ('mode' in v) { if (v.mode !== 'auto' && v.mode !== 'on' && v.mode !== 'off') bad('index.mode', 'must be "auto", "on" or "off"'); else c.index.mode = v.mode; }
      if ('title' in v) { if (v.title !== null && (typeof v.title !== 'string' || v.title.trim() === '')) bad('index.title', 'must be a non-empty string or null'); else c.index.title = v.title as string | null; }
      if ('theme' in v) { if (v.theme !== null && (typeof v.theme !== 'string' || !/^[a-z0-9-]+$/.test(v.theme))) bad('index.theme', 'must be a theme id (lower-case letters, digits, -) or null'); else c.index.theme = v.theme as string | null; }
      if ('lang' in v) { if (typeof v.lang !== 'string' || !LANG.test(v.lang)) bad('index.lang', 'must be a BCP 47 language tag such as "en"'); else c.index.lang = v.lang; }
    }
  }
  if ('notFound' in raw) {
    const v = raw.notFound;
    if (v !== null) {
      if (typeof v !== 'string' || sitePathProblem(v) !== null || v.includes('/') || !/\.md$/.test(v)) bad('notFound', 'must be null or the file name of a text at the site root, e.g. "404.md"');
      else c.notFound = v;
    }
  }
  // every config finding is an error (unknown keys and naming-needs-kit too): no config, no build
  return { config: findings.length > 0 ? null : c, findings };
}

/** Why a value is not a base URL (absolute http(s), ending in `/`, no query or fragment), or null. */
export function baseUrlProblem(v: unknown): string | null {
  if (typeof v !== 'string') return 'must be a string or null';
  let u: URL;
  try { u = new URL(v); } catch { return `${JSON.stringify(v)} is not an absolute URL`; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'must be an http(s) URL';
  if (!v.endsWith('/')) return `must end in "/" (e.g. "${v}/")`;
  if (u.search || u.hash || v.includes('?') || v.includes('#')) return 'must not hold a query or fragment';
  if (u.username || u.password) return 'must not hold credentials';
  return null;
}

/** Parse `orz-site.json` bytes: the validated config, or findings. */
export function parseConfig(bytes: Uint8Array, file = CONFIG_FILE): ConfigResult {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    return { config: null, findings: [{ code: 'bad-config', message: 'the config is not valid UTF-8', path: file }] };
  }
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    return { config: null, findings: [{ code: 'bad-config', message: `the config is not valid JSON: ${(e as Error).message}`, path: file }] };
  }
  return validateConfig(raw, file);
}

/** The kinds a naming leaves at the family name. */
export const isFamily = (n: Naming): boolean => n === 'family';

export type { Kind };
