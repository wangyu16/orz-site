/**
 * The green-run stamp and the test tiers of an orz family package (family Phase 4 step 2, claims R.10–R.19 in the
 * family root's notes/PHASE4-CLAIMS.md). ONE file, byte-identical in orz-markdown, orz-mdhtml, orz-slides and
 * orz-paged; the canonical copy is the family root's scripts/release-tooling/ (`scripts/tooling-sync.ts`).
 * Package-specific facts come from `release.config.json` (see release-check.ts and `test` there).
 *
 *   tsx scripts/test-release.ts             `npm run test:release` — THE stamp run: on a clean tree, build (it must
 *                                           leave the tree clean: deterministic), run the full suite once (vitest,
 *                                           JSON reporter), re-run each failing file alone (up to 2 tries, every try
 *                                           recorded) — only its FAILED tests (`vitest run <file> -t '^(?:<exact full
 *                                           names>)$'`) when they can be selected reliably, else the whole file (a
 *                                           suite-level failure: a hook, an import error, a failed suite no failed
 *                                           test explains; each try records which) — run the config's `extra` steps,
 *                                           and when all is green write
 *                                           `.release/green.json` (git-ignored): commit, tree, Node and Chrome
 *                                           versions, per-file counts, re-runs, kit version, bundle hashes, date.
 *                                           `--full-extra` runs every extra step in full (else: see `extra` below).
 *   tsx scripts/test-release.ts --check     the STAMP CHECK of prepublishOnly (after the build and the release gate):
 *                                           passes only when a stamp exists, its commit is HEAD, the tree is clean and
 *                                           every built bundle hashes as stamped. It never runs the suite (seconds).
 *   tsx scripts/test-release.ts --fast      `npm run test:fast`: the no-Chrome lanes (config `test.fast`, vitest args).
 *   tsx scripts/test-release.ts --changed [--base <ref>] [--list]
 *                                           `npm run test:changed`: the fast lane, then the slow (Chrome) test files
 *                                           whose imports reach a file changed against <ref> (default origin/main;
 *                                           committed, staged, unstaged and untracked changes all count). The import
 *                                           graph: static `import`/`export … from`/`import()`/`require()` of relative
 *                                           modules, plus string literals that name an existing repository path
 *                                           (`'src/browser/index.ts'`, `'tests/fixtures/columns'` → every file under
 *                                           it), resolved from the file's folder or the repository root. A change
 *                                           under a `test.changedAll` prefix (package.json, the lockfile, the vitest
 *                                           config, the global setup, build/ …) selects every slow file. A speed tier,
 *                                           not proof: `test:release` is the proof. `--list` prints the selection.
 *
 * `extra` (config): steps run after the suite, e.g. orz-paged's columns matrix — `{ name, full, sample, fullWhen }`:
 * the full command runs when a changed file (against the last green run's commit, `.release/history.jsonl`, else
 * `test.base`) starts with one of `fullWhen`, or with `--full-extra`; else the sample command.
 * Self-contained like release-check.ts (node: built-ins only, no top-level await, no TS-only runtime syntax).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ExtraStep { name: string; full: string[]; sample?: string[]; fullWhen?: string[] }
export interface TestConfig {
  bundles: string[];
  build: string[];
  kit: { name: string; required: string } | null;
  test: {
    /** vitest args of the no-Chrome lanes (`--project main` …). */
    fast: string[];
    /** Path prefixes whose change selects every slow file in test:changed. */
    changedAll: string[];
    /** Record the installed Chrome's version (the suite drives real Chrome). */
    chrome: boolean;
    /** Tries per failing file, alone (default 2). */
    retries: number;
    /** Where test:changed and the extra steps diff from when there is no stamp. */
    base: string;
  };
  extra: ExtraStep[];
}

export interface FileCounts { passed: number; failed: number; skipped: number; todo: number; ms: number; status: 'passed' | 'failed'; reruns?: number; rerun?: 'tests' | 'file' }
/**
 * One re-run try. `mode` "tests": only the file's failed tests ran (`tests`, their full names, via `-t`); "file": the
 * whole file ran, `why` says why the tests could not be selected (or why a "tests" try was not trusted).
 */
