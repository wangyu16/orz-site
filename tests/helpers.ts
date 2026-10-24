/**
 * Test helpers: a static file server for a built site (the way Pages serves
 * it: `x.html`, folders → `index.html`, 404 → `404.html`), real Chrome via
 * playwright-core (channel 'chrome'), temp folders, and the fixture.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const FIXTURE = join(ROOT, 'fixtures', 'course');

export function tempDir(prefix = 'orz-site-'): string { return mkdtempSync(join(tmpdir(), prefix)); }

/** A copy of the course fixture in a temp folder. */
export function fixtureCopy(): string {
  const dir = join(tempDir(), 'course');
  cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes(`${join('course', '_site')}`) });
  return dir;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.xml': 'application/xml', '.png': 'image/png', '.js': 'text/javascript', '.mjs': 'text/javascript' };

/** Serve a folder under a path prefix (`/bio101/`), as GitHub Pages does. */
export async function serveFolder(dir: string, prefix = '/'): Promise<{ url: string; origin: string; close(): Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push(u.pathname);
    let rel = decodeURIComponent(u.pathname);
    if (!rel.startsWith(prefix)) { res.statusCode = 404; res.end('not under the site'); return; }
    rel = rel.slice(prefix.length);
    let file = join(dir, rel);
    if (!resolve(file).startsWith(resolve(dir))) { res.statusCode = 403; res.end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file)) {
      res.statusCode = 404;
      const nf = join(dir, '404.html');
      if (existsSync(nf)) { res.setHeader('content-type', TYPES['.html'] as string); res.end(readFileSync(nf)); } else res.end('404');
      return;
    }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('access-control-allow-origin', '*');
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  return { url: `${origin}${prefix}`, origin, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** playwright-core's chromium (this package's devDependency, else ../orz-slides'), or null. */
export async function chromium(): Promise<typeof import('playwright-core').chromium | null> {
  try { return (await import('playwright-core')).chromium; } catch { /* fall through */ }
  try { return (await import(join(ROOT, '..', 'orz-slides', 'node_modules', 'playwright-core', 'index.mjs'))).chromium; } catch { return null; }
}

/** True when an installed Chrome can be launched. */
export async function haveChrome(): Promise<boolean> {
  const c = await chromium();
  if (!c) return false;
  try { const b = await c.launch({ channel: 'chrome', headless: true }); await b.close(); return true; } catch { return false; }
}

import { loadCarriers, readSiteFolder } from '../src/node.js';
import type { BuildEnv } from '../src/types.js';

let loaded: Awaited<ReturnType<typeof loadCarriers>> | null = null;
/** The installed carriers (cached). */
export async function env(extra: BuildEnv = {}): Promise<BuildEnv> {
  loaded ??= await loadCarriers();
  return { carriers: loaded.carriers, ...extra };
}

/** A folder's file map and parsed config. */
export function readFolder(dir: string): { files: Map<string, Uint8Array>; config: unknown } {
  const cfg = join(dir, 'orz-site.json');
  return { files: readSiteFolder(dir).files, config: existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')) : null };
}

const enc = new TextEncoder();
/** A file map from strings. */
export const mapOf = (o: Record<string, string | Uint8Array>): Map<string, Uint8Array> => new Map(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]));

/** A format-1 text with a header. */
export const text = (title: string, body: string, extra = ''): string => `{{nyml\nkind: document\ntitle: ${title}\n${extra}}}\n\n${body}\n`;

/** The pins of the installed carriers: this package's exact devDependencies (the fixture's orz-site.json names the same, config.test.ts). */
const DEV = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies;
export const PINS = { md: DEV['orz-mdhtml'] as string, slides: DEV['orz-slides'] as string, paged: DEV['orz-paged'] as string } as const;

/**
 * Whether the pinned carriers carry a non-family link naming into their files
 * (the kit's `twinLinks`, K1: carriers 1.1.0 and later). Before the carriers
 * are pinned to 1.1 the naming tests check the refusal (`naming-unsupported`);
 * after, the naming itself (S.14, S.15).
 */
export const K1 = Object.values(PINS).every((v) => { const [a, b] = v.split('.').map(Number); return (a as number) > 1 || (a === 1 && (b as number) >= 1); });
/** The non-family naming of the naming tests (spec S.14). */
export const NAMING = { md: '{stem}.html' } as const;
/** A small config. */
export const cfg = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ format: 1, carriers: { ...PINS }, sitemap: 'baseUrl' in o, ...o });

export const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b ?? new Uint8Array());
