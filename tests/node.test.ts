/**
 * The Node adapter and the CLI: claims S.9 (confinement), S.10 (a folder's
 * always-excluded paths are never read), S.11 (reports: stable codes, `next`
 * runnable verbatim, the carriers' --json shape), `init --github` and the
 * workflow drift check (route A, spec §8).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSite } from '../src/build.js';
import { buildFolder, readSiteFolder, SiteError, writeSite } from '../src/node.js';
import { workflowDrift, workflowPins, workflowText } from '../src/workflow.js';
import { cfg, env, FIXTURE, fixtureCopy, mapOf, PINS, ROOT, tempDir, text } from './helpers.js';

/** Run the CLI (from the sources) in `cwd`. */
function cli(args: string[], cwd = ROOT): { status: number; stdout: string; stderr: string; json: any } {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(ROOT, 'src', 'cli.ts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  let json: unknown = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json };
}

/** Run a report's `next` verbatim: `orz-site …` through the CLI, a carrier through its installed bin. */
function runNext(next: { tool?: string; command: string; args: string[] }, cwd: string): number {
  if (!next.tool) return cli([next.command, ...next.args], cwd).status;
  const bin = join(ROOT, 'node_modules', '.bin', next.tool);
  return spawnSync(bin, [next.command, ...next.args], { cwd, encoding: 'utf8' }).status ?? -1;
}

/** Every code the spec lists (§7.2), plus the ones 0.1 adds. */
const CODES = new Set(['bad-config', 'unknown-key', 'newer-config', 'no-config', 'shell-mismatch', 'naming-unsupported', 'name-collision', 'case-collision', 'not-utf8', 'invalid-text', 'newer-format', 'carrier-mismatch', 'empty-text', 'assembled-input', 'legacy-file', 'missing-link', 'missing-asset', 'raw-twin-link', 'root-relative', 'case-link', 'include-missing', 'include-host', 'include-network', 'include-too-large', 'include-key-clash', 'include-own-output', 'outside-root', 'symlink-out', 'too-large', 'too-many-files', 'no-base-url', 'out-not-site', 'workflow-drift', 'exists', 'write-failed',
  /* 0.1 additions */ 'no-carrier', 'no-pin', 'unreadable', 'bad-usage', 'no-such-file', 'refused', 'failed']);

describe('[S.9] confinement', () => {
  it('site paths with .., absolute, backslash or NUL are refused (outside-root)', async () => {
    const r = await buildSite(mapOf({ 'a.md': text('A', '# A'), '../x.md': 'x', '/abs.md': 'x', 'a\\b.md': 'x', 'n\0.md': 'x' }), cfg(), await env());
    expect(r.ok).toBe(false);
    expect(r.files.size).toBe(0);
    expect(r.report.errors.map((e) => [e.code, e.path])).toEqual([['outside-root', '../x.md'], ['outside-root', '/abs.md'], ['outside-root', 'a\\b.md'], ['outside-root', 'n\0.md']]);
  });

  it('a folder: a symbolic link out of the root is symlink-out; links inside are followed; a cycle is refused', () => {
    const base = tempDir();
    const site = join(base, 'site');
    mkdirSync(join(site, 'notes'), { recursive: true });
    writeFileSync(join(base, 'outside.md'), 'secret');
    writeFileSync(join(site, 'notes', 'a.md'), '# A');
    symlinkSync(join(base, 'outside.md'), join(site, 'leak.md'));
    symlinkSync(join(site, 'notes'), join(site, 'alias'));
    symlinkSync(site, join(site, 'notes', 'loop'));
    const r = readSiteFolder(site);
    expect([...r.files.keys()].sort()).toEqual(['alias/a.md', 'notes/a.md']);
    expect(r.errors.map((e) => [e.code, e.path]).sort()).toEqual([['symlink-out', 'alias/loop'], ['symlink-out', 'leak.md'], ['symlink-out', 'notes/loop']]);
  });

  it('the build of such a folder is refused; nothing is written', async () => {
    const dir = fixtureCopy();
    symlinkSync('/etc/hosts', join(dir, 'hosts.md'));
    const out = join(dir, '..', 'out');
    const r = cli(['build', dir, '-o', out, '--json']);
    expect(r.status).toBe(1);
    expect(r.json).toMatchObject({ ok: false, command: 'build', reason: 'symlink-out', exitCode: 1 });
    expect(existsSync(out)).toBe(false);
  });

  it('writeSite never writes outside out, never replaces a folder it did not make, never the site itself', async () => {
    const dir = tempDir();
    const good = await buildSite(mapOf({ 'a.md': text('A', '# A') }), cfg(), await env());
    const evil = { ...good, files: new Map([...good.files, ['../evil.txt', new Uint8Array([1])]]) };
    expect(() => writeSite(join(dir, 'out'), evil)).toThrow(SiteError);
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
    expect(existsSync(join(dir, 'out'))).toBe(false);
    mkdirSync(join(dir, 'mine'));
    writeFileSync(join(dir, 'mine', 'thesis.docx'), 'precious');
    expect(() => writeSite(join(dir, 'mine'), good)).toThrow(/out-not-site|holds no orz-site-manifest/);
    expect(readFileSync(join(dir, 'mine', 'thesis.docx'), 'utf8')).toBe('precious');
    expect(() => writeSite(dir, good, { root: join(dir, 'mine') })).toThrow(/holds it/);
    writeSite(join(dir, 'out'), good);
    writeSite(join(dir, 'out'), good); // replacing its own output is fine
    expect(readdirSync(join(dir, 'out')).sort()).toEqual([...good.files.keys()].filter((p) => !p.includes('/')).sort());
    expect(readdirSync(dir).filter((n) => n.includes('orz-site-'))).toEqual([]); // no temporary folder left
  });
});

describe('[S.10] a folder\'s always-excluded paths are never read', () => {
  it('dot paths, node_modules, *~, the config and the output folder are not in the map', () => {
    const dir = fixtureCopy();
    mkdirSync(join(dir, '.private'));
    writeFileSync(join(dir, '.private', 'n.md'), 'secret');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'r.md'), '# R');
    writeFileSync(join(dir, 'index.md~'), 'backup');
    mkdirSync(join(dir, '_site'));
    writeFileSync(join(dir, '_site', 'old.md'), '# old');
    const r = readSiteFolder(dir, { out: join(dir, '_site') });
    const keys = [...r.files.keys()];
    expect(keys.some((k) => k.startsWith('.') || k.includes('/.') || k.includes('node_modules') || k.endsWith('~') || k === 'orz-site.json' || k.startsWith('_site'))).toBe(false);
    expect(r.outDir).toBe('_site');
  });
});

