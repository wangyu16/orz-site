#!/usr/bin/env node
/**
 * The orz-site CLI (spec §7.3):
 *
 *   orz-site build [dir] [-o out] [--base-url u] [--offline] [--incremental] [--json]
 *   orz-site check [dir] [--offline] [--json]
 *   orz-site init  [dir] [--github [--update]] [--json]
 *
 * Exit 0 done (warnings allowed), 1 refused, 2 usage — the carriers' codes.
 * `--json`: `{ ok: true, command, …, warnings }` or `{ ok: false, command,
 * error, reason, next?, exitCode, errors, warnings }`; `reason` is the first
 * error's code; `next = { command, args }` (plus `tool` for another program)
 * runnable verbatim, never `--force` (carrier-node §2).
 */
import { join, relative, resolve } from 'node:path';
import { buildFolder, initSite, SiteError, writeSite } from './node.js';
import type { Finding, Kind, Next, Report } from './types.js';
import { VERSION } from './version.js';

const TOOL = 'orz-site';
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const HELP = `orz-site ${VERSION} — a folder of orz texts as a static site

usage:
  orz-site build [dir] [-o out] [--base-url url] [--offline] [--incremental] [--json]
  orz-site check [dir] [--offline] [--json]
  orz-site init  [dir] [--github [--update]] [--json]

  build   assemble every text of dir (default .) into out (default dir/_site)
  check   everything build checks, writing nothing; also red for a missing
          orz-site.json, unpinned kinds and a workflow whose versions drift
  init    write orz-site.json (the installed carriers as pins); --github also
          writes .github/workflows/orz-site.yml (GitHub Actions + Pages)

exit: 0 done, 1 refused, 2 usage. Config reference: schema/site-1.json; spec: spec/site.md (both in the package)`;

class UsageError extends Error {}

interface Args { command: string; dir: string; out?: string; baseUrl?: string; offline: boolean; incremental: boolean; json: boolean; github: boolean; update: boolean }

function parseArgs(argv: string[]): Args | 'help' | 'version' {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return 'help';
  if (argv[0] === '--version' || argv[0] === '-v') return 'version';
  const [command, ...rest] = argv as [string, ...string[]];
  if (!['build', 'check', 'init'].includes(command)) throw new UsageError(`unknown command ${JSON.stringify(command)} (build, check, init)`);
  const a: Args = { command, dir: '.', offline: false, incremental: false, json: false, github: false, update: false };
  const allowed: Record<string, string[]> = {
    build: ['-o', '--out', '--base-url', '--offline', '--incremental', '--json'],
    check: ['--offline', '--json', '--base-url'],
    init: ['--github', '--update', '--json'],
  };
  let dirSet = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] as string;
    if (t === '--help' || t === '-h') return 'help';
    if (t.startsWith('-')) {
      const [flag, inlineValue] = t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, undefined];
      if (!(allowed[command] as string[]).includes(flag)) throw new UsageError(`${command} does not take ${flag}`);
      const value = (): string => {
        if (inlineValue !== undefined) return inlineValue;
        const v = rest[++i];
        if (v === undefined) throw new UsageError(`${flag} needs a value`);
        return v;
      };
      if (flag === '-o' || flag === '--out') a.out = value();
      else if (flag === '--base-url') a.baseUrl = value();
      else if (flag === '--offline') a.offline = true;
      else if (flag === '--incremental') a.incremental = true;
      else if (flag === '--json') a.json = true;
      else if (flag === '--github') a.github = true;
      else if (flag === '--update') a.update = true;
    } else {
      if (dirSet) throw new UsageError(`one folder only (got ${JSON.stringify(a.dir)} and ${JSON.stringify(t)})`);
      a.dir = t; dirSet = true;
    }
  }
  if (a.update && !a.github) throw new UsageError('--update goes with --github');
  return a;
}

const CARRIER_TOOLS = new Set(['orz-mdhtml', 'orz-slides', 'orz-paged']);

/** A finding's `next`, with site paths made relative to the working folder so it runs verbatim from here. */
function localNext(f: Finding, dir: string): Next | undefined {
  const n = f.next;
  if (!n) return undefined;
  if (n.tool && CARRIER_TOOLS.has(n.tool) && f.path) return { ...n, args: n.args.map((x) => (x === f.path ? relative(process.cwd(), join(dir, x)) || '.' : x)) };
  return n;
}
const localize = (list: Finding[], dir: string): Finding[] => list.map((f) => { const next = localNext(f, dir); return next ? { ...f, next } : f; });

