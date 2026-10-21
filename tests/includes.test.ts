/**
 * Claim S.8 — includes per allowlist (spec §2.5), with a local HTTP server
 * standing in for an allowed host: the default fetcher (https only, no
 * redirects, size and time limits) runs against real HTTP responses through
 * a transport that maps https://allowed.test/ to the server.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { extract } from 'orz-markdown/carrier';
import { includeRecordEnv } from 'orz-markdown/carrier/editor';
import { resolveFileIncludes } from 'orz-markdown/carrier/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite } from '../src/build.js';
import { defaultFetch, MAX_INCLUDE_CHARS } from '../src/includes.js';
import { cfg, dec, env, mapOf, tempDir, text } from './helpers.js';

let server: Server;
let origin = '';
const hits = new Map<string, number>();
beforeAll(async () => {
  server = createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    hits.set(p, (hits.get(p) ?? 0) + 1);
    if (p === '/a.md') { res.end('From A. {{markdown https://allowed.test/nested.md}}\n'); return; }
    if (p === '/nested.md') { res.end('Nested *B*.\n\n{{md https://evil.test/deep.md}}\n'); return; }
    if (p === '/plain.md') { res.end('Plain include.\n'); return; }
    if (p === '/redirect.md') { res.statusCode = 302; res.setHeader('location', '/plain.md'); res.end(); return; }
    if (p === '/big.md') { res.setHeader('content-type', 'text/markdown'); res.end('x'.repeat(MAX_INCLUDE_CHARS * 3 + 10)); return; }
    if (p === '/slow.md') { setTimeout(() => res.end('late'), 2_000); return; }
    if (p === '/error.md') { res.statusCode = 500; res.end('boom'); return; }
    res.statusCode = 404; res.end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The transport: https://allowed.test/… → the local server (http on the loopback), redirects untouched. */
const transport: typeof fetch = (input, init) => fetch(String(input).replace('https://allowed.test', origin), init);
const fetcher = (o: { timeoutMs?: number } = {}) => defaultFetch({ fetchImpl: transport, ...o });
const site = (body: string, extra: Record<string, string> = {}) => mapOf({ 'a.md': text('A', body), ...extra });
const config = (o: Record<string, unknown> = {}) => cfg({ baseUrl: 'https://owner.github.io/course/', sitemap: false, includes: { allowedHosts: ['allowed.test'] }, ...o });
const codes = (r: Awaited<ReturnType<typeof buildSite>>) => r.report.errors.map((e) => [e.code, e.target]);