describe('[S.11] the CLI: exit codes, --json, next', () => {
  it('build --json: the success shape; the output folder is the build', () => {
    const dir = fixtureCopy();
    const out = join(dir, '..', 'site-out');
    const r = cli(['build', dir, '-o', out, '--json']);
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: 'build', documents: 7, assets: 2, outputs: 20, errors: [], warnings: [] });
    expect(existsSync(join(out, 'orz-site-manifest.json'))).toBe(true);
    // the default output is dir/_site, and it is excluded from the next build
    expect(cli(['build', dir, '--json']).status).toBe(0);
    const again = cli(['build', dir, '--json']);
    expect(again.json.outputs).toBe(20);
  });

  it('a refusal --json: { ok: false, command, error, reason, next?, exitCode } with reason = the first error\'s code; usage is exit 2', () => {
    const dir = fixtureCopy();
    writeFileSync(join(dir, 'lessons', 'broken.md'), text('Broken', '[x](nowhere.md)'));
    const r = cli(['build', dir, '-o', join(dir, '..', 'o'), '--json']);
    expect(r.status).toBe(1);
    expect(Object.keys(r.json).sort()).toEqual(['command', 'error', 'errors', 'exitCode', 'ok', 'reason', 'warnings']);
    expect(r.json).toMatchObject({ ok: false, command: 'build', reason: 'missing-link', exitCode: 1 });
    const u = cli(['build', '--frobnicate', '--json']);
    expect(u.status).toBe(2);
    expect(u.json).toMatchObject({ ok: false, reason: 'bad-usage', exitCode: 2 });
    expect(cli(['publish']).status).toBe(2);
    expect(cli(['--version']).stdout.trim()).toBe(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  });

  it('every code a refusal can carry is a known code', async () => {
    const seen = new Set<string>();
    const probes: Array<[Record<string, string>, unknown]> = [
      [{ 'a.md': text('A', '[x](n.md) {{md nope.md}}'), 'b.md~': 'x', '../c': 'x' }, cfg({ exlude: [] })],
      [{ 'a.md': text('A', '[x](n.md) {{md https://evil.test/x.md}}'), 'A.png': 'x', 'a.png': 'y', 'x.md.html': 'z', 'x.md': text('X', '') }, cfg({ carriers: { md: '9.9.9' } })],
      [{ 'a.md': text('A', '[x](n.md) {{md nope.md}} <a href="b.md">b</a>'), 'b.md': '{{nyml\nkind: document\nformat: 9\n}}\n#' }, cfg({ includes: { missing: 'warn' } })],
    ];
    for (const [files, config] of probes) {
      const r = await buildSite(mapOf(files), config, await env());
      for (const f of [...r.report.errors, ...r.report.warnings]) seen.add(f.code);
    }
    for (const c of seen) expect(CODES.has(c), c).toBe(true);
    expect(seen.size).toBeGreaterThan(5);
  });

  it('next runs verbatim and moves the build forward: no config → init; a 0.x deck → orz-slides upgrade; drift → init --github --update', () => {
    const dir = fixtureCopy();
    rmSync(join(dir, 'orz-site.json'));
    const c1 = cli(['check', dir, '--json']);
    expect(c1.json).toMatchObject({ ok: false, reason: 'no-config', next: { command: 'init', args: [] } });
    expect(runNext(c1.json.next, dir)).toBe(0);
    expect(cli(['check', '.', '--json'], dir).json.reason).not.toBe('no-config');
    // the fresh config pins the installed carriers and refuses nothing the fixture needs except its own choices
    const written = JSON.parse(readFileSync(join(dir, 'orz-site.json'), 'utf8'));
    expect(written.carriers).toEqual(PINS);
    writeFileSync(join(dir, 'orz-site.json'), readFileSync(join(FIXTURE, 'orz-site.json')));

    writeFileSync(join(dir, 'slides', 'old.slides.md'), '<!-- deck title="Old" -->\n\n<!-- slide -->\n## One\n');
    const c2 = cli(['check', '.', '--json'], dir);
    expect(c2.json).toMatchObject({ ok: false, reason: 'invalid-text', next: { tool: 'orz-slides', command: 'upgrade', args: ['slides/old.slides.md'] } });
    expect(runNext(c2.json.next, dir)).toBe(0);
    expect(existsSync(join(dir, 'slides', 'old.slides.md~'))).toBe(true); // the upgrade's backup: excluded by orz-site
    expect(cli(['check', '.', '--json'], dir).status).toBe(0);

    expect(cli(['init', '.', '--github'], dir).status).toBe(0);
    const wf = join(dir, '.github', 'workflows', 'orz-site.yml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace(`orz-slides@${PINS.slides}`, 'orz-slides@0.9.0'));
    const c3 = cli(['check', '.', '--json'], dir);
    expect(c3.json).toMatchObject({ ok: false, reason: 'workflow-drift', next: { command: 'init', args: ['.', '--github', '--update'] } });
    expect(runNext(c3.json.next, dir)).toBe(0);
    expect(cli(['check', '.', '--json'], dir)).toMatchObject({ status: 0, json: { ok: true, command: 'check' } });
  });

  it('[S.4] build --incremental over its own output gives the same files as a full build', () => {
    const dir = fixtureCopy();
    const out = join(dir, '..', 'inc');
    expect(cli(['build', dir, '-o', out]).status).toBe(0);
    writeFileSync(join(dir, 'lessons', '02-membranes.md'), `${readFileSync(join(dir, 'lessons', '02-membranes.md'), 'utf8')}\nOne more line.\n`);
    expect(cli(['build', dir, '-o', out, '--incremental']).status).toBe(0);
    const full = join(dir, '..', 'full');
    expect(cli(['build', dir, '-o', full]).status).toBe(0);
    const list = (d: string): string[] => (readdirSync(d, { recursive: true }) as string[]).sort();
    expect(list(out)).toEqual(list(full));
    for (const f of list(full)) if (!f.endsWith('/') && existsSync(join(full, f)) && !statSync(join(full, f)).isDirectory()) expect(readFileSync(join(out, f)).equals(readFileSync(join(full, f))), f).toBe(true);
  });

  it('check writes nothing; build refuses an output folder it did not make (out-not-site)', () => {
    const dir = fixtureCopy();
    expect(cli(['check', dir]).status).toBe(0);
    expect(existsSync(join(dir, '_site'))).toBe(false);
    const other = join(dir, '..', 'docs');
    mkdirSync(other);
    writeFileSync(join(other, 'keep.txt'), 'mine');
    const r = cli(['build', dir, '-o', other, '--json']);
    expect(r.json).toMatchObject({ ok: false, reason: 'out-not-site' });
    expect(readFileSync(join(other, 'keep.txt'), 'utf8')).toBe('mine');
  });
});

