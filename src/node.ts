/**
 * `orz-site/node` — the Node adapter (spec §7.1): read a folder into a file
 * map (§10's confinement), load the installed carriers, write a site
 * atomically into an output folder it owns, and the folder-level `build`,
 * `check` and `init` the CLI runs. Everything that decides what is built is
 * the core (`buildSite`); this module only moves bytes.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { buildSite, GENERATED, MANIFEST_FILE } from './build.js';
import { CONFIG_FILE, defaultConfig, SCHEMA_URL } from './config.js';
import { byCodeUnits } from './paths.js';
import { KINDS, type BuildEnv, type BuildResult, type CarrierModule, type Finding, type Kind, type Manifest, type Report } from './types.js';
import { VERSION } from './version.js';
import { differsOnlyInVersions, WORKFLOW_FILE, workflowDrift, workflowText } from './workflow.js';

export * from './index.js';

const PACKAGE: Record<Kind, string> = { md: 'orz-mdhtml', slides: 'orz-slides', paged: 'orz-paged' };

/** What {@link readSiteFolder} read. */
export interface FolderRead {
  files: Map<string, Uint8Array>;
  errors: Finding[];
  warnings: Finding[];
  /** The output folder's site path when it lies inside the root, else null. */
  outDir: string | null;
}

/**
 * Read a site folder into a file map (spec §2.1, §10). Never read: any path
 * segment starting with `.`, `node_modules/`, names ending in `~`, the config
 * file (read apart) and the output folder. Symbolic links inside the root are
 * followed; a link whose real path leaves the root is `symlink-out`, a cycle
 * too. Paths are NFC.
 */
export function readSiteFolder(dir: string, o: { out?: string } = {}): FolderRead {
  const root = realpathSync(dir);
  const files = new Map<string, Uint8Array>();
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  let outReal: string | null = null;
  if (o.out && existsSync(o.out)) { try { outReal = realpathSync(o.out); } catch { outReal = null; } }
  const outAbs = o.out ? resolve(o.out) : null;
  const inside = (p: string): boolean => p === root || p.startsWith(root + sep);
  const outDirOf = (abs: string | null): string | null => (abs && inside(abs) && abs !== root ? relative(root, abs).split(sep).join('/') : null);
  const outDir = outDirOf(outReal) ?? outDirOf(outAbs);

  const walk = (abs: string, site: string, stack: Set<string>): void => {
    let entries: string[];
    try { entries = readdirSync(abs); } catch (e) { errors.push({ code: 'unreadable', message: `the folder cannot be read (${(e as Error).message})`, path: site || '.' }); return; }
    for (const name of entries.sort(byCodeUnits)) {
      if (name.startsWith('.') || name === 'node_modules' || name.endsWith('~')) continue;
      const sitePath = (site ? `${site}/${name}` : name).normalize('NFC');
      if (sitePath === CONFIG_FILE) continue;
      const full = join(abs, name);
      if (outReal && (full === outReal || (outAbs !== null && full === outAbs))) continue;
      if (outDir && (sitePath === outDir || sitePath.startsWith(`${outDir}/`))) continue;
      let st = lstatSync(full);
      let real = full;
      if (st.isSymbolicLink()) {
        try { real = realpathSync(full); } catch { errors.push({ code: 'symlink-out', message: 'a symbolic link whose target does not exist', path: sitePath }); continue; }
        if (!inside(real)) { errors.push({ code: 'symlink-out', message: `a symbolic link out of the site root (to ${real}); not read`, path: sitePath }); continue; }
        st = statSync(real);
      }
      if (st.isDirectory()) {
        const key = realpathSync(real);
        if (stack.has(key)) { errors.push({ code: 'symlink-out', message: 'a symbolic link cycle; not read', path: sitePath }); continue; }
        if (outReal && key === outReal) continue;
        walk(real, sitePath, new Set([...stack, key]));
      } else if (st.isFile()) {
        files.set(sitePath, new Uint8Array(readFileSync(real)));
      }
    }
  };
  walk(root, '', new Set([root]));
  return { files, errors, warnings, outDir };
}

