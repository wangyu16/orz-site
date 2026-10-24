/**
 * The core on the course fixture and on small file maps: claims S.1
 * (determinism), S.3 (no text lost), S.4 (incremental = full), S.5 (links),
 * S.6 (pins and delivery), S.7 (collisions), S.10 (excludes), S.12 (the
 * index's text) and the document rules of spec §2.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { extract, storedText, twinHref } from 'orz-markdown/carrier';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSite } from '../src/build.js';
import { linkTargets } from 'orz-markdown/carrier';
import { dirOf, resolveIn } from '../src/paths.js';
import type { BuildEnv, BuildResult, CarrierModule, Kind } from '../src/types.js';
import { cfg, dec, env, FIXTURE, K1, mapOf, NAMING, PINS, readFolder, ROOT, text } from './helpers.js';

const digest = (r: BuildResult): string => {
  const h = createHash('sha256');
  for (const [p, b] of r.files) { h.update(p); h.update('\0'); h.update(b); h.update('\0'); }
  h.update(JSON.stringify(r.report));
  return h.digest('hex');
};

let fixture: { files: Map<string, Uint8Array>; config: unknown };
let built: BuildResult;
beforeAll(async () => {
  fixture = readFolder(FIXTURE);
  built = await buildSite(fixture.files, fixture.config, await env());
  if (!built.ok) throw new Error(JSON.stringify(built.report.errors, null, 2));
});

describe('the course fixture', () => {
  it('builds green with every expected output', () => {
    expect(built.report.errors).toEqual([]);
    expect(built.report.warnings).toEqual([]);
    expect([...built.files.keys()]).toEqual([
      '.nojekyll', '404.html', '404.md', 'data/measurements.csv', 'handouts/lab-safety.paged.html', 'handouts/lab-safety.paged.md',
      'img/cell.svg', 'index.html', 'index.md', 'index.md.html', 'lessons/01-cells.md', 'lessons/01-cells.md.html',
      'lessons/02-membranes.md', 'lessons/02-membranes.md.html', 'lessons/03-energy.md', 'lessons/03-energy.md.html',
      'orz-site-manifest.json', 'sitemap.xml', 'slides/week1.slides.html', 'slides/week1.slides.md',
    ]);
    expect(built.report).toMatchObject({ ok: true, documents: 7, assets: 2, outputs: 20 });
  });

  it('[S.1] determinism: twice, another insertion order → the same bytes and report', async () => {
    const again = await buildSite(new Map([...fixture.files].reverse()), fixture.config, await env());
    expect(digest(again)).toBe(digest(built));
  });

  it('[S.1] determinism: another TZ, LANG and clock (a child process) → the same bytes and report', () => {
    const script = join(ROOT, 'tests', 'digest-fixture.ts');
    const run = (envVars: Record<string, string>, clock: string): string => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', join(ROOT, 'tests', 'clock.mjs'), script], { cwd: ROOT, env: { ...process.env, ...envVars, ORZ_TEST_CLOCK: clock }, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const a = run({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }, '2001-02-03T04:05:06Z');
    const b = run({ TZ: 'America/Los_Angeles', LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8' }, '2049-12-31T23:59:59Z');
    expect(a).toBe(b);
    expect(a).toBe(digest(built));
  });

  it('[S.3] no text lost: extract(output).text === storedText(input); published twins equal the input bytes', () => {
    for (const d of built.manifest.documents) {
      const input = dec(fixture.files.get(d.path));
      const x = extract(dec(built.files.get(d.output)));
      expect(x?.text, d.path).toBe(storedText(input, d.kind));
      expect(x?.kind).toBe(d.kind);
      expect(built.files.get(d.path)).toEqual(fixture.files.get(d.path));
    }
    const idx = built.manifest.generated.find((g) => g.path === 'index.html');
    expect(extract(dec(built.files.get('index.html')))?.text).toBe(idx?.source);
  });

  it('[S.5] every link the check accepts resolves to a file of the output (twinHref against the page)', () => {
    let checked = 0;
    for (const d of built.manifest.documents) {
      const t = dec(fixture.files.get(d.path));
      const record = extract(dec(built.files.get(d.output)))?.includes ?? {};
      const all = [...linkTargets(t), ...Object.entries(record).filter(([k]) => !/^\w+:\/\//.test(k)).flatMap(([, v]) => linkTargets(v))];
      for (const l of all) {
        if (l.kind === 'other' || l.raw) continue;
        const href = l.kind === 'twin' ? twinHref(l.href) : l.href;
        const path = decodeURIComponent(href.replace(/[?#].*$/, ''));
        const target = resolveIn(dirOf(d.output), path);
        expect(target, `${d.path}: ${l.href}`).not.toBeNull();
        expect(built.files.has(target as string), `${d.path}: ${l.href} → ${target}`).toBe(true);
        checked++;
      }
    }
    const idx = built.manifest.generated.find((g) => g.path === 'index.html')?.source as string;
    for (const l of linkTargets(idx)) { expect(built.files.has(decodeURIComponent(twinHref(l.href)))).toBe(true); checked++; }
    expect(checked).toBeGreaterThan(20);
  });

  it('[S.6] every output names the pinned shell and the configured delivery (inline globs honoured)', () => {
    for (const d of built.manifest.documents) {
      const x = extract(dec(built.files.get(d.output)));
      expect(x?.shell).toBe(PINS[d.kind as Kind]);
      expect(x?.delivery).toBe(d.path.startsWith('handouts/') ? 'inline' : 'cdn');
      expect(d.delivery).toBe(x?.delivery);
    }
    expect(extract(dec(built.files.get('index.html')))).toMatchObject({ shell: PINS.md, delivery: 'cdn' });
  });

  it('[S.14, family-naming half] every page equals the carrier\'s own assemble(text, { delivery, includes }) — no option of orz-site\'s own', async () => {
    const e = await env();
    for (const d of built.manifest.documents) {
      const x = extract(dec(built.files.get(d.output)));
      const again = await (e.carriers?.[d.kind] as CarrierModule).assemble(dec(fixture.files.get(d.path)), { delivery: d.delivery, ...(x?.includes ? { includes: x.includes } : {}) });
      expect(again === dec(built.files.get(d.output)), d.path).toBe(true);
    }
  });

  it('the manifest: includes with their origin and hash, skipped paths, generated files, sorted, canonical JSON', () => {
    const m = JSON.parse(dec(built.files.get('orz-site-manifest.json')));
    expect(m).toEqual(JSON.parse(JSON.stringify(built.manifest)));
    expect(dec(built.files.get('orz-site-manifest.json')).endsWith('}\n')).toBe(true);
    const home = built.manifest.documents.find((d) => d.path === 'index.md');
    expect(home?.includes.map((i) => [i.target, i.from])).toEqual([['shared/policies.md', 'file']]);
    const energy = built.manifest.documents.find((d) => d.path === 'lessons/03-energy.md');
    expect(energy?.includes.map((i) => [i.target, i.from])).toEqual([['https://owner.github.io/bio101/shared/glossary.md', 'own-host']]);
    expect(built.manifest.skipped).toEqual([{ path: 'drafts/week4.md', reason: 'excluded' }, { path: 'shared/glossary.md', reason: 'excluded' }, { path: 'shared/objectives-1.md', reason: 'excluded' }, { path: 'shared/policies.md', reason: 'excluded' }]);
    expect(built.manifest.documents.find((d) => d.path === '404.md')?.output).toBe('404.html');
    expect(built.manifest.generated.map((g) => g.path)).toEqual(['.nojekyll', 'index.html', 'sitemap.xml']);
    expect(built.manifest.generated.find((g) => g.path === 'index.html')?.text).toBeUndefined(); // index.md is the course home's text
  });

  it('the sitemap: one <url> per page (no 404), ISO dates as lastmod, no clock', () => {
    const xml = dec(built.files.get('sitemap.xml'));
    expect(xml.match(/<loc>/g)?.length).toBe(7);
    expect(xml).toContain('<loc>https://owner.github.io/bio101/lessons/01-cells.md.html</loc>\n    <lastmod>2026-09-02</lastmod>');
    expect(xml).not.toContain('404');
  });
});

describe('[S.4] incremental = full', () => {
  it('after a single-file change, an incremental build equals a full build, and reuses the unchanged pages', async () => {
    const e = await env();
    let calls = 0;
    const counting = Object.fromEntries(Object.entries(e.carriers ?? {}).map(([k, c]) => [k, { ...c, assemble: (t: string, o: Parameters<CarrierModule['assemble']>[1]) => { calls++; return (c as CarrierModule).assemble(t, o); } }])) as BuildEnv['carriers'];
    for (const change of ['lessons/02-membranes.md', 'shared/policies.md', 'img/cell.svg']) {
      const files = new Map(fixture.files);
      const old = dec(files.get(change));
      files.set(change, new TextEncoder().encode(`${old}\nChanged.\n`));
      const full = await buildSite(files, fixture.config, await env());
      calls = 0;
      const inc = await buildSite(files, fixture.config, { ...e, carriers: counting, previous: { manifest: built.manifest, files: built.files } });
      expect(digest(inc), change).toBe(digest(full));
      // only the changed text (or the text including the changed partial) is re-assembled; the index always is
      expect(calls, change).toBe(change === 'img/cell.svg' ? 1 : 2);
    }
  });
  it('a tampered previous output is not reused', async () => {
    const files = new Map(built.files);
    files.set('lessons/01-cells.md.html', new TextEncoder().encode('tampered'));
    const inc = await buildSite(fixture.files, fixture.config, await env({ previous: { manifest: built.manifest, files } }));
    expect(digest(inc)).toBe(digest(built));
  });
});

describe('documents (spec §2.2–2.4)', () => {
  it('the file name decides the kind; a disagreeing carrier: is a warning', async () => {
    const r = await buildSite(mapOf({ 'a.md': text('A', '# A', 'carrier: slides\n') }), cfg(), await env());
    expect(r.ok).toBe(true);
    expect(r.report.warnings.map((w) => w.code)).toEqual(['carrier-mismatch']);
    expect(extract(dec(r.files.get('a.md.html')))?.kind).toBe('md');
  });

  it('an empty text is skipped with empty-text; a link to it is missing-link', async () => {
    const r = await buildSite(mapOf({ 'a.md': text('A', '# A\n\n[b](b.md)'), 'b.md': text('B', '  \n') }), cfg(), await env());
    expect(r.report.warnings.map((w) => w.code)).toEqual(['empty-text']);
    expect(r.report.errors.map((e) => [e.code, e.path])).toEqual([['missing-link', 'a.md']]);
  });

  it('a 0.x deck text is refused by the carrier\'s lint (invalid-text, deck-block) with the upgrade as next', async () => {
    const r = await buildSite(mapOf({ 'old.slides.md': '<!-- deck title="Old" -->\n\n<!-- slide -->\n## One\n' }), cfg(), await env());
    expect(r.ok).toBe(false);
    expect(r.files.size).toBe(0);
    const f = r.report.errors.find((e) => e.code === 'invalid-text');
    expect(f?.message).toMatch(/^deck-block/);
    expect(f?.next).toEqual({ tool: 'orz-slides', command: 'upgrade', args: ['old.slides.md'] });
  });

  it('a header format above the carrier\'s is newer-format; invalid UTF-8 is not-utf8', async () => {
    const r = await buildSite(mapOf({ 'a.md': '{{nyml\nkind: document\nformat: 2\n}}\n\n# A\n', 'b.md': new Uint8Array([0x23, 0x20, 0xff]) }), cfg(), await env());
    expect(r.report.errors.map((e) => [e.code, e.path])).toEqual([['newer-format', 'a.md'], ['not-utf8', 'b.md']]);
  });

  it('assets are copied byte for byte; an assembled input is assembled-input (and legacy-file for a 0.x one)', async () => {
    const bin = new Uint8Array(256).map((_, i) => i);
    const old = '<!doctype html><html><head><meta name="generator" content="orz-mdhtml 0.9.4"></head><body><script type="text/markdown" id="orz-src"># Old</script></body></html>';
    const r = await buildSite(mapOf({ 'a.md': text('A', '# A'), 'b.bin': bin, 'old/notes.md.html': old }), cfg(), await env());
    expect(r.ok).toBe(true);
    expect(r.files.get('b.bin')).toEqual(bin);
    expect(r.report.warnings.map((w) => [w.code, w.path, w.next])).toEqual([
      ['assembled-input', 'old/notes.md.html', undefined],
      ['legacy-file', 'old/notes.md.html', { tool: 'orz-mdhtml', command: 'upgrade', args: ['old/notes.md.html'] }],
    ]);
  });

  it('upper-case extensions are assets, not documents', async () => {
    const r = await buildSite(mapOf({ 'A.MD': '# A' }), cfg({ index: { mode: 'off' } }), await env());
    expect(r.manifest.documents).toEqual([]);
    expect(r.files.has('A.MD')).toBe(true);
  });

  it('no config: build uses the defaults and warns no-config; check is red', async () => {
    const b = await buildSite(mapOf({ 'a.md': text('A', '# A') }), null, await env());
    expect(b.ok).toBe(true);
    expect(b.report.warnings.map((w) => w.code)).toEqual(['no-base-url', 'no-config']);
    const c = await buildSite(mapOf({ 'a.md': text('A', '# A') }), null, await env({ check: true }));
    expect(c.report.errors.map((e) => e.code)).toEqual(['no-config']);
    expect(c.files.size).toBe(0);
  });
});

describe('[S.6] pins', () => {
  it('a carrier whose version differs from the pin is refused (shell-mismatch, next: npm install the pin)', async () => {
    const r = await buildSite(mapOf({ 'a.md': text('A', '# A') }), cfg({ carriers: { md: '1.0.1' } }), await env());
    expect(r.ok).toBe(false);
    expect(r.files.size).toBe(0);
    expect(r.report.errors).toEqual([expect.objectContaining({ code: 'shell-mismatch', next: { tool: 'npm', command: 'install', args: ['orz-mdhtml@1.0.1'] } })]);
  });
  it('a used kind without a carrier is no-carrier; without a pin: a warning in build, an error in check', async () => {
    const e = await env();
    const r = await buildSite(mapOf({ 'a.slides.md': text('A', '<!-- slide -->\n## A') }), cfg(), { ...e, carriers: { md: e.carriers?.md as CarrierModule } });
    expect(r.report.errors.map((x) => [x.code, x.next])).toEqual([['no-carrier', { tool: 'npm', command: 'install', args: [`orz-slides@${PINS.slides}`] }]]);
    const b = await buildSite(mapOf({ 'a.md': text('A', '# A') }), { format: 1 }, e);
    expect(b.report.warnings.map((x) => x.code)).toContain('no-pin');
    const c = await buildSite(mapOf({ 'a.md': text('A', '# A') }), { format: 1 }, { ...e, check: true });
    expect(c.report.errors.map((x) => x.code)).toEqual(['no-pin']);
  });
  it('[S.14, family-naming half] the family naming spelt out is the family naming: byte-identical to the default build', async () => {
    const spelt = await buildSite(fixture.files, { ...(fixture.config as Record<string, unknown>), naming: { md: '{stem}.md.html' } }, await env());
    for (const [p, b] of built.files) if (p !== 'orz-site-manifest.json') expect(Buffer.compare(Buffer.from(spelt.files.get(p) ?? new Uint8Array()), Buffer.from(b)), p).toBe(0);
  });
  it.skipIf(K1)('a non-family naming with carriers that do not carry it (before 1.1) is naming-unsupported, nothing built', async () => {
    const r = await buildSite(mapOf({ 'a.md': text('A', '# A [b](b.slides.md)'), 'b.slides.md': text('B', '<!-- slide -->\n## B') }), cfg({ naming: NAMING }), await env());
    expect(r.report.errors.map((x) => [x.code, x.target])).toEqual([['naming-unsupported', 'carriers.md'], ['naming-unsupported', 'carriers.slides']]);
    expect(r.report.errors[0]?.message).toContain(`orz-mdhtml ${PINS.md} does not carry a naming`);
    expect(r.files.size).toBe(0);
  });
});

describe.skipIf(!K1)('[S.14, naming half] a non-family naming (carriers with the kit\'s twinLinks)', () => {
  let named: BuildResult;
  let config: Record<string, unknown>;
  beforeAll(async () => {
    config = { ...(fixture.config as Record<string, unknown>), naming: NAMING };
    named = await buildSite(fixture.files, config, await env());
    if (!named.ok) throw new Error(JSON.stringify(named.report.errors, null, 2));
  });

  it('pages take the naming\'s names (md: {stem}.html; the deck and the handout keep the family\'s), the home page is index.html, no generated index', () => {
    expect(named.report.errors).toEqual([]);
    const outputs = Object.fromEntries(named.manifest.documents.map((d) => [d.path, d.output]));
    expect(outputs).toEqual({
      '404.md': '404.html', 'handouts/lab-safety.paged.md': 'handouts/lab-safety.paged.html', 'index.md': 'index.html',
      'lessons/01-cells.md': 'lessons/01-cells.html', 'lessons/02-membranes.md': 'lessons/02-membranes.html', 'lessons/03-energy.md': 'lessons/03-energy.html',
      'slides/week1.slides.md': 'slides/week1.slides.html',
    });
    expect(named.manifest.generated.map((g) => g.path)).not.toContain('index.html');
    expect([...named.files.keys()].filter((p) => p.endsWith('.md.html'))).toEqual([]);
    expect(named.manifest.naming).toEqual(NAMING);
  });

  it('every page carries the naming and equals the carrier\'s own assemble(text, { delivery, includes, twinLinks })', async () => {
    const e = await env();
    for (const d of named.manifest.documents) {
      const page = dec(named.files.get(d.output));
      const x = (e.carriers?.[d.kind] as CarrierModule).extract(page);
      expect(x?.twinLinks, d.path).toEqual(NAMING);
      const again = await (e.carriers?.[d.kind] as CarrierModule).assemble(dec(fixture.files.get(d.path)), { delivery: d.delivery, ...(x?.includes ? { includes: x.includes } : {}), twinLinks: NAMING });
      expect(again === page, d.path).toBe(true);
      expect(x?.text).toBe(storedText(dec(fixture.files.get(d.path))));
    }
  });

  it('every link the check accepts, twinHref(href, naming) against the page, names a file of the output', () => {
    let checked = 0;
    for (const d of named.manifest.documents) {
      const t = dec(fixture.files.get(d.path));
      const record = extract(dec(named.files.get(d.output)))?.includes ?? {};
      const all = [...linkTargets(t), ...Object.entries(record).filter(([k]) => !/^\w+:\/\//.test(k)).flatMap(([, v]) => linkTargets(v))];
      for (const l of all) {
        if (l.kind === 'other' || l.raw) continue;
        const href = l.kind === 'twin' ? twinHref(l.href, NAMING) : l.href;
        const target = resolveIn(dirOf(d.output), decodeURIComponent(href.replace(/[?#].*$/, '')));
        expect(target !== null && named.files.has(target), `${d.path}: ${l.href} → ${target}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

});

describe('[S.7] collisions are refused, every party named, nothing written', () => {
  const cases: Array<[string, Record<string, string>, Record<string, unknown>, string, string[]]> = [
    ['page vs committed assembled file', { 'x.md': text('X', '# X'), 'x.md.html': '<p>old</p>' }, {}, 'name-collision', ['the page of x.md', 'the asset x.md.html']],
    ['index.html asset vs index "on"', { 'a.md': text('A', '# A'), 'index.html': '<p>hi</p>' }, { index: { mode: 'on' } }, 'name-collision', ['the asset index.html', 'the generated index']],
    ['sitemap.xml asset vs the sitemap', { 'a.md': text('A', '# A'), 'sitemap.xml': '<x/>' }, { baseUrl: 'https://o.github.io/c/' }, 'name-collision', ['the asset sitemap.xml', 'the sitemap']],
    ['the manifest name', { 'a.md': text('A', '# A'), 'orz-site-manifest.json': '{}' }, {}, 'name-collision', ['the asset orz-site-manifest.json', 'the site manifest']],
    ['404.html asset vs notFound', { 'nf.md': text('NF', '# NF'), '404.html': 'x' }, { notFound: 'nf.md' }, 'name-collision', ['the page of nf.md', 'the asset 404.html']],
    ['case-only pair', { 'a.md': text('A', '# A'), 'img/A.png': 'x', 'img/a.png': 'y' }, {}, 'case-collision', ['img/A.png', 'img/a.png']],
    ['a file and a folder', { 'a.md': text('A', '# A'), 'data': 'x', 'data/b.csv': 'y' }, {}, 'name-collision', ['data', 'data/b.csv']],
  ];
  for (const [name, files, config, code, parties] of cases) {
    it(name, async () => {
      const r = await buildSite(mapOf(files), cfg(config), await env());
      expect(r.ok).toBe(false);
      expect(r.files.size).toBe(0);
      const f = r.report.errors.find((e) => e.code === code);
      expect(f, JSON.stringify(r.report.errors)).toBeDefined();
      for (const p of parties) expect(f?.message).toContain(p);
    });
  }
  it('auto index steps aside when an asset is index.html', async () => {
    const r = await buildSite(mapOf({ 'a.md': text('A', '# A'), 'index.html': '<p>mine</p>' }), cfg(), await env());
    expect(r.ok).toBe(true);
    expect(dec(r.files.get('index.html'))).toBe('<p>mine</p>');
  });
});

describe('[S.5] links: probes for each missing target', () => {
  const site = (body: string, extra: Record<string, string> = {}) => mapOf({ 'notes/a.md': text('A', body), 'notes/b.md': text('B', '# B'), 'drafts/d.md': text('D', '# D'), 'e.md': text('E', ''), 'img/x.png': 'x', ...extra });
  const probe = async (body: string, o: Record<string, unknown> = {}) => buildSite(site(body), cfg({ exclude: ['drafts/'], ...o }), await env());
  it('accepted: a sibling text, a fragment and query, an asset, URLs, fragments only', async () => {
    const r = await probe('[b](b.md#x) [b2](./b.md?q=1) [img](../img/x.png) [u](https://x.org/a.md) [f](#top) [m](mailto:a@b.c)');
    expect(r.report.errors).toEqual([]);
    expect(r.report.warnings.map((w) => w.code)).toEqual(['empty-text']);
  });
  for (const [what, href] of [['a missing text', 'nope.md'], ['an excluded text', '../drafts/d.md'], ['an empty text', '../e.md'], ['a text outside the root', '../../x.md'], ['a slides twin that is not there', 'w.slides.md']]) {
    it(`${what} → missing-link (error by default, warning with links.missing "warn")`, async () => {
      const r = await probe(`[x](${href})`);
      expect(r.report.errors.map((e) => [e.code, e.path, e.line, e.target])).toEqual([['missing-link', 'notes/a.md', 6, href]]);
      const w = await probe(`[x](${href})`, { links: { missing: 'warn' } });
      expect(w.ok).toBe(true);
      expect(w.report.warnings.map((e) => e.code)).toContain('missing-link');
    });
  }
  it('a missing asset is a warning; raw-HTML twin links, upper-case extensions and root-relative links are warnings', async () => {
    const r = await probe('[c](c.csv) <a href="b.md">raw</a> [U](B.MD) [r](/notes/b.md)', { baseUrl: 'https://o.github.io/course/' });
    expect(r.ok).toBe(true);
    expect(r.report.warnings.map((w) => w.code)).toEqual(['empty-text', 'case-link', 'missing-asset', 'raw-twin-link', 'root-relative']);
  });
  it('links in code are not links', async () => {
    const r = await probe('`[x](nope.md)`\n\n```\n[y](nope.md)\n```');
    expect(r.report.errors).toEqual([]);
  });
});

describe('[S.10] excludes never reach the output', () => {
  it('dot paths, node_modules, *~, the config, the output folder and configured globs', async () => {
    const files = mapOf({
      'a.md': text('A', '# A'), '.git/HEAD': 'x', '.github/workflows/x.yml': 'x', 'notes/.secret.md': text('S', '# S'),
      'node_modules/p/readme.md': text('R', '# R'), 'a.md~': 'backup', 'orz-site.json': '{}', '_site/old.md.html': 'x',
      'drafts/x.md': text('X', '# X'), 'private/y.md': text('Y', '# Y'),
    });
    const r = await buildSite(files, cfg({ exclude: ['drafts/', 'private/*.md'] }), await env({ outDir: '_site' }));
    expect(r.ok).toBe(true);
    expect([...r.files.keys()]).toEqual(['.nojekyll', 'a.md', 'a.md.html', 'index.html', 'index.md', 'orz-site-manifest.json']);
  });
  it('an excluded partial is still an include source (Q9)', async () => {
    const r = await buildSite(mapOf({ 'a.md': text('A', '{{md shared/p.md}}'), 'shared/p.md': 'Partial' }), cfg({ exclude: ['shared/'] }), await env());
    expect(r.ok).toBe(true);
    expect(extract(dec(r.files.get('a.md.html')))?.includes).toEqual({ 'shared/p.md': 'Partial' });
    expect(r.files.has('shared/p.md')).toBe(false);
  });
});
