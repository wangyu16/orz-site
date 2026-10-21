/**
 * `buildSite(files, config, env) → { ok, files, manifest, report }` — the
 * pure core (spec §7.1). It imports nothing from Node, reads no clock, no
 * randomness, no environment and no locale: the same file map, config,
 * `baseUrl`, orz-site version and carrier versions give byte-identical
 * output and report (§3.7). A refused build returns `ok: false`, the report
 * and NO files (never a partial site). Carriers are injected
 * (`env.carriers`); the Node adapter (`orz-site/node`) loads the installed
 * packages.
 */
import { extract as kitExtract, decodeText, kindFromFilename, twinName, withoutHeader } from 'orz-markdown/carrier';
import { CONFIG_FILE, baseUrlProblem, defaultConfig, validateConfig } from './config.js';
import { matchesAny } from './glob.js';
import { indexText, type IndexEntry } from './index-page.js';
import { defaultFetch, isSoftInclude, recordHash, resolveIncludes, type IncludeContext } from './includes.js';
import { linkTargets as localLinkTargets } from './links.js';
import { baseOf, byCodeUnits, decodePath, dirOf, encodePath, resolveIn, sitePathProblem } from './paths.js';
import { KINDS, type BuildEnv, type BuildResult, type CarrierModule, type DocumentInfo, type Finding, type Kind, type LinkRef, type Manifest, type ManifestDocument, type Report, type SiteConfig, type SiteFiles } from './types.js';
import { canonicalJson, sha256Hex, utf8 } from './util.js';
import { VERSION } from './version.js';

/** Limits (spec §10). */
export const LIMITS = Object.freeze({ textChars: 5_000_000, assetBytes: 100 * 1024 * 1024, files: 20_000, totalBytes: 1024 * 1024 * 1024 });
/** Names orz-site writes itself. */
export const MANIFEST_FILE = 'orz-site-manifest.json';
export const GENERATED = Object.freeze({ index: 'index.html', indexText: 'index.md', sitemap: 'sitemap.xml', notFound: '404.html', nojekyll: '.nojekyll', manifest: MANIFEST_FILE });

const PACKAGE: Record<Kind, string> = { md: 'orz-mdhtml', slides: 'orz-slides', paged: 'orz-paged' };

/** Why a path is always excluded (spec §2.2), or null. `outDir`: the output folder when it lies inside the root. */
export function alwaysExcluded(path: string, outDir?: string | null): string | null {
  const segs = path.split('/');
  if (segs.some((s) => s.startsWith('.'))) return 'dot-path';
  if (segs.includes('node_modules')) return 'node_modules';
  if (path.endsWith('~')) return 'backup';
  if (path === CONFIG_FILE) return 'config';
  if (outDir && (path === outDir || path.startsWith(`${outDir}/`))) return 'output';
  return null;
}

interface Doc {
  path: string;
  bytes: Uint8Array;
  text: string;
  kind: Kind;
  carrier: CarrierModule;
  info: DocumentInfo;
  output: string;
  delivery: 'inline' | 'cdn';
}

/** Findings about the whole site (no path) or its config sort first: they are the root cause, and the CLI's `reason`. */
const siteLevel = (f: Finding): number => (f.path === undefined ? 0 : f.path === CONFIG_FILE ? 1 : 2);

function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => siteLevel(a) - siteLevel(b) || byCodeUnits(a.path ?? '', b.path ?? '') || (a.line ?? 0) - (b.line ?? 0) || byCodeUnits(a.code, b.code) || byCodeUnits(a.target ?? '', b.target ?? '') || byCodeUnits(a.message, b.message));
}

/** Dedupe identical findings (same code, path, line, target, message). */
function dedupe(list: Finding[]): Finding[] {
  const seen = new Set<string>();
  return list.filter((f) => { const k = JSON.stringify([f.code, f.path, f.line, f.target, f.message]); if (seen.has(k)) return false; seen.add(k); return true; });
}

