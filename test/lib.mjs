// Machinery the suites share: fixture handling, a server started with its own
// environment, local torrent seeds and scripted peers speaking the wire
// protocol by hand. Nothing here reads the project's own .env.

import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  access,
  glob,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import WebTorrent from 'webtorrent';

const execFileAsync = promisify(execFile);

export const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
export const workDir = path.join(repoRoot, 'test', '.work');
export const fixtureDir = path.join(workDir, 'fixtures');
export const logDir = path.join(workDir, 'logs');
export const cacheRoot = path.join(workDir, 'cache');

const HANDSHAKE_BYTES = 68;
const BLOCK_REQUEST = 6;
const PIECE_MESSAGE = 7;
const BITFIELD_MESSAGE = 5;
const INTERESTED_MESSAGE = 2;
const UNCHOKE_MESSAGE = 1;

// ---------------------------------------------------------------- reporting

/**
 * One line per check, non-zero exit if any failed. A check body returns true
 * to pass, false or a string to fail, or throws with the reason.
 */
export function reporter(suiteName) {
  const failures = [];
  let checks = 0;
  const startedAt = Date.now();

  const record = (label, outcome) => {
    checks++;
    if (outcome.passed) {
      const extra = outcome.detail ? ` — ${outcome.detail}` : '';
      console.log(`ok   ${label}${extra}`);
      return;
    }
    failures.push(label);
    console.log(`FAIL ${label} — ${outcome.detail}`);
  };

  return {
    /** Title line between groups of checks. */
    section(title) {
      console.log(`\n-- ${title}`);
    },

    note(message) {
      console.log(`     ${message}`);
    },

    async check(label, body) {
      const began = Date.now();
      try {
        const outcome = await body();
        if (outcome === true) {
          record(label, { passed: true, detail: `${Date.now() - began}ms` });
        } else if (outcome === false) {
          record(label, { passed: false, detail: 'check returned false' });
        } else {
          record(label, {
            passed: outcome.passed === true,
            detail: outcome.detail ?? 'no detail',
          });
        }
      } catch (err) {
        record(label, {
          passed: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },

    /**
     * Runs the same body twice, once per variant, so a toggle can be judged by
     * what changes rather than by an absolute number.
     */
    async compare(label, variants, body) {
      const results = new Map();
      for (const variant of variants) {
        try {
          results.set(variant, { value: await body(variant) });
        } catch (err) {
          results.set(variant, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      console.log(`-- ${label}`);
      for (const [variant, outcome] of results) {
        const shown = outcome.error
          ? `error: ${outcome.error}`
          : typeof outcome.value === 'number'
            ? String(outcome.value)
            : JSON.stringify(outcome.value);
        console.log(`     ${String(variant)}: ${shown}`);
      }
      return results;
    },

    finish() {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `\n${suiteName}: ${checks - failures.length}/${checks} checks passed in ${seconds}s`,
      );
      if (failures.length > 0) {
        console.log(`failed: ${failures.join(', ')}`);
        process.exitCode = 1;
      }
      return failures.length === 0;
    },
  };
}

// ------------------------------------------------------------- time and fs

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Polls until the predicate answers truthy. Returns the last value or throws. */
export async function waitFor(
  predicate,
  { timeoutMs = 30_000, intervalMs = 50 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

export async function fileSize(target) {
  try {
    return (await stat(target)).size;
  } catch {
    return 0;
  }
}

export async function dirFiles(target) {
  const found = await readdir(target, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  const files = [];
  for (const entry of found) {
    if (!entry.isFile()) {
      continue;
    }
    files.push(path.join(entry.parentPath, entry.name));
  }
  return files;
}

export async function dirSize(target) {
  let total = 0;
  for (const file of await dirFiles(target)) {
    total += await fileSize(file);
  }
  return total;
}

export async function removeDir(target) {
  await rm(target, { recursive: true, force: true });
}

export async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2));
}

// ------------------------------------------------------------ external tools

let resolved;

/** ffmpeg and ffprobe. `FFMPEG_PATH` wins; otherwise found under winget. */
export function binaries() {
  if (resolved) {
    return resolved;
  }
  const ffmpegPath = process.env.FFMPEG_PATH;
  const ffprobePath = process.env.FFPROBE_PATH;
  if (ffmpegPath) {
    resolved = {
      ffmpeg: ffmpegPath,
      // ffprobe lives beside ffmpeg unless told otherwise.
      ffprobe:
        ffprobePath ?? ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'),
    };
    return resolved;
  }
  throw new Error('FFMPEG_PATH is not set and ffmpeg was not found');
}

/** Resolves ffmpeg through the winget package glob, for suite entry points. */
export async function resolveBinaries() {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  for await (const candidate of glob(
    path.join(
      localAppData,
      'Microsoft',
      'WinGet',
      'Packages',
      'Gyan.FFmpeg_*',
      '*',
      'bin',
      'ffmpeg.exe',
    ),
  )) {
    process.env.FFMPEG_PATH = candidate;
    if (!process.env.FFPROBE_PATH) {
      process.env.FFPROBE_PATH = candidate.replace(
        /ffmpeg\.exe$/,
        'ffprobe.exe',
      );
    }
    break;
  }
  if (!process.env.FFMPEG_PATH) {
    throw new Error('No ffmpeg under the winget packages; set FFMPEG_PATH');
  }
  return binaries();
}

export async function ffmpeg(args, { timeoutMs = 240_000 } = {}) {
  const { ffmpeg: bin } = binaries();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err),
    };
  }
}

export async function ffprobeJson(
  target,
  args = ['-show_format', '-show_streams'],
) {
  const { ffprobe: bin } = binaries();
  const { stdout } = await execFileAsync(
    bin,
    ['-v', 'error', '-print_format', 'json', ...args, target],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** Every packet or frame ffprobe reports, for timestamp comparisons. */
export async function ffprobeEntries(target, what) {
  const { ffprobe: bin } = binaries();
  const { stdout } = await execFileAsync(
    bin,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      `-show_${what}`,
      '-select_streams',
      '0',
      target,
    ],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  return JSON.parse(stdout)[what] ?? [];
}

// ---------------------------------------------------------------- fixtures

export const fixtures = {
  movie: () => path.join(fixtureDir, 'movie.mkv'),
  sparse: () => path.join(fixtureDir, 'sparse.mkv'),
  codecs: () => path.join(fixtureDir, 'codecs.mkv'),
  tiny: () => path.join(fixtureDir, 'tiny.mkv'),
};

/** Builds the fixtures once. `--force` in argv rebuilds them. */
export async function ensureFixtures({
  force = process.argv.includes('--force'),
} = {}) {
  await mkdir(fixtureDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, 'test', 'make-fixtures.mjs')],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, ...(force ? { FORCE: '1' } : {}) },
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`make-fixtures exited with ${code}`));
      }
    });
  });
}

