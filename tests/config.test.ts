/**
 * The config (spec §3): validation, unknown keys, the format version, the
 * 0.1 naming refusal, and agreement with the published JSON Schema
 * (schema/site-1.json). Claim S.11 (stable codes) in part.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig, READER_NOTICE_MAX, templateProblem, validateConfig } from '../src/config.js';
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

  it('[S.16] readerCopy (0.2): false by default; true, false and { notice } are accepted (the notice collapsed and trimmed as the kit stores it; {} is true); an empty, too long or control-character notice, another key or another type is bad-config / unknown-key', () => {
    expect(validateConfig({ format: 1 }).config?.readerCopy).toBe(false);
    expect(validateConfig({ format: 1, readerCopy: true }).config?.readerCopy).toBe(true);
    expect(validateConfig({ format: 1, readerCopy: false }).config?.readerCopy).toBe(false);
    expect(validateConfig({ format: 1, readerCopy: {} }).config?.readerCopy).toBe(true);
    expect(validateConfig({ format: 1, readerCopy: { notice: '  Your own\n copy. ' } }).config?.readerCopy).toEqual({ notice: 'Your own copy.' });
    expect(validateConfig({ format: 1, readerCopy: { notice: 'x'.repeat(300) } }).findings).toEqual([]);
    for (const bad of [{ notice: '' }, { notice: ' \n ' }, { notice: 'x'.repeat(301) }, { notice: 'a\u0007b' }, { notice: 3 }, 'yes', 1, null, []]) {
      expect(codes({ format: 1, readerCopy: bad }), JSON.stringify(bad)).toEqual(['bad-config']);
    }
    expect(codes({ format: 1, readerCopy: { text: 'x' } })).toEqual(['unknown-key']);
  });

  it('[S.16] (audit LOW-2/LOW-3) a notice is checked as the kit checks it: format characters (bidi overrides, zero-width spaces, soft hyphen), unpaired surrogates and text with nothing visible are bad-config; the zero-width joiner and non-joiner inside text are kept; the length is in UTF-16 code units (150 emoji fit, 151 do not)', () => {
    for (const notice of ['abc\u202edef', 'a\u200bb', 'soft\u00adhyphen', 'x\ud800', '\u00a0', '\u3000', '\u200d', '\u0301', '😀'.repeat(151)]) {
      expect(codes({ format: 1, readerCopy: { notice } }), JSON.stringify(notice)).toEqual(['bad-config']);
    }
    for (const notice of ['Edits stay yours 👩\u200d💻.', 'می\u200cخواهم', '😀'.repeat(150)]) {
      expect(validateConfig({ format: 1, readerCopy: { notice } }).config?.readerCopy, notice).toEqual({ notice });
    }
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
  it('[S.16] (audit LOW-3) readerCopy.notice: the schema requires a visible character (whitespace-only, invisible-only text fails its pattern) and says the length is counted in UTF-16 code units, as the validator counts it', () => {
    const notice = (schema.properties['readerCopy'] as unknown as { oneOf: Array<{ properties?: { notice?: { pattern?: string; description?: string; maxLength?: number } } }> }).oneOf[1].properties!.notice!;
    expect(notice.maxLength).toBe(READER_NOTICE_MAX);
    expect(notice.description).toMatch(/UTF-16 code units/);
    // as JSON Schema tools run it: an ECMA-262 regex, unanchored, with or without the u flag
    for (const flags of ['', 'u']) {
      const re = new RegExp(notice.pattern!, flags);
      for (const bad of ['   ', '\u00a0\u3000', '\t\n', '\u200b\u200d', '\ufeff ']) expect(re.test(bad), JSON.stringify(bad)).toBe(false);
      for (const good of ['x', '  Your own copy.  ', '日本語', '😀']) expect(re.test(good), good).toBe(true);
    }
    // never stricter than the validator: what its pattern refuses, the validator refuses too
    for (const bad of ['   ', '\u00a0\u3000', '\u200b\u200d']) expect(codes({ format: 1, readerCopy: { notice: bad } })).toEqual(['bad-config']);
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
