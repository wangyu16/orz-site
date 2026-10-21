# Changelog

All notable changes to **orz-site** are recorded here. Versions follow
[Semantic Versioning](https://semver.org/). The config format (`format` in
`orz-site.json`) and the manifest format are versioned on their own.

## [0.1.0] — unreleased

First version (family REBUILD Phase 4 step 9; design: `spec/site.md`, FC-20).

- `buildSite(files, config, env)` — the pure, browser-safe core: documents by
  file name, assets byte for byte, always-excluded paths, includes resolved at
  build time (file, own-host, allowed hosts; hashes in the manifest), the link
  check, collisions refused, empty texts skipped, 0.x texts refused through the
  carriers' lint, cdn delivery with `inline` globs, the generated index (an orz
  `md` document assembled by the pinned orz-mdhtml), `sitemap.xml`,
  `.nojekyll`, `404.html`, published texts and `orz-site-manifest.json`,
  incremental build keys; deterministic (no clock, sorted output).
- `orz-site/node`: `readSiteFolder` (symlinks out of the root refused),
  `loadCarriers` (the installed carriers; pins checked by the core),
  `writeSite` (atomic, never over a folder it did not make), `buildFolder`,
  `initSite`.
- CLI `orz-site build | check | init [--github [--update]]`, `--json` reports
  with reason codes and runnable `next` commands; the GitHub Actions + Pages
  workflow template (route A).
- `orz-site.json` format 1 and its JSON Schema `schema/site-1.json`; unknown
  keys are errors.
- Limits: family naming only (a non-family `naming` is refused with
  `naming-needs-kit` until the kit's K1); Node only (K2).