// ------------------------------------------------------------------- server

const BASE_PORT = 3921;

/**
 * Port for a suite. Suites read TEST_PORT; the extra ordinal keeps several of
 * them from colliding when they run side by side.
 */
export function suitePort(ordinal = 0) {
  return Number(process.env.TEST_PORT ?? BASE_PORT + ordinal);
}

/**
 * Environment for the server child. Built from scratch rather than inherited,
 * so nothing in the developer's `.env` or shell leaks into a suite. Values the
 * suites rely on are small budgets and short timeouts.
 */
export function serverEnv({
  port,
  cacheDir,
  logLevel = 'debug',
  overrides = {},
}) {
  const { ffmpeg } = binaries();
  return {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: logLevel,
    CACHE_DIR: cacheDir,
    FFMPEG_PATH: ffmpeg,
    PIECE_CACHE_MB: '512',
    SEGMENT_CACHE_MB: '512',
    METADATA_CACHE_MB: '128',
    CACHE_TOTAL_MB: '1024',
    CACHE_SWEEP_MINUTES: '0.25',
    MAX_CONCURRENT_JOBS: '4',
    REQUEST_TIMEOUT_S: '90',
    READ_STALL_S: '20',
    METADATA_TIMEOUT_S: '20',
    TORRENT_IDLE_S: '45',
    KEEP_WARM_S: '0',
    ...overrides,
  };
}

