// Run by the S.1 test in a child process (another TZ, LANG and clock): builds the course fixture and prints a digest of every output byte and the report.
import { createHash } from 'node:crypto';
import { buildSite } from '../src/build.js';
import { env, FIXTURE, readFolder } from './helpers.js';

const { files, config } = readFolder(FIXTURE);
const r = await buildSite(files, config, await env());
const h = createHash('sha256');
for (const [p, b] of r.files) { h.update(p); h.update('\0'); h.update(b); h.update('\0'); }
h.update(JSON.stringify(r.report));
process.stdout.write(`${h.digest('hex')}\n`);
