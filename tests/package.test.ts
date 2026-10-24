/**
 * The package: the main entry is browser-safe (no Node built-ins, no
 * process/env reads in the core's import graph — spec §7.1), the version is
 * package.json's, and the tarball ships only the whitelist.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { ROOT } from './helpers.js';

/** The relative-import graph of a source file. */
function graph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, 'utf8');
  for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+'(\.[^']+)'/g)) graph(resolve(dirname(entry), (m[1] as string).replace(/\.js$/, '.ts')), seen);
  return seen;
}

describe('the package', () => {
  it('the main entry\'s import graph uses no Node built-in, no process, no clock, no randomness', () => {
    const files = [...graph(join(ROOT, 'src', 'index.ts'))];
    expect(files.map((f) => f.slice(ROOT.length + 1)).sort()).toEqual(['src/build.ts', 'src/config.ts', 'src/glob.ts', 'src/includes.ts', 'src/index-page.ts', 'src/index.ts', 'src/paths.ts', 'src/types.ts', 'src/util.ts', 'src/version.ts', 'src/workflow.ts']);
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/from\s+'node:|require\(|\bprocess\.|Date\.now|new Date\(|Math\.random|localeCompare|toLocale/);
      for (const m of src.matchAll(/from\s+'([^.'][^']*)'/g)) expect(['orz-markdown', 'orz-markdown/carrier'], `${f}: ${m[1]}`).toContain(m[1]);
    }
  });

  it('src/version.ts is package.json\'s version', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  });

  it('npm pack ships dist, the schema, the spec, README, CHANGELOG, LICENSE and package.json only', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]?.files.map((f) => f.path) ?? [];
    for (const f of files) expect(f, f).toMatch(/^(dist\/|schema\/site-1\.json$|spec\/site\.md$|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$)/);
    for (const want of ['dist/index.js', 'dist/node.js', 'dist/cli.js', 'schema/site-1.json', 'LICENSE', 'README.md', 'CHANGELOG.md']) expect(files).toContain(want);
    expect(files.some((f) => f.startsWith('dist/') && f.includes('test'))).toBe(false);
  });
});
