/**
 * Route A (spec §8): the GitHub Actions + Pages workflow `orz-site init
 * --github` writes, and the drift check `orz-site check` runs on it. Pure
 * text work. Actions are pinned by major tag (owner decision Q4).
 */
import { KINDS, type Kind } from './types.js';

export const WORKFLOW_FILE = '.github/workflows/orz-site.yml';
const PACKAGE: Record<Kind, string> = { md: 'orz-mdhtml', slides: 'orz-slides', paged: 'orz-paged' };

/** The workflow text for an orz-site version and the config's carrier pins. */
export function workflowText(siteVersion: string, pins: Partial<Record<Kind, string>>): string {
  const packages = [`orz-site@${siteVersion}`, ...KINDS.filter((k) => pins[k]).map((k) => `${PACKAGE[k]}@${pins[k]}`)].join(' ');
  return `# Written by orz-site ${siteVersion} (orz-site init --github). The versions below
# must match orz-site.json; \`orz-site check\` reports a difference.
name: Publish site
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: orz-site-\${{ hashFiles('orz-site.json') }}
      - id: pages
        uses: actions/configure-pages@v5
      - name: Install orz-site and the pinned carriers
        run: >
          npm install --prefix "$RUNNER_TEMP/orz" --no-save --no-package-lock
          --ignore-scripts --no-audit --no-fund
          ${packages}
      - name: Build
        run: >
          "$RUNNER_TEMP/orz/node_modules/.bin/orz-site" build .
          -o "$RUNNER_TEMP/site" --base-url "\${{ steps.pages.outputs.base_url }}/"
      - uses: actions/upload-pages-artifact@v3
        with:
          path: \${{ runner.temp }}/site
  deploy:
    needs: build
    runs-on: ubuntu-24.04
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

/** The carrier pins a workflow's install line names (`orz-<x>@<v>`), and its orz-site version. */
export function workflowPins(text: string): { site: string | null; carriers: Partial<Record<Kind, string>> } {
  const carriers: Partial<Record<Kind, string>> = {};
  for (const k of KINDS) {
    const m = new RegExp(`(?:^|\\s)${PACKAGE[k]}@(\\S+)`, 'm').exec(text);
    if (m) carriers[k] = m[1] as string;
  }
  const site = /(?:^|\s)orz-site@(\S+)/m.exec(text);
  return { site: site ? (site[1] as string) : null, carriers };
}

/** Lines that hold orz-site's own versions (the header comment and the install line), for `--update`. */
const OWN_LINE = /^(# Written by orz-site \S+ \(orz-site init --github\)\. The versions below|\s+orz-site@\S+(\s+orz-(mdhtml|slides|paged)@\S+)*)$/;

/** True when two workflow texts differ only in orz-site's own version lines. */
export function differsOnlyInVersions(a: string, b: string): boolean {
  const strip = (t: string): string => t.split('\n').filter((l) => !OWN_LINE.test(l)).join('\n');
  return strip(a) === strip(b);
}

/** The pins that differ between the config and the workflow (empty: none). */
export function workflowDrift(text: string, pins: Partial<Record<Kind, string>>): string[] {
  const got = workflowPins(text).carriers;
  const out: string[] = [];
  for (const k of KINDS) if ((got[k] ?? null) !== (pins[k] ?? null)) out.push(`${PACKAGE[k]}: orz-site.json ${pins[k] ?? '(none)'}, the workflow ${got[k] ?? '(none)'}`);
  return out;
}