// The server builds its WebTorrent client with uTP on, which sends loopback
// peers over UDP. This preload turns that off before the app loads, so every
// connection in a suite is plain TCP and a scripted peer can answer it.
export const preloadPath = path.join(repoRoot, 'test', 'preload.mjs');
const indexEntry = path.join(repoRoot, 'test', 'serve.mjs');

/**
 * The built server as a child process. Its whole environment comes from
 * `serverEnv`, and it runs with cwd inside `test/.work` so dotenv finds no
 * `.env` to load.
 */
export class TestServer {
  constructor({ name, port, cacheDir, options = {} }) {
    this.name = name;
    this.port = port;
    this.cacheDir = cacheDir;
    this.options = options;
    this.logPath = path.join(logDir, `${name}.log`);
    this.child = undefined;
    this.tail = [];
  }

  static async start(spec) {
    const server = new TestServer(spec);
    await server.launch();
    return server;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  get url() {
    return (pathname) => `${this.baseUrl}${pathname}`;
  }

  get cacheLayout() {
    return {
      root: this.cacheDir,
      pieces: path.join(this.cacheDir, 'pieces'),
      torrents: path.join(this.cacheDir, 'torrents'),
      hls: path.join(this.cacheDir, 'hls'),
    };
  }

  async launch() {
    const {
      fresh = true,
      env: overrides = {},
      logLevel = 'debug',
    } = this.options;
    if (fresh) {
      await removeDir(this.cacheDir);
    }
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(path.dirname(this.logPath), { recursive: true });

    this.child = spawn(process.execPath, [indexEntry], {
      // No .env sits in test/.work, so dotenv loads nothing and the child sees
      // only what serverEnv put there.
      cwd: workDir,
      env: serverEnv({
        port: this.port,
        cacheDir: this.cacheDir,
        logLevel,
        overrides,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines = [];
    this.tail = lines;
    this.logSink = createWriteStream(this.logPath, { flags: 'a' });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream.pipe(this.logSink, { end: false });
      stream.setEncoding('utf8');
      let buffered = '';
      stream.on('data', (chunk) => {
        buffered += chunk;
        const parts = buffered.split('\n');
        buffered = parts.pop() ?? '';
        for (const part of parts) {
          lines.push(part);
          if (lines.length > 400) {
            lines.shift();
          }
        }
      });
    }

    const exited = new Promise((resolve) => {
      this.child.once('exit', (code) => resolve(code ?? 0));
    });
    this.exited = exited;

    try {
      await waitFor(
        async () => {
          if (await this.up()) {
            return true;
          }
          return false;
        },
        { timeoutMs: 30_000, intervalMs: 100 },
      );
    } catch (err) {
      const codes = await Promise.race([
        exited,
        sleep(1).then(() => undefined),
      ]);
      throw new Error(
        `server "${this.name}" never answered on ${this.baseUrl}` +
          (codes === undefined ? '' : ` (exited with ${codes})`) +
          `\n${this.logTail(20)}`,
      );
    }
    return this;
  }

  logTail(count = 20) {
    return this.tail.slice(-count).join('\n');
  }

  /** 200 from /status means the listener is up and the app answered. */
  async up() {
    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Any request. Never throws on a non-2xx status. */
  async request(pathname, init = {}) {
    const response = await fetch(`${this.baseUrl}${pathname}`, init);
    const body = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: response.headers,
      bytes: body,
      get text() {
        return body.toString('utf8');
      },
      json() {
        return JSON.parse(body.toString('utf8'));
      },
    };
  }

  async getJson(pathname) {
    return (await this.request(pathname)).json();
  }

  async getBytes(pathname) {
    return (await this.request(pathname)).bytes;
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) {
      return;
    }
    this.child.kill('SIGTERM');
    await this.exited;
    await new Promise((resolve) => {
      this.logSink.end(() => resolve());
    });
    this.child = undefined;
  }

  /** Stops and starts again over the same cache directory. */
  async restart(overrides = {}) {
    await this.stop();
    this.options = { ...this.options, fresh: false, env: overrides };
    await this.launch();
    return this;
  }
}

// ---------------------------------------------------------------- mangling

export function playlistOf(text) {
  const lines = text.split(/\r?\n/);
  const result = {
    version: undefined,
    targetDuration: undefined,
    mediaSequence: undefined,
    endList: false,
    independentSegments: false,
    segments: [],
    playlists: [],
    streamInf: false,
  };
  let pendingInf;
  let pendingStreamInf;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-VERSION:')) {
      result.version = Number(line.slice('#EXT-X-VERSION:'.length));
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      result.targetDuration = Number(
        line.slice('#EXT-X-TARGETDURATION:'.length),
      );
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      result.mediaSequence = Number(
        line.slice('#EXT-X-MEDIA-SEQUENCE:'.length),
      );
    } else if (line === '#EXT-X-ENDLIST') {
      result.endList = true;
    } else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
      result.independentSegments = true;
    } else if (line.startsWith('#EXTINF:')) {
      pendingInf = Number(line.slice('#EXTINF:'.length).split(',')[0]);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingStreamInf = parseAttributes(
        line.slice('#EXT-X-STREAM-INF:'.length),
      );
      result.streamInf = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      result.map = attrs.URI;
    } else if (line === '' || line.startsWith('#')) {
      continue;
    } else if (pendingStreamInf) {
      result.playlists.push({ uri: line, ...pendingStreamInf });
      pendingStreamInf = undefined;
    } else {
      result.segments.push({ uri: line, duration: pendingInf });
      pendingInf = undefined;
    }
  }
  return result;
}

