/**
 * The release gate of an orz family package (family Phase 4 step 1, claims R.1–R.9 in the family root's
 * notes/PHASE4-CLAIMS.md). ONE file, byte-identical in orz-markdown, orz-mdhtml, orz-slides and orz-paged; the
 * canonical copy is the family root's scripts/release-tooling/ (`scripts/tooling-sync.ts --write` copies it, `--check`
 * compares). Everything package-specific comes from `release.config.json` next to package.json.
 *
 *   tsx scripts/release-check.ts                 `npm run release:check`; both prepublishOnlys run it
 *   tsx scripts/release-check.ts --after-build   the root prepublishOnly, right after `npm run build`: a dirty tree
 *                                                then means the build is not deterministic or not committed
 *
 * It refuses, each time with the reason and what to do, unless
 *   - the package and its browser package (`browser` in the config; the kit has none) have one version;      R.1
 *   - the CHANGELOG has a dated entry for the version, not marked unreleased/prepared;                       R.2, R.3
 *   - for a carrier (`kit` in the config): the kit dependency is written ^X.Y.Z with X.Y.Z at least the kit
 *     the code needs (`kit.required`);                                                                       R.4
 *   - the installed kit is a registry install (not a link to a checkout; the lockfile names a registry
 *     tarball) that satisfies that range;                                                                   R.5, R.6
 *   - every built bundle embeds the installed kit's VERSION, or the one the release manifest names (`kit`);   R.7
 *   - the working tree is clean (a release is a commit);                                                     R.8
 *   - the release manifest matches the built files (the config's `checks`, e.g. browser/scripts/check-release.mjs).  R.9
 * Self-contained (node: built-ins only, no top-level await, no TS-only runtime syntax), so it runs under tsx in a
 * CommonJS or ESM package and under `node --experimental-strip-types`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ReleaseConfig {
  /** The browser package's folder (lockstep version), or null (the kit). */
  browser: string | null;
  /** The kit dependency of a carrier, or null (the kit itself). */
  kit: { name: string; required: string } | null;
  /** The release manifest (carriers: browser/release.json); its optional `kit` names the bundled kit. */
  manifest: string | null;
  /** The built files (or folders) the stamp hashes; the `.js`/`.mjs` ones are scanned for the bundled kit. */
  bundles: string[];
  /** Commands that must pass: the release manifest matches the built files. */
  checks: string[][];
  /** The build (`npm run build`), run by test-release before the suite. */
  build: string[];
  changelog: string;
  [key: string]: unknown;
}

export interface ReleaseState {
  name: string;
  version: string;
  /** null: no browser package. */
  browserVersion: string | null;
  /** package.json's dependency on the kit (null: none, or this is the kit). */
  kitRange: string | null;
  /** node_modules/<kit> is a symbolic link (a checkout), not an install. */
  kitLinked: boolean;
  kitInstalled: string | null;
  /** package-lock.json's `resolved` for the kit (null: no entry; "link" for a linked entry). */
  kitLocked: string | null;
  /** Per built bundle: the kit VERSIONs it embeds (null: the file is missing; []: none found). */
  bundledKit: { file: string; versions: string[] | null }[];
  /** The kit version the release manifest names, if any. */
  manifestKit: string | null;
  changelog: string;
  head: string | null;
  /** `git status --porcelain` is empty (false outside a git repository). */
  clean: boolean;
  /** The porcelain lines, for the message. */
  dirty: string[];
  /** The config's `checks`, run: their failures (command and output). */
  checkFailures: { command: string; output: string }[];
}

const ROOT_OF_SCRIPT = (): string => join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(root: string): ReleaseConfig {
  const file = join(root, 'release.config.json');
  if (!existsSync(file)) throw new Error(`${file} is missing: every package names its release facts there`);
  const c = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReleaseConfig>;
  return {
    ...c,
    browser: c.browser ?? null,
    kit: c.kit ?? null,
    manifest: c.manifest ?? null,
    bundles: c.bundles ?? [],
    checks: c.checks ?? [],
    build: c.build ?? ['npm', 'run', 'build'],
    changelog: c.changelog ?? 'CHANGELOG.md',
  };
}

const parse = (v: string): number[] | null => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const atLeast = (v: number[], min: number[]): boolean => { for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return (v[i] as number) > (min[i] as number); return true; };

/** The kit VERSIONs a bundle embeds: the kit's version module, `X.VERSION="a.b.c";X.KATEX_VERSION=` once minified. */
export function bundledKitVersions(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\.VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']\s*[;,]\s*\1\.KATEX_VERSION\s*=/g)) out.add(m[2] as string);
  return [...out];
}

