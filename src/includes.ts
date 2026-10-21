/**
 * Includes resolved at build time (spec §2.5) into each document's
 * `#orz-includes` record, passed to the carrier's `assemble({ includes })`.
 * The text keeps its directives.
 *
 * - file targets: from the file map, relative to the including text's folder,
 *   inside the root, one level (FC-07);
 * - URLs on the site's own host (under `baseUrl`): from the map, never the
 *   network;
 * - URLs on an allowed host: fetched (https only, no redirects, 15 s,
 *   5 000 000 characters), each URL once per build, nested URL includes up to
 *   depth 3 through the kit's `prepareSources` with a recording fetcher — so
 *   the record holds exactly the URLs the page's own `prepareSources` will
 *   look up;
 * - anything else: `include-host`.
 */
import { decodeText } from 'orz-markdown/carrier';
import { prepareSources } from 'orz-markdown';
import { dirOf, decodePath, resolveIn } from './paths.js';
import type { Finding, IncludeFetch, ManifestInclude, SiteConfig } from './types.js';
import { sha256Hex, utf8 } from './util.js';

/** The kit's limits (prepareSources defaults). */
export const MAX_INCLUDE_CHARS = 5_000_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_URL_DEPTH = 3;

/** A refused network include (thrown by a fetcher). */
export class IncludeFetchError extends Error {
  readonly code: 'include-host' | 'include-network' | 'include-too-large' | 'include-missing';
  constructor(code: IncludeFetchError['code'], message: string) { super(message); this.code = code; }
}

/** A URL target (`scheme://…`), as the kit's `isUrl`. */
export const isUrl = (t: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(t);

/**
 * The default fetcher of network includes: https only, redirects refused,
 * 15 s, 5 000 000 characters. `fetchImpl` is the transport (default: the
 * global `fetch`; tests pass one that reaches a local server).
 */
export function defaultFetch(o: { fetchImpl?: typeof fetch; timeoutMs?: number; maxChars?: number } = {}): IncludeFetch {
  const impl = o.fetchImpl ?? globalThis.fetch;
  const timeoutMs = o.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxChars = o.maxChars ?? MAX_INCLUDE_CHARS;
  return async (url: string) => {
    let u: URL;
    try { u = new URL(url); } catch { throw new IncludeFetchError('include-host', 'not a URL'); }
    if (u.protocol !== 'https:') throw new IncludeFetchError('include-host', `${u.protocol} is refused: network includes are fetched over https only`);
    let res: Response;
    try {
      res = await impl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' } });
    } catch (e) {
      const name = (e as Error).name;
      throw new IncludeFetchError('include-network', name === 'TimeoutError' || name === 'AbortError' ? `no answer within ${timeoutMs / 1000} s` : `the fetch failed (${(e as Error).message})`);
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      throw new IncludeFetchError('include-host', `the server answers with a redirect (${res.status || 'opaque'}${res.headers.get('location') ? ` to ${res.headers.get('location')}` : ''}); redirects are refused — include the final URL`);
    }
    if (res.status === 404 || res.status === 410) { await res.body?.cancel().catch(() => undefined); return null; }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new IncludeFetchError('include-network', `HTTP ${res.status}`); }
    const declared = Number(res.headers.get('content-length') ?? 'NaN');
    const maxBytes = maxChars * 3;
    if (Number.isFinite(declared) && declared > maxBytes) { await res.body?.cancel().catch(() => undefined); throw new IncludeFetchError('include-too-large', `${declared} bytes, more than ${maxChars} characters can take`); }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new IncludeFetchError('include-too-large', `more than ${maxChars} characters`); }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    return bytes;
  };
}