/** Attribute list after a tag, both quoting styles accepted. */
function parseAttributes(text) {
  const attributes = {};
  const pattern = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
  for (const match of text.matchAll(pattern)) {
    attributes[match[1]] = match[3] ?? match[2];
  }
  return attributes;
}

export function magnetWithPeers(magnet, peers) {
  const extra = peers.map((peer) => `x.pe=${peer}`).join('&');
  return extra ? `${magnet}&${extra}` : magnet;
}

export function infoHashOf(magnet) {
  const match = /urn:btih:([0-9a-f]{40})/i.exec(magnet);
  return match?.[1]?.toLowerCase();
}

// ----------------------------------------------------------------- seeding

/**
 * WebTorrent client with every outside discovery path off, so a suite's swarm
 * is the loopback connections it asked for and nothing else.
 */
export function createSeeder(options = {}) {
  const client = new WebTorrent({
    dht: false,
    lsd: false,
    tracker: false,
    utPex: false,
    natUpnp: false,
    natPmp: false,
    utp: false,
    maxConns: 200,
    ...options,
  });
  client.on('error', (err) => {
    console.log(`     seeder error: ${err.message}`);
  });
  return client;
}

/**
 * One torrent served from this process. `magnet` carries its own address in
 * `x.pe`, which is all the server needs to find it.
 */
export class SeededTorrent {
  constructor({ torrent, client, port, inputs }) {
    this.torrent = torrent;
    this.client = client;
    this.port = port;
    this.inputs = inputs;
    this.infoHash = torrent.infoHash;
    this.name = torrent.name;
    this.pieceLength = torrent.pieceLength;
    this.pieceCount = torrent.pieces.length;
    this.length = torrent.length;
  }