/** What stops a release, in words (empty: none). Pure, for the tests. */
export function releaseProblems(s: ReleaseState, config: ReleaseConfig, opts: { afterBuild?: boolean } = {}): string[] {
  const out: string[] = [];
  const browserName = `${s.name}-browser`;
  // R.1 lockstep
  if (config.browser && s.browserVersion !== s.version) out.push(`${s.name} is ${s.version}, ${browserName} ${s.browserVersion ?? '(missing)'}: the two are released with the same version — bump both package.json files`);
  // R.4–R.7 the kit
  if (config.kit) {
    const kit = config.kit.name;
    const req = config.kit.required;
    const min = parse(req);
    if (!min) out.push(`release.config.json kit.required is "${req}": write it as X.Y.Z`);
    const range = s.kitRange === null ? null : /^\^(\d+\.\d+\.\d+)$/.exec(s.kitRange);
    const floor = range ? parse(range[1] as string) : null;
    if (!floor) out.push(`the ${kit} dependency is "${s.kitRange ?? '(none)'}": write it as ^${req} (or later) in package.json, then \`npx npm@11 install ${kit}@^${req}\``);
    else if (min && (!atLeast(floor, min) || floor[0] !== min[0])) out.push(`the ${kit} dependency is "${s.kitRange}", but this code needs ${kit} ${req} (release.config.json kit.required): \`npx npm@11 install ${kit}@^${req}\``);
    if (s.kitLocked !== null && !/^https:\/\/registry\.npmjs\.org\//.test(s.kitLocked)) out.push(`package-lock.json resolves ${kit} to "${s.kitLocked}", not the npm registry: \`npx npm@11 install ${kit}@${s.kitRange ?? `^${req}`}\` and commit the lockfile`);
    if (s.kitLinked) out.push(`node_modules/${kit} is a link to a checkout: never release from a link — \`npx npm@11 install ${kit}@${s.kitRange ?? `^${req}`}\` installs the published package`);
    else if (s.kitInstalled === null) out.push(`${kit} is not installed: \`npm ci\``);
    else {
      const v = parse(s.kitInstalled);
      if (!v || (min && !atLeast(v, min)) || (floor && (!atLeast(v, floor) || v[0] !== floor[0]))) out.push(`the installed ${kit} is ${s.kitInstalled}, which does not satisfy "${s.kitRange}" (at least ${req}): \`npm ci\` (or \`npx npm@11 install ${kit}@${s.kitRange ?? `^${req}`}\`)`);
    }
    for (const b of s.bundledKit) {
      if (b.versions === null) { out.push(`${b.file} is missing: \`npm run build\``); continue; }
      if (b.versions.length === 0) { out.push(`${b.file} embeds no ${kit} VERSION that the gate can read (the kit's version module): rebuild with \`npm run build\`, or check the bundle`); continue; }
      const ok = b.versions.every((x) => x === s.kitInstalled || (s.manifestKit !== null && x === s.manifestKit));
      if (!ok) out.push(`${b.file} embeds ${kit} ${b.versions.join(', ')}, but the installed ${kit} is ${s.kitInstalled ?? '(none)'}${s.manifestKit ? ` and the manifest names ${s.manifestKit}` : ''}: \`npm run build\` (a stale bundle, or one built from a link)`);
    }
  }
  // R.2, R.3 the CHANGELOG
  const esc = s.version.replace(/\./g, '\\.');
  const head = new RegExp(`^## \\[${esc}\\] [-–—] (.*)$`, 'm').exec(s.changelog);
  const entry = head ? /^(\d{4}-\d{2}-\d{2})(.*)$/.exec((head[1] as string).trim()) : null;
  if (!head) out.push(`the CHANGELOG has no "## [${s.version}] — <date>" entry: move [Unreleased] to it and date it`);
  else if (!entry) out.push(`the CHANGELOG entry of ${s.version} is not dated ("${(head[1] as string).trim()}"): date it (YYYY-MM-DD)`);
  else if (/unreleased|prepared|not (yet )?(released|published)/i.test(entry[2] as string)) out.push(`the CHANGELOG entry of ${s.version} is still marked "${(entry[2] as string).trim()}": date it and drop the mark`);
  // R.8 a clean tree
  if (s.head === null) out.push('this is not a git repository (or git failed): a release is a commit');
  else if (!s.clean) {
    const files = s.dirty.slice(0, 8).join('; ') + (s.dirty.length > 8 ? `; … (${s.dirty.length})` : '');
    out.push(opts.afterBuild
      ? `the working tree is not clean after the build (${files}): either there were uncommitted changes, or the build changed tracked files (not deterministic, or its output was not committed) — commit or revert, and \`npm run build\` again`
      : `the working tree has uncommitted changes (${files}): commit the release first (keep tokens outside the repo)`);
  }
  // R.9 the release manifest matches the built files
  for (const f of s.checkFailures) out.push(`\`${f.command}\` refuses (the release manifest does not match the built files — \`npm run build\`): ${f.output.trim().split('\n').slice(0, 6).join(' | ')}`);
  return out;
}

/** The repository's state now. */
export function releaseState(root: string, config: ReleaseConfig): ReleaseState {
  const json = (f: string): Record<string, any> => JSON.parse(readFileSync(join(root, f), 'utf8')) as Record<string, any>;
  const pkg = json('package.json');
  const git = (...args: string[]): string | null => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, ''); } catch { return null; } };
  let kitRange: string | null = null;
  let kitLinked = false;
  let kitInstalled: string | null = null;
  let manifestKit: string | null = null;
  let kitLocked: string | null = null;
  const bundledKit: ReleaseState['bundledKit'] = [];
  if (config.kit) {
    const name = config.kit.name;
    kitRange = (pkg.dependencies?.[name] as string | undefined) ?? null;
    const link = join(root, 'node_modules', name);
    kitLinked = existsSync(link) && lstatSync(link).isSymbolicLink();
    kitInstalled = existsSync(join(link, 'package.json')) ? String(json(`node_modules/${name}/package.json`).version) : null;
    if (existsSync(join(root, 'package-lock.json'))) {
      const entry = (json('package-lock.json').packages ?? {})[`node_modules/${name}`] as { resolved?: string; link?: boolean } | undefined;
      kitLocked = entry ? (entry.link ? 'link' : String(entry.resolved ?? '(no resolved)')) : null;
    }
    if (config.manifest && existsSync(join(root, config.manifest))) {
      const k = json(config.manifest).kit as unknown;
      manifestKit = typeof k === 'string' ? k : (k && typeof k === 'object' && typeof (k as { version?: unknown }).version === 'string') ? (k as { version: string }).version : null;
    }
    for (const b of config.bundles) {
      if (!/\.m?js$/.test(b)) continue;
      const p = join(root, b);
      bundledKit.push({ file: b, versions: existsSync(p) && statSync(p).isFile() ? bundledKitVersions(readFileSync(p, 'latin1')) : null });
    }
  }
  const porcelain = git('status', '--porcelain');
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean) : [];
  const checkFailures: ReleaseState['checkFailures'] = [];
  for (const cmd of config.checks) {
    const [bin, ...args] = cmd as [string, ...string[]];
    const r = spawnSync(bin === 'node' ? process.execPath : bin, args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) checkFailures.push({ command: cmd.join(' '), output: `${r.stderr ?? ''}${r.stdout ?? ''}${r.error ? String(r.error) : ''}` || `exit ${r.status}` });
  }
  const changelogFile = join(root, config.changelog);
  return {
    name: String(pkg.name),
    version: String(pkg.version),
    browserVersion: config.browser ? (existsSync(join(root, config.browser, 'package.json')) ? String(json(join(config.browser, 'package.json')).version) : null) : null,
    kitRange, kitLinked, kitInstalled, kitLocked, bundledKit, manifestKit,
    changelog: existsSync(changelogFile) ? readFileSync(changelogFile, 'utf8') : '',
    head: git('rev-parse', 'HEAD'),
    clean: porcelain === '',
    dirty,
    checkFailures,
  };
}

/** The kit this repository's code needs (release.config.json kit.required; null for the kit). */
export const KIT_REQUIRED: string | null = (() => { try { return loadConfig(ROOT_OF_SCRIPT()).kit?.required ?? null; } catch { return null; } })();

const isMain = (): boolean => { try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };

if (isMain()) {
  const root = ROOT_OF_SCRIPT();
  const config = loadConfig(root);
  const state = releaseState(root, config);
  const problems = releaseProblems(state, config, { afterBuild: process.argv.includes('--after-build') });
  if (problems.length > 0) {
    console.error(`${state.name} release check: not ready\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const parts = [config.browser ? 'lockstep' : null, config.kit ? `${config.kit.name} ${state.kitInstalled} installed and bundled` : null, 'dated entry', 'clean tree', config.checks.length ? 'manifest matches the files' : null].filter(Boolean);
  console.log(`${state.name} release check: ${state.version} at ${state.head?.slice(0, 12)} passes (${parts.join(', ')})`);
}