/** The installed carriers. */
export interface LoadedCarriers {
  carriers: Partial<Record<Kind, CarrierModule>>;
}

/** Adapt a carrier package's Node library to {@link CarrierModule}. */
export function carrierModule(kind: Kind, m: Record<string, unknown>): CarrierModule {
  return {
    kind,
    version: String(m['VERSION']),
    formats: (m['FORMATS'] as readonly number[] | undefined) ?? [1],
    assemble: m['assemble'] as CarrierModule['assemble'],
    extract: m['extract'] as CarrierModule['extract'],
    readDocument: m['readDocument'] as CarrierModule['readDocument'],
    ...(typeof m['includeTargets'] === 'function' ? { includeTargets: m['includeTargets'] as (t: string) => string[] } : {}),
    ...(typeof m['linkTargets'] === 'function' ? { linkTargets: m['linkTargets'] as CarrierModule['linkTargets'] } : {}),
  };
}

/**
 * Import the installed `orz-mdhtml`, `orz-slides`, `orz-paged` (those that are
 * installed; the core refuses a used kind without one, and a version other
 * than the pin — `shell-mismatch`). A carrier that re-exports the kit's
 * `includeTargets`/`linkTargets` (1.1) is read with them; otherwise the core
 * uses its own kit's (browser-safe since orz-markdown 2.5.0).
 */