  get magnet() {
    return `${this.torrent.magnetURI}&x.pe=127.0.0.1:${this.port}`;
  }

  magnetFor(peers = []) {
    return magnetWithPeers(this.torrent.magnetURI, [
      `127.0.0.1:${this.port}`,
      ...peers,
    ]);
  }

  /** The whole first file's bytes, for comparing what the swarm served. */
  fileData() {
    return readFile(this.inputs[0]);
  }

  async pieceData(index) {
    const handle = await open(this.inputs[0]);
    try {
      const rest = this.length - index * this.pieceLength;
      const { buffer } = await handle.read(
        Buffer.alloc(Math.min(this.pieceLength, rest)),
        0,
        Math.min(this.pieceLength, rest),
        index * this.pieceLength,
      );
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async close() {
    await new Promise((resolve) => this.client.destroy(() => resolve()));
  }
}

/**
 * Seeds one or more files and waits for the swarm to be reachable. `paths` may
 * be a single path, an array of paths or a directory.
 */
export async function seed(input, options = {}) {
  const paths = Array.isArray(input) ? input : [input];
  const client = options.client ?? createSeeder();
  const torrent = client.seed(paths, {
    announce: [],
    private: true,
    pieceLength: options.pieceLength,
    ...options.torrentOptions,
  });
  await new Promise((resolve, reject) => {
    torrent.once('ready', resolve);
    torrent.once('error', reject);
  });
  const port = await waitFor(
    () => (client.torrentPort > 0 ? client.torrentPort : false),
    {
      timeoutMs: 10_000,
    },
  );
  return new SeededTorrent({
    torrent,
    client,
    port: Number(port),
    inputs: paths,
  });
}

// ----------------------------------------------------------- scripted peers

/**
 * A peer wished into existence by hand: enough of the wire protocol to seed,
 * to stay silent, to answer with noise, or to hold a connection and offer
 * nothing. Real clients cannot be told to misbehave this precisely.
 *
 * `source` supplies piece bytes: `{ infoHash, pieceLength, pieceCount, bytes }`
 * where `bytes` is the whole torrent payload, so every piece served is the one
 * the torrent's hashes expect.
 */
export class ScriptedPeer {
  constructor(source, options = {}) {
    this.source = source;
    this.mode = options.mode ?? 'honest';
    // honest answers everything; silent never answers; corrupt answers noise;
    // empty advertises no pieces and holds the connection; partial answers
    // until `stallAfterBlocks` requests have gone out and then stops.
    this.stallAfterBlocks = options.stallAfterBlocks ?? Infinity;
    this.stallAfterRequests = options.stallAfterRequests ?? Infinity;
    this.stallFromOffset = options.stallFromOffset ?? Infinity;
    this.replyDelayMs = options.replyDelayMs ?? 0;
    this.unchoke = options.unchoke ?? true;
    this.port = 0;
    this.stats = {
      handshakes: 0,
      requests: 0,
      blocks: 0,
      bytes: 0,
      stalls: 0,
      corrupt: 0,
    };
    this.sockets = new Set();
    this.server = net.createServer((socket) => this.attach(socket));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  get address() {
    return `127.0.0.1:${this.port}`;
  }

  async stop() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  attach(socket) {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));

    let handshake = Buffer.alloc(0);
    let payload = Buffer.alloc(0);
    let greeted = false;

    socket.on('data', (chunk) => {
      if (!greeted) {
        handshake = Buffer.concat([handshake, chunk]);
        if (handshake.length < HANDSHAKE_BYTES) {
          return;
        }
        // Echo the handshake we were sent, but with our own peer id in its tail.
        const mine = Buffer.from(handshake.subarray(0, HANDSHAKE_BYTES));
        Buffer.from(randomPeerId(), 'hex').copy(mine, HANDSHAKE_BYTES - 20);
        socket.write(mine);
        this.stats.handshakes++;
        handshake = Buffer.alloc(0);
        greeted = true;
        socket.write(this.bitfieldMessage());
        return;
      }

      payload = Buffer.concat([payload, chunk]);
      while (payload.length >= 4) {
        const length = payload.readUInt32BE(0);
        if (length === 0) {
          payload = payload.subarray(4);
          continue;
        }
        if (payload.length < 4 + length) {
          break;
        }
        const body = payload.subarray(4, 4 + length);
        payload = payload.subarray(4 + length);
        this.handleMessage(socket, body);
      }
    });
  }

  bitfieldMessage() {
    const bytes = Math.ceil(this.source.pieceCount / 8);
    const field = Buffer.alloc(bytes, 0);
    if (this.mode !== 'empty') {
      for (let piece = 0; piece < this.source.pieceCount; piece++) {
        field[piece >> 3] |= 0x80 >> (piece % 8);
      }
    }
    return Buffer.concat([messageHeader(BITFIELD_MESSAGE), field]);
  }

  handleMessage(socket, body) {
    const id = body[0];
    if (id === INTERESTED_MESSAGE && this.unchoke) {
      socket.write(messageHeader(UNCHOKE_MESSAGE));
      return;
    }
    if (id !== BLOCK_REQUEST) {
      return;
    }

    const index = body.readUInt32BE(1);
    const begin = body.readUInt32BE(5);
    const length = body.readUInt32BE(9);
    this.stats.requests++;

    const offset = index * this.source.pieceLength + begin;
    if (
      this.mode === 'silent' ||
      this.stats.requests > this.stallAfterRequests ||
      this.stats.blocks >= this.stallAfterBlocks ||
      offset >= this.stallFromOffset
    ) {
      this.stats.stalls++;
      return;
    }

    const send = () => {
      const data = this.blockFor(index, begin, length);
      socket.write(pieceMessage(index, begin, data));
      this.stats.blocks++;
      this.stats.bytes += data.length;
    };
    if (this.replyDelayMs > 0) {
      setTimeout(send, this.replyDelayMs);
    } else {
      send();
    }
  }

  blockFor(index, begin, length) {
    if (this.mode === 'corrupt') {
      this.stats.corrupt++;
      return crypto.randomBytes(length);
    }
    return this.source.bytes.subarray(
      index * this.source.pieceLength + begin,
      index * this.source.pieceLength + begin + length,
    );
  }
}

function messageHeader(id, payloadLength = 0) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(1 + payloadLength, 0);
  head[4] = id;
  return head;
}