function emptyManifest(config: SiteConfig | null, baseUrl: string | null): Manifest {
  return { format: 1, generator: `orz-site ${VERSION}`, config: { sha256: '' }, baseUrl, carriers: {}, naming: config?.naming ?? 'family', documents: [], assets: [], generated: [], skipped: [] };
}

/**
 * Build a site (spec §7.1). `config` is the parsed `orz-site.json` (validated
 * here; unknown keys are errors) or null/undefined for none (`no-config`).
 */
export async function buildSite(files: SiteFiles, config: unknown, env: BuildEnv = {}): Promise<BuildResult> {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const add = (f: Finding, level: 'error' | 'warning' = 'error'): void => { (level === 'error' ? errors : warnings).push(f); };
  for (const f of env.findings?.errors ?? []) add(f);
  for (const f of env.findings?.warnings ?? []) add(f, 'warning');

  // ── config ───────────────────────────────────────────────────────────────
  let cfg: SiteConfig;
  if (config === null || config === undefined) {
    cfg = defaultConfig();
    if (env.check) add({ code: 'no-config', message: `no ${CONFIG_FILE}: \`orz-site init\` writes one with the installed carriers as pins`, path: CONFIG_FILE, next: { command: 'init', args: [] } });
    else add({ code: 'no-config', message: `no ${CONFIG_FILE}: building with the defaults and the carriers installed (\`orz-site init\` writes a config that pins them)`, path: CONFIG_FILE, next: { command: 'init', args: [] } }, 'warning');
  } else {
    const v = validateConfig(config);
    for (const f of v.findings) add(f);
    if (!v.config) return refused(errors, warnings, null, env.baseUrl ?? null);
    cfg = v.config;
  }
  let baseUrl = cfg.baseUrl;
  if (env.baseUrl !== undefined) {
    const p = baseUrlProblem(env.baseUrl);
    if (p) { add({ code: 'bad-config', message: `--base-url: ${p}`, target: 'baseUrl' }); return refused(errors, warnings, cfg, null); }
    baseUrl = env.baseUrl;
  }

  // ── the file map ─────────────────────────────────────────────────────────
  const paths = [...files.keys()].sort(byCodeUnits);
  if (paths.length > LIMITS.files) add({ code: 'too-many-files', message: `${paths.length} files, more than ${LIMITS.files} (spec §10)` });
  let total = 0;
  const valid: string[] = [];
  for (const p of paths) {
    const problem = sitePathProblem(p);
    if (problem) { add({ code: 'outside-root', message: `not a site path (${problem}); not read`, path: p }); continue; }
    total += (files.get(p) as Uint8Array).length;
    valid.push(p);
  }
  if (total > LIMITS.totalBytes) add({ code: 'too-large', message: `the site holds ${total} bytes, more than ${LIMITS.totalBytes} (GitHub Pages' limit)` });

  const outDir = env.outDir ?? null;
  const skipped: Manifest['skipped'] = [];
  const docCandidates: string[] = [];
  const assets: string[] = [];
  for (const p of valid) {
    const always = alwaysExcluded(p, outDir);
    if (always) { if (always !== 'config') skipped.push({ path: p, reason: 'excluded' }); continue; }
    if (matchesAny(p, cfg.exclude)) { skipped.push({ path: p, reason: 'excluded' }); continue; }
    if (/\.md$/.test(p) && kindFromFilename(p)) docCandidates.push(p);
    else assets.push(p);
  }

  // ── carriers and pins ────────────────────────────────────────────────────
  const carriers = env.carriers ?? {};
  const kindsUsed = new Set<Kind>(docCandidates.map((p) => kindFromFilename(p) as Kind));
  const indexWanted = cfg.index.mode !== 'off';
  if (indexWanted) kindsUsed.add('md');
  const carrierOk = new Map<Kind, CarrierModule>();
  for (const kind of KINDS) {
    if (!kindsUsed.has(kind)) continue;
    const c = carriers[kind];
    const pin = cfg.carriers[kind];
    const pkg = PACKAGE[kind];
    if (!c) {
      add({ code: 'no-carrier', message: `the site has ${kind === 'md' && !docCandidates.some((p) => kindFromFilename(p) === 'md') ? 'an index (an md document)' : `${kind} documents`} but no ${pkg} is installed`, target: pkg, next: { tool: 'npm', command: 'install', args: [`${pkg}@${pin ?? 'latest'}`] } });
      continue;
    }
    if (pin && c.version !== pin) {
      add({ code: 'shell-mismatch', message: `${CONFIG_FILE} pins ${pkg} ${pin}, the installed one is ${c.version}: a site is built with exactly the pinned shell`, path: CONFIG_FILE, target: `carriers.${kind}`, next: { tool: 'npm', command: 'install', args: [`${pkg}@${pin}`] } });
      continue;
    }
    if (!pin && config !== null && config !== undefined) {
      add({ code: 'no-pin', message: `${CONFIG_FILE} pins no ${kind} carrier; ${env.check ? 'a checked site pins every kind it uses' : `building with the installed ${pkg} ${c.version}`} (add "carriers": { "${kind}": "${c.version}" })`, path: CONFIG_FILE, target: `carriers.${kind}` }, env.check ? 'error' : 'warning');
    }
    carrierOk.set(kind, c);
  }
  const includeTargets = (kind: Kind) => (text: string): string[] => {
    const c = carrierOk.get(kind);
    if (c?.includeTargets) return c.includeTargets(text);
    if (env.includeTargets) return env.includeTargets(text);
    throw new TypeError('orz-site: no includeTargets — pass a carrier with includeTargets (K2) or env.includeTargets (the kit\'s orz-markdown/carrier/node includeTargets)');
  };
  const linksOf = (kind: Kind, text: string): LinkRef[] => carrierOk.get(kind)?.linkTargets?.(text) ?? localLinkTargets(text);

  // ── documents ────────────────────────────────────────────────────────────
  const docs: Doc[] = [];
  const notBuilt = new Map<string, string>(); // text path → why it has no page
  for (const p of skipped) if (/\.md$/.test(p.path) && kindFromFilename(p.path)) notBuilt.set(p.path, 'excluded');
  for (const p of docCandidates) {
    const kind = kindFromFilename(p) as Kind;
    const bytes = files.get(p) as Uint8Array;
    let text: string;
    try { text = decodeText(bytes, { fatal: true }); } catch {
      add({ code: 'not-utf8', message: 'not valid UTF-8: a text twin is UTF-8', path: p }); notBuilt.set(p, 'not UTF-8'); continue;
    }
    if (text.length > LIMITS.textChars) { add({ code: 'too-large', message: `${text.length} characters, more than ${LIMITS.textChars}`, path: p }); notBuilt.set(p, 'too large'); continue; }
    const carrier = carrierOk.get(kind);
    if (!carrier) { notBuilt.set(p, `no ${kind} carrier`); continue; }
    let info: DocumentInfo;
    try { info = carrier.readDocument(text, { filename: baseOf(p) }); } catch (e) {
      add({ code: 'invalid-text', message: `the ${PACKAGE[kind]} reader refuses it: ${(e as Error).message}`, path: p }); notBuilt.set(p, 'invalid'); continue;
    }
    const newest = Math.max(...carrier.formats);
    if (info.format > newest) {
      add({ code: 'newer-format', message: `text format ${info.format} is newer than ${PACKAGE[kind]} ${carrier.version} reads (${newest}): pin a newer ${PACKAGE[kind]}`, path: p, target: `carriers.${kind}` });
      notBuilt.set(p, 'newer format'); continue;
    }
    const lintErrors = info.lint.filter((l) => l.level === 'error');
    if (lintErrors.length > 0) {
      for (const l of lintErrors) {
        const next = (l as { next?: string }).next;
        add({ code: 'invalid-text', message: `${l.code}: ${l.message}`, path: p, ...(l.line ? { line: l.line } : {}), ...(next ? { next: { tool: PACKAGE[kind], command: next, args: [p] } } : {}) });
      }
      notBuilt.set(p, 'refused by its lint'); continue;
    }
    const declared = info.header?.fields['carrier'];
    if (declared !== undefined && declared !== kind) add({ code: 'carrier-mismatch', message: `the header says carrier: ${declared}, the file name makes it ${kind} (the name decides, FC-18 §3)`, path: p }, 'warning');
    if (withoutHeader(text).body.trim() === '') {
      add({ code: 'empty-text', message: 'the text has no body: no page is built (links to it are missing-link)', path: p }, 'warning');
      skipped.push({ path: p, reason: 'empty-text' }); notBuilt.set(p, 'empty'); continue;
    }
    const output = cfg.notFound === p ? GENERATED.notFound : (twinName(p) as string);
    const delivery = matchesAny(p, cfg.inline) ? 'inline' : cfg.delivery;
    docs.push({ path: p, bytes, text, kind, carrier, info, output, delivery });
  }
  if (cfg.notFound && !docs.some((d) => d.path === cfg.notFound)) add({ code: 'bad-config', message: `notFound: ${cfg.notFound} is not a built document of the site`, path: CONFIG_FILE, target: 'notFound' });

  // ── assets ───────────────────────────────────────────────────────────────
  for (const p of assets) {
    const bytes = files.get(p) as Uint8Array;
    if (bytes.length > LIMITS.assetBytes) add({ code: 'too-large', message: `${bytes.length} bytes, more than ${LIMITS.assetBytes} (GitHub's file limit)`, path: p });
    const kind = /\.(md|slides|paged)\.html$/.test(p) ? kindFromFilename(p) : null;
    if (kind) {
      add({ code: 'assembled-input', message: 'an assembled file in the input is copied as an asset (built files are not committed, FD-07): commit its text twin instead', path: p }, 'warning');
      let held: ReturnType<typeof kitExtract> = null;
      try { held = kitExtract(decodeText(bytes)); } catch { held = null; }
      if (!held || !held.shell) add({ code: 'legacy-file', message: `a 0.x ${kind} file: upgrade it to a text twin`, path: p, next: { tool: PACKAGE[kind], command: 'upgrade', args: [p] } }, 'warning');
    }
  }

  // ── output plan and collisions ───────────────────────────────────────────
  const docByPath = new Map(docs.map((d) => [d.path, d]));
  const outputs = new Map<string, string[]>(); // output path → parties
  const want = (out: string, party: string): void => { const l = outputs.get(out); if (l) l.push(party); else outputs.set(out, [party]); };
  for (const d of docs) want(d.output, `the page of ${d.path}`);
  for (const a of assets) want(a, `the asset ${a}`);
  if (cfg.texts) for (const d of docs) want(d.path, `the published text ${d.path}`);
  const takenByContent = (name: string): boolean => outputs.has(name);
  const makeIndex = cfg.index.mode === 'on' || (cfg.index.mode === 'auto' && !takenByContent(GENERATED.index));
  if (makeIndex) want(GENERATED.index, 'the generated index');
  const sitemapOn = cfg.sitemap && baseUrl !== null;
  if (cfg.sitemap && baseUrl === null) add({ code: 'no-base-url', message: 'no baseUrl: no sitemap.xml is written (set "baseUrl", or pass --base-url)', path: CONFIG_FILE, target: 'baseUrl' }, 'warning');
  if (sitemapOn) want(GENERATED.sitemap, 'the sitemap');
  want(GENERATED.manifest, 'the site manifest');
  want(GENERATED.nojekyll, 'the .nojekyll marker');
  const publishIndexText = makeIndex && cfg.texts && !outputs.has(GENERATED.indexText);
  if (publishIndexText) want(GENERATED.indexText, 'the generated index\'s text');
  const keyFor = (party: string): string => {
    if (party.startsWith('the page of ')) return `rename the text, or set "notFound"/"naming" differently`;
    if (party.startsWith('the published text')) return '"texts": false';
    if (party.startsWith('the asset')) return 'rename or exclude the asset ("exclude")';
    if (party === 'the generated index') return '"index": { "mode": "off" }';
    if (party === 'the sitemap') return '"sitemap": false';
    return 'rename the file';
  };
  for (const [out, parties] of [...outputs].sort((a, b) => byCodeUnits(a[0], b[0]))) {
    if (parties.length > 1) add({ code: 'name-collision', message: `${parties.join(' and ')} all want ${out}; change one: ${[...new Set(parties.map(keyFor))].join(' / ')}`, path: out });
  }
  const lower = new Map<string, string[]>();
  for (const out of outputs.keys()) { const k = out.toLowerCase(); const l = lower.get(k); if (l) l.push(out); else lower.set(k, [out]); }
  for (const [, outs] of [...lower].sort((a, b) => byCodeUnits(a[0], b[0]))) {
    if (outs.length > 1) add({ code: 'case-collision', message: `${outs.sort(byCodeUnits).join(' and ')} differ only in letter case (${outs.map((o) => (outputs.get(o) as string[]).join(', ')).join('; ')}): GitHub Pages is case-sensitive, most disks are not — rename one`, path: outs[0] as string });
  }
  for (const out of outputs.keys()) {
    const segs = out.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      if (outputs.has(dir)) add({ code: 'name-collision', message: `${dir} is both a file (${(outputs.get(dir) as string[]).join(', ')}) and the folder of ${out}`, path: dir });
    }
  }

  // ── includes and links ───────────────────────────────────────────────────
  const ictx: IncludeContext = {
    files, config: cfg, baseUrl, offline: env.offline === true,
    fetch: env.fetch ?? defaultFetch(),
    includeTargets: (t) => includeTargets('md')(t),
    cache: new Map(),
  };
  const records = new Map<string, Awaited<ReturnType<typeof resolveIncludes>>>();
  for (const d of docs) {
    const r = await resolveIncludes(d.path, d.text, { ...ictx, includeTargets: includeTargets(d.kind) });
    records.set(d.path, r);
    for (const f of r.findings) add(f, isSoftInclude(f.code) && cfg.includes.missing === 'warn' ? 'warning' : 'error');
  }
  const outputSet = new Set(outputs.keys());
  const basePath = baseUrl ? new URL(baseUrl).pathname : '/';
  for (const d of docs) {
    const links = [...linksOf(d.kind, d.text), ...(records.get(d.path)?.fileTexts ?? []).flatMap((t) => linksOf(d.kind, t).map((l) => ({ ...l, line: 0 })))];
    for (const l of links) checkLink(d, l);
  }
  function checkLink(d: Doc, l: LinkRef): void {
    const at = { path: d.path, ...(l.line ? { line: l.line } : {}), target: l.href };
    if (l.kind === 'other') return;
    if (l.raw) {
      if (l.kind === 'twin') add({ code: 'raw-twin-link', message: `a raw-HTML <a href="${l.href}"> is not rewritten to the page's name (only Markdown links are); write it as [text](${l.href})`, ...at }, 'warning');
      return;
    }
    const cut = l.href.search(/[?#]/);
    const rawPath = cut >= 0 ? l.href.slice(0, cut) : l.href;
    const pathPart = decodePath(rawPath);
    if (l.kind === 'asset' && !l.image && /\.md$/i.test(pathPart) && !/\.md$/.test(pathPart)) {
      add({ code: 'case-link', message: `${l.href}: a text extension in upper case is not rewritten to the page's name (write .md in lower case)`, ...at }, 'warning');
      return;
    }
    let resolved: string | null;
    if (pathPart.startsWith('/')) {
      if (basePath !== '/') add({ code: 'root-relative', message: `${l.href} resolves against the host root, not the site (${basePath}); write it relative to this page`, ...at }, 'warning');
      const local = basePath !== '/' && pathPart.startsWith(basePath) ? pathPart.slice(basePath.length) : pathPart.slice(1);
      resolved = resolveIn('', local);
    } else resolved = resolveIn(dirOf(d.path), pathPart);
    if (l.kind === 'twin') {
      const target = resolved;
      if (target !== null && docByPath.has(target) && cfg.notFound !== target) return;
      const why = target === null ? 'it leaves the site root' : cfg.notFound === target ? 'it is the 404 page (published as 404.html)' : notBuilt.has(target) ? `${target} is not built (${notBuilt.get(target)})` : `${target} is not a text of the site`;
      add({ code: 'missing-link', message: `${l.href}: a link to a page that is not built — ${why}`, ...at }, cfg.links.missing === 'warn' ? 'warning' : 'error');
      return;
    }
    // asset
    if (resolved === null) { add({ code: 'missing-asset', message: `${l.href} leaves the site root`, ...at }, 'warning'); return; }
    const isDir = rawPath.endsWith('/') || resolved === '';
    const file = isDir ? (resolved ? `${resolved}/index.html` : 'index.html') : resolved;
    if (outputSet.has(file)) return;
    add({ code: 'missing-asset', message: `${l.href}: ${file} is not in the built site${skipped.some((s) => s.path === resolved) ? ' (excluded)' : ''}`, ...at }, 'warning');
  }

  if (errors.length > 0) return refused(errors, warnings, cfg, baseUrl);

  // ── assemble ─────────────────────────────────────────────────────────────
  const out = new Map<string, Uint8Array>();
  const manifestDocs: ManifestDocument[] = [];
  const previous = env.previous;
  const namingKey = JSON.stringify(cfg.naming);
  for (const d of docs) {
    const r = records.get(d.path) as Awaited<ReturnType<typeof resolveIncludes>>;
    const textSha = await sha256Hex(d.bytes);
    const key = await sha256Hex(JSON.stringify(['orz-site', VERSION, d.kind, d.carrier.version, d.delivery, namingKey, textSha, await recordHash(r.record)]));
    let html: Uint8Array | null = null;
    const prev = previous?.manifest.documents.find((x) => x.path === d.path);
    if (prev && prev.key === key && prev.output === d.output) {
      const bytes = previous?.files.get(prev.output);
      if (bytes && (await sha256Hex(bytes)) === prev.outputSha256) html = bytes;
    }
    if (!html) {
      try {
        const s = await d.carrier.assemble(d.text, { delivery: d.delivery, ...(Object.keys(r.record).length > 0 ? { includes: r.record } : {}) });
        html = utf8(s);
      } catch (e) {
        add({ code: 'invalid-text', message: `${PACKAGE[d.kind]} ${d.carrier.version} cannot assemble it: ${(e as Error).message}`, path: d.path });
        continue;
      }
    }
    out.set(d.output, html);
    if (cfg.texts) out.set(d.path, d.bytes);
    manifestDocs.push({
      path: d.path, sha256: textSha, kind: d.kind, output: d.output, outputSha256: await sha256Hex(html), delivery: d.delivery,
      title: d.info.title, ...(d.info.meta.uid ? { uid: d.info.meta.uid } : {}), includes: r.manifest, key,
    });
  }
  if (errors.length > 0) return refused(errors, warnings, cfg, baseUrl);
  const manifestAssets: Manifest['assets'] = [];
  for (const a of assets) { out.set(a, files.get(a) as Uint8Array); manifestAssets.push({ path: a, sha256: await sha256Hex(files.get(a) as Uint8Array) }); }

  const generated: Manifest['generated'] = [];
  if (makeIndex) {
    const md = carrierOk.get('md') as CarrierModule;
    const entries: IndexEntry[] = docs.filter((d) => d.output !== GENERATED.notFound).map((d) => ({
      path: d.path, kind: d.kind, title: d.info.title,
      ...(d.info.meta.date ? { date: d.info.meta.date } : {}),
      ...(d.info.meta.description ? { description: d.info.meta.description } : {}),
    }));
    const text = indexText(entries, cfg.index);
    const delivery = matchesAny(GENERATED.indexText, cfg.inline) ? 'inline' : cfg.delivery;
    let html: Uint8Array;
    try { html = utf8(await md.assemble(text, { delivery })); } catch (e) {
      add({ code: 'invalid-text', message: `the generated index cannot be assembled: ${(e as Error).message}`, path: GENERATED.index });
      return refused(errors, warnings, cfg, baseUrl);
    }
    out.set(GENERATED.index, html);
    if (publishIndexText) out.set(GENERATED.indexText, utf8(text));
    generated.push({ path: GENERATED.index, sha256: await sha256Hex(html), source: text, ...(publishIndexText ? { text: GENERATED.indexText } : {}) });
  }
  if (sitemapOn) {
    const pages = [...docs.filter((d) => d.output !== GENERATED.notFound).map((d) => ({ out: d.output, date: d.info.meta.date })), ...(makeIndex ? [{ out: GENERATED.index, date: undefined }] : [])]
      .sort((a, b) => byCodeUnits(a.out, b.out));
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const body = pages.map((p) => `  <url>\n    <loc>${esc(`${baseUrl}${encodePath(p.out)}`)}</loc>\n${p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? `    <lastmod>${p.date}</lastmod>\n` : ''}  </url>\n`).join('');
    const xml = utf8(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}</urlset>\n`);
    out.set(GENERATED.sitemap, xml);
    generated.push({ path: GENERATED.sitemap, sha256: await sha256Hex(xml) });
  }
  const nojekyll = new Uint8Array(0);
  out.set(GENERATED.nojekyll, nojekyll);
  generated.push({ path: GENERATED.nojekyll, sha256: await sha256Hex(nojekyll) });
  generated.sort((a, b) => byCodeUnits(a.path, b.path));

  const usedCarriers: Manifest['carriers'] = {};
  for (const k of KINDS) if (docs.some((d) => d.kind === k) || (k === 'md' && makeIndex)) usedCarriers[k] = { version: (carrierOk.get(k) as CarrierModule).version };
  const manifest: Manifest = {
    format: 1,
    generator: `orz-site ${VERSION}`,
    config: { sha256: await sha256Hex(env.configBytes ?? utf8(canonicalJson(config ?? null))) },
    baseUrl,
    carriers: usedCarriers,
    naming: cfg.naming,
    documents: manifestDocs.sort((a, b) => byCodeUnits(a.path, b.path)),
    assets: manifestAssets.sort((a, b) => byCodeUnits(a.path, b.path)),
    generated,
    skipped: skipped.sort((a, b) => byCodeUnits(a.path, b.path)),
  };
  out.set(GENERATED.manifest, utf8(canonicalJson(manifest)));

  const sorted = new Map([...out].sort((a, b) => byCodeUnits(a[0], b[0])));
  const report: Report = { ok: true, errors: [], warnings: sortFindings(dedupe(warnings)), documents: docs.length, assets: assets.length, outputs: sorted.size };
  if (env.check) return { ok: true, files: new Map(), manifest, report };
  return { ok: true, files: sorted, manifest, report };

  function refused(errs: Finding[], warns: Finding[], c: SiteConfig | null, b: string | null): BuildResult {
    const report: Report = { ok: false, errors: sortFindings(dedupe(errs)), warnings: sortFindings(dedupe(warns)), documents: 0, assets: 0, outputs: 0 };
    return { ok: false, files: new Map(), manifest: emptyManifest(c, b), report };
  }
}

/** `checkSite` = `buildSite` without outputs (spec §7.1): the report. */
export async function checkSite(files: SiteFiles, config: unknown, env: BuildEnv = {}): Promise<Report> {
  return (await buildSite(files, config, { ...env, check: true })).report;
}