export interface Rerun { file: string; try: number; ok: boolean; passed: number; failed: number; skipped: number; ms: number; mode: 'tests' | 'file'; tests?: string[]; why?: string }
export interface Stamp {
  stamp: 1;
  name: string;
  version: string;
  commit: string;
  tree: string;
  node: string;
  chrome: string | null;
  kit: { name: string; version: string | null };
  bundles: Record<string, string>;
  totals: { files: number; passed: number; failed: number; skipped: number; todo: number };
  files: Record<string, FileCounts>;
  reruns: Rerun[];
  extra: { name: string; mode: 'full' | 'sample'; reason: string; ok: boolean; ms: number }[];
  durationMs: { build: number; suite: number; reruns: number; extra: number; total: number };
  date: string;
}

export const STAMP = join('.release', 'green.json');
/** One line per green run (commit, version, date): the base of the extra steps' "changed since the last stamp". */
export const HISTORY = join('.release', 'history.jsonl');

function lastGreenCommit(root: string): string | null {
  const p = join(root, HISTORY);
  const lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
  for (let i = lines.length - 1; i >= 0; i--) { try { return (JSON.parse(lines[i] as string) as { commit: string }).commit; } catch { /* a torn line */ } }
  return readStamp(root)?.commit ?? null;
}
const ROOT_OF_SCRIPT = (): string => join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadTestConfig(root: string): TestConfig {
  const c = JSON.parse(readFileSync(join(root, 'release.config.json'), 'utf8')) as Record<string, any>;
  const t = (c.test ?? {}) as Record<string, any>;
  return {
    bundles: (c.bundles as string[] | undefined) ?? [],
    build: (c.build as string[] | undefined) ?? ['npm', 'run', 'build'],
    kit: (c.kit as TestConfig['kit'] | undefined) ?? null,
    test: {
      fast: (t.fast as string[] | undefined) ?? [],
      changedAll: (t.changedAll as string[] | undefined) ?? ['package.json', 'package-lock.json', 'vitest.config.ts'],
      chrome: t.chrome !== false,
      retries: typeof t.retries === 'number' ? t.retries : 2,
      base: (t.base as string | undefined) ?? 'origin/main',
    },
    extra: (c.extra as ExtraStep[] | undefined) ?? [],
  };
}

// ---------------------------------------------------------------------------------------------------------------- git

const gitIn = (root: string) => (...args: string[]): string | null => {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).replace(/\n$/, ''); } catch { return null; }
};

export function treeState(root: string): { head: string | null; tree: string | null; dirty: string[] } {
  const git = gitIn(root);
  const porcelain = git('status', '--porcelain');
  return { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), dirty: porcelain === null ? ['(git status failed: not a git repository?)'] : porcelain.split('\n').filter(Boolean) };
}

/** Files changed against `base` (committed since the merge base, staged, unstaged, untracked); null: unknown base. */
export function changedFiles(root: string, base: string): string[] | null {
  const git = gitIn(root);
  if (git('rev-parse', '--verify', '--quiet', `${base}^{commit}`) === null) return null;
  const out = new Set<string>();
  for (const list of [git('diff', '--name-only', `${base}...HEAD`) ?? git('diff', '--name-only', base, 'HEAD'), git('diff', '--name-only', 'HEAD'), git('ls-files', '--others', '--exclude-standard')]) {
    for (const f of (list ?? '').split('\n')) if (f) out.add(f);
  }
  return [...out].sort();
}

// ------------------------------------------------------------------------------------------------------------- hashes

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** sha256 of a file, or of a folder (its sorted relative paths and their contents' hashes); null: missing. */
export function hashPath(p: string): string | null {
  if (!existsSync(p)) return null;
  if (statSync(p).isFile()) return sha256(readFileSync(p));
  const lines: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) lines.push(`${relative(p, full).split(sep).join('/')}\0${sha256(readFileSync(full))}`);
    }
  };
  walk(p);
  return sha256(lines.join('\n'));
}