function pieceMessage(index, begin, data) {
  const body = Buffer.alloc(8 + data.length);
  body.writeUInt32BE(index, 0);
  body.writeUInt32BE(begin, 4);
  data.copy(body, 8);
  return Buffer.concat([messageHeader(PIECE_MESSAGE, 8 + data.length), body]);
}

function randomPeerId() {
  return crypto.randomBytes(20).toString('hex');
}

/**
 * Everything `ScriptedPeer` needs to serve real bytes for a torrent: whole
 * payload of every file laid out in torrent order.
 */
export async function torrentSource(seeded, options = {}) {
  const parts = [];
  // The paths handed to seed(), not webtorrent's own, which are relative.
  for (const input of seeded.inputs) {
    parts.push(await readFile(input));
  }
  return {
    infoHash: seeded.infoHash,
    pieceLength: seeded.pieceLength,
    pieceCount: seeded.pieceCount,
    bytes: Buffer.concat(parts),
    ...options,
  };
}

// -------------------------------------------------------------- misc helpers

export async function ensureBuilt() {
  if (!(await exists(path.join(repoRoot, 'dist', 'index.js')))) {
    throw new Error('dist/index.js is missing; run npm run build first');
  }
}

export const MiB = 1024 * 1024;

export async function httpHead(server, pathname) {
  const response = await fetch(server.url(pathname), { method: 'HEAD' });
  return { status: response.status, headers: response.headers };
}
