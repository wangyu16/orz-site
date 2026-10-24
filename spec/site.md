# orz-site · a folder of texts as a static site (FC-20, draft)

**Status:** approved 2026-10-21 (owner: Q1–Q10 as recommended, FD-08
"Design decided"); contract FC-20 is a draft until 1.0. Implemented by
orz-site 0.1 (REBUILD §3 Phase 4 step 9) on kit 2.5.0 (K1, K2): the
kit's browser-safe `includeTargets`/`linkTargets` (Node = browser, S.2), and
a non-family `naming` through the kit's `twinLinks` (§4.2 option A), refused
as `naming-unsupported` when a pinned carrier predates 1.1 (§3.5); claims in
[notes/CLAIMS.md](../notes/CLAIMS.md).
Decisions it rests on: FD-05, FD-07, FD-08 (family `docs/DECISIONS.md`);
contracts it uses: FC-07, FC-08, FC-18, FC-19 (family `docs/CONTRACTS.md`).
Open owner decisions: [DESIGN-QUESTIONS.md](../DESIGN-QUESTIONS.md) (Q1–Q10,
cited as **[Qn]**). Points this draft is not sure of are marked **[unsure]**.

## 1. Purpose and non-goals

`orz-site` turns a folder of orz texts (FC-18) and their assets into a static
site of assembled files, identically in Node and in the browser, so a
repository keeps only text and GitHub Pages serves the assembled pages
(FD-07).

- One pure function, `buildSite(files, config) → { files, report }` (§7).
  The CLI and the GitHub workflow (route A, §8) and an app in the browser
  (route B, §9) all call it.
- Layer (RULES §1): above orz-mdhtml, orz-slides, orz-paged (and the kit
  through them); below Alembic and coursewerk. No carrier and no kit module
  names orz-site; orz-site names no consumer.

**Non-goals.** Not a CMS (no accounts, drafts, permissions, scheduling); no
server and no dev server (a local preview is "build, then open the folder");
no Markdown parsing of its own (RULES §2.4: every parse is the kit's, reached
through the pinned carriers); no Alembic logic (course structure, terms,
private/public routing, permalink rewriting — a host filters and prepares the
file map it passes in, §2.1); no themes or layouts of its own (§5); no
upgrade of 0.x files (§2.4); no publishing to npm or GitHub itself (route B's
commit is the app's, §9).

## 2. Input

### 2.1 The file map

The input is a map of **site paths** to bytes: `Map<string, Uint8Array>`.
A site path is relative, POSIX (`/`), NFC, with no empty, `.` or `..`
segment, no leading `/`, no NUL, no `\`. The Node adapter
`readSiteFolder(dir, config)` builds the map from a folder (§10 rules); an app
builds it from wherever it keeps files. **The map is the whole site:** a host
that must withhold files (private material) leaves them out; orz-site never
reaches beyond the map, except for allowed URL includes (§2.5).

### 2.2 What is what

In order, first match wins:

1. **Excluded** (not read, not published): the config's `exclude` globs, plus
   always: any path segment starting with `.` (`.git/`, `.github/`, dot-files),
   `node_modules/`, a name ending in `~` (carrier backups, STATUS D-92/D-115),
   the config file itself, and the output folder when it lies inside the root.
   Excluded texts remain readable as **file include sources** **[unsure: or
   should excluded mean invisible? Q9 sides with readable, for `shared/`
   partials]**.
2. **Document** — a text twin by its **file name** (FC-18 §3, kit
   `kindFromFilename`): `*.slides.md` → `slides`, `*.paged.md` → `paged`,
   any other `*.md` → `md` (lower-case extensions only, as twin links,
   FC-18 §8.3). The header's `carrier:` key does **not** override the name
   (FC-18 §3: "a file name … still decides the kind of an existing text"); a
   disagreeing `carrier:` is the warning `carrier-mismatch`. **[Q5:** Alembic
   and coursewerk keep slides as `slides/<slug>.md` today — kind by folder.**]**
3. **Asset** — everything else, copied byte for byte. An assembled carrier
   file in the input (`*.md.html`, `*.slides.html`, `*.paged.html`) is an
   asset with the warning `assembled-input` (built files are not committed,
   FD-07); a 0.x one also `legacy-file` with `next: orz-<x> upgrade <path>`.

A document whose body (the text after the header) is empty or whitespace only
is **skipped** — no page, and links to it are `missing-link` — with the
warning `empty-text` (consumers keep empty slots, Alembic `slotHasContent`)
**[unsure: skip by default, or only with `skipEmpty: true`?]**.

### 2.3 Reading a document

Each document is decoded with the kit's `decodeText` (strict UTF-8, BOM
kept); invalid UTF-8 is `not-utf8`. Its kind's carrier `readDocument(text,
{ filename })` gives title, description, date, kind, lints. A lint error
refuses the document (`invalid-text`), e.g. slides' `deck-block` — so a 0.x
deck text is refused here even though the slides library's `assemble`
accepts it (STATUS D-112). A header `format` above the pinned carrier's
`FORMATS` is `newer-format`.

### 2.4 Old files

orz-site builds from texts only. It never extracts or upgrades assembled
files, so the browser `extract` of 0.x files (STATUS D-111) does not limit
it; an app that wants to convert 0.x files does so before building (Node
`orz-<x> upgrade`, or a browser upgrade once D-111 is fixed).

### 2.5 Includes

Includes resolve **at build time** into each file's `#orz-includes` record
(FC-18 §8.3 D4), passed to the carrier as `assemble(text, { includes })`.
The text keeps its directives. Targets come from the kit's parser
(`includeTargets`, the directives `md`, `markdown`, `md-include`; never in
code or comments) — see K2 in §13.

| Target | Resolved from | Rule |
|---|---|---|
| file path (`{{md shared/intro.md}}`) | the file map, relative to the including text's folder | must stay inside the root; one level (FC-07: file includes do not nest) |
| URL on the **site's own host** (under `baseUrl`, §3) | the file map (the path under `baseUrl`) — never the network | the target must be a text in the map; an output name (`*.html`) is `include-own-output` |
| URL on a host in `includes.allowedHosts` | the network, through the kit's `prepareSources` with a recording fetcher | `https:` only; redirects refused; nested URL includes up to depth 3; 5 000 000 characters and 15 s per fetch (the kit's defaults); each URL fetched once per build |
| any other URL | — | `include-host` |

