// Shared helpers for the test suites.
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

// Async on purpose: synchronous ffprobe calls would block a seeder running in the same process.
export const execFileAsync = promisify(execFile);

export const root = path.resolve(import.meta.dirname, '..');
export const workDir = path.join(root, 'test', '.work');
export const fixturesDir = path.join(workDir, 'fixtures');
mkdirSync(fixturesDir, { recursive: true });

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE =
  process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg(?=(\.exe)?$)/i, 'ffprobe');

const MAX_BUFFER = 1 << 28;

// ---- reporting ------------------------------------------------------------

let failures = 0;

export function section(title) {
  console.log(`\n== ${title}`);
}

export function check(ok, label, detail = '') {
  if (!ok) {
    failures++;
  }
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`,
  );
  return ok;
}

export const failureCount = () => failures;

export const summarize = (times) => {
  const sorted = [...times].sort((a, b) => a - b);
  return `min=${sorted[0]}ms median=${sorted[Math.floor(sorted.length / 2)]}ms max=${sorted.at(-1)}ms`;
};

// ---- ffmpeg ---------------------------------------------------------------

export const ffmpeg = (args) =>
  execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], {
    maxBuffer: MAX_BUFFER,
  });

export const ffprobe = async (args) =>
  (
    await execFileAsync(FFPROBE, ['-v', 'error', ...args], {
      maxBuffer: MAX_BUFFER,
    })
  ).stdout.trim();

/** [pts, dts] of every packet in a stream. */
export async function packets(file, stream = '0') {
  const out = await ffprobe([
    '-select_streams',
    stream,
    '-show_entries',
    'packet=pts,dts',
    '-of',
    'csv=p=0',
    file,
  ]);
  return out
    ? out.split(/\r?\n/).map((line) => line.split(',').map(Number))
    : [];
}

export async function packetCount(file, stream) {
  return Number(
    await ffprobe([
      '-select_streams',
      String(stream),
      '-count_packets',
      '-show_entries',
      'stream=nb_read_packets',
      '-of',
      'csv=p=0',
      file,
    ]),
  );
}

export async function mediaDuration(file) {
  return Number(
    await ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', file]),
  );
}

export async function audioChannels(file) {
  return Number(
    await ffprobe([
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=channels',
      '-of',
      'csv=p=0',
      file,
    ]),
  );
}

// ---- MP4 ------------------------------------------------------------------

export function boxes(buf, start = 0, end = buf.length) {
  const found = [];
  for (let pos = start; pos + 8 <= end;) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
    }
    if (size === 0) {
      size = end - pos;
    }
    found.push({ type, start: pos, size });
    pos += size;
  }
  return found;
}

const childBox = (buf, parent, type) =>
  boxes(buf, parent.start + 8, parent.start + parent.size).find(
    (box) => box.type === type,
  );

/** baseMediaDecodeTime of a segment's first fragment, in track timescale units. */
export function firstTfdt(segment) {
  const moof = boxes(segment).find((box) => box.type === 'moof');
  const tfdt = childBox(segment, childBox(segment, moof, 'traf'), 'tfdt');
  return segment[tfdt.start + 8] === 1
    ? Number(segment.readBigUInt64BE(tfdt.start + 12))
    : segment.readUInt32BE(tfdt.start + 12);
}

export function trackTimescale(init) {
  const moov = boxes(init).find((box) => box.type === 'moov');
  const mdhd = childBox(
    init,
    childBox(init, childBox(init, moov, 'trak'), 'mdia'),
    'mdhd',
  );
  return init.readUInt32BE(
    mdhd.start + 8 + (init[mdhd.start + 8] === 1 ? 20 : 12),
  );
}

// ---- torrent + server -----------------------------------------------------

export function directorySize(dir) {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .reduce(
        (total, entry) =>
          total + statSync(path.join(entry.parentPath, entry.name)).size,
        0,
      );
  } catch {
    return 0;
  }
}

/** Seeds a file from a local WebTorrent client and returns a magnet pointing at it. */
export async function seedFixture(file, options = {}) {
  const { pieceLength, ...clientOptions } = options;
  const { default: WebTorrent } = await import('webtorrent');
  // No DHT, trackers or local discovery: the magnet carries the peer address.
  const client = new WebTorrent({
    dht: false,
    tracker: false,
    lsd: false,
    ...clientOptions,
  });
  const torrent = await new Promise((resolve) =>
    client.seed(
      file,
      { announce: [], ...(pieceLength ? { pieceLength } : {}) },
      resolve,
    ),
  );
  if (!client.listening) {
    await new Promise((resolve) => client.once('listening', resolve));
  }
  return {
    client,
    torrent,
    magnet: `${torrent.magnetURI}&x.pe=127.0.0.1:${client.address().port}`,
  };
}

const servers = new Set();
process.on('exit', () => servers.forEach((child) => child.kill()));

/** Starts the compiled server, resolving once it is listening. */
export function startServer({ name, port, cacheDir, env = {} }) {
  mkdirSync(path.join(workDir, 'logs'), { recursive: true });
  const log = createWriteStream(path.join(workDir, 'logs', `${name}.log`), {
    flags: 'a',
  });
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      FFMPEG_PATH: FFMPEG,
      CACHE_DIR: cacheDir,
      LOG_LEVEL: 'debug',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.add(child);
  child.once('exit', () => servers.delete(child));
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server ${name} did not start`)),
      30000,
    );
    child.stdout.on('data', (data) => {
      if (!data.toString().includes('Listening on')) {
        return;
      }
      clearTimeout(timer);
      resolve({
        base: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise((done) => {
            child.once('exit', done);
            child.kill();
          }),
      });
    });
    child.once('exit', (code) =>
      reject(
        new Error(
          `server ${name} exited with ${code}; see test/.work/logs/${name}.log`,
        ),
      ),
    );
  });
}

/** GET a URL, returning status, body and elapsed time. */
export async function get(url, binary = true) {
  const started = Date.now();
  const res = await fetch(url);
  const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return {
    status: res.status,
    body,
    ms: Date.now() - started,
    type: res.headers.get('content-type'),
  };
}
