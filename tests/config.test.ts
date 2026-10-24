/**
 * The config (spec §3): validation, unknown keys, the format version, the
 * 0.1 naming refusal, and agreement with the published JSON Schema
 * (schema/site-1.json). Claim S.11 (stable codes) in part.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig, templateProblem, validateConfig } from '../src/config.js';
import { globRegExp, matchesAny } from '../src/glob.js';
import { encodePath, relativeFrom, resolveIn, sitePathProblem } from '../src/paths.js';
import { PINS, ROOT } from './helpers.js';

const codes = (raw: unknown): string[] => validateConfig(raw).findings.map((f) => f.code);

describe('[S.11] config validation', () => {
  it('a minimal config gets every default', () => {
    const r = validateConfig({ format: 1 });
    expect(r.findings).toEqual([]);
    expect(r.config).toEqual(defaultConfig());
  });

  it('the fixture config is valid', () => {
    const r = parseConfig(readFileSync(join(ROOT, 'fixtures', 'course', 'orz-site.json')));
    expect(r.findings).toEqual([]);
    expect(r.config?.carriers).toEqual(PINS); // = package.json's exact devDependencies
  });

  it('unknown keys are errors at every level (a misspelt exclude must not publish drafts)', () => {
    expect(codes({ format: 1, exlude: ['drafts/'] })).toEqual(['unknown-key']);
    expect(codes({ format: 1, includes: { allowed: [] } })).toEqual(['unknown-key']);
    expect(codes({ format: 1, index: { mode: 'auto', titel: 'x' } })).toEqual(['unknown-key']);
    expect(codes({ format: 1, carriers: { poster: '1.0.0' } })).toEqual(['unknown-key']);
    expect(validateConfig({ format: 1, exlude: [] }).config).toBeNull();
  });

  it('format: missing or wrong is bad-config; newer is newer-config with a next', () => {
    expect(codes({})).toEqual(['bad-config']);
    expect(codes({ format: '1' })).toEqual(['bad-config']);
    const r = validateConfig({ format: 2, whatever: true });
    expect(r.findings.map((f) => f.code)).toEqual(['newer-config']);
    expect(r.findings[0]?.next).toEqual({ tool: 'npm', command: 'install', args: ['orz-site@latest'] });
  });

  it('values are checked', () => {
    expect(codes({ format: 1, carriers: { md: '^1.0.0' } })).toEqual(['bad-config']);
    expect(codes({ format: 1, delivery: 'local' })).toEqual(['bad-config']);
    expect(codes({ format: 1, baseUrl: 'https://o.github.io/c' })).toEqual(['bad-config']);
    expect(codes({ format: 1, baseUrl: 'ftp://o/' })).toEqual(['bad-config']);
    expect(codes({ format: 1, includes: { allowedHosts: ['https://x.org'] } })).toEqual(['bad-config']);
    expect(codes({ format: 1, exclude: ['!drafts/'] })).toEqual(['bad-config']);
    expect(codes({ format: 1, exclude: ['{a,b}/'] })).toEqual(['bad-config']);
    expect(codes({ format: 1, notFound: 'errors/404.md' })).toEqual(['bad-config']);
    expect(codes({ format: 1, index: { lang: 'english language' } })).toEqual(['bad-config']);
    expect(codes([])).toEqual(['bad-config']);
  });

  it('a valid non-family naming is accepted (the build checks the carriers carry it); an invalid one is bad-config', () => {
    const r = validateConfig({ format: 1, naming: { md: '{stem}.html' } });
    expect(r.findings).toEqual([]);
    expect(r.config?.naming).toEqual({ md: '{stem}.html' });
    expect(codes({ format: 1, naming: { md: '{stem}{stem}.html' } })).toEqual(['bad-config']);
    expect(codes({ format: 1, naming: { md: 'x/{stem}.html' } })).toEqual(['bad-config']);
    expect(codes({ format: 1, naming: { md: '{stem}.htm' } })).toEqual(['bad-config']);
    expect(codes({ format: 1, naming: 'family' })).toEqual([]);
    expect(templateProblem('{stem}.page.html')).toBeNull();
  });

  it('invalid JSON or UTF-8 is bad-config', () => {
    expect(parseConfig(new TextEncoder().encode('{ format: 1 }')).findings[0]?.code).toBe('bad-config');
    expect(parseConfig(new Uint8Array([0xff, 0xfe])).findings[0]?.code).toBe('bad-config');
  });
});

describe('the JSON Schema agrees with the validator', () => {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'site-1.json'), 'utf8')) as { properties: Record<string, { properties?: Record<string, unknown> }>; additionalProperties: boolean };
  it('top-level and nested keys are the validator\'s', () => {
    expect(schema.additionalProperties).toBe(false);
    const top = Object.keys(schema.properties).sort();
    const known = ['$schema', ...Object.keys(defaultConfig())].sort();
    expect(top).toEqual(known);
    for (const k of ['includes', 'links', 'index'] as const) {
      expect(Object.keys(schema.properties[k]?.properties ?? {}).sort()).toEqual(Object.keys(defaultConfig()[k]).sort());
    }
    expect(Object.keys(schema.properties['carriers']?.properties ?? {}).sort()).toEqual(['md', 'paged', 'slides']);
  });
  it('the schema\'s defaults are the validator\'s', () => {
    const d = defaultConfig() as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(schema.properties)) {
      const def = (v as { default?: unknown }).default;
      if (def !== undefined) expect([k, def]).toEqual([k, d[k]]);
      for (const [kk, vv] of Object.entries(v.properties ?? {})) {
        const dd = (vv as { default?: unknown }).default;
        if (dd !== undefined) expect([`${k}.${kk}`, dd]).toEqual([`${k}.${kk}`, (d[k] as Record<string, unknown>)[kk]]);
      }
    }
  });
});

describe('globs (spec §3.6)', () => {
  it('* stays in a segment, ** crosses folders, ? is one character, a trailing / is a folder', () => {
    expect(matchesAny('drafts/a.md', ['drafts/'])).toBe(true);
    expect(matchesAny('drafts/x/y.md', ['drafts/'])).toBe(true);
    expect(matchesAny('drafts.md', ['drafts/'])).toBe(false);
    expect(matchesAny('a/b.md', ['*.md'])).toBe(false);
    expect(matchesAny('b.md', ['*.md'])).toBe(true);
    expect(matchesAny('a/b/c.md', ['**/*.md'])).toBe(true);
    expect(matchesAny('c.md', ['**/*.md'])).toBe(true);
    expect(matchesAny('handouts/x/y.paged.md', ['handouts/**'])).toBe(true);
    expect(matchesAny('w1.md', ['w?.md'])).toBe(true);
    expect(matchesAny('w10.md', ['w?.md'])).toBe(false);
    expect(globRegExp('a+b(c).md').test('a+b(c).md')).toBe(true);
  });
});

describe('site paths (spec §2.1)', () => {
  it('refuses absolute, .., backslash, NUL, empty segments and non-NFC', () => {
    for (const bad of ['/a.md', '../a.md', 'a/../b.md', 'a\\b.md', 'a\0.md', 'a//b.md', './a.md', '', 'C:/x.md', 'e\u0301.md']) expect([bad, sitePathProblem(bad)]).not.toEqual([bad, null]);
    for (const good of ['a.md', 'a/b c/é.md', 'img/x.png']) expect(sitePathProblem(good)).toBeNull();
  });
  it('resolves inside the root only', () => {
    expect(resolveIn('notes', '../a.md')).toBe('a.md');
    expect(resolveIn('notes', '../../a.md')).toBeNull();
    expect(resolveIn('notes', '/x/a.md')).toBe('x/a.md');
    expect(relativeFrom('a/b', 'a/c/d.md')).toBe('../c/d.md');
    expect(encodePath('a b/c(1).md')).toBe('a%20b/c%281%29.md');
  });
});
