import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);

export const root = path.resolve(import.meta.dirname, '..');
export const workDir = path.join(root, 'test', '.work');
export const fixturesDir = path.join(workDir, 'fixtures');
mkdirSync(fixturesDir, { recursive: true });

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// ffprobe ships next to ffmpeg, so FFMPEG_PATH is enough to locate both.
export const FFPROBE =
  process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg(?=(\.exe)?$)/i, 'ffprobe');

// An ffprobe packet dump of a whole fixture runs to tens of megabytes.
const MAX_BUFFER = 1 << 28;

// Suites assert through check() and exit on failureCount() at the end, so
// one failed assertion still leaves the rest of the suite to report.
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

/**
 * Flat list of the MP4 boxes in a range. Size 1 means the real size follows
 * as 64 bits; size 0 means the box runs to the end of the range.
 */
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

/**
 * Decode time of a segment's first fragment, in the track's timescale.
 * Version 1 of tfdt stores it as 64 bits, version 0 as 32.
 */
export function firstTfdt(segment) {
  const moof = boxes(segment).find((box) => box.type === 'moof');
  const tfdt = childBox(segment, childBox(segment, moof, 'traf'), 'tfdt');
  return segment[tfdt.start + 8] === 1
    ? Number(segment.readBigUInt64BE(tfdt.start + 12))
    : segment.readUInt32BE(tfdt.start + 12);
}

// Timescale of the first track in an init segment. An mdhd of version 1
// holds 64-bit times, which pushes the timescale field 8 bytes further in.
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

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} took over ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

/**
 * Seeds a fixture from this process. Trackers, DHT and LSD are off, so the
 * magnet carries the seeder's own address in `x.pe` for the client to use.
 */
export async function seedFixture(file, options = {}) {
  const { pieceLength, ...clientOptions } = options;
  const { default: WebTorrent } = await import('webtorrent');
  const client = new WebTorrent({
    dht: false,
    tracker: false,
    lsd: false,
    ...clientOptions,
  });
  const torrent = await withTimeout(
    new Promise((resolve, reject) => {
      client.once('error', reject);
      client.seed(
        file,
        { announce: [], ...(pieceLength ? { pieceLength } : {}) },
        resolve,
      );
    }),
    60_000,
    `seeding ${path.basename(file)}`,
  );
  if (!client.listening) {
    await withTimeout(
      new Promise((resolve) => client.once('listening', resolve)),
      30_000,
      'the seeder listening',
    );
  }
  return {
    client,
    torrent,
    magnet: `${torrent.magnetURI}&x.pe=127.0.0.1:${client.address().port}`,
  };
}

/**
 * A BitTorrent peer with scripted behaviour: an empty bitfield, a permanent
 * choke, corrupt blocks, or a cap on how many blocks it answers.
 */
export async function startFakePeer({
  file,
  torrent,
  has = 'all',
  choke = false,
  corrupt = false,
  serveBlocks = Infinity,
}) {
  const [{ default: Protocol }, handle] = await Promise.all([
    import('bittorrent-protocol'),
    open(file, 'r'),
  ]);
  const peerId = randomBytes(20);
  const pieceCount = Math.ceil(torrent.length / torrent.pieceLength);
  const bitfield = Buffer.alloc(
    Math.ceil(pieceCount / 8),
    has === 'all' ? 0xff : 0x00,
  );
  const stats = { connections: 0, requests: 0, served: 0, held: 0 };
  const sockets = new Set();

  const onConnection = (socket) => {
    stats.connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));

    const wire = new Protocol('tcpIncoming', 1);
    wire.on('error', () => {});
    socket.pipe(wire).pipe(socket);

    wire.once('crypto-infohash', () => wire.setInfoHash(torrent.infoHash));
    wire.once('handshake', (infoHash) => {
      wire.handshake(infoHash, peerId);
      wire.bitfield(bitfield);
      if (!choke) {
        wire.unchoke();
      }
    });
    wire.on('interested', () => {
      if (!choke) {
        wire.unchoke();
      }
    });
    wire.on('request', (index, offset, length, respond) => {
      stats.requests++;
      if (stats.served >= serveBlocks) {
        stats.held++;
        return;
      }
      stats.served++;
      if (corrupt) {
        respond(null, randomBytes(length));
        return;
      }
      const buffer = Buffer.alloc(length);
      handle.read(buffer, 0, length, index * torrent.pieceLength + offset).then(
        () => respond(null, buffer),
        () => {},
      );
    });
  };

  const { default: utp } = await import('utp-native');
  const tcp = createServer(onConnection);
  const udp = utp.createServer(onConnection);
  // A peer is reached over TCP or uTP and its address carries one port, so
  // the same number has to be free on both before it can be advertised.
  let port = 0;
  for (let attempt = 0; attempt < 10 && !port; attempt++) {
    await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const candidate = tcp.address().port;
    const bound = await withTimeout(
      new Promise((resolve) => {
        udp.once('error', () => resolve(false));
        udp.listen(candidate, '127.0.0.1', () => resolve(true));
      }),
      2000,
      'binding uTP',
    ).catch(() => false);
    if (bound) {
      port = candidate;
    } else {
      await new Promise((resolve) => tcp.close(resolve));
    }
  }
  if (!port) {
    throw new Error('could not find a port free for both TCP and uTP');
  }

  return {
    address: `127.0.0.1:${port}`,
    stats,
    async stop() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => tcp.close(resolve));
      await new Promise((resolve) => udp.close(resolve));
      await handle.close();
    },
  };
}

// A suite that throws must not leave a server process behind.
const servers = new Set();
process.on('exit', () => {
  for (const child of servers) {
    child.kill();
  }
});

export function startServer({
  name,
  port,
  cacheDir,
  env = {},
  entry = process.env.SERVER_ENTRY ?? 'dist/index.js',
}) {
  // Both streams go to test/.work/logs/<name>.log, which is where to look
  // when a suite fails.
  mkdirSync(path.join(workDir, 'logs'), { recursive: true });
  const log = createWriteStream(path.join(workDir, 'logs', `${name}.log`), {
    flags: 'a',
  });
  const child = spawn(process.execPath, [entry], {
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

export async function get(url, binary = true) {
  const started = Date.now();
  const res = await fetch(url);
  const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return {
    status: res.status,
    body,
    ms: Date.now() - started,
    type: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
  };
}