describe('init and route A\'s workflow (spec §8)', () => {
  it('init writes orz-site.json and, with --github, the workflow; it never overwrites (exists)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.md'), text('A', '# A'));
    const r = cli(['init', dir, '--github', '--json']);
    expect(r.json).toMatchObject({ ok: true, command: 'init', written: ['orz-site.json', '.github/workflows/orz-site.yml'], carriers: PINS });
    const wf = readFileSync(join(dir, '.github', 'workflows', 'orz-site.yml'), 'utf8');
    expect(wf).toBe(workflowText('0.1.0', PINS));
    expect(wf).toContain(`orz-site@0.1.0 orz-mdhtml@${PINS.md} orz-slides@${PINS.slides} orz-paged@${PINS.paged}`);
    // D-122: the majors current on 2026-10-24, all on GitHub's Node 24 runtime; none of the Node 20 ones
    for (const a of ['actions/checkout@v7', 'actions/setup-node@v7', 'actions/cache@v6', 'actions/configure-pages@v6', 'actions/upload-pages-artifact@v5', 'actions/deploy-pages@v5']) expect(wf).toContain(`uses: ${a}\n`);
    for (const a of ['checkout@v4', 'setup-node@v4', 'cache@v4', 'configure-pages@v5', 'upload-pages-artifact@v3', 'deploy-pages@v4']) expect(wf).not.toContain(a);
    // upload-pages-artifact >= v4 drops dot files unless asked: the artifact keeps .nojekyll (= the local build, S.13)
    expect(wf).toMatch(/upload-pages-artifact@v5\n\s+with:\n\s+path: .*\n\s+include-hidden-files: true\n/);
    expect(cli(['init', dir, '--json']).json).toMatchObject({ ok: false, reason: 'exists' });
    expect(cli(['init', dir, '--github', '--json']).json).toMatchObject({ ok: true, written: [] });
    writeFileSync(join(dir, '.github', 'workflows', 'orz-site.yml'), `${wf}# my own step\n`);
    expect(cli(['init', dir, '--github', '--update', '--json']).json).toMatchObject({ ok: false, reason: 'exists' });
    expect(cli(['check', dir, '--json']).status).toBe(0);
  });

  it('the drift check reads the install line', () => {
    const wf = workflowText('0.1.0', { md: '1.0.2' });
    expect(workflowPins(wf)).toEqual({ site: '0.1.0', carriers: { md: '1.0.2' } });
    expect(workflowDrift(wf, { md: '1.0.2' })).toEqual([]);
    expect(workflowDrift(wf, { md: '1.0.3', slides: '1.0.0' })).toHaveLength(2);
  });

  it('buildFolder reads the config bytes into the manifest hash', async () => {
    const { result } = await buildFolder(FIXTURE, {});
    const { createHash } = await import('node:crypto');
    expect(result.manifest.config.sha256).toBe(createHash('sha256').update(readFileSync(join(FIXTURE, 'orz-site.json'))).digest('hex'));
  });
});
