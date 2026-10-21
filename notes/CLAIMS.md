# orz-site claims (S.*)

The claims of [spec/site.md §12](../spec/site.md), each bound to tests whose
titles carry its id (`[S.n] …`). Family plan: REBUILD.md §3 Phase 4 step 9;
the family root's `notes/PHASE4-CLAIMS.md` names this file for the S.* claims.

```bash
npm test                 # main (no browser), then chrome (real Chrome via playwright-core, channel 'chrome')
npm run test:fast        # main only
```

The Chrome files skip themselves without an installed Chrome; such a run does
not verify the claims marked "Chrome". `tests/verify.test.ts` needs the
network (the live verify.html and jsDelivr).

## Claims

| Id | Claim | Bound by | Result (2026-10-21) |
|---|---|---|---|
| S.1 | **Determinism:** the fixture built twice, with the file map in another insertion order, in another `TZ`, `LANG` and clock, gives byte-identical files, manifest and report. | `build.test.ts` [S.1] ×2 (the second runs two child processes: `TZ=Pacific/Kiritimati LANG=tr_TR.UTF-8` with the clock at 2001, `TZ=America/Los_Angeles LANG=ja_JP.UTF-8` at 2049, `tests/clock.mjs`) | ✅ — Node 22.17 only; "Node 20 and 22" is not run here (one Node installed) |
| S.2 | **Node = browser:** the CLI and `buildSite` in Chrome with the `-browser` ESM of the same pins give identical bytes. | — | ⏸ **pending K2**: before K2 the include targets come from the kit's Node entry (`orz-markdown/carrier/node`), and the carriers' `-browser` ESM do not export `includeTargets`/`linkTargets`; the main entry is already free of Node imports (`package.test.ts`) |
| S.3 | **No text lost:** `extract(output).text === storedText(input)` for every page (and the index = its manifest text); published twins equal the input bytes. | `build.test.ts` [S.3] | ✅ 7 documents + the index |
| S.4 | **Incremental = full:** after a single-file change (a text, an included partial, an asset) an incremental build equals a full build and re-assembles only what changed; a tampered previous output is not reused; the CLI's `--incremental` too. | `build.test.ts` [S.4] ×2, `node.test.ts` [S.4] | ✅ |
| S.5 | **Every rewritten link resolves:** every link the check accepts, `twinHref` against the page, names a file of the output (also in included content and the index); in Chrome, every rendered same-site link of every page names a file of the output and following links works; a probe link to each kind of missing target (missing, excluded, empty, outside the root, a missing slides twin) is `missing-link`, an error by default and a warning with `links.missing: "warn"`. | `build.test.ts` [S.5] (1 + 8 probes), `chrome.test.ts` [S.5] (Chrome) | ✅ fixture in Chrome: 24 rendered same-site links on 8 pages (index 6, home 7, lessons 3+2+2, deck 2, handout 1, 404 1), all resolve |
| S.6 | **Pins:** a carrier whose `version` differs from the pin is refused (`shell-mismatch`, `next: npm install orz-<x>@<pin>`); every output's `#orz-shell` names the pinned version and the configured delivery (`inline` globs honoured). | `build.test.ts` [S.6] ×4 | ✅ |
| S.7 | **Collisions refused:** page vs committed assembled file, `index.html` vs the index, `sitemap.xml`, the manifest name, `404.html`, a case-only pair, a file vs a folder — each refused with every party named and no output. | `build.test.ts` [S.7] ×8 | ✅ |
| S.8 | **Includes per allowlist:** own-host URLs from the map with no network call; an allowed host fetched once per build (nested includes recorded under their own URLs); a disallowed host, `http:`, a redirect, an oversize body, a 404, a server error, `network: false`, `--offline` and a timeout refused with their codes; the file-include record equals the kit's `resolveFileIncludes` (what the carriers' CLI stores); `include-key-clash` checked against the kit's `includeRecordEnv`. | `includes.test.ts` [S.8] ×14 (a local HTTP server behind the default fetcher) | ✅ |
| S.9 | **Confinement:** `..`, absolute, backslash and NUL paths refused (`outside-root`); a symlink out of the root and a symlink cycle refused (`symlink-out`), links inside followed; a file include leaving the root refused; nothing is written outside `<out>`, into a folder orz-site did not make, or over the site itself. | `node.test.ts` [S.9] ×4, `includes.test.ts` (outside-root) | ✅ |
| S.10 | **Excludes:** dot paths, `node_modules/`, `*~`, the config, `<out>` and configured globs never reach the output (map and folder); an excluded partial stays an include source (Q9). | `build.test.ts` [S.10] ×2, `node.test.ts` [S.10] | ✅ |
| S.11 | **Reports:** every finding has a known code; `--json` has the carriers' shape (`ok`, `command`, `error`, `reason` = the first error's code, `next?`, `exitCode`; exit 0/1/2); every `next` run verbatim moves the build forward: no config → `orz-site init`; a 0.x deck → `orz-slides upgrade slides/old.slides.md` (its `~` backup is then excluded); drift → `orz-site init . --github --update`. | `node.test.ts` [S.11] ×6, `config.test.ts` [S.11] ×7 | ✅ — `npm install orz-<x>@<pin>` (shell-mismatch, no-carrier) is checked for shape only, not run |
| S.12 | **Index:** titles and descriptions holding Markdown, `{{md …}}`, `<script>`, `<img onerror>` and line breaks appear as text in Chrome (no script runs, no include resolves, no "Included file not available" note); every index link resolves; the index extracts to its manifest text. | `chrome.test.ts` [S.12] (Chrome), `build.test.ts` [S.3], [S.5] | ✅ — answers the spec's [unsure]: the kit's `{{` directives respect backslash escapes |
| S.13 | **Route A:** in a throwaway GitHub repository the workflow written by `init --github` deploys, the deployed files equal a local `orz-site build` of the same commit, and nothing built is committed. | — | ⏸ **pending the owner** (a GitHub repository and Pages; the steps below) |
| S.14 | **Naming (with K1):** under `{ "md": "{stem}.html" }` the published page's rendered links and the editor preview's point at the same files; a default-naming build's outputs are byte-identical to the carriers' `assemble` without the option. | `build.test.ts` [S.14, family-naming half] | ◐ the family-naming half ✅ (every page = the carrier's own `assemble(text, { delivery, includes })`); the naming half ⏸ **pending K1** |
| S.15 | **verify:** verify.html reports "Reproduced byte for byte" for built pages. | `verify.test.ts` [S.15, family naming] ×7 (Chrome; the live https://markdown.orz.how/verify.html) | ◐ family naming ✅ for all 7 kinds of page (md with a file include, md with an own-host URL include, a deck, an inline paged handout, 404, the generated index, the course home); a non-family naming ⏸ **pending K1** |

Run of 2026-10-21 (macOS, Node 22.17.0, Chrome, orz-mdhtml 1.0.2, orz-slides
1.0.0, orz-paged 1.0.0, orz-markdown 2.4.0, all from npm): **7 files, 91
tests passed** (config 12, build 39, includes 14, node 14, package 3,
chrome 2, verify 7), 183 s.

## S.13 — the steps (owner)

Route A needs a real GitHub repository with Pages, so it waits for the owner.
orz-site must be installable by the workflow: either publish 0.1.0 first, or
run the test with a tarball (option b).

1. Create a throwaway public repository, e.g. `orz-site-route-a`, with
   Settings → Pages → Source: **GitHub Actions**.
2. Copy `fixtures/course/*` into its root (not the folder itself). Replace
   `https://owner.github.io/bio101/` with the repository's Pages URL
   (`https://<owner>.github.io/orz-site-route-a/`) in `orz-site.json`
   (`baseUrl`) and in `lessons/03-energy.md` (the own-host include): the
   workflow passes the real Pages URL as `--base-url`, and an include on any
   other host is refused (`include-host`). Then in it:
   `npx orz-site init . --github` (keeps the fixture's `orz-site.json`, writes
   `.github/workflows/orz-site.yml`), commit, `git push -u origin main`.
   - (b) before publishing: `npm pack` in orz-site, commit
     `orz-site-0.1.0.tgz` to the throwaway repository, and in the workflow's
     install line replace `orz-site@0.1.0` with `./orz-site-0.1.0.tgz`
     (then `orz-site check` there is still green: it compares the carrier
     pins only).
3. Wait for the "Publish site" run to finish green (`gh run watch`).
4. Locally, on the same commit: `orz-site build . -o /tmp/local
   --base-url https://<owner>.github.io/orz-site-route-a/`.
5. Compare: `gh run download <run-id> -n github-pages` (a `artifact.tar`),
   unpack it, and `diff -r` against `/tmp/local` — expect no difference; also
   fetch three pages from `https://<owner>.github.io/orz-site-route-a/` and
   compare them with `/tmp/local`.
6. `git ls-files` in the repository lists no `*.html`, no
   `orz-site-manifest.json`: nothing built is committed.
7. Record the result here (✅ with the repository, run id and date), and
   check the spec's [unsure] notes: whether `configure-pages`' `base_url` has
   no trailing `/`, and whether Pages serves `x.html` at `/x`.
8. Delete the throwaway repository.

## Not claims, but checked by hand (2026-10-21)

The fixture course (`fixtures/course/`: a home `index.md` with a file
include, three lessons with links, math, a mermaid diagram and an own-host
URL include, a deck, an inline paged handout, an SVG and a CSV, a `404.md`,
excluded `drafts/` and `shared/`) builds to 20 files (7 pages, 7 texts, the
generated index, 2 assets, `sitemap.xml`, `.nojekyll`, the manifest), no
error and no warning. Served under `/bio101/` and opened in Chrome: the index,
the home, lessons 1–3, the deck, the handout and the 404 page render; their
screenshots were read (links show as `.md.html`/`.slides.html`/`.paged.html`
names, the partial and the own-host glossary render inside the pages).
