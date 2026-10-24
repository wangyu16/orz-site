/**
 * The types of orz-site's library (spec/site.md §7). Browser-safe: no Node
 * types are used anywhere in the core.
 */

/** A document kind (FC-18 §3). */
export type Kind = 'md' | 'slides' | 'paged';
export const KINDS: readonly Kind[] = ['md', 'slides', 'paged'];

/** The input: site path → bytes (spec §2.1). */
export type SiteFiles = ReadonlyMap<string, Uint8Array>;

/** Per-kind output name templates (§3.3); `"family"` = FC-18's twins. */
export type Naming = 'family' | { md?: string; slides?: string; paged?: string };

/** `orz-site.json`, format 1, after validation and defaults (§3.2). */
export interface SiteConfig {
  format: 1;
  carriers: Partial<Record<Kind, string>>;
  delivery: 'cdn' | 'inline';
  inline: string[];
  naming: Naming;
  baseUrl: string | null;
  includes: { allowedHosts: string[]; network: boolean; missing: 'error' | 'warn' };
  links: { missing: 'error' | 'warn' };
  exclude: string[];
  texts: boolean;
  index: { mode: 'auto' | 'on' | 'off'; title: string | null; theme: string | null; lang: string };
  sitemap: boolean;
  notFound: string | null;
}

/**
 * The command that resolves a finding, runnable verbatim (never `--force`):
 * `orz-site <command> <args…>`, or `<tool> <command> <args…>` when `tool` is
 * set (e.g. `npm install orz-slides@1.0.0`). The carriers' shape
 * (carrier-node §2), plus `tool` for a command of another program.
 */
export interface Next { command: string; args: string[]; tool?: string }

/** One finding of a build or check (§7.2). */
export interface Finding {
  code: string;
  message: string;
  path?: string;
  line?: number;
  target?: string;
  next?: Next;
}

/** The report (§7.2): findings sorted by path, line, code. */
export interface Report {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  documents: number;
  assets: number;
  outputs: number;
}

/** What a carrier's `readDocument` gives (the fields orz-site reads). */
export interface DocumentInfo {
  kind: Kind;
  format: number;
  header: { fields: Record<string, string> } | null;
  meta: { title?: string; description?: string; date?: string; uid?: string };
  title: string;
  lint: Array<{ level: 'error' | 'warning'; code: string; message: string; line?: number }>;
}

/** What a carrier's `extract` gives. */
export interface Extracted {
  text: string;
  kind: Kind;
  format: number;
  shell: string;
  delivery: string;
  includes?: Record<string, string>;
  /** The link naming the file carries (kit 2.5.0 `twinLinks`; absent: the family's). */
  twinLinks?: { md?: string; slides?: string; paged?: string } | null;
}

/** One link of a text as the renderer sees it (the kit's `linkTargets`, orz-markdown ≥ 2.5.0; spec §13 K2). */
export interface LinkRef {
  href: string;
  /** 1-based line in the text. */
  line: number;
  /** `twin`: a link the twin rule rewrites; `asset`: another relative path; `other`: a URL, `#frag`, `?q`, `mailto:` … */
  kind: 'twin' | 'asset' | 'other';
  /** A raw-HTML `<a href>` (not rewritten by the twin rule). */
  raw: boolean;
  /** An image (`![](…)`), not a link. */
  image?: boolean;
}

/**
 * The surface of a carrier module orz-site uses (§7.1) — every `orz-<x>` Node
 * library and `orz-<x>-browser` bundle has it. `kind` is supplied by the
 * loader when the module does not name it.
 */
export interface CarrierModule {
  kind: Kind;
  version: string;
  formats: readonly number[];
  assemble(text: string, o: { delivery: 'inline' | 'cdn'; includes?: Record<string, string>; twinLinks?: Naming }): string | Promise<string>;
  extract(html: string): Extracted | null;
  readDocument(text: string, o?: { filename?: string }): DocumentInfo;
  /** K2: the include targets as the carrier's kit parses them. */
  includeTargets?(text: string): string[];
  /** K2: the links as the carrier's kit parses them. */
  linkTargets?(text: string): LinkRef[];
}

/** Fetch a URL for a network include: its bytes, or null (not found). Throw `IncludeFetchError` for a refusal. */
export type IncludeFetch = (url: string) => Promise<Uint8Array | null>;

/** The environment of a build (§7.1). */
export interface BuildEnv {
  carriers?: Partial<Record<Kind, CarrierModule>>;
  /** Network includes (§2.5); default: the global `fetch`, https only, no redirects, 15 s, 5 000 000 characters. */
  fetch?: IncludeFetch;
  /** Overrides `config.baseUrl`. */
  baseUrl?: string;
  offline?: boolean;
  /** Incremental build (§6.1): the previous manifest and output. */
  previous?: { manifest: Manifest; files: SiteFiles };
  /**
   * The include targets of a text, used when a carrier module has no
   * `includeTargets` (carriers before 1.1). Default: the kit's
   * `includeTargets` (`orz-markdown/carrier`, browser-safe since 2.5.0).
   */
  includeTargets?(text: string): string[];
  /** Findings of the host (e.g. the Node adapter's folder read), merged into the report. */
  findings?: { errors?: Finding[]; warnings?: Finding[] };
  /** The output folder's site path when it lies inside the site root (always excluded, §2.2). */
  outDir?: string | null;
  /** The config's raw bytes (for the manifest's `config.sha256`); else its canonical JSON is hashed. */
  configBytes?: Uint8Array;
  /** True when the site has no config file (`no-config`). */
  noConfig?: boolean;
  /** Check mode (§7.3): stricter (missing pins are errors) and no outputs. */
  check?: boolean;
}

export interface ManifestInclude { target: string; from: 'file' | 'own-host' | 'network'; sha256: string }
export interface ManifestDocument {
  path: string;
  sha256: string;
  kind: Kind;
  output: string;
  outputSha256: string;
  delivery: 'inline' | 'cdn';
  title: string;
  uid?: string;
  includes: ManifestInclude[];
  key: string;
}
export interface Manifest {
  format: 1;
  generator: string;
  config: { sha256: string };
  baseUrl: string | null;
  carriers: Partial<Record<Kind, { version: string }>>;
  naming: Naming;
  documents: ManifestDocument[];
  assets: Array<{ path: string; sha256: string }>;
  generated: Array<{ path: string; sha256: string; text?: string; source?: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

export interface BuildResult { ok: boolean; files: Map<string, Uint8Array>; manifest: Manifest; report: Report }