/** A file target on the record reader's virtual root (as the kit's `includeRecordEnv` normalizes it). */
export function rootKey(target: string): string {
  const out: string[] = [];
  for (const seg of target.replace(/^[A-Za-z]:/, '').split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** The parser env of a record (the kit's `includeRecordEnv`, orz-markdown/carrier/editor; reimplemented to keep the editor entry out of the core). */
function recordEnv(record: Readonly<Record<string, string>>): { markdownBasePath: string; readFile(p: string): string | null } {
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(record)) if (!isUrl(k)) files.set(rootKey(k), v);
  return { markdownBasePath: '/', readFile: (p: string) => files.get(rootKey(p)) ?? null };
}

/** What a URL fetch gave, cached per build. */
type Fetched = { ok: true; text: string; bytes: Uint8Array; from: 'own-host' | 'network' } | { ok: false; code: string; message: string };

/** Build-wide include state: one fetch per URL. */
export interface IncludeContext {
  files: ReadonlyMap<string, Uint8Array>;
  config: SiteConfig;
  baseUrl: string | null;
  offline: boolean;
  fetch: IncludeFetch;
  includeTargets(text: string): string[];
  cache: Map<string, Promise<Fetched>>;
}

/** What one document's includes resolved to. */
export interface ResolvedDocumentIncludes {
  record: Record<string, string>;
  manifest: ManifestInclude[];
  findings: Finding[];
  /** The texts of the file includes (for the link check). */
  fileTexts: string[];
}

/** Where a URL comes from under this site's rules. */
function classify(url: string, ctx: IncludeContext): { from: 'own-host'; path: string } | { from: 'network' } | { from: 'refused'; code: string; message: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { from: 'refused', code: 'include-host', message: 'not a valid URL' }; }
  if (ctx.baseUrl) {
    const base = new URL(ctx.baseUrl);
    if (u.origin === base.origin && u.pathname.startsWith(base.pathname)) return { from: 'own-host', path: decodePath(u.pathname.slice(base.pathname.length)) };
  }
  const allowed = ctx.config.includes.allowedHosts.includes(u.host.toLowerCase());
  if (!allowed) return { from: 'refused', code: 'include-host', message: `${u.host} is not the site's own host${ctx.baseUrl ? ` (${new URL(ctx.baseUrl).host})` : ' (no baseUrl)'} and not in includes.allowedHosts` };
  if (u.protocol !== 'https:') return { from: 'refused', code: 'include-host', message: `${u.protocol} is refused: network includes are fetched over https only` };
  if (ctx.offline || !ctx.config.includes.network) return { from: 'refused', code: 'include-network', message: ctx.offline ? 'offline (--offline): network includes are not fetched' : 'includes.network is false: network includes are not fetched' };
  return { from: 'network' };
}

async function fetchUrl(url: string, ctx: IncludeContext): Promise<Fetched> {
  const hit = ctx.cache.get(url);
  if (hit) return hit;
  const p = (async (): Promise<Fetched> => {
    const c = classify(url, ctx);
    if (c.from === 'refused') return { ok: false, code: c.code, message: c.message };
    if (c.from === 'own-host') {
      if (/\.html?$/i.test(c.path)) return { ok: false, code: 'include-own-output', message: `${c.path} is an output name on the site's own host; include the text (its .md twin) instead` };
      const bytes = ctx.files.get(c.path);
      if (!bytes) return { ok: false, code: 'include-missing', message: `the site's own host: ${c.path || '(the root)'} is not a file of the site` };
      return decoded(bytes, 'own-host');
    }
    try {
      const bytes = await ctx.fetch(url);
      if (bytes === null) return { ok: false, code: 'include-missing', message: 'not found (the server answered 404)' };
      return decoded(bytes, 'network');
    } catch (e) {
      if (e instanceof IncludeFetchError) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: 'include-network', message: `the fetch failed (${(e as Error).message})` };
    }
  })();
  ctx.cache.set(url, p);
  return p;
}

function decoded(bytes: Uint8Array, from: 'own-host' | 'network'): Fetched {
  let text: string;
  try { text = decodeText(bytes, { fatal: true }); } catch { return { ok: false, code: 'include-missing', message: 'not valid UTF-8 text' }; }
  if (text.length > MAX_INCLUDE_CHARS) return { ok: false, code: 'include-too-large', message: `${text.length} characters, more than ${MAX_INCLUDE_CHARS}` };
  return { ok: true, text, bytes, from };
}