const nextLine = (n: Next): string => [n.tool ?? TOOL, n.command, ...n.args.map((w) => (/^[\w./@%+=:,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`))].join(' ');
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const where = (f: Finding): string => (f.path ? `${f.path}${f.line ? `:${f.line}` : ''}: ` : '');

function printFindings(report: Report): void {
  for (const w of report.warnings) process.stderr.write(`${TOOL}: warning: ${where(w)}${w.message} [${w.code}]${w.next ? `\n    next: ${nextLine(w.next)}` : ''}\n`);
  for (const e of report.errors) process.stderr.write(`${TOOL}: error: ${where(e)}${e.message} [${e.code}]${e.next ? `\n    next: ${nextLine(e.next)}` : ''}\n`);
}

function emitJson(o: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(o, null, 2)}\n`); }

function fail(command: string, json: boolean, message: string, reason: string, exitCode: number, next?: Next, report?: Report): number {
  if (json) emitJson({ ok: false, command, error: message, reason, ...(next ? { next } : {}), exitCode, ...(report ? { errors: report.errors, warnings: report.warnings } : {}) });
  else {
    if (report) printFindings(report);
    process.stderr.write(`${TOOL} ${command}: ${message}${next ? `\n  next: ${nextLine(next)}` : ''}\n${exitCode === EXIT_USAGE ? `(see ${TOOL} --help)\n` : ''}`);
  }
  return exitCode;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  const json = argv.includes('--json');
  try { parsed = parseArgs(argv); } catch (e) {
    return fail(argv[0] ?? '', json, (e as Error).message, 'bad-usage', EXIT_USAGE);
  }
  if (parsed === 'help') { process.stdout.write(`${HELP}\n`); return EXIT_OK; }
  if (parsed === 'version') { process.stdout.write(`${VERSION}\n`); return EXIT_OK; }
  const a = parsed;
  try {
    if (a.command === 'init') {
      const r = await initSite(a.dir, { github: a.github, update: a.update });
      if (a.json) emitJson({ ok: true, command: 'init', written: r.written, carriers: r.config['carriers'] as Partial<Record<Kind, string>>, warnings: [] });
      else process.stdout.write(r.written.length ? r.written.map((w) => `wrote ${join(a.dir, w)}`).join('\n') + '\n' : 'nothing to write: up to date\n');
      return EXIT_OK;
    }
    const out = a.command === 'build' ? (a.out ?? join(a.dir, '_site')) : undefined;
    const { result } = await buildFolder(a.dir, { ...(out ? { out } : {}), ...(a.baseUrl !== undefined ? { baseUrl: a.baseUrl } : {}), offline: a.offline, incremental: a.incremental, check: a.command === 'check' });
    const report: Report = { ...result.report, errors: localize(result.report.errors, a.dir), warnings: localize(result.report.warnings, a.dir) };
    if (!report.ok) {
      const first = report.errors[0] as Finding;
      const msg = `refused: ${report.errors.length} error${report.errors.length === 1 ? '' : 's'} (first: ${where(first)}${first.message})`;
      return fail(a.command, a.json, msg, first.code, EXIT_FAILED, first.next, report);
    }
    if (a.command === 'build') {
      writeSite(out as string, result, { root: a.dir });
      if (a.json) emitJson({ ok: true, command: 'build', out: resolve(out as string), documents: report.documents, assets: report.assets, outputs: report.outputs, errors: [], warnings: report.warnings });
      else { printFindings(report); process.stdout.write(`${TOOL} build: ${plural(report.documents, 'document')}, ${plural(report.assets, 'asset')} → ${plural(report.outputs, 'file')} in ${out}\n`); }
    } else {
      if (a.json) emitJson({ ok: true, command: 'check', documents: report.documents, assets: report.assets, outputs: report.outputs, errors: [], warnings: report.warnings });
      else { printFindings(report); process.stdout.write(`${TOOL} check: green — ${plural(report.documents, 'document')}, ${plural(report.assets, 'asset')}, ${plural(report.outputs, 'file')} would be written\n`); }
    }
    return EXIT_OK;
  } catch (e) {
    if (e instanceof SiteError) return fail(a.command, a.json, e.message, e.reason, e.exitCode, e.next);
    return fail(a.command, a.json, e instanceof Error ? e.message : String(e), 'failed', EXIT_FAILED);
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`${TOOL}: ${(e as Error).stack ?? String(e)}\n`); process.exitCode = EXIT_FAILED; });