export async function loadCarriers(): Promise<LoadedCarriers> {
  const carriers: Partial<Record<Kind, CarrierModule>> = {};
  for (const kind of KINDS) {
    try {
      carriers[kind] = carrierModule(kind, (await import(PACKAGE[kind])) as Record<string, unknown>);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  return { carriers };
}

/** The installed version of each carrier (for `init`). */
export async function installedVersions(): Promise<Partial<Record<Kind, string>>> {
  const { carriers } = await loadCarriers();
  const out: Partial<Record<Kind, string>> = {};
  for (const k of KINDS) if (carriers[k]) out[k] = (carriers[k] as CarrierModule).version;
  return out;
}

/** A failure of the adapter (usage or a write), with the CLI's reason code. */
export class SiteError extends Error {
  readonly reason: string;
  readonly exitCode: number;
  readonly next?: Finding['next'];
  constructor(message: string, reason: string, exitCode = 1, next?: Finding['next']) { super(message); this.reason = reason; this.exitCode = exitCode; if (next) this.next = next; }
}

/**
 * Write a built site to `out` (spec §6): into a sibling temporary folder,
 * then renamed over `out`. An existing `out` that is not empty and holds no
 * `orz-site-manifest.json` is refused (`out-not-site`): the build never
 * replaces a folder it did not make. `root` (the site folder) can never be
 * the output or inside it.
 */
export function writeSite(out: string, result: BuildResult, o: { root?: string } = {}): void {
  if (!result.ok) throw new SiteError('the build was refused: nothing is written', 'refused');
  const target = resolve(out);
  if (o.root) {
    const root = realpathSync(o.root);
    const t = existsSync(target) ? realpathSync(target) : target;
    if (t === root || root.startsWith(t + sep)) throw new SiteError(`the output ${out} is the site folder or holds it: choose another -o`, 'out-not-site', 2);
  }
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (!st.isDirectory()) throw new SiteError(`${out} exists and is not a folder: choose another -o, or remove it`, 'out-not-site');
    const entries = readdirSync(target);
    if (entries.length > 0 && !entries.includes(MANIFEST_FILE)) throw new SiteError(`${out} exists, is not empty and holds no ${MANIFEST_FILE}: orz-site replaces only a folder it made — choose another -o, or empty it`, 'out-not-site');
  }
  const parent = dirname(target);
  try { mkdirSync(parent, { recursive: true }); } catch (e) { throw new SiteError(`cannot create ${parent}: ${(e as Error).message}`, 'write-failed'); }
  const tmp = mkdtempSync(join(parent, `.${basename(target)}.orz-site-`));
  try {
    for (const [p, bytes] of result.files) {
      const file = join(tmp, ...p.split('/'));
      if (!resolve(file).startsWith(tmp + sep)) throw new SiteError(`refusing to write ${p} outside the output`, 'write-failed');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    if (existsSync(target)) {
      const old = `${tmp}.old`;
      renameSync(target, old);
      renameSync(tmp, target);
      rmSync(old, { recursive: true, force: true });
    } else renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (e instanceof SiteError) throw e;
    throw new SiteError(`writing ${out} failed: ${(e as Error).message}; the previous output is unchanged`, 'write-failed');
  }
}

/** Options of {@link buildFolder}. */
export interface FolderOptions {
  out?: string;
  baseUrl?: string;
  offline?: boolean;
  incremental?: boolean;
  check?: boolean;
  /** Network transport (tests); default the global fetch. */
  fetch?: BuildEnv['fetch'];
  /** Carriers to use instead of the installed ones (tests). */
  carriers?: Partial<Record<Kind, CarrierModule>>;
}

/** What {@link buildFolder} gives: the core's result plus the read config. */
export interface FolderBuild { result: BuildResult; config: unknown; outDir: string | null }

function readConfig(dir: string): { raw: unknown; bytes: Uint8Array | null; problem: Finding | null } {
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) return { raw: null, bytes: null, problem: null };
  const bytes = new Uint8Array(readFileSync(file));
  try {
    return { raw: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')), bytes, problem: null };
  } catch (e) {
    return { raw: null, bytes, problem: { code: 'bad-config', message: `${CONFIG_FILE} is not valid UTF-8 JSON: ${(e as Error).message}`, path: CONFIG_FILE } };
  }
}

/** A refused result without running the core (the config cannot be read). */
function refusedResult(errors: Finding[]): BuildResult {
  const report: Report = { ok: false, errors, warnings: [], documents: 0, assets: 0, outputs: 0 };
  return { ok: false, files: new Map(), manifest: { format: 1, generator: `orz-site ${VERSION}`, config: { sha256: '' }, baseUrl: null, carriers: {}, naming: 'family', documents: [], assets: [], generated: [], skipped: [] }, report };
}

/** Build (or check) a site folder: read it, load the carriers, run the core. Writes nothing. */
export async function buildFolder(dir: string, o: FolderOptions = {}): Promise<FolderBuild> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new SiteError(`${dir} is not a folder`, 'no-such-file', 2);
  const cfg = readConfig(dir);
  if (cfg.problem) return { result: refusedResult([cfg.problem]), config: null, outDir: null };
  const read = readSiteFolder(dir, o.out ? { out: o.out } : {});
  const loaded = o.carriers ? { carriers: o.carriers } : await loadCarriers();
  let previous: BuildEnv['previous'];
  if (o.incremental && o.out && existsSync(join(o.out, MANIFEST_FILE))) {
    try {
      const manifest = JSON.parse(readFileSync(join(o.out, MANIFEST_FILE), 'utf8')) as Manifest;
      const files = new Map<string, Uint8Array>();
      for (const d of manifest.documents ?? []) {
        const f = join(o.out, ...d.output.split('/'));
        if (existsSync(f)) files.set(d.output, new Uint8Array(readFileSync(f)));
      }
      previous = { manifest, files };
    } catch { previous = undefined; }
  }
  const extra: Finding[] = [];
  if (o.check && cfg.raw && typeof cfg.raw === 'object') {
    const wf = join(dir, ...WORKFLOW_FILE.split('/'));
    if (existsSync(wf)) {
      const pins = ((cfg.raw as { carriers?: Partial<Record<Kind, string>> }).carriers) ?? {};
      const drift = workflowDrift(readFileSync(wf, 'utf8'), pins);
      if (drift.length) extra.push({ code: 'workflow-drift', message: `the workflow installs other versions than ${CONFIG_FILE} pins (${drift.join('; ')})`, path: WORKFLOW_FILE, next: { command: 'init', args: [dir, '--github', '--update'] } });
    }
  }
  const env: BuildEnv = {
    carriers: loaded.carriers,
    offline: o.offline === true,
    findings: { errors: [...read.errors, ...extra], warnings: read.warnings },
    outDir: read.outDir,
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(previous ? { previous } : {}),
    ...(cfg.bytes ? { configBytes: cfg.bytes } : {}),
    ...(o.check ? { check: true } : {}),
  };
  const result = await buildSite(read.files, cfg.raw, env);
  return { result, config: cfg.raw, outDir: read.outDir };
}

/** What `init` wrote. */
export interface InitResult { written: string[]; config: Record<string, unknown> }

/** The config `init` writes: the installed carriers as pins and the defaults, in the spec's key order. */
export function initialConfig(pins: Partial<Record<Kind, string>>): Record<string, unknown> {
  const d = defaultConfig();
  return {
    $schema: SCHEMA_URL,
    format: 1,
    carriers: Object.fromEntries(KINDS.filter((k) => pins[k]).map((k) => [k, pins[k]])),
    delivery: d.delivery,
    inline: d.inline,
    naming: d.naming,
    baseUrl: d.baseUrl,
    includes: d.includes,
    links: d.links,
    exclude: d.exclude,
    texts: d.texts,
    index: d.index,
    sitemap: d.sitemap,
    notFound: d.notFound,
  };
}

/**
 * `orz-site init [dir] [--github [--update]]` (spec §7.3): write
 * `orz-site.json` (the installed carriers as pins, the defaults) and, with
 * `github`, `.github/workflows/orz-site.yml` (§8). An existing file is never
 * overwritten (`exists`); `--update` rewrites the workflow only when it
 * differs from the template in orz-site's own version lines alone.
 */
export async function initSite(dir: string, o: { github?: boolean; update?: boolean; pins?: Partial<Record<Kind, string>> } = {}): Promise<InitResult> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new SiteError(`${dir} is not a folder`, 'no-such-file', 2);
  const written: string[] = [];
  const cfgFile = join(dir, CONFIG_FILE);
  let config: Record<string, unknown>;
  if (existsSync(cfgFile)) {
    if (!o.github) throw new SiteError(`${CONFIG_FILE} exists; init never overwrites it (edit it, or remove it first)`, 'exists');
    try { config = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>; } catch (e) { throw new SiteError(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`, 'bad-config'); }
  } else {
    config = initialConfig(o.pins ?? (await installedVersions()));
    writeFileSync(cfgFile, `${JSON.stringify(config, null, 2)}\n`);
    written.push(CONFIG_FILE);
  }
  if (o.github) {
    const pins = (config['carriers'] as Partial<Record<Kind, string>> | undefined) ?? {};
    const text = workflowText(VERSION, pins);
    const wf = join(dir, ...WORKFLOW_FILE.split('/'));
    if (existsSync(wf)) {
      const have = readFileSync(wf, 'utf8');
      if (have === text) return { written, config };
      if (!differsOnlyInVersions(have, text)) throw new SiteError(`${WORKFLOW_FILE} exists and differs from the template beyond its versions; init never overwrites it (merge by hand, or remove it and run init --github again)`, 'exists');
      if (!o.update) throw new SiteError(`${WORKFLOW_FILE} exists with other versions; \`orz-site init --github --update\` rewrites its version lines`, 'exists', 1, { command: 'init', args: [dir, '--github', '--update'] });
    }
    mkdirSync(dirname(wf), { recursive: true });
    writeFileSync(wf, text);
    written.push(WORKFLOW_FILE);
  }
  return { written, config };
}

export { GENERATED, WORKFLOW_FILE };
