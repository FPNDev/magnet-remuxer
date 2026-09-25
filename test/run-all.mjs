// Runs every suite in the order test/README.md fixes: queue first because it
// needs no fixture, make-fixtures next because everything below it reads an
// MKV, then the rest in the table's order. remux.mjs runs five times, each
// with a different fixture and target segment duration.
//
//   node test/run-all.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const fixture = (name) => path.join('test', '.work', 'fixtures', name);

const suites = [
  { name: 'queue', args: [] },
  { name: 'make-fixtures', args: [] },
  {
    name: 'remux',
    args: [fixture('tiny.mkv'), '2'],
    label: 'remux tiny@2s',
  },
  {
    name: 'remux',
    args: [fixture('tiny.mkv'), '4'],
    label: 'remux tiny@4s',
  },
  {
    name: 'remux',
    args: [fixture('movie.mkv'), '2'],
    label: 'remux movie@2s',
  },
  {
    name: 'remux',
    args: [fixture('sparse.mkv'), '2'],
    label: 'remux sparse@2s',
  },
  {
    name: 'remux',
    args: [fixture('codecs.mkv'), '3'],
    label: 'remux codecs@3s',
  },
  { name: 'audio-window', args: [] },
  { name: 'abort', args: [] },
  { name: 'piece-cache', args: [] },
  { name: 'e2e', args: [] },
  { name: 'multi', args: [] },
  { name: 'concurrency', args: [] },
  { name: 'peers', args: [] },
  // { name: 'tail-hedge', args: [] },
  { name: 'cache-budget', args: [] },
  { name: 'warm', args: [] },

  // { name: 'peer-churn', args: [] },
  // { name: 'corrupt-peers', args: [] },
  // { name: 'piece-reuse', args: [] },
];

function run(suite) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, 'test', `${suite.name}.mjs`), ...suite.args],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    child.on('error', (err) => resolve({ ...suite, code: 1, error: err.message, ms: Date.now() - startedAt }));
    child.on('exit', (code) => resolve({ ...suite, code: code ?? 1, ms: Date.now() - startedAt }));
  });
}

const results = [];
for (const suite of suites) {
  console.log(`\n=== ${suite.label ?? suite.name} ===`);
  const result = await run(suite);
  results.push(result);
  const status = result.code === 0 ? 'ok  ' : 'FAIL';
  console.log(`${status} ${suite.label ?? suite.name} (${(result.ms / 1000).toFixed(1)}s)`);
}

const failed = results.filter((result) => result.code !== 0);
const totalSeconds = (results.reduce((sum, result) => sum + result.ms, 0) / 1000).toFixed(1);
console.log(`\n${results.length - failed.length}/${results.length} suites passed in ${totalSeconds}s`);
if (failed.length > 0) {
  console.log(`failed: ${failed.map((result) => result.label ?? result.name).join(', ')}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
