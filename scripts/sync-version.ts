/** Write package.json's version into src/version.ts (RULES §4.5: the version is read from package.json at build time). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const file = join(root, 'src', 'version.ts');
const want = `/** orz-site's version — generated from package.json by scripts/sync-version.ts (prebuild, pretest). */\nexport const VERSION = '${version}';\n`;
if (readFileSync(file, 'utf8') !== want) { writeFileSync(file, want); console.log(`src/version.ts: ${version}`); }