- The record's keys are the targets **as written**; nested URL includes get
  their own URL keys (the preview's `prepareSources` looks each up there).
  Two file targets of one document that normalize to the same record key
  (the record reader's virtual root: `../a.md` and `a.md` from different
  folders) with different contents are refused, `include-key-clash`
  **[unsure: verify against the kit's `includeRecordEnv` in a test]**.
- **Missing or refused include:** the finding (`include-missing`,
  `include-host`, `include-too-large`, `include-network`) is an **error** by
  default (`includes.missing: "error"`); with `"warn"` the directive stays
  unresolved and the page shows the kit's "Included file not available"
  note. **[Q6]**
- `--offline` (and `includes.network: false`) fetches nothing: a URL include
  on another host is `include-network`.
- Network includes make the output depend on what the host serves at build
  time: their SHA-256 are in the manifest (§6), and §3.7's determinism is
  stated for equal fetched bytes. **[Q8]**

## 3. Config

### 3.1 File and format

`orz-site.json` at the root of the site folder — JSON, UTF-8, an object.
**[Q3 — JSON recommended over nyml or YAML.]** Why JSON: the config is
nested (per-kind pins and naming, lists of globs); `JSON.parse` is identical
in Node and every browser with no dependency (route B); a JSON Schema
(`schema/site-1.json` in the package) gives validation and editor completion;
the workflow can read it without orz-site (`node -p`). It is not document
metadata, so it is no second metadata grammar (RULES §2.4); the cost is no
comments.

Unknown keys are an **error** (`unknown-key`; a misspelt `exlude` must not
publish drafts). `format` above 1 is `newer-config` with `next` naming a
newer orz-site. A missing config: `build` uses the defaults with the carriers
it finds installed and warns `no-config`; `check` is red.

### 3.2 Keys

```json
{
  "$schema": "https://cdn.jsdelivr.net/npm/orz-site@0.1/schema/site-1.json",
  "format": 1,
  "carriers": { "md": "1.1.0", "slides": "1.1.0", "paged": "1.1.0" },
  "delivery": "cdn",
  "inline": ["handouts/**"],
  "naming": "family",
  "baseUrl": "https://owner.github.io/course/",
  "includes": { "allowedHosts": [], "network": true, "missing": "error" },
  "links": { "missing": "error" },
  "exclude": ["drafts/**"],
  "texts": true,
  "index": { "mode": "auto", "title": "Course", "theme": null, "lang": "en" },
  "sitemap": true,
  "notFound": null
}
```

| Key | Meaning | Default |
|---|---|---|
| `format` | config format version (§11) | required |
| `carriers` | exact shell version per kind (an npm version of `orz-<x>`/`orz-<x>-browser`); a kind the site does not use may be omitted | required for `check` |
| `delivery` | `cdn` or `inline` for every document | `cdn` (FD-07) |
| `inline` | globs of documents assembled `inline` anyway (e.g. a handout meant to be downloaded and used offline) | `[]` |
| `naming` | output names (§3.3) | `"family"` |
| `baseUrl` | the site's absolute URL, ending in `/`; the CLI's `--base-url` overrides it (route A passes Pages' URL) | none |
| `includes` | §2.5 | as shown |
| `links.missing` | `error` or `warn` for a link to a text that is not built (§4) | `error` |
| `exclude` | globs (§3.6) | `[]` |
| `texts` | also publish each document's text twin as is (`week1.slides.md`), so other sites can include it and readers can read the source **[Q7]** | `true` |
| `index` | the generated index (§5) | as shown |
| `sitemap` | write `sitemap.xml` (needs `baseUrl`) | `true` |
| `notFound` | a document whose output is written as `404.html` instead of its own name (must sit at the root) | `null` |

Per-document delivery is config, not a header key: the text holds author
choices, the delivery is a publishing choice (FC-18 §6), and the family
defines no `x_` key (FC-18 §5).

### 3.3 Naming

`"family"` = FC-18's twins: `x.md` → `x.md.html`, `x.slides.md` →
`x.slides.html`, `x.paged.md` → `x.paged.html`. Otherwise an object of
per-kind **templates**; a kind left out keeps the family name:

```json
"naming": { "md": "{stem}.html" }
```

- `{stem}` is the file name without its text extension (`week1` for
  `week1.slides.md`). A template holds `{stem}` exactly once, otherwise only
  `[A-Za-z0-9._-]`, ends in `.html`, and has no `/`: the folder is kept, so
  every relative asset link of the document still resolves.
- Directory naming (`x/index.html`) is **not** offered: it moves the page one
  folder down and breaks its relative links. **[Q2]** GitHub Pages already
  serves `x.html` at `/x` (verified on a Pages site, S.13, 2026-10-23: `/404`, `/index`, `/slides/week1.slides` serve the `.html`).
- A non-family name drops the dual extension from the published URL; the
  file's identity is then its `#orz-shell` / `data-orz-kind` (FC-08) — see
  K1 in §13 for the "Save as" name.
- The same naming drives the links (§4), the index (§5) and the sitemap.

### 3.4 Collisions (refused, never resolved)

The build is refused (`name-collision`) when two of these want one output
path: a document's output, an asset, a published text (`texts`), the
generated `index.html`, `404.html`, `sitemap.xml`, `orz-site-manifest.json`,
`.nojekyll`. Example: `x.md` and `x.slides.md` under `{stem}.html` for both;
`x.md` → `x.md.html` next to a committed `x.md.html`. Paths that differ only
in letter case are refused too (`case-collision`): Pages is case-sensitive,
the owner's disk is not. The report names every party and the key to change.

### 3.5 Pins

`carriers` pins the shell (FC-18 §8.1: the shell version is the carrier
release). The builder **refuses** a carrier whose `version` differs from the
pin (`shell-mismatch`, `next: npm install orz-<x>@<pin>`). How the pinned
versions get installed is route-specific (§8, §9) **[Q4]**. A naming other
than `"family"` needs carriers with K1 (§13); older pinned carriers are
refused (`naming-unsupported`).

### 3.6 Globs

`*` (not `/`), `**` (any depth), `?`, matched against site paths; a pattern
ending in `/` means the folder and everything under it. No negation, no
braces. **[unsure: pick an existing tiny matcher or write one — the output
must not depend on its version]**

### 3.7 Reproducibility

The same file map, config, `baseUrl` and orz-site version, with the same
carrier versions, give **byte-identical output files and report** — in Node
and the browser, on any OS, any clock, any locale (for network includes:
given the same fetched bytes). orz-site uses no clock, randomness,
environment, absolute paths or locale-dependent comparison: paths sort by
UTF-16 code units; JSON is written with sorted keys, two-space indents and a
final LF.

## 4. Links

### 4.1 What happens to a link

| Link in a text (Markdown `[ ](…)`, not images) | In the built site |
|---|---|
| relative or root-relative path to a text (`week2.slides.md`, `../notes.md#part`, `?q` kept) | the target's output name under the site's naming (family: `week2.slides.html`, `../notes.md.html#part`; with `"md": "{stem}.html"`: `../notes.html#part`); fragment and query kept |
| relative path to an asset (`data.csv`, `img/a.png`) | untouched; the asset is copied |
| absolute URL, `//host`, `#frag`, `?q`, `mailto:` | untouched |
| raw-HTML `<a href="x.md">` | untouched (as FC-18 §8.3); warning `raw-twin-link` |

The text never changes; only the rendered `href` does (FC-18 §8.3). Links
inside included content render in the including page and follow the same
rule. The **link check** reads each document's links with the pinned
carrier's own parser (K2) and resolves them against the file map:

- a link to a text that is not a built document (missing, excluded, skipped
  as empty, outside the root) → `missing-link` (`links.missing`);
- a link to a missing asset → warning `missing-asset`;
- a root-relative link (`/x.md`) when `baseUrl` has a path (a project site,
  `/course/`) → warning `root-relative` (it resolves against the host root,
  not the site);
- an upper-case text extension (`X.MD`) → warning `case-link` (not
  rewritten by the kit);
- fragments are **not** checked in 0.1 (heading ids come from the renderer)
  **[unsure: worth adding through the carriers' render later]**.

### 4.2 Where the rewrite happens

**The rewrite happens when the page renders, not in the file's bytes.** An
assembled file holds the text in `#orz-src`; the engine renders it in the
reader's browser, and the kit's `orz_twin_links` rule (env
`orzTwinLinks: true`, `twinHref`) rewrites `.md` hrefs there to the family
names. So whatever names the site uses must reach that rule, in the file.

**Option A — a naming option in the kit (recommended, [Q1]).** `assemble(text,
{ delivery, includes, twinLinks })` takes the naming (§3.3's templates,
JSON); the envelope stores it in `#orz-shell` (`"links": {…}`), written only
when it is not the family naming, so every existing file's bytes stay as
they are; `extract` returns it; the runtime renders with
`env.orzTwinLinks = <naming>`; `twinHref(href, naming?)` is the one mapping
for the file, the editor preview, an app's preview (FC-19 option) and
orz-site's link check — preview and output agree by construction.

- *FC-18 law 1 (round trip):* untouched — the text is not changed.
- *Law 2 (determinism):* the naming is part of the options `o`;
  `assemble(T, s, o)` stays byte-identical. Two namings give two files that
  differ only in `#orz-shell`.
- *Law 3 (idempotence) and every re-assembly:* the option must be carried
  over exactly, as `includes` already is — the in-file save
  (StandaloneContext `assemble`), the quiet update (`reassemble` passes it,
  and the round-trip check gains a `links` code), and **verify.html**, which
  today re-assembles with `{ delivery, includes }` from `extract` and would
  otherwise report "Not what the published package assembles".
- Cost: a kit minor, then a minor of each carrier (§13).

**Option B — orz-site post-processes assembled HTML (rejected).** There is
no rendered `<a>` in the file to rewrite. The only places are (i) the text
island — that changes the document (the published text would differ from
the repository's; `extract` of the page no longer equals the input; a
reader's "Save" writes `.html` links into their text), or (ii) an injected
script or attribute — then the file is no longer `assemble(T, s, o)`:
verify.html reports a mismatch, and the first in-file save or quiet update
re-assembles the file and silently drops the injection. B is not fragile but
impossible without breaking FC-18.

**Option C — family naming only (fallback).** orz-site 0.1 can ship before
K1 with `naming: "family"` only; D-113 stays open until K1.

## 5. Index, sitemap, 404

- **Index** (`index.mode`): `auto` (default) writes `index.html` when no
  document's output is `index.html`; `on` always (a document wanting
  `index.html` is then a `name-collision`); `off` never. The index is **an
  orz `md` document**, generated as text and assembled by the pinned
  orz-mdhtml with the site's delivery and naming — themed by the kit, a
  self-editing file like every page, no template code of orz-site's own
  **[Q10]**. Its text:

  ```markdown
  {{nyml
  kind: document
  title: <index.title, else "Contents">
  lang: <index.lang>
  theme: <index.theme, omitted when null>
  }}

  # <title>

  ## <folder, omitted for the root>

  - [<document title>](<path relative to the root, as a .md link>) — <kind> · <date>
    <description>
  ```

  Entries are the built documents (not `notFound`, not assets), grouped by
  folder, sorted by site path; `kind` is shown only for `slides`/`paged`;
  `date` and `description` only when the header has them. Titles and
  descriptions are escaped (every ASCII punctuation backslash-escaped, line
  breaks as spaces) so a title cannot open a directive, a link or a block
  **[unsure: confirm the kit's `{{` directives respect backslash escapes;
  claim S.12 tests it]**. The links are `.md` links, so the page's own twin
  rule maps them; `twinLinks` naming applies. The index's text is in the
  manifest (it has no input file); with `texts: true` it is published as
  `index.md` unless that name is taken (then not published).
- **Sitemap** (`sitemap`): `sitemap.xml`, one `<url>` per built page and
  the index, `<loc>` = `baseUrl` + the output path (percent-encoded per
  segment), `<lastmod>` = the header `date` when it is an ISO date
  (`YYYY-MM-DD`), else none (no clock). No `baseUrl` → no sitemap, warning
  `no-base-url`.
- **404** (`notFound`): that document's output is `404.html`. Otherwise no
  404 page (Pages shows its own).
- **`.nojekyll`** is always written (route B publishes from a branch, where
  Pages would otherwise run Jekyll and drop `_`-prefixed files).

## 6. Output

```
<out>/
  .nojekyll
  index.html                  generated (§5), when on
  sitemap.xml                 when baseUrl
  orz-site-manifest.json      §6.1
  week1.slides.html           documents, in their folders, by the naming
  week1.slides.md             text twins, when texts: true
  notes/intro.md.html
  img/cell.png                assets, byte for byte, same paths
```

The output folder mirrors the input tree. The CLI writes into a sibling
temporary folder and renames it over `<out>` at the end; an existing `<out>`
without an `orz-site-manifest.json` is refused (`out-not-site`), so the
build never deletes a folder it did not make.

### 6.1 Manifest

`orz-site-manifest.json` (published with the site **[Q7]**), deterministic
(§3.7):

```json
{
  "format": 1,
  "generator": "orz-site 0.1.0",
  "config": { "sha256": "…" },
  "baseUrl": "https://owner.github.io/course/",
  "carriers": { "md": { "version": "1.1.0" }, "slides": { "version": "1.1.0" } },
  "naming": "family",
  "documents": [
    { "path": "week1.slides.md", "sha256": "…", "kind": "slides", "output": "week1.slides.html",
      "outputSha256": "…", "delivery": "cdn", "title": "…", "uid": "doc-…",
      "includes": [ { "target": "shared/a.md", "from": "file", "sha256": "…" } ],
      "key": "…" }
  ],
  "assets": [ { "path": "img/cell.png", "sha256": "…" } ],
  "generated": [ { "path": "index.html", "sha256": "…", "text": "index.md" } ],
  "skipped": [ { "path": "drafts/x.md", "reason": "excluded" } ]
}
```

- `key` = SHA-256 of (orz-site version, kind, carrier version, delivery,
  naming, text SHA-256, the include record's SHA-256). **Incremental
  build:** given the previous manifest and output (`buildSite(…, { previous
  })`, CLI `--incremental`), a document whose `key` is unchanged reuses its
  output bytes; the result is identical to a full build (claim S.4). A
  SHOULD: assembly is fast, and route A starts from nothing unless the
  workflow caches `<out>`.
- For a host (Alembic): which text became which page, with which shell; the
  `uid`s; what was skipped and why.

## 7. API

### 7.1 Library (one core, Node and browser)

```ts
buildSite(files: SiteFiles, config: SiteConfig, env?: BuildEnv): Promise<BuildResult>
checkSite(files: SiteFiles, config: SiteConfig, env?: BuildEnv): Promise<Report>   // = buildSite without outputs

type SiteFiles = ReadonlyMap<string, Uint8Array>;          // §2.1
interface BuildEnv {
  carriers?: Partial<Record<'md' | 'slides' | 'paged', CarrierModule>>; // browser: required; Node: default = the installed packages
  fetch?: (url: string) => Promise<Uint8Array | null>;     // network includes (§2.5); default: global fetch, redirect "error"
  baseUrl?: string;                                         // overrides config.baseUrl
  offline?: boolean;
  previous?: { manifest: Manifest; files: SiteFiles };      // incremental (§6.1)
}
interface CarrierModule {                                   // the surface every orz-<x> and orz-<x>-browser already has
  kind: 'md' | 'slides' | 'paged'; version: string; formats: readonly number[];
  assemble(text: string, o: { delivery: 'inline' | 'cdn'; includes?: Record<string, string>; twinLinks?: Naming }): string | Promise<string>;
  extract(html: string): Extracted | null;
  readDocument(text: string, o?: { filename?: string }): DocumentInfo;
  includeTargets?(text: string): string[];                  // K2
  linkTargets?(text: string): LinkRef[];                    // K2
}
interface BuildResult { ok: boolean; files: Map<string, Uint8Array>; manifest: Manifest; report: Report }
```

- The core imports nothing from Node and reads no global state; a refused
  build returns `ok: false`, the report, and **no** files (never a partial
  site).
- Node only: `readSiteFolder(dir, config)`, `writeSite(out, result)`,
  `loadCarriers(config)` (imports the installed `orz-mdhtml`, `orz-slides`,
  `orz-paged`; refuses mismatching pins). Entry `orz-site/node`; the main
  entry is browser-safe.
- Inline delivery in the browser needs the engine text: the app's carrier
  module supplies it (the IIFE bundle has it; the ESM fetches it from
  jsDelivr, FC-19 §2).

### 7.2 Report

```ts
interface Report { ok: boolean; errors: Finding[]; warnings: Finding[]; documents: number; assets: number; outputs: number }
interface Finding { code: string; message: string; path?: string; line?: number; target?: string; next?: Next }
```

Findings sorted by path, line, code. Codes (new ones may be added, none
renamed): `bad-config`, `unknown-key`, `newer-config`, `no-config`,
`shell-mismatch`, `naming-unsupported`, `name-collision`,
`case-collision`, `not-utf8`, `invalid-text`, `newer-format`,
`carrier-mismatch`, `empty-text`, `assembled-input`, `legacy-file`,
`missing-link`, `missing-asset`, `raw-twin-link`, `root-relative`,
`case-link`, `include-missing`, `include-host`, `include-network`,
`include-too-large`, `include-key-clash`, `include-own-output`,
`outside-root`, `symlink-out`, `too-large`, `too-many-files`,
`no-base-url`, `out-not-site`, `workflow-drift`, `exists`, `write-failed`.

### 7.3 CLI

```
orz-site build [dir] [-o out] [--base-url u] [--offline] [--incremental] [--json]
orz-site check [dir] [--offline] [--json]
orz-site init  [dir] [--github] [--json]
```

- `build`: `dir` defaults to `.`, `out` to `_site` (auto-excluded). Exit 0
  done (warnings allowed), 1 refused, 2 usage — the carriers' codes.
- `check`: everything `build` checks, writing nothing; also red for a
  missing config, for pins that differ from the installed carriers, and for
  a workflow whose install line differs from the config (`workflow-drift`).
- `init`: writes `orz-site.json` with the installed carriers' versions as
  pins and the defaults; `--github` also writes
  `.github/workflows/orz-site.yml` (§8). An existing file is never
  overwritten (`exists`); when it differs only in orz-site's own lines
  (versions) the `next` is `orz-site init --github --update` **[unsure:
  is `--update` worth it in 0.1, or just tell the user to delete the file]**.
- `--json`: `{ ok: true, command, …, warnings }` /
  `{ ok: false, command, error, reason, next?, exitCode }` with
  `next = { command, args }` runnable verbatim, never `--force` — the
  carriers' shape (carrier-node §2). `reason` is the first error's code.

## 8. Route A — GitHub Actions and Pages (default)

`orz-site init --github` writes this (versions filled from the config and
the running orz-site; Pages source must be "GitHub Actions"):

```yaml
# Written by orz-site 0.1.0 (orz-site init --github). The versions below
# must match orz-site.json; `orz-site check` reports a difference.
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
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - uses: actions/cache@v6
        with:
          path: ~/.npm
          key: orz-site-${{ hashFiles('orz-site.json') }}
      - id: pages
        uses: actions/configure-pages@v6
      - name: Install orz-site and the pinned carriers
        run: >
          npm install --prefix "$RUNNER_TEMP/orz" --no-save --no-package-lock
          --ignore-scripts --no-audit --no-fund
          orz-site@0.1.0 orz-mdhtml@1.1.0 orz-slides@1.1.0 orz-paged@1.1.0
      - name: Build
        run: >
          "$RUNNER_TEMP/orz/node_modules/.bin/orz-site" build .
          -o "$RUNNER_TEMP/site" --base-url "${{ steps.pages.outputs.base_url }}/"
      - uses: actions/upload-pages-artifact@v5
        with:
          path: ${{ runner.temp }}/site
          include-hidden-files: true
  deploy:
    needs: build
    runs-on: ubuntu-24.04
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

- Built files are a Pages artifact only — never committed, never in the
  checkout (`--prefix` and `-o` under `$RUNNER_TEMP`).
- Pins: orz-site and each carrier at exact versions; Node at the major
  (output does not depend on the Node patch, S.2); actions at major tags
  **[Q4 covers whether actions are pinned by commit SHA]** — the majors
  current on 2026-10-24, all on GitHub's Node 24 runtime (STATUS D-122; S.13
  ran with the older Node 20 majors). `upload-pages-artifact` ≥ v4 leaves
  dot files out by default; `include-hidden-files: true` keeps `.nojekyll`,
  so the artifact still equals a local build. A shell update
  is "edit the pin in `orz-site.json`, run `orz-site init --github
  --update`" — one commit.
- `configure-pages`' `base_url` has no trailing `/` (verified, S.13, 2026-10-23: the build with `${base_url}/` equals a local build with one `/`),
  hence the `/`.
- A repository with its own `package.json` may instead add orz-site and the
  carriers as dev dependencies and let its lockfile pin them; `check` then
  compares the lockfile **[unsure: 0.1 or later]**.

## 9. Route B — an app builds in the browser and commits

The app (not orz-site) does:

1. Read `orz-site.json` and the site's files (its own storage or the
   repository's default branch), leaving out what must not be published.
2. Import each pinned carrier: `import('https://cdn.jsdelivr.net/npm/orz-<x>-browser@<pin>/esm/orz-<x>.browser.mjs')`
   (CSP: `script-src` and `connect-src https://cdn.jsdelivr.net`). The pin
   is the config's — the app's own editor component version does not
   matter; files carry their own shells (REBUILD §7.8). `buildSite` refuses
   a module whose `version` is not the pin (S.6). **[unsure: the ESM has
   no SRI in `release.json` (only the IIFE bundle has a SHA-384); an app
   that wants integrity fetches the IIFE, checks it, and runs it in a
   sandboxed frame like the quiet update — heavier]**
3. `buildSite(files, config, { carriers, fetch, baseUrl })` — `fetch` is
   the app's (CORS applies to network includes in a browser).
4. Commit `result.files` as **one** commit to the publishing branch (e.g.
   `gh-pages`, Pages source "Deploy from a branch"): one tree, binary files
   as base64 blobs. Because the output is deterministic, the app may skip
   the commit when the tree hash is unchanged. Route A and B must not both
   publish one site (Pages has one source).

Route A and route B on the same commit and config give the same files
(S.2, S.13).

## 10. Security and trust

Texts and includes are **trusted** (FD-07; orz-markdown M.21): orz-site
does not sanitize documents beyond what the carriers do, and the isolation
checks below guard against accidents, not hostile authors. It refuses:

- a site path that is absolute, has `..`, `\`, NUL, or is not valid UTF-8
  (`outside-root`);
- (Node) a symbolic link whose real path leaves the root (`symlink-out`);
  links inside the root are followed; a cycle is refused;
- a text over 5 000 000 characters, an asset over 100 MB (GitHub's file
  limit), more than 20 000 files, a total over 1 GB (Pages' limit)
  (`too-large`, `too-many-files`) **[unsure: limits are guesses; keep them
  configurable?]**;
- a URL include outside `allowedHosts` and the own host; any redirect;
  anything but `https:` (`include-host`);
- writing outside `<out>`, or into an `<out>` it did not make (§6).

It never executes document content; it never reads `.secrets`-like dot
paths (excluded, §2.2); it never pushes or publishes.

## 11. Versioning

- **0.1.0** first (REBUILD Phase 4 step 9); **1.0.0** once Alembic's
  Phase 5 has built a real site with it. Pre-1.0: minor for a new capability
  or behaviour change, patch for fixes (RULES §4.1). One package, no
  `-browser` twin: the main entry is the browser ESM (no bundled
  carriers; the app passes them), `orz-site/node` the Node adapter and CLI
  **[unsure: does route B want a single-file IIFE too?]**.
- **Config format** `format: 1`, independent of the package version. A new
  optional key is added in a minor release (an older orz-site refuses it as
  `unknown-key`, with `next` naming the release that knows it); changing a
  key's meaning is format 2, and orz-site reads every older format.
- **Manifest format** `format: 1`, same rules.
- **Carriers:** peer dependencies `orz-mdhtml`, `orz-slides`, `orz-paged`
  `^1.1.0` (K1; `^1.0.0` if 0.1 ships with family naming only, §4.2 C).

## 12. Claims (S.*; family root `notes/PHASE4-CLAIMS.md`)

Each is a test that fails when the claim does not hold.

| Id | Claim |
|---|---|
| S.1 | **Determinism:** building the fixture site twice — and with the file map in another insertion order, another `TZ`, `LANG` and clock — gives byte-identical files, manifest and report. |
| S.2 | **Node = browser:** the fixture built by the CLI (Node 20 and 22) and by `buildSite` in Chrome with the `-browser` ESM of the same pins gives identical bytes. |
| S.3 | **No text lost:** for every built document, `extract(output).text === storedText(input)`; with `texts: true` the published twin equals the input bytes. |
| S.4 | **Incremental = full:** after any single-file change, an incremental build equals a full build. |
| S.5 | **Every rewritten link resolves:** for every link the check accepts, `twinHref(href, naming)` resolved against the page's URL names a file in the output; a probe link to each kind of missing target yields `missing-link` (error by default). |
| S.6 | **Pins:** a carrier whose `version` differs from the config is refused (`shell-mismatch`); every output's `#orz-shell` names the pinned version and the configured delivery (`inline` globs honoured). |
| S.7 | **Collisions refused:** each pair in §3.4 (and a case-only pair) is refused with both paths named; no output is written. |
| S.8 | **Includes per allowlist:** own-host URLs are read from the map with no network call; an allowed host is fetched once; a disallowed host, a redirect, `http:`, an oversize body and `--offline` are refused with their codes; each record equals what the carrier's own CLI would store for file includes. |
| S.9 | **Confinement:** `..`, absolute paths, a symlink out of the root, and a file include leaving the root are refused; nothing outside `<out>` is written. |
| S.10 | **Excludes:** dot paths, `node_modules/`, `*~`, the config, `<out>` and configured globs never reach the output. |
| S.11 | **Reports:** every refusal has a stable `code`, and every `next` run verbatim moves the build forward (no `--force`); `--json` matches the carriers' shape. |
| S.12 | **Index:** titles containing Markdown, `{{`, `<script>` and line breaks appear as text; every index link resolves (S.5); the index extracts to its manifest text. |
| S.13 | **Route A:** in a throwaway GitHub repository, the workflow written by `init --github` deploys, the deployed files equal a local `orz-site build` of the same commit, and nothing is committed. |
| S.14 | **Naming (with K1):** under `{ "md": "{stem}.html" }` the published page's rendered links (in Chrome) and the editor preview's links point at the same existing files; a default-naming build's outputs are byte-identical to the carriers' `assemble` without the option. |
| S.15 | **verify (with K1):** verify.html reports "Reproduced byte for byte" for a page built with a non-family naming. |

## 13. What the kit and carriers must add

In owner order (RULES §3): kit → carriers → orz-site.

**K1 · Twin-link naming** (FC-18 §8.2/§8.3 minor revision; FC-19 §2/§3;
shell-runtime §7.2; carrier-app §2/§3.2; website verify.html). Kit 2.5.0
**[unsure: version]**:

- `type TwinNaming = { md?: string; slides?: string; paged?: string }`
  (templates as §3.3, validated by the kit); `twinHref(href, naming?)`;
  `env.orzTwinLinks: true | TwinNaming`.
- `assembleEnvelope`/`assemble(text, { …, twinLinks })` writes
  `"links"` into `#orz-shell` only when it differs from the family naming;
  `extract(html).twinLinks`; `readOpenedFile` reads it; StandaloneContext's
  `assemble`, `reassemble` (and its round-trip check, new code `links`) and
  verify.html's re-assembly carry it over exactly, as `includes`.
- The runtime and every preview render with it; FC-19 `EditorOptions`
  gains `twinLinks?: TwinNaming` so an app's preview shows its own names
  (`hooks.resolveLink` keeps working for clicks).
- `readOpenedFile`'s `fileName` for a page whose name is not dual
  (`week1.html`): invert the naming (`week1.md.html`) instead of
  `document.md.html`.
- Closes STATUS **D-113**: the Studio passes its naming to `assemble` and
  `mountEditor`; a pattern rather than a function, because the file must
  carry it to the reader's browser and to verify.html (a function cannot be
  stored).

**K2 · Parser-based targets, browser-safe.** `includeTargets(text)` is
Node-only today (`orz-markdown/carrier/node`, though it uses nothing of
Node); move it to `orz-markdown/carrier`, and add `linkTargets(text) →
{ href, line, kind: 'twin' | 'asset' | 'other', raw: boolean }[]` (Markdown
links and images as the renderer sees them, raw-HTML `<a>` flagged). Each
carrier re-exports both from its own bundled kit (Node lib and `-browser`)
so orz-site parses with the pinned carrier's kit — the same parse as the
page.

**C1 · Carriers 1.1.0** (orz-mdhtml, orz-slides, orz-paged, each with its
`-browser`): pass `twinLinks` through `assemble`, `renderPreview`,
`mountEditor` and every render path that sets `orzTwinLinks` (mdhtml
`md/render`; slides `present/render`, the editor, `flat`; paged
`render-paged`); re-export K2. No carrier learns of orz-site.

**Not needed by orz-site:** D-111 (browser `extract` of 0.x files — orz-site
never reads assembled files; it matters only if route B is to upgrade old
files) and D-112 (orz-site refuses legacy deck texts by lint, §2.3); both
remain worth fixing for apps. D-115 is avoided by excluding `*~` (§2.2).

**FC-20 · Site config and output** (new CONTRACTS row): owner
`orz-site/spec/site.md` + `orz-site/schema/site-1.json`; shape: the config
(§3), the output layout and manifest (§6), the report codes (§7.2);
implementers: orz-site; consumers: Alembic (Phase 5), coursewerk (if it
ever publishes), the GitHub workflow template. FC-08 gains a note: a site
may publish an assembled file under a non-dual name; its identity is then
`#orz-shell`. FC-18's row "Sites (FD-07)" points to FC-20.
