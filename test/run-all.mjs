import { spawn } from 'node:child_process';
import path from 'node:path';

import { fixturesDir } from './lib.mjs';

// Order matters: queue.mjs needs no fixture and runs first, and
// make-fixtures.mjs builds the MKVs every suite below it reads.
const suites = [
  ['queue.mjs', []],
  ['make-fixtures.mjs', []],
  ['remux.mjs', [path.join(fixturesDir, 'movie.mkv'), '6']],
  ['remux.mjs', [path.join(fixturesDir, 'tiny.mkv'), '2']],
  ['remux.mjs', [path.join(fixturesDir, 'sparse.mkv'), '4']],
  ['remux.mjs', [path.join(fixturesDir, 'codecs.mkv'), '4']],
  ['remux.mjs', [path.join(fixturesDir, 'movie.mkv'), '2']],
  ['audio-window.mjs', []],
  ['abort.mjs', []],
  ['piece-cache.mjs', []],
  ['e2e.mjs', []],
  ['multi.mjs', []],
  ['concurrency.mjs', []],
  ['peers.mjs', []],
  ['tail-hedge.mjs', []],
  ['peer-churn.mjs', []],
  ['corrupt-peers.mjs', []],
  ['piece-reuse.mjs', []],
  ['cache-budget.mjs', []],
  ['warm.mjs', []],
];

let failed = 0;
for (const [script, args] of suites) {
  const code = await new Promise((resolve) => {
    spawn(process.execPath, [path.join(import.meta.dirname, script), ...args], {
      stdio: 'inherit',
    }).once('exit', resolve);
  });
  if (code !== 0) {
    failed++;
    console.log(
      `\n!! ${script} ${args.map((a) => path.basename(a)).join(' ')} exited with ${code}`,
    );
  }
}

console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
