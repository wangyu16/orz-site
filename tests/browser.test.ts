/**
 * Claim S.2 (spec §12): Node = browser. The course fixture built by
 * `buildSite` in Node with the installed carrier libraries, and by the same
 * `buildSite` in real Chrome — the main entry bundled for the browser
 * (esbuild, platform "browser": it pulls in the kit, `orz-markdown/carrier`,
 * whose `includeTargets`/`linkTargets` are browser-safe since 2.5.0) with the
 * carriers' `-browser` ES modules of the same pins (route B, spec §9) —
 * gives the same files, byte for byte, the same manifest and the same report.
 * The inline paged handout makes the browser's paged module fetch its engine
 * from jsDelivr, so this needs the network. Skips without Chrome.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite } from '../src/build.js';
import type { BuildResult, Kind } from '../src/types.js';
import { chromium, env, FIXTURE, haveChrome, PINS, readFolder, ROOT, serveFolder, tempDir } from './helpers.js';

const CHROME = await haveChrome();
const BROWSER_PACKAGE: Record<Kind, string> = { md: 'orz-mdhtml-browser', slides: 'orz-slides-browser', paged: 'orz-paged-browser' };
const ESM: Record<Kind, string> = { md: 'esm/orz-mdhtml.browser.mjs', slides: 'esm/orz-slides.browser.mjs', paged: 'esm/orz-paged.browser.mjs' };

let browser: Browser;
beforeAll(async () => { if (CHROME) browser = await (await chromium())!.launch({ channel: 'chrome', headless: true }); });
afterAll(async () => { await browser?.close(); });

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describe('[S.2] the -browser packages are the pinned versions', () => {
  it('each orz-<x>-browser devDependency is installed at the pin of its Node library', () => {
    for (const k of Object.keys(PINS) as Kind[]) {
      const v = (JSON.parse(readFileSync(join(ROOT, 'node_modules', BROWSER_PACKAGE[k], 'package.json'), 'utf8')) as { version: string }).version;
      expect(v, BROWSER_PACKAGE[k]).toBe(PINS[k]);
    }
  });
});

describe.skipIf(!CHROME)('[S.2] Node = browser', () => {
  it('buildSite in Chrome with the -browser ES modules gives the Node build\'s files, manifest and report byte for byte', async () => {
    const { files, config } = readFolder(FIXTURE);
    const node: BuildResult = await buildSite(files, config, await env());
    expect(node.ok, JSON.stringify(node.report.errors)).toBe(true);

    // the page: the bundled core and the three -browser ES modules, served on the loopback
    const dir = join(tempDir(), 'page');
    mkdirSync(dir, { recursive: true });
    const bundle = await esbuild({ entryPoints: [join(ROOT, 'src', 'index.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
    writeFileSync(join(dir, 'core.mjs'), bundle.outputFiles[0]!.contents);
    for (const k of Object.keys(ESM) as Kind[]) copyFileSync(join(ROOT, 'node_modules', BROWSER_PACKAGE[k], ESM[k]), join(dir, `${k}.mjs`));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>S.2</title>\n');
    const server = await serveFolder(dir, '/');
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      await page.goto(`${server.url}index.html`);
      const input = Object.fromEntries([...files].map(([p, b]) => [p, b64(b)]));
      await page.evaluate((x) => { (globalThis as unknown as { __s2: unknown }).__s2 = x; }, { input, config });
      // a string, so the test runner's transform cannot rewrite the page's dynamic import()s
      const got = (await page.evaluate(`(async () => {
        const { input, config } = globalThis.__s2;
        const core = await import('/core.mjs');
        const carriers = {};
        for (const kind of ['md', 'slides', 'paged']) {
          const m = await import('/' + kind + '.mjs');
          carriers[kind] = {
            kind, version: m.version, formats: m.formats, assemble: m.assemble, extract: m.extract, readDocument: m.readDocument,
            ...(typeof m.includeTargets === 'function' ? { includeTargets: m.includeTargets } : {}),
            ...(typeof m.linkTargets === 'function' ? { linkTargets: m.linkTargets } : {}),
          };
        }
        const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const map = new Map(Object.entries(input).map(([p, s]) => [p, bytes(s)]));
        const r = await core.buildSite(map, config, { carriers });
        const out = {};
        for (const [p, b] of r.files) { let s = ''; for (const x of b) s += String.fromCharCode(x); out[p] = btoa(s); }
        return { ok: r.ok, report: r.report, manifest: r.manifest, files: out };
      })()`)) as { ok: boolean; report: BuildResult['report']; manifest: BuildResult['manifest']; files: Record<string, string> };
      expect(got.report).toEqual(node.report);
      expect(got.ok).toBe(true);
      expect(got.manifest).toEqual(node.manifest);
      expect(Object.keys(got.files)).toEqual([...node.files.keys()]);
      for (const [p, b] of node.files) expect(got.files[p] === b64(b), `${p} differs between Node and Chrome`).toBe(true);
    } finally { await page.close(); await server.close(); }
    expect(errors).toEqual([]);
  }, 240_000);
});
