/**
 * verify.html reproduces the built pages (spec §12 S.15's family-naming
 * half): each built file of the course fixture — md with a file include, md
 * with an own-host URL include, a deck, an inline paged handout, the 404 page
 * and the generated index — is dropped into the family's verify page in real
 * Chrome, which re-assembles it from its own text with the PUBLISHED
 * `-browser` package of the version the file names and compares the bytes.
 * The live page (https://markdown.orz.how/verify.html) is used; when it cannot
 * be reached, the local orz-markdown/docs/verify.html served on the loopback.
 * Needs the network (jsDelivr) either way; skips without Chrome.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite } from '../src/build.js';
import { writeSite } from '../src/node.js';
import { chromium, env, FIXTURE, haveChrome, readFolder, ROOT, serveFolder, tempDir } from './helpers.js';

const CHROME = await haveChrome();
const LIVE = 'https://markdown.orz.how/verify.html';
const LOCAL_DOCS = join(ROOT, '..', 'orz-markdown', 'docs');

let browser: Browser;
let out = '';
let verifyUrl = '';
let close: (() => Promise<void>) | null = null;
beforeAll(async () => {
  if (!CHROME) return;
  browser = await (await chromium())!.launch({ channel: 'chrome', headless: true });
  const { files, config } = readFolder(FIXTURE);
  const r = await buildSite(files, config, await env());
  out = join(tempDir(), 'site');
  writeSite(out, r);
  const page = await browser.newPage();
  try {
    const res = await page.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (res?.ok()) verifyUrl = LIVE;
  } catch { /* offline: the local copy */ }
  await page.close();
  if (!verifyUrl && existsSync(join(LOCAL_DOCS, 'verify.html'))) {
    const s = await serveFolder(LOCAL_DOCS, '/');
    verifyUrl = `${s.url}verify.html`;
    close = s.close;
  }
}, 120_000);
afterAll(async () => { await browser?.close(); await close?.(); });

const PAGES = ['index.md.html', 'lessons/01-cells.md.html', 'lessons/03-energy.md.html', 'slides/week1.slides.html', 'handouts/lab-safety.paged.html', '404.html', 'index.html'];

describe.skipIf(!CHROME)('[S.15, family naming] verify.html reproduces every built page', () => {
  for (const p of PAGES) {
    it(p, async () => {
      expect(verifyUrl, 'no verify.html reachable').not.toBe('');
      const page = await browser.newPage();
      try {
        await page.goto(verifyUrl, { waitUntil: 'networkidle' });
        await page.setInputFiles('#file', join(out, ...p.split('/')));
        await page.waitForFunction(() => /Reproduced|Not what|does not match|Couldn’t|MODIFIED/.test(document.getElementById('out')?.innerText ?? ''), null, { timeout: 90_000 });
        await page.waitForTimeout(500);
        const result = await page.locator('#out').innerText();
        await page.screenshot({ path: join(ROOT, '.scratch', 'screenshots', `verify-${p.replace(/\//g, '_')}.png`), fullPage: true });
        expect(result, `${verifyUrl}\n${result}`).toContain('Reproduced byte for byte');
      } finally { await page.close(); }
    }, 120_000);
  }
});