describe('[S.8] includes per allowlist', () => {
  it('an allowed host is fetched once per build; nested URL includes get their own record keys; hashes in the manifest', async () => {
    hits.clear();
    const files = mapOf({ 'a.md': text('A', '{{md https://allowed.test/plain.md}}'), 'b.md': text('B', '{{md https://allowed.test/plain.md}}\n\n{{markdown https://allowed.test/a.md}}') });
    const r = await buildSite(files, config({ includes: { allowedHosts: ['allowed.test'], missing: 'warn' } }), await env({ fetch: fetcher() }));
    expect(hits.get('/plain.md')).toBe(1);
    expect(hits.get('/a.md')).toBe(1);
    expect(hits.get('/nested.md')).toBe(1);
    expect(hits.has('/deep.md')).toBe(false);
    const rec = extract(dec(r.files.get('b.md.html')))?.includes;
    expect(Object.keys(rec ?? {}).sort()).toEqual(['https://allowed.test/a.md', 'https://allowed.test/nested.md', 'https://allowed.test/plain.md']);
    const doc = r.manifest.documents.find((d) => d.path === 'b.md');
    expect(doc?.includes.map((i) => [i.target, i.from])).toEqual([['https://allowed.test/a.md', 'network'], ['https://allowed.test/nested.md', 'network'], ['https://allowed.test/plain.md', 'network']]);
    expect(doc?.includes.every((i) => /^[0-9a-f]{64}$/.test(i.sha256))).toBe(true);
    // the nested include on a host that is not allowed is reported (a warning here, missing: "warn")
    expect(r.report.warnings.map((w) => [w.code, w.target])).toEqual([['include-host', 'https://evil.test/deep.md']]);
  });

  it('own-host URLs are read from the file map with no network call; an output name is include-own-output', async () => {
    let calls = 0;
    const counting = async (u: string) => { calls++; return fetcher()(u); };
    const r = await buildSite(site('{{md https://owner.github.io/course/shared/g.md}}', { 'shared/g.md': 'Glossary' }), config({ exclude: ['shared/'] }), await env({ fetch: counting, offline: true }));
    expect(r.ok).toBe(true);
    expect(calls).toBe(0);
    expect(extract(dec(r.files.get('a.md.html')))?.includes).toEqual({ 'https://owner.github.io/course/shared/g.md': 'Glossary' });
    const o = await buildSite(site('{{md https://owner.github.io/course/b.md.html}}', { 'b.md': text('B', '# B') }), config(), await env({ fetch: counting }));
    expect(codes(o)).toEqual([['include-own-output', 'https://owner.github.io/course/b.md.html']]);
    const m = await buildSite(site('{{md https://owner.github.io/course/nope.md}}'), config(), await env({ fetch: counting }));
    expect(codes(m)).toEqual([['include-missing', 'https://owner.github.io/course/nope.md']]);
    expect(calls).toBe(0);
  });

  const refusals: Array<[string, string, string, Record<string, unknown>]> = [
    ['a host not in allowedHosts', 'https://evil.test/x.md', 'include-host', {}],
    ['http: on an allowed host', 'http://allowed.test/plain.md', 'include-host', {}],
    ['a redirect', 'https://allowed.test/redirect.md', 'include-host', {}],
    ['an oversize body', 'https://allowed.test/big.md', 'include-too-large', {}],
    ['a 404', 'https://allowed.test/gone.md', 'include-missing', {}],
    ['a server error', 'https://allowed.test/error.md', 'include-network', {}],
    ['includes.network false', 'https://allowed.test/plain.md', 'include-network', { includes: { allowedHosts: ['allowed.test'], network: false } }],
  ];
  for (const [what, url, code, o] of refusals) {
    it(`${what} → ${code} (an error by default; with missing "warn" a warning)`, async () => {
      const r = await buildSite(site(`{{md ${url}}}`), config(o), await env({ fetch: fetcher() }));
      expect(codes(r)).toEqual([[code, url]]);
      expect(r.files.size).toBe(0);
      const w = await buildSite(site(`{{md ${url}}}`), config({ ...o, includes: { allowedHosts: ['allowed.test'], missing: 'warn', ...((o['includes'] as object | undefined) ?? {}) } }), await env({ fetch: fetcher() }));
      expect(w.ok).toBe(true);
      expect(w.report.warnings.map((x) => x.code)).toEqual([code]);
      expect(extract(dec(w.files.get('a.md.html')))?.includes).toBeUndefined();
    });
  }

  it('--offline refuses a network include without a request (include-network)', async () => {
    hits.clear();
    const r = await buildSite(site('{{md https://allowed.test/plain.md}}'), config(), await env({ fetch: fetcher(), offline: true }));
    expect(codes(r)).toEqual([['include-network', 'https://allowed.test/plain.md']]);
    expect(hits.size).toBe(0);
  });

  it('a fetch that takes longer than the limit is include-network', async () => {
    const r = await buildSite(site('{{md https://allowed.test/slow.md}}'), config(), await env({ fetch: fetcher({ timeoutMs: 300 }) }));
    expect(codes(r)).toEqual([['include-network', 'https://allowed.test/slow.md']]);
  });

  it('file includes: the record equals what the carrier CLI stores (the kit\'s resolveFileIncludes)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'parts'));
    const t = text('A', '{{md parts/one.md}}\n\n{{md ./parts/two.md}}\n\n`{{md parts/not-in-code.md}}`');
    writeFileSync(join(dir, 'a.md'), t);
    writeFileSync(join(dir, 'parts', 'one.md'), 'One\r\nwith CRLF\n');
    writeFileSync(join(dir, 'parts', 'two.md'), '﻿Two with a BOM\n');
    const cli = resolveFileIncludes(t, dir).includes;
    const r = await buildSite(mapOf({ 'a.md': t, 'parts/one.md': 'One\r\nwith CRLF\n', 'parts/two.md': '﻿Two with a BOM\n' }), config({ exclude: ['parts/'] }), await env());
    expect(r.ok).toBe(true);
    expect(extract(dec(r.files.get('a.md.html')))?.includes).toEqual(cli);
    expect(Object.keys(cli)).toEqual(['parts/one.md', './parts/two.md']);
  });

  it('a missing file include is include-missing; one leaving the root is outside-root', async () => {
    const r = await buildSite(mapOf({ 'n/a.md': text('A', '{{md nope.md}}\n\n{{md ../../etc/passwd}}') }), config(), await env());
    expect(codes(r)).toEqual([['include-missing', 'nope.md'], ['outside-root', '../../etc/passwd']]);
  });

  it('include-key-clash: two targets that are one record key on the page with different files', async () => {
    // the kit's own record reader maps both to /a.md: the page could show only one of them
    const kitEnv = includeRecordEnv({ '../a.md': 'ROOT', 'a.md': 'NOTES' });
    expect(['ROOT', 'NOTES']).toContain(kitEnv.readFile?.('/a.md'));
    const r = await buildSite(mapOf({ 'notes/x.md': text('X', '{{md ../a.md}}\n\n{{md a.md}}'), 'a.md': 'ROOT', 'notes/a.md': 'NOTES' }), config({ exclude: ['a.md', 'notes/a.md'] }), await env());
    expect(codes(r)).toEqual([['include-key-clash', 'a.md']]);
    // the same file written two ways is no clash
    const same = await buildSite(mapOf({ 'notes/x.md': text('X', '{{md a.md}}\n\n{{md ./a.md}}'), 'notes/a.md': 'NOTES' }), config({ exclude: ['notes/a.md'] }), await env());
    expect(same.ok).toBe(true);
  });
});
