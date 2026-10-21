/**
 * The generated index (spec §5, Q10): an orz `md` document generated as TEXT
 * and assembled by the pinned orz-mdhtml with the site's delivery — themed by
 * the kit, self-editing like every page, no template code of orz-site's own.
 * Its links are `.md` links, so the page's own twin rule maps them.
 */
import { byCodeUnits, dirOf, encodePath } from './paths.js';
import type { Kind } from './types.js';

/** One built document, as the index lists it. */
export interface IndexEntry { path: string; kind: Kind; title: string; date?: string; description?: string }

/**
 * Escape a title or description as inline Markdown text: line breaks become
 * spaces, every ASCII punctuation character is backslash-escaped (CommonMark
 * §2.4), so the value cannot open a directive (`{{`), a link, an HTML tag, an
 * emphasis or a block. Claim S.12 renders it in Chrome.
 */
export function escapeInline(s: string): string {
  return s.replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ').replace(/\s+/g, ' ').trim().replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`);
}

/** A header value: one line, no `}}` (the header cannot hold either). */
const headerValue = (s: string): string => s.replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ').replace(/\s+/g, ' ').replace(/\}\}/g, '} }').trim();

/** The index text (deterministic: entries grouped by folder, sorted by site path). */
export function indexText(entries: readonly IndexEntry[], o: { title: string | null; theme: string | null; lang: string }): string {
  const title = o.title ?? 'Contents';
  const lines: string[] = ['{{nyml', 'kind: document', `title: ${headerValue(title)}`, `lang: ${o.lang}`];
  if (o.theme) lines.push(`theme: ${o.theme}`);
  lines.push('}}', '', `# ${escapeInline(title)}`, '');
  const sorted = [...entries].sort((a, b) => byCodeUnits(a.path, b.path));
  const folders = [...new Set(sorted.map((e) => dirOf(e.path)))].sort(byCodeUnits);
  if (sorted.length === 0) lines.push('No documents yet.', '');
  for (const folder of folders) {
    if (folder !== '') lines.push(`## ${escapeInline(folder)}`, '');
    for (const e of sorted.filter((x) => dirOf(x.path) === folder)) {
      const facts = [e.kind !== 'md' ? e.kind : null, e.date ? (/^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : escapeInline(e.date)) : null].filter(Boolean);
      lines.push(`- [${escapeInline(e.title) || escapeInline(e.path)}](${encodePath(e.path)})${facts.length ? ` — ${facts.join(' · ')}` : ''}`);
      if (e.description && escapeInline(e.description)) lines.push(`  ${escapeInline(e.description)}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
