/**
 * orz-site — a folder of orz texts as a static site (spec/site.md, FC-20).
 *
 * The main entry is the browser-safe core: `buildSite` / `checkSite` with the
 * carriers injected, the config validator, and the small pure helpers. The
 * Node adapter and CLI are `orz-site/node`.
 */
export { buildSite, checkSite, alwaysExcluded, LIMITS, GENERATED, MANIFEST_FILE } from './build.js';
export { validateConfig, parseConfig, defaultConfig, templateProblem, baseUrlProblem, CONFIG_FILE, CONFIG_FORMAT, SCHEMA_URL } from './config.js';
export { globRegExp, globProblem, matchesAny } from './glob.js';
export { indexText, escapeInline, type IndexEntry } from './index-page.js';
export { defaultFetch, IncludeFetchError, rootKey, MAX_INCLUDE_CHARS, FETCH_TIMEOUT_MS, MAX_URL_DEPTH } from './includes.js';
export { linkTargets, linkKind } from './links.js';
export { sitePathProblem, resolveIn, encodePath } from './paths.js';
export { workflowText, workflowPins, workflowDrift, differsOnlyInVersions, WORKFLOW_FILE } from './workflow.js';
export { canonicalJson, sha256Hex } from './util.js';
export { VERSION } from './version.js';
export * from './types.js';
