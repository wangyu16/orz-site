# Changelog

All notable changes to **orz-site** are recorded here. Versions follow
[Semantic Versioning](https://semver.org/). The config format (`format` in
`orz-site.json`) and the manifest format are versioned on their own.

## [0.1.0] — 2026-10-24

First version (family REBUILD Phase 4 step 9; design: `spec/site.md`, FC-20).
Needs orz-markdown ≥ 2.5.0 and carriers ≥ 1.1.0 (peers).

- `buildSite(files, config, env)` — the pure, browser-safe core: documents by
  file name, assets byte for byte, always-excluded paths, includes resolved at
  build time (file, own-host, allowed hosts; hashes in the manifest), the link
  check, collisions refused, empty texts skipped, 0.x texts refused through the
  carriers' lint, cdn delivery with `inline` globs, the generated index (an orz
  `md` document assembled by the pinned orz-mdhtml), `sitemap.xml`,
  `.nojekyll`, `404.html`, published texts and `orz-site-manifest.json`,
  incremental build keys; deterministic (no clock, sorted output).
- Include and link targets from the kit's parser: `includeTargets` and
  `linkTargets` of `orz-markdown/carrier` (browser-safe since 2.5.0; a
  carrier's own re-export is preferred), re-exported from the main entry.
  The same build runs in a browser with the carriers' `-browser` ES modules
  and gives the same bytes as in Node (claim S.2).
- Host naming: `"naming": { "md": "{stem}.html" }` (per-kind templates)
  names the pages and reaches every page as the kit's `twinLinks`, so its
  rendered links, the editor preview and verify.html use the site's names.
  Needs carriers that carry it (1.1.0 or later); with older pins the build is
  refused (`naming-unsupported`), checked by reading each assembled page back
  with the carrier's own `extract`.
- `orz-site/node`: `readSiteFolder` (symlinks out of the root refused),
  `loadCarriers` (the installed carriers; pins checked by the core),
  `writeSite` (atomic, never over a folder it did not make), `buildFolder`,
  `initSite`.
- CLI `orz-site build | check | init [--github [--update]]`, `--json` reports
  with reason codes and runnable `next` commands.
- Route A: the GitHub Actions + Pages workflow `init --github` writes, with
  actions at their current majors, all on GitHub's Node 24 runtime
  (`checkout@v7`, `setup-node@v7`, `cache@v6`, `configure-pages@v6`,
  `upload-pages-artifact@v5` with `include-hidden-files: true` so the
  artifact keeps `.nojekyll`, `deploy-pages@v5`; STATUS D-122).
- `orz-site.json` format 1 and its JSON Schema `schema/site-1.json`; unknown
  keys are errors.
