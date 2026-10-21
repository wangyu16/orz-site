/**
 * The links of a text, as the renderer sees them (spec §4.1).
 *
 * TODO(K2): replace with the kit's `linkTargets` after K2 (spec §13: the kit
 * exports `linkTargets` from `orz-markdown/carrier` and each carrier
 * re-exports it from its own bundled kit). orz-markdown 2.4.0 has no
 * `linkTargets`, so this module reads links from the kit's own parser
 * (`kitParser`, RULES §2.4: orz-site parses no Markdown of its own) and
 * classifies them with the kit's `twinHref`. A carrier module that has
 * `linkTargets` (K2) is preferred by the builder.
 */
import { kitParser, twinHref, withoutHeader } from 'orz-markdown/carrier';
import type { LinkRef } from './types.js';

interface Tok { type: string; map: [number, number] | null; content: string; children: Tok[] | null; attrGet?(n: string): string | null }

const RAW_A = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** The class of an href: `other` (a URL, `//host`, `#frag`, `?q`, empty), `twin` (the twin rule rewrites it), else `asset`. */
export function linkKind(href: string): LinkRef['kind'] {
  if (href === '' || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith('//') || href.startsWith('#') || href.startsWith('?')) return 'other';
  return twinHref(href) !== href ? 'twin' : 'asset';
}

/**
 * The links and images of a text's body (after the header), in order:
 * Markdown links (`link_open`, as markdown-it normalized them — the href the
 * twin rule sees), images, and raw-HTML `<a href>` (flagged `raw`). Not in
 * code, comments or directive bodies the parser keeps opaque.
 */
export function linkTargets(text: string): LinkRef[] {
  const { body, offset } = withoutHeader(text);
  const before = (text.slice(0, offset).match(/\r\n|\r|\n/g) ?? []).length;
  const tokens = kitParser().parse(body, {}) as unknown as Tok[];
  const out: LinkRef[] = [];
  const raw = (html: string, line: number): void => {
    for (const m of html.matchAll(RAW_A)) {
      const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      out.push({ href, line, kind: linkKind(href), raw: true });
    }
  };
  for (const t of tokens) {
    const start = t.map ? before + t.map[0] + 1 : before + 1;
    if (t.type === 'html_block') { raw(t.content, start); continue; }
    if (t.type !== 'inline' || !t.children) continue;
    let line = start;
    for (const c of t.children) {
      if (c.type === 'softbreak' || c.type === 'hardbreak') { line++; continue; }
      if (c.type === 'link_open') {
        const href = c.attrGet?.('href') ?? '';
        out.push({ href, line, kind: linkKind(href), raw: false });
      } else if (c.type === 'image') {
        const href = c.attrGet?.('src') ?? '';
        const k = linkKind(href);
        out.push({ href, line, kind: k === 'twin' ? 'asset' : k, raw: false, image: true });
      } else if (c.type === 'html_inline') raw(c.content, line);
    }
  }
  return out;
}
