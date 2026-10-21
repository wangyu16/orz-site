import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Two groups: `main` (unit, core and CLI; no browser) — `npm run test:fast`
 * is `--project main` — then `chrome` (the files that drive real Chrome via
 * playwright-core, channel 'chrome': the index rendering, the fixture's
 * pages and verify.html). Chrome tests skip themselves when Chrome is not
 * installed; such a run does not verify the claims marked "Chrome" in
 * notes/CLAIMS.md.
 */
const CHROME = ['tests/chrome.test.ts', 'tests/verify.test.ts'];

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    projects: [
      { extends: true, test: { name: 'main', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, ...CHROME], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'chrome', include: CHROME, sequence: { groupOrder: 1 } } },
    ],
  },
});