export function bundleHashes(root: string, bundles: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of bundles) out[b] = hashPath(join(root, b)) ?? 'missing';
  return out;
}

// --------------------------------------------------------------------------------------------------------- stamp check

/** Why the stamp does not cover this state (empty: it does). Pure, for the tests. */
export function stampProblems(stamp: Stamp | null, now: { head: string | null; dirty: string[]; bundles: Record<string, string>; kit: string | null }): string[] {
  const run = 'run `npm run test:release` on this commit (a clean tree), then publish';
  if (!stamp) return [`no green-run stamp (${STAMP}): ${run}`];
  const out: string[] = [];
  if (stamp.commit !== now.head) out.push(`the stamp is for commit ${stamp.commit.slice(0, 12)}, HEAD is ${now.head?.slice(0, 12) ?? '(none)'}: ${run}`);
  if (now.dirty.length) out.push(`the working tree is not clean (${now.dirty.slice(0, 6).join('; ')}${now.dirty.length > 6 ? '; …' : ''}): commit or revert — the stamp covers a commit, not a tree with changes`);
  for (const [file, hash] of Object.entries(stamp.bundles)) {
    const cur = now.bundles[file] ?? 'missing';
    if (cur !== hash) out.push(`${file} is ${cur === 'missing' ? 'missing' : `not the stamped build (sha256 ${cur.slice(0, 12)}…, stamped ${hash.slice(0, 12)}…)`}: \`npm run build\`; if it still differs, the build is not deterministic or not what was tested — ${run}`);
  }
  for (const file of Object.keys(now.bundles)) if (!(file in stamp.bundles)) out.push(`${file} is a release bundle the stamp does not cover: ${run}`);
  if (stamp.kit.version !== now.kit) out.push(`the stamp was made with ${stamp.kit.name} ${stamp.kit.version ?? '(none)'}, ${now.kit ?? 'none'} is installed now: \`npm ci\`, or ${run}`);
  return out;
}

export function readStamp(root: string): Stamp | null {
  const p = join(root, STAMP);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as Stamp; } catch { return null; }
}