/** Codes that follow `includes.missing` (error by default, warning with "warn"); the rest are always errors. */
const SOFT = new Set(['include-missing', 'include-host', 'include-network', 'include-too-large', 'not-utf8']);
export const isSoftInclude = (code: string): boolean => SOFT.has(code);

/** Resolve one document's includes. */
export async function resolveIncludes(docPath: string, text: string, ctx: IncludeContext): Promise<ResolvedDocumentIncludes> {
  const record: Record<string, string> = {};
  const manifest: ManifestInclude[] = [];
  const findings: Finding[] = [];
  const fileTexts: string[] = [];
  const problem = (code: string, target: string, message: string): void => { findings.push({ code, path: docPath, target, message: `{{… ${target}}}: ${message}` }); };
  const targets = ctx.includeTargets(text);
  const byRootKey = new Map<string, { target: string; text: string }>();

  for (const target of targets) {
    if (isUrl(target)) continue;
    const site = resolveIn(dirOf(docPath), target);
    if (site === null || site === '') { problem('outside-root', target, 'the file include leaves the site root; it is not read'); continue; }
    const bytes = ctx.files.get(site);
    if (!bytes) { problem('include-missing', target, `no such file in the site (${site})`); continue; }
    let t: string;
    try { t = decodeText(bytes, { fatal: true }); } catch { problem('not-utf8', target, `${site} is not valid UTF-8`); continue; }
    if (t.length > MAX_INCLUDE_CHARS) { problem('include-too-large', target, `${site}: ${t.length} characters, more than ${MAX_INCLUDE_CHARS}`); continue; }
    const key = rootKey(target);
    const prior = byRootKey.get(key);
    if (prior && prior.text !== t) {
      problem('include-key-clash', target, `this include and {{… ${prior.target}}} are one record key (${key}) on the page's virtual root but name different files; write both the same way relative to one folder`);
      continue;
    }
    byRootKey.set(key, { target, text: t });
    record[target] = t;
    fileTexts.push(t);
    manifest.push({ target, from: 'file', sha256: await sha256Hex(bytes) });
  }

  // URLs: every top-level target classified (prepareSources silently keeps a directive on a host it may not fetch)
  const attempted = new Set<string>();
  const reported = new Set<string>();
  const record_ = async (url: string): Promise<string | null> => {
    attempted.add(url);
    const got = await fetchUrl(url, ctx);
    if (!got.ok) {
      if (!reported.has(url)) { reported.add(url); problem(got.code, url, got.message); }
      return null;
    }
    if (!(url in record)) {
      record[url] = got.text;
      manifest.push({ target: url, from: got.from, sha256: await sha256Hex(got.bytes) });
    }
    return got.text;
  };
  const urlTargets = targets.filter(isUrl);
  if (urlTargets.length > 0) {
    const hosts = new Set(ctx.config.includes.allowedHosts);
    if (ctx.baseUrl) hosts.add(new URL(ctx.baseUrl).host);
    const fileRecord = { ...record };
    await prepareSources(text, {
      fetcher: record_,
      allowedHosts: [...hosts].sort(),
      includeEnv: recordEnv(fileRecord),
      maxDepth: MAX_URL_DEPTH,
      maxSize: MAX_INCLUDE_CHARS,
    });
    for (const url of urlTargets) if (!attempted.has(url)) await record_(url);
    // nested URL includes on a host prepareSources would not fetch
    for (const [url, body] of Object.entries(record)) {
      if (!isUrl(url)) continue;
      for (const nested of ctx.includeTargets(body)) {
        if (!isUrl(nested) || attempted.has(nested) || reported.has(nested)) continue;
        const c = classify(nested, ctx);
        if (c.from === 'refused') { reported.add(nested); problem(c.code, nested, `${c.message} (included by ${url})`); }
      }
    }
  }
  manifest.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return { record, manifest, findings, fileTexts };
}

/** SHA-256 of a record (sorted keys), for the incremental key. */
export async function recordHash(record: Readonly<Record<string, string>>): Promise<string> {
  const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(utf8(JSON.stringify(keys.map((k) => [k, record[k]]))));
}
