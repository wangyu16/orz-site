/**
 * Real Chrome (playwright-core, channel 'chrome'; RULES §8.4): the built
 * pages as a reader sees them, served the way GitHub Pages serves them under
 * a project path (/bio101/). Claims S.5 (every rendered link names a file of
 * the output; following links works) and S.12 (the index shows hostile
 * titles as text, every index link resolves). Skips when Chrome is missing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite } from '../src/build.js';
import { writeSite } from '../src/node.js';
import { chromium, env, FIXTURE, haveChrome, K1, mapOf, NAMING, PINS, readFolder, ROOT, serveFolder, tempDir, text } from './helpers.js';

const CHROME = await haveChrome();
const SHOTS = join(ROOT, '.scratch', 'screenshots');

let browser: Browser;
beforeAll(async () => { if (CHROME) browser = await (await chromium())!.launch({ channel: 'chrome', headless: true }); mkdirSync(SHOTS, { recursive: true }); });
afterAll(async () => { await browser?.close(); });

/** Build a file map to a temp folder and serve it under /bio101/. */
async function serveBuilt(files: Map<string, Uint8Array>, config: unknown) {
  const r = await buildSite(files, config, await env());
  if (!r.ok) throw new Error(JSON.stringify(r.report.errors));
  const out = join(tempDir(), 'site');
  writeSite(out, r);
  return { r, out, server: await serveFolder(out, '/bio101/') };
}

/** The rendered links of a page (resolved hrefs of same-origin <a>), once the engine has rendered. */
async function renderedLinks(page: import('playwright-core').Page): Promise<string[]> {
  await page.waitForFunction(() => document.querySelectorAll('a[href]').length > 0 || document.readyState === 'complete');
  await page.waitForTimeout(800);
  return page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href).filter((h) => h.startsWith(location.origin)));
}

describe.skipIf(!CHROME)('the course fixture in Chrome', () => {
  it('[S.5] every rendered link of every page names a file of the output; following links works', async () => {
    const { files, config } = readFolder(FIXTURE);
    const { r, server } = await serveBuilt(files, config);
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let links = 0;
    try {
      const pages = [...r.manifest.documents.map((d) => d.output), 'index.html'];
      for (const p of pages) {
        await page.goto(server.url + p, { waitUntil: 'networkidle' });
        for (const href of await renderedLinks(page)) {
          const path = decodeURIComponent(new URL(href).pathname.slice('/bio101/'.length));
          expect(r.files.has(path) || r.files.has(`${path}index.html`), `${p}: ${href}`).toBe(true);
          links++;
        }
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(SHOTS, `${p.replace(/\//g, '_')}.png`) });
      }
      // follow: index → lesson 1 → lesson 2 → the deck → the handout
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await page.click('a:has-text("Lesson 1")');
      await page.waitForURL(/lessons\/01-cells\.md\.html$/);
      await page.click('a:has-text("Membranes")');
      await page.waitForURL(/lessons\/02-membranes\.md\.html$/);
      await page.waitForSelector('h1:has-text("Membranes")');
      await page.goto(`${server.url}lessons/01-cells.md.html`, { waitUntil: 'networkidle' });
      await page.click('a:has-text("Week 1")');
      await page.waitForURL(/slides\/week1\.slides\.html$/);
      // the 404 page for an unknown path
      const res = await page.goto(`${server.url}lessons/nope`, { waitUntil: 'networkidle' });
      expect(res?.status()).toBe(404);
      await page.waitForSelector('h1:has-text("Page not found")');
    } finally { await page.close(); await server.close(); }
    expect(links).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  }, 180_000);
});

describe.skipIf(!CHROME || !K1)('[S.14, naming half] a site built with { md: "{stem}.html" } in Chrome', () => {
  it('every rendered same-site link of every page names a file of the output (the page renders with the naming it carries)', async () => {
    const { files, config } = readFolder(FIXTURE);
    const { r, server } = await serveBuilt(files, { ...(config as Record<string, unknown>), naming: NAMING });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let links = 0;
    try {
      for (const p of r.manifest.documents.map((d) => d.output)) {
        await page.goto(server.url + p, { waitUntil: 'networkidle' });
        for (const href of await renderedLinks(page)) {
          const path = decodeURIComponent(new URL(href).pathname.slice('/bio101/'.length));
          expect(path.endsWith('.md.html'), `${p}: ${href} is a family name`).toBe(false);
          expect(r.files.has(path) || r.files.has(`${path}index.html`), `${p}: ${href}`).toBe(true);
          links++;
        }
      }
      await page.goto(`${server.url}lessons/01-cells.html`, { waitUntil: 'networkidle' });
      await page.click('a:has-text("Membranes")');
      await page.waitForURL(/lessons\/02-membranes\.html$/);
      await page.waitForSelector('h1:has-text("Membranes")');
    } finally { await page.close(); await server.close(); }
    expect(links).toBeGreaterThan(10);
    expect(errors).toEqual([]);
  }, 180_000);
});

describe.skipIf(!CHROME)('[S.12] the index in Chrome', () => {
  it('titles with Markdown, {{, <script> and line breaks appear as text; every index link resolves', async () => {
    const hostile = [
      ['a.md', text('*Bold* [link](secret.md) <script>window.__pwned=1</script> `code` \\\\ & | # x', '# A', 'description: |\n  Line one {{md secret.md } }\n  line *two* <img src=x onerror="window.__pwned=2">\n')],
      ['b.md', '# B {{md secret.md}} title <b>bold</b>\n\nbody\n'],
      ['notes/c.slides.md', text('C [x](y) ](z) ![i](j) :::warning', '<!-- slide -->\n## C')],
      ['secret.md', 'SECRET TEXT'],
    ] as const;
    const files = mapOf(Object.fromEntries(hostile));
    const { r, server } = await serveBuilt(files, { format: 1, carriers: { md: PINS.md, slides: PINS.slides }, exclude: ['secret.md'], sitemap: false, index: { title: 'Index <script>window.__pwned=3</script> {{md secret.md}}' } });
    const page = await browser.newPage();
    try {
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await page.waitForSelector('#orz-doc li a');
      const items = await page.$$eval('#orz-doc li', (lis) => lis.map((li) => ({ text: (li as HTMLElement).innerText, href: (li.querySelector('a') as HTMLAnchorElement).href, title: (li.querySelector('a') as HTMLAnchorElement).innerText })));
      const titles = Object.fromEntries(r.manifest.documents.map((d) => [d.path, d.title]));
      expect(items.map((i) => i.title)).toEqual([titles['a.md'], titles['b.md'], titles['notes/c.slides.md']].map((t) => (t as string).replace(/\s+/g, ' ').trim()));
      expect(items[0]?.text).toContain('Line one {{md secret.md } } line *two* <img src=x onerror="window.__pwned=2">');
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
      expect(await page.locator('#orz-doc script, #orz-doc img').count()).toBe(0);
      const body = await page.locator('#orz-doc').innerText();
      expect(body).not.toContain('SECRET');
      expect(body).not.toMatch(/Included file not available/i);
      expect(await page.locator('#orz-doc h1').innerText()).toBe('Index <script>window.__pwned=3</script> {{md secret.md}}');
      for (const i of items) {
        const path = decodeURIComponent(new URL(i.href).pathname.slice('/bio101/'.length));
        expect(r.files.has(path), i.href).toBe(true);
      }
      await page.screenshot({ path: join(SHOTS, 'hostile-index.png') });
    } finally { await page.close(); await server.close(); }
  }, 120_000);
});

export { writeFileSync };
