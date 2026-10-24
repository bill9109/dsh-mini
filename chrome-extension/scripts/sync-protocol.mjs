#!/usr/bin/env node
/**
 * The v2 edit protocol has ONE source of truth: src/shared/edit-protocol.cjs.
 * The browser build needs a copy it can load with a plain <script>, and a hand-maintained second
 * copy drifts silently - which for a validation contract means the Host and the page would start
 * enforcing different rules. `npm run sync:protocol` regenerates the copy; `--check` (run by
 * npm run check) fails the build if the two ever differ.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(here, '..', 'src', 'shared', 'edit-protocol.cjs');
const target = join(here, 'src', 'edit-protocol.js');
const canonical = readFileSync(source, 'utf8');
const current = (() => { try { return readFileSync(target, 'utf8'); } catch { return null; } })();
if (process.argv.includes('--check')) {
  if (current === canonical) { console.log('OK: edit-protocol.js matches its single source of truth'); process.exit(0); }
  console.error('✗ src/edit-protocol.js differs from src/shared/edit-protocol.cjs');
  console.error('  Run: npm run sync:protocol');
  process.exit(1);
}
writeFileSync(target, canonical);
console.log('edit-protocol.js regenerated from ' + source);