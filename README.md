# orz-site

**A folder of orz texts as a static site.** `orz-site` turns a folder of
text twins — Markdown documents (`*.md`), slide decks (`*.slides.md`), paged
documents (`*.paged.md`) — and their assets into a site of self-editing
pages, ready for GitHub Pages or any static host. The repository keeps only
text; the build assembles every page with the exact carrier versions the
site pins.

```
course/                          _site/
  orz-site.json                    index.html               generated contents page
  index.md                ──►      index.md.html  index.md
  lessons/01-cells.md              lessons/01-cells.md.html  lessons/01-cells.md
  slides/week1.slides.md           slides/week1.slides.html  slides/week1.slides.md
  handouts/lab.paged.md            handouts/lab.paged.html   handouts/lab.paged.md
  img/cell.svg                     img/cell.svg              copied byte for byte
  shared/policies.md (excluded)    sitemap.xml  .nojekyll  orz-site-manifest.json
```

- **Every page is a carrier file**: the same bytes `orz-mdhtml`, `orz-slides`
  or `orz-paged` assemble, so each page can be read, edited and saved by a
  reader, and [verify.html](https://markdown.orz.how/verify.html) reproduces
  it byte for byte.
- **Links between texts just work**: `[Week 1](../slides/week1.slides.md)`
  in a text opens `week1.slides.html` on the site (the kit's twin-link rule,
  applied when the page renders); dead links between texts stop the build.
- **Includes are resolved at build time** (`{{md shared/policies.md}}`, or a
  URL on the site's own host or an allowed host) and stored in each page.
- **Deterministic**: the same texts, config and versions give the same
  bytes — no timestamps, sorted output.

Status: **0.1.0, the first release.** Layer: above the carriers
(`orz-mdhtml`, `orz-slides`, `orz-paged`) and the kit (`orz-markdown`); no
carrier or kit module knows orz-site (family RULES §1). Design:
[spec/site.md](spec/site.md) (family contract FC-20).

## Install

```bash
npm install --save-dev orz-site orz-mdhtml@1.0.2 orz-slides@1.0.0 orz-paged@1.0.0
```

The carriers (and the kit, `orz-markdown`) are **peer dependencies**: the
site's `orz-site.json` pins the exact carrier versions, and the build refuses
an installed carrier whose version differs (`shell-mismatch`). Install only
the kinds the site uses. Node ≥ 20.16.

## CLI

```
orz-site build [dir] [-o out] [--base-url url] [--offline] [--incremental] [--json]
orz-site check [dir] [--offline] [--json]
orz-site init  [dir] [--github [--update]] [--json]
```

| Command | What it does |
|---|---|
| `build` | Assembles every text of `dir` (default `.`) into `out` (default `dir/_site`, excluded from the input). Writes into a temporary sibling folder and renames it over `out`; an existing `out` that is not an orz-site output is refused (`out-not-site`). `--base-url` overrides `baseUrl` (route A passes the Pages URL). `--offline` fetches nothing. `--incremental` reuses the pages of `out` whose build key is unchanged (the result equals a full build). |
| `check` | Everything `build` checks, writing nothing. Also red for a missing `orz-site.json`, a kind used without a pin, and a workflow whose install line drifts from the pins (`workflow-drift`). |
| `init` | Writes `orz-site.json` with the installed carriers as pins and every default. `--github` also writes `.github/workflows/orz-site.yml` (route A). An existing file is never overwritten (`exists`); `--github --update` rewrites a workflow that differs from the template only in its version lines. |

Exit status: `0` done (warnings allowed), `1` refused, `2` usage — as the
carriers. With `--json`, one object on stdout:

```json
{ "ok": true, "command": "build", "out": "/abs/_site", "documents": 7, "assets": 2, "outputs": 20, "errors": [], "warnings": [] }
{ "ok": false, "command": "build", "error": "refused: 1 error (first: …)", "reason": "missing-link", "next": { "command": "init", "args": [] }, "exitCode": 1, "errors": [ … ], "warnings": [ … ] }
```

`reason` is the first error's code; `next` (when there is one) is a command
to run verbatim — `orz-site <command> <args>`, or `<tool> <command> <args>`
when it names another program (`{ "tool": "npm", "command": "install",
"args": ["orz-slides@1.0.0"] }`, `{ "tool": "orz-slides", "command":
"upgrade", "args": ["slides/old.slides.md"] }`). Never `--force`. Findings
are `{ code, message, path?, line?, target?, next? }`, sorted with the
site-level ones (the config) first, then by path, line and code. The codes
are listed in [spec/site.md §7.2](spec/site.md); 0.1 adds `no-carrier`,
`no-pin` and `unreadable`.

## Config: `orz-site.json`

JSON at the site root. Reference: the JSON Schema
[`schema/site-1.json`](schema/site-1.json) (published in the package:
`"$schema": "https://cdn.jsdelivr.net/npm/orz-site@0.1/schema/site-1.json"`)
and [spec/site.md §3](spec/site.md). **Unknown keys are errors** (a misspelt
`exlude` must not publish drafts). `format` is the config format (1),
independent of the package version.

```json
{
  "$schema": "https://cdn.jsdelivr.net/npm/orz-site@0.1/schema/site-1.json",
  "format": 1,
  "carriers": { "md": "1.0.2", "slides": "1.0.0", "paged": "1.0.0" },
  "delivery": "cdn",
  "inline": ["handouts/**"],
  "naming": "family",
  "baseUrl": "https://owner.github.io/course/",
  "includes": { "allowedHosts": [], "network": true, "missing": "error" },
  "links": { "missing": "error" },
  "exclude": ["drafts/", "shared/"],
  "texts": true,
  "index": { "mode": "auto", "title": "Course", "theme": null, "lang": "en" },
  "sitemap": true,
  "notFound": "404.md"
}
```

| Key | Meaning | Default |
|---|---|---|
| `format` | config format version | required |
| `carriers` | exact version per kind (`md` → orz-mdhtml, `slides` → orz-slides, `paged` → orz-paged) | `check` requires a pin per kind used |
| `delivery` | `cdn` (engine from jsDelivr; right for sites) or `inline` | `cdn` |
| `inline` | globs of documents assembled inline anyway | `[]` |
| `naming` | `"family"` (`x.md` → `x.md.html`, `x.slides.md` → `x.slides.html`, `x.paged.md` → `x.paged.html`), or per-kind templates such as `{ "md": "{stem}.html" }` (`{stem}` once, otherwise only `A-Z a-z 0-9 . _ -`, ending in `.html`, same folder; a kind left out keeps the family name). A template naming needs carriers 1.1.0 or later, which carry it into each page (`twinLinks`), so the rendered links, the editor preview and verify.html agree; older pins are refused (`naming-unsupported`) | `"family"` |
| `baseUrl` | the site's URL, ending in `/` (sitemap, own-host includes, root-relative warnings) | none |
| `includes` | `allowedHosts` (https hosts that may be fetched), `network`, `missing` (`error`/`warn`) | `[]`, `true`, `error` |
| `links.missing` | a link to a text that is not built: `error` or `warn` | `error` |
| `exclude` | globs neither built nor published (still readable as file includes) | `[]` |
| `texts` | also publish each text twin as is | `true` |
| `index` | the generated contents page: `mode` (`auto`/`on`/`off`), `title`, `theme`, `lang` | `auto`, "Contents", default theme, `en` |
| `sitemap` | write `sitemap.xml` (needs `baseUrl`) | `true` |
| `notFound` | a root text whose page is written as `404.html` | `null` |

Globs: `*` (not `/`), `**` (any depth), `?`; a pattern ending in `/` is the
folder and everything under it. Always excluded: any path segment starting
with `.`, `node_modules/`, names ending in `~` (carrier backups), the config
and the output folder.

## What the build does

- **Kind by file name** (FC-18): `*.slides.md`, `*.paged.md`, other `*.md`;
  everything else is an asset, copied byte for byte. A committed assembled
  file is copied with the warning `assembled-input` (and `legacy-file` for a
  0.x one, with the upgrade command as `next`).
- **Each text is read by its own carrier** (`readDocument`); a lint error
  refuses it (`invalid-text`) — so a 0.x deck text is refused with
  `orz-slides upgrade <path>` as `next`. An empty text (no body) is skipped
  with `empty-text`.
- **Includes** resolve into each page's `#orz-includes` record: file targets
  from the site (relative to the text, inside the root; excluded partials
  included); URLs on the site's own host from the site's files, never the
  network; URLs on an `allowedHosts` host fetched once per build (https
  only, no redirects, 15 s, 5 000 000 characters, nested up to depth 3), their
  SHA-256 in the manifest; anything else `include-host`. Missing or refused
  includes are errors unless `includes.missing` is `warn`.
- **Links** between texts are checked with the kit's parser: a link to a text
  that is not built (missing, excluded, empty, outside the root) is
  `missing-link` (an error by default); a missing asset, a raw-HTML
  `<a href="x.md">`, an upper-case `X.MD` and a root-relative link on a
  project site are warnings. Fragments are not checked in 0.1.
- **Collisions** are refused, never resolved: two parties wanting one output
  path (`name-collision`), or paths differing only in letter case
  (`case-collision`); every party is named.
- **The index** (`index.mode: auto`, when no page or asset is `index.html`)
  is an orz `md` document generated as text — titles, kinds, dates and
  descriptions of the built documents, grouped by folder — and assembled by
  the pinned orz-mdhtml; its text is in the manifest (and published as
  `index.md` when that name is free).
- **The manifest** `orz-site-manifest.json` (published): which text became
  which page with which shell, the includes and their hashes, the `uid`s,
  what was skipped and why, and each page's build key (for `--incremental`).

## Library

```ts
import { buildSite } from 'orz-site';                       // the browser-safe core
import { buildFolder, readSiteFolder, loadCarriers, writeSite, initSite } from 'orz-site/node';

const { files, errors } = readSiteFolder('course');
const { carriers } = await loadCarriers();
const result = await buildSite(files, config, { carriers, baseUrl: 'https://owner.github.io/course/' });
// → { ok, files: Map<path, bytes>, manifest, report }; a refused build has no files
if (result.ok) writeSite('_site', result);
```

`buildSite(files, config, env)` takes a `Map<sitePath, Uint8Array>` and the
parsed config, and reads nothing else: no clock, no environment, no files.
`env.carriers` are the carrier modules (`kind`, `version`, `formats`,
`assemble`, `extract`, `readDocument`; from 1.1 also `includeTargets`,
`linkTargets`); `env.fetch` the transport for network includes;
`env.previous` a previous manifest and output for an incremental build. The
include and link targets come from the kit's parser (`includeTargets`,
`linkTargets` of `orz-markdown/carrier`, re-exported from the main entry):
the carrier's own when it has them, else the kit's — browser-safe, so a
build in the browser reads the same targets as one in Node.

## Publishing

**Route A — GitHub Actions and Pages (default).** `orz-site init --github`
writes `.github/workflows/orz-site.yml`: on each push to `main` it installs
orz-site and the pinned carriers (exact versions, into `$RUNNER_TEMP`, never
committed), builds with the Pages URL as `--base-url`, and deploys the
output as a Pages artifact. Set the repository's Pages source to **GitHub
Actions**. Actions are pinned by major tag. A carrier update is: edit the pin
in `orz-site.json`, run `orz-site init --github --update`, commit;
`orz-site check` reports a workflow that does not match the pins.

**Route B — an app builds in the browser and commits.** The core is the same
code in a browser: the app reads the site's files, imports each pinned
`orz-<x>-browser` ESM from jsDelivr, calls `buildSite`, and commits
`result.files` as one commit to a publishing branch (Pages source "Deploy
from a branch"; `.nojekyll` is always written). Claim S.2: the course
fixture built this way in Chrome, with the `-browser` ES modules of the
pinned versions, equals the Node build byte for byte.

## Limits of 0.1

- A template `naming` needs every carrier the site uses at 1.1.0 or later
  (`naming-unsupported` otherwise): a page's links are rewritten by the kit
  when the page renders, so the site's names must travel in the file (the
  kit's `twinLinks`, orz-markdown 2.5.0).
- The 404 page's relative links resolve from the site root only.
- Route B (an app that builds in the browser and commits) is the core's job
  only up to `result.files`: committing is the app's.

## Development

```bash
npm ci
npm test              # vitest: main (unit, core, CLI) then chrome (real Chrome, skipped without it)
npm run test:fast     # the no-Chrome lane
npm run build         # dist/
```

Claims and their tests: [notes/CLAIMS.md](notes/CLAIMS.md). The fixture
course is `fixtures/course/`. Release: the family's gate and green-run stamp
(`scripts/release-check.ts`, `scripts/test-release.ts`, copied from the
family root by `scripts/tooling-sync.ts`; facts in `release.config.json`).

## License

MIT © Yu Wang