function kitVersion(root: string, config: TestConfig): { name: string; version: string | null } {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
  if (!config.kit) return { name: pkg.name, version: pkg.version };
  const p = join(root, 'node_modules', config.kit.name, 'package.json');
  return { name: config.kit.name, version: existsSync(p) ? String((JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version) : null };
}

export function checkStamp(root: string): string[] {
  const config = loadTestConfig(root);
  const t = treeState(root);
  return stampProblems(readStamp(root), { head: t.head, dirty: t.dirty, bundles: bundleHashes(root, config.bundles), kit: kitVersion(root, config).version });
}

// -------------------------------------------------------------------------------------------------------------- vitest

interface VitestJson { success?: boolean; numFailedTestSuites?: number; testResults?: { name: string; status: string; assertionResults?: { status: string; fullName?: string; ancestorTitles?: string[]; duration?: number | null }[]; startTime?: number; endTime?: number; message?: string }[] }

/** What one vitest run says about a file beyond its counts: each test's status by full name, its own error message. */
export interface FileDetail { tests: Record<string, string>; failedTests: string[]; message: string }

function vitestBin(root: string): string {
  const req = createRequire(join(root, 'package.json'));
  const pkgPath = req.resolve('vitest/package.json');
  return join(dirname(pkgPath), 'vitest.mjs');
}

export interface VitestRun {
  status: number;
  files: Record<string, FileCounts> | null;
  success: boolean;
  detail: Record<string, FileDetail>;
  /** The failed suites (files and describe blocks) the report counts, and how many its failed tests explain. */
  failedSuites: { reported: number; explained: number };
}

/** One vitest run; the per-file counts from its JSON report (null: no report — vitest itself failed). */
export function runVitest(root: string, args: string[], report: string): VitestRun {
  rmSync(report, { force: true });
  const r = spawnSync(process.execPath, [vitestBin(root), 'run', ...args, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], { cwd: root, stdio: 'inherit', env: process.env });
  if (!existsSync(report)) return { status: r.status ?? 1, files: null, success: false, detail: {}, failedSuites: { reported: 0, explained: 0 } };
  const json = JSON.parse(readFileSync(report, 'utf8')) as VitestJson;
  const files: Record<string, FileCounts> = {};
  const detail: Record<string, FileDetail> = {};
  const realRoot = realpathSync(root);
  // vitest counts a suite (a file or a describe block) as failed when anything in it failed: a failed test fails
  // its file and every describe around it. More failed suites than that means a failure no test carries (a hook).
  const explained = new Set<string>();
  for (const f of json.testResults ?? []) {
    const c: FileCounts = { passed: 0, failed: 0, skipped: 0, todo: 0, ms: Math.max(0, (f.endTime ?? 0) - (f.startTime ?? 0)), status: f.status === 'passed' ? 'passed' : 'failed' };
    const d: FileDetail = { tests: {}, failedTests: [], message: (f.message ?? '').trim() };
    for (const a of f.assertionResults ?? []) {
      if (a.status === 'passed') c.passed++;
      else if (a.status === 'failed') c.failed++;
      else if (a.status === 'todo') c.todo++;
      else c.skipped++;
      const name = a.fullName ?? '';
      d.tests[name] = a.status === 'passed' && d.tests[name] && d.tests[name] !== 'passed' ? d.tests[name] as string : a.status;
      if (a.status === 'failed') {
        if (!d.failedTests.includes(name)) d.failedTests.push(name);
        const anc = a.ancestorTitles ?? [];
        for (let k = 1; k <= anc.length; k++) explained.add(`${f.name}\0${anc.slice(0, k).join('\0')}`);
      }
    }
    if (c.failed > 0) c.status = 'failed';
    if (c.status === 'failed') explained.add(f.name);
    const key = relative(realRoot, existsSync(f.name) ? realpathSync(f.name) : f.name).split(sep).join('/');
    files[key] = c;
    detail[key] = d;
  }
  return { status: r.status ?? 1, files, success: json.success === true, detail, failedSuites: { reported: json.numFailedTestSuites ?? 0, explained: explained.size } };
}

/** A string as a regular expression that matches exactly it. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** vitest's `-t` pattern that selects exactly these tests (matched against each test's full name: its describe titles and its title, space-joined). */
export const testNamePattern = (names: string[]): string => `^(?:${names.map(escapeRegExp).join('|')})$`;

/**
 * How a failing file is re-run: only its failed tests, or (when they cannot be selected reliably) the whole file.
 * Pure, for the tests. `suitesExplained`: the run's failed suites are all explained by failed tests.
 */
export function rerunPlan(d: FileDetail | undefined, suitesExplained: boolean): { mode: 'tests'; tests: string[] } | { mode: 'file'; why: string } {
  if (!d) return { mode: 'file', why: 'the report has no test list for the file' };
  if (d.message) return { mode: 'file', why: `the file failed on its own (${d.message.split('\n')[0]?.slice(0, 120)})` };
  if (!d.failedTests.length) return { mode: 'file', why: 'a suite-level failure (a hook, or the file itself): no failed test to select' };
  if (d.failedTests.some((n) => !n.trim())) return { mode: 'file', why: 'a failed test without a name' };
  if (!suitesExplained) return { mode: 'file', why: 'the run reports more failed suites than its failed tests explain (a failing hook?)' };
  return { mode: 'tests', tests: d.failedTests };
}

/** Whether a "tests" re-run really ran the selected tests and they all passed (null: the selection is not trustworthy). */
export function selectedResult(d: FileDetail | undefined, tests: string[]): { ok: boolean; why?: string } | null {
  if (!d) return null;
  const missing = tests.filter((t) => !(t in d.tests) || d.tests[t] === 'skipped');
  if (missing.length) return null;
  const bad = tests.filter((t) => d.tests[t] !== 'passed');
  return bad.length ? { ok: false, why: `still failing: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? '; …' : ''}` } : { ok: true };
}

// ------------------------------------------------------------------------------------------------------------- helpers

const run = (root: string, cmd: string[], label: string): { ok: boolean; ms: number } => {
  const t0 = Date.now();
  const [bin, ...args] = cmd as [string, ...string[]];
  console.log(`\n▶ ${label}: ${cmd.join(' ')}`);
  const r = spawnSync(bin === 'node' ? process.execPath : bin, args, { cwd: root, stdio: 'inherit', env: process.env });
  return { ok: r.status === 0, ms: Date.now() - t0 };
};

function chromeVersion(root: string): string | null {
  try {
    const req = createRequire(join(root, 'package.json'));
    const pw = req.resolve('playwright-core');
    const code = `const { chromium } = require(${JSON.stringify(pw)}); chromium.launch({ channel: 'chrome', headless: true }).then(async (b) => { console.log(b.version()); await b.close(); }).catch(() => process.exit(3));`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 60_000 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}

const fail = (lines: string[]): never => { console.error(lines.join('\n')); process.exit(1); };
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

// ------------------------------------------------------------------------------------------------------- import graph

const CODE = /\.(?:[cm]?[jt]s|tsx)$/;

/** The repository's files (tracked and untracked, not ignored), as a set of posix paths. */
function repoFiles(root: string): string[] {
  const git = gitIn(root);
  return [...new Set(`${git('ls-files') ?? ''}\n${git('ls-files', '--others', '--exclude-standard') ?? ''}`.split('\n').filter(Boolean))].filter((f) => existsSync(join(root, f)));
}

/** Each code file's direct dependencies (repository-relative posix paths). */
export function importGraph(root: string, files: string[]): Map<string, Set<string>> {
  const set = new Set(files);
  const dirs = new Map<string, string[]>();
  for (const f of files) { let d = f; while (d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')); const list = dirs.get(d) ?? []; list.push(f); dirs.set(d, list); } }
  const norm = (p: string): string => p.split(sep).join('/');
  const resolveSpec = (from: string, spec: string, literal: boolean): string[] => {
    const bases = spec.startsWith('.') ? [norm(relative(root, resolve(root, dirname(from), spec)))] : literal ? [norm(spec.replace(/^\/+/, ''))] : [];
    for (const b of bases) {
      if (!b || b.startsWith('..')) continue;
      const stem = b.replace(/\.(?:[cm]?js)$/, '');
      for (const cand of [b, `${stem}.ts`, `${stem}.mts`, `${stem}.cts`, `${stem}.tsx`, `${b}.ts`, `${b}.js`, `${b}/index.ts`, `${b}/index.js`]) if (set.has(cand)) return [cand];
      const under = dirs.get(b.replace(/\/$/, ''));
      if (literal && under) return under;
    }
    return [];
  };
  const graph = new Map<string, Set<string>>();
  for (const f of files) {
    if (!CODE.test(f)) continue;
    const deps = new Set<string>();
    let text = '';
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g)) for (const d of resolveSpec(f, m[2] as string, false)) deps.add(d);
    for (const m of text.matchAll(/(['"`])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?)\1/g)) for (const d of resolveSpec(f, m[2] as string, true)) if (d !== f) deps.add(d);
    graph.set(f, deps);
  }
  return graph;
}

export function closure(graph: Map<string, Set<string>>, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const todo = [start];
  while (todo.length) for (const d of graph.get(todo.pop() as string) ?? []) if (!seen.has(d)) { seen.add(d); todo.push(d); }
  return seen;
}

/** vitest's own file list for some args, repository-relative (`list --json=<file>`: with filters, `--json` alone prints nothing). */
function vitestList(root: string, args: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'orz-test-changed-'));
  const out = join(dir, 'list.json');
  try {
    const r = spawnSync(process.execPath, [vitestBin(root), 'list', '--filesOnly', `--json=${out}`, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0) fail([`vitest list ${args.join(' ')} failed:`, r.stderr, r.stdout]);
    const list = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { file: string }[]) : [];
    return [...new Set(list.map((x) => relative(realpathSync(root), realpathSync(x.file)).split(sep).join('/')))].sort();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function selectChanged(root: string, slow: string[], changed: string[], changedAll: string[]): { files: string[]; why: Record<string, string> } {
  const why: Record<string, string> = {};
  const all = changed.find((c) => changedAll.some((p) => c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`)));
  if (all) { for (const f of slow) why[f] = `${all} changed (test.changedAll)`; return { files: slow, why }; }
  const graph = importGraph(root, repoFiles(root));
  const changedSet = new Set(changed);
  for (const f of slow) {
    const hit = [...closure(graph, f)].find((x) => changedSet.has(x));
    if (hit) why[f] = hit === f ? 'changed' : `imports ${hit}`;
  }
  return { files: slow.filter((f) => f in why), why };
}

// ---------------------------------------------------------------------------------------------------------- the modes

function stampRun(root: string, argv: string[]): void {
  const config = loadTestConfig(root);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
  const t0 = Date.now();
  const before = treeState(root);
  if (before.head === null) fail([`${pkg.name} test:release: not a git repository — a stamp is for a commit`]);
  if (before.dirty.length) fail([`${pkg.name} test:release: the working tree is not clean (${before.dirty.slice(0, 8).join('; ')}): commit or stash first — the stamp covers one commit`]);
  const previous = lastGreenCommit(root);
  mkdirSync(join(root, '.release'), { recursive: true });
  rmSync(join(root, STAMP), { force: true });

  const build = run(root, config.build, 'build');
  if (!build.ok) fail([`${pkg.name} test:release: the build failed — no stamp`]);
  const afterBuild = treeState(root);
  if (afterBuild.dirty.length) fail([`${pkg.name} test:release: the build changed the tree (${afterBuild.dirty.slice(0, 8).join('; ')}): the build must be deterministic and its committed output current — commit the build, then run again. No stamp.`]);
  const bundles = bundleHashes(root, config.bundles);
  const missing = Object.entries(bundles).filter(([, h]) => h === 'missing').map(([f]) => f);
  if (missing.length) fail([`${pkg.name} test:release: the build did not produce ${missing.join(', ')} (release.config.json bundles) — no stamp`]);

  const report = join(root, '.release', 'vitest.json');
  const s0 = Date.now();
  const suite = runVitest(root, [], report);
  const suiteMs = Date.now() - s0;
  if (!suite.files) fail([`${pkg.name} test:release: vitest wrote no report (exit ${suite.status}): it failed before or outside the test files — no stamp`]);
  const files = suite.files as Record<string, FileCounts>;
  const failing = Object.keys(files).filter((f) => files[f]?.status === 'failed').sort();
  if (Object.keys(files).length === 0) fail([`${pkg.name} test:release: vitest ran no test file — no stamp`]);
  if (!suite.success && failing.length === 0) fail([`${pkg.name} test:release: vitest reported a failure outside any test file (an unhandled error, the global setup?) — see the output above. No stamp.`]);

  const reruns: Rerun[] = [];
  const r0 = Date.now();
  const still: string[] = [];
  const suitesExplained = suite.failedSuites.reported <= suite.failedSuites.explained;
  const rerunReport = join(root, '.release', 'vitest-rerun.json');
  for (const f of failing) {
    let ok = false;
    let plan = rerunPlan(suite.detail[f], suitesExplained);
    for (let i = 1; i <= config.test.retries && !ok; i++) {
      if (plan.mode === 'tests') {
        const tests = plan.tests;
        console.log(`\n▶ re-run ${i}/${config.test.retries} alone: ${f} — only its ${tests.length} failed test(s): ${tests.slice(0, 4).join(' | ')}${tests.length > 4 ? ' | …' : ''}`);
        const t = Date.now();
        const one = runVitest(root, [join(root, f), '-t', testNamePattern(tests)], rerunReport);
        const c = one.files?.[f];
        const sel = selectedResult(one.detail[f], tests);
        if (sel !== null) {
          ok = sel.ok && one.success && !!c && c.failed === 0;
          reruns.push({ file: f, try: i, ok, passed: c?.passed ?? 0, failed: c?.failed ?? 0, skipped: c?.skipped ?? 0, ms: Date.now() - t, mode: 'tests', tests, ...(ok ? {} : { why: sel.why ?? (one.success ? 'the file failed' : 'vitest reported a failure') }) });
          if (ok) { const o = files[f] as FileCounts; files[f] = { ...o, passed: o.passed + o.failed, failed: 0, status: 'passed', reruns: i, rerun: 'tests' }; }
          continue;
        }
        // the -t selection did not run every failed test: not reliable — this try and the next take the whole file
        const why = `the -t selection did not run all ${tests.length} failed test(s)`;
        reruns.push({ file: f, try: i, ok: false, passed: c?.passed ?? 0, failed: c?.failed ?? 0, skipped: c?.skipped ?? 0, ms: Date.now() - t, mode: 'tests', tests, why: `${why}: not trusted` });
        plan = { mode: 'file', why };
      }
      console.log(`\n▶ re-run ${i}/${config.test.retries} alone: ${f} — the whole file (${plan.why})`);
      const t = Date.now();
      const one = runVitest(root, [join(root, f)], rerunReport);
      const c = one.files?.[f];
      ok = !!c && c.status === 'passed' && one.success;
      reruns.push({ file: f, try: i, ok, passed: c?.passed ?? 0, failed: c?.failed ?? 0, skipped: c?.skipped ?? 0, ms: Date.now() - t, mode: 'file', why: plan.why });
      if (ok && c) files[f] = { ...c, reruns: i, rerun: 'file' };
    }
    if (!ok) still.push(f);
  }
  const rerunMs = Date.now() - r0;

  const extras: Stamp['extra'] = [];
  const e0 = Date.now();
  for (const step of config.extra) {
    let mode: 'full' | 'sample' = 'full';
    let reason = 'no sample command';
    if (argv.includes('--full-extra')) reason = '--full-extra';
    else if (step.sample) {
      const base = previous && gitIn(root)('cat-file', '-e', `${previous}^{commit}`) !== null ? previous : config.test.base;
      const changed = changedFiles(root, base);
      const hit = changed === null ? null : changed.find((c) => (step.fullWhen ?? []).some((p) => c.startsWith(p)));
      if (changed === null) reason = `base ${base} unknown`;
      else if (hit) reason = `${hit} changed since ${base.slice(0, 12)}`;
      else { mode = 'sample'; reason = `nothing under ${(step.fullWhen ?? []).join(', ')} changed since ${base.slice(0, 12)}`; }
    }
    const r = run(root, mode === 'full' ? step.full : (step.sample as string[]), `${step.name} (${mode}: ${reason})`);
    extras.push({ name: step.name, mode, reason, ok: r.ok, ms: r.ms });
  }
  const extraMs = Date.now() - e0;

  const after = treeState(root);
  const problems: string[] = [];
  for (const f of still) problems.push(`${f} failed in the full run and in ${config.test.retries} tries alone — a real failure, not a flake`);
  for (const e of extras) if (!e.ok) problems.push(`the extra step ${e.name} (${e.mode}) failed`);
  if (after.head !== before.head) problems.push(`HEAD moved during the run (${before.head?.slice(0, 12)} → ${after.head?.slice(0, 12)})`);
  if (after.dirty.length) problems.push(`the suite changed the tree (${after.dirty.slice(0, 8).join('; ')}): tests must not modify tracked files`);
  let finalBundles = bundleHashes(root, config.bundles);
  if (JSON.stringify(finalBundles) !== JSON.stringify(bundles)) {
    // the suite's global setup may re-stage the bundles: rebuild once and compare with the tested build
    run(root, config.build, 'rebuild (the suite re-staged the bundles)');
    finalBundles = bundleHashes(root, config.bundles);
    if (JSON.stringify(finalBundles) !== JSON.stringify(bundles)) problems.push(`the bundles differ between two builds of one commit (${Object.keys(bundles).filter((b) => bundles[b] !== finalBundles[b]).join(', ')}): the build is not deterministic`);
  }
  const totals = { files: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const c of Object.values(files)) { totals.files++; totals.passed += c.passed; totals.failed += c.status === 'failed' ? c.failed : 0; totals.skipped += c.skipped; totals.todo += c.todo; }
  const summary = `${totals.files} files, ${totals.passed} passed, ${totals.skipped} skipped, ${reruns.length} re-run(s) (${reruns.filter((r) => r.ok).length} green; ${reruns.filter((r) => r.mode === 'tests').length} of failed tests only, ${reruns.filter((r) => r.mode === 'file').length} of whole files), suite ${secs(suiteMs)}, total ${secs(Date.now() - t0)}`;
  if (problems.length) fail([`\n${pkg.name} test:release: NOT green — no stamp. ${summary}`, ...problems.map((p) => `  - ${p}`)]);

  const stamp: Stamp = {
    stamp: 1,
    name: pkg.name,
    version: pkg.version,
    commit: before.head as string,
    tree: before.tree as string,
    node: process.version,
    chrome: config.test.chrome ? chromeVersion(root) : null,
    kit: kitVersion(root, config),
    bundles,
    totals,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
    reruns,
    extra: extras,
    durationMs: { build: build.ms, suite: suiteMs, reruns: rerunMs, extra: extraMs, total: Date.now() - t0 },
    date: new Date().toISOString(),
  };
  writeFileSync(join(root, STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  appendFileSync(join(root, HISTORY), `${JSON.stringify({ commit: stamp.commit, version: stamp.version, date: stamp.date, extra: extras.map((e) => `${e.name}:${e.mode}`) })}\n`);
  rmSync(report, { force: true });
  rmSync(join(root, '.release', 'vitest-rerun.json'), { force: true });
  console.log(`\n${pkg.name} test:release: green — stamped ${STAMP} for ${stamp.commit.slice(0, 12)} (${pkg.version}). ${summary}`);
}

function fastRun(root: string): void {
  const config = loadTestConfig(root);
  const r = spawnSync(process.execPath, [vitestBin(root), 'run', ...config.test.fast], { cwd: root, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function changedRun(root: string, argv: string[]): void {
  const config = loadTestConfig(root);
  const i = argv.indexOf('--base');
  const base = i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : config.test.base;
  const changed = changedFiles(root, base);
  if (changed === null) fail([`test:changed: the base "${base}" is not a commit here: \`git fetch\`, or pass \`--base <ref>\``]);
  const all = vitestList(root, []);
  const fast = new Set(vitestList(root, config.test.fast));
  const slow = all.filter((f) => !fast.has(f));
  const sel = selectChanged(root, slow, changed as string[], config.test.changedAll);
  console.log(`test:changed against ${base}: ${(changed as string[]).length} changed file(s); fast lane (${fast.size} files) + ${sel.files.length} of ${slow.length} slow file(s)`);
  for (const f of sel.files) console.log(`  ${f} — ${sel.why[f]}`);
  if (argv.includes('--list')) return;
  let status = spawnSync(process.execPath, [vitestBin(root), 'run', ...config.test.fast], { cwd: root, stdio: 'inherit' }).status ?? 1;
  if (sel.files.length) status ||= spawnSync(process.execPath, [vitestBin(root), 'run', ...sel.files.map((f) => join(root, f))], { cwd: root, stdio: 'inherit' }).status ?? 1;
  process.exit(status);
}

const isMain = (): boolean => { try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };

if (isMain()) {
  const root = ROOT_OF_SCRIPT();
  const argv = process.argv.slice(2);
  const name = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }).name;
  if (argv.includes('--check')) {
    const problems = checkStamp(root);
    if (problems.length) fail([`${name} stamp check: refused\n${problems.map((p) => `  - ${p}`).join('\n')}`]);
    const s = readStamp(root) as Stamp;
    console.log(`${name} stamp check: green run of ${s.commit.slice(0, 12)} (${s.date}; ${s.totals.passed} passed, ${s.reruns.length} re-run(s)) covers HEAD, a clean tree and the built bundle(s)`);
  } else if (argv.includes('--fast')) fastRun(root);
  else if (argv.includes('--changed')) changedRun(root, argv);
  else stampRun(root, argv);
}
