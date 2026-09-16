// Inspects an MKV the way the server sees it: tracks, renditions, and what a
// segment's slice actually contains. Takes a magnet link, or a path to a local
// file when a torrent has already been fetched.
//
//   node test/inspect.mjs <magnet|file> [fileIndex] [segments] [--remux]
import os from 'node:os';
import path from 'node:path';

const DIST = new URL('../dist', import.meta.url).href;
const mi = await import(DIST + '/media/media-index.js');
const { getRenditions, aacSampleRate, codecString } = await import(
  DIST + '/media/codecs.js'
);
const { readElementHeader, readVint, UNKNOWN_SIZE } = await import(
  DIST + '/matroska/ebml.js'
);
const { Id, TOP_LEVEL_IDS } = await import(DIST + '/matroska/ids.js');

const target = process.argv[2];
const wantFile =
  process.argv[3] === undefined || process.argv[3] === '-'
    ? undefined
    : Number(process.argv[3]);
const segments = (process.argv[4] ?? '0').split(',').map(Number);

let bytesRead = 0;
let source;
let fileName;
let client;

if (target.startsWith('magnet:')) {
  const { default: WebTorrent } = await import('webtorrent');
  client = new WebTorrent();
  client.on('error', (e) =>
    console.error('client error', e && e.message ? e.message : e),
  );

  const torrent = client.add(target, {
    deselect: true,
    // WebTorrent preallocates the whole file, so a 4K remux needs tens of
    // GB free wherever this points. INSPECT_STORE moves it off the temp drive.
    path: process.env.INSPECT_STORE || path.join(os.tmpdir(), 'inspect-store'),
    storeCacheSlots: 0,
  });
  torrent.setMaxListeners(400);

  const ready = new Promise((resolve, reject) => {
    torrent.once('ready', resolve);
    torrent.once('error', reject);
    setTimeout(() => reject(new Error('metadata timeout')), 180000);
  });
  console.log('waiting for metadata...');
  await ready;
  console.log(
    'torrent:',
    torrent.name,
    torrent.infoHash,
    'pieceLength',
    torrent.pieceLength,
  );

  const playable = torrent.files
    .map((f, index) => ({ index, name: f.name, length: f.length }))
    .filter((f) => /\.(mkv|mk3d|webm)$/i.test(f.name));
  console.log('playable files:', playable);

  const fileIndex =
    wantFile !== undefined
      ? wantFile
      : playable.sort((a, b) => b.length - a.length)[0].index;
  const file = torrent.files[fileIndex];
  fileName = file.name;
  console.log(
    'using file #' +
      fileIndex +
      ': ' +
      file.name +
      ' (' +
      (file.length / 2 ** 30).toFixed(2) +
      ' GiB)',
  );

  source = {
    length: file.length,
    stream(start, end) {
      bytesRead += end - start;
      return file.createReadStream({ start, end: end - 1 });
    },
  };

  // A starved swarm looks exactly like a hung program, so say which it is.
  setInterval(() => {
    console.log(
      '  [swarm] peers=' +
        torrent.numPeers +
        ' choking=' +
        torrent.wires.filter((w) => w.peerChoking).length +
        ' down=' +
        (torrent.downloadSpeed / 1024).toFixed(0) +
        ' KiB/s' +
        ' got=' +
        (torrent.downloaded / 2 ** 20).toFixed(1) +
        ' MiB',
    );
  }, 15000).unref();
} else {
  const { LocalFileSource } = await import(DIST + '/io/byte-source.js');
  const local = await LocalFileSource.open(target);
  fileName = path.basename(target);
  console.log(
    'using local file: ' +
      target +
      ' (' +
      (local.length / 2 ** 30).toFixed(2) +
      ' GiB)',
  );
  source = {
    length: local.length,
    stream(start, end) {
      bytesRead += end - start;
      return local.stream(start, end);
    },
  };
}

console.log('reading layout...');
const index = await mi.buildMediaIndex(source, fileName, 6);
console.log(
  'duration',
  index.duration.toFixed(1),
  's; keyframes',
  index.keyframes.length,
  'segments',
  mi.segmentCount(index),
  'firstCluster',
  index.firstClusterOffset,
  'mediaEnd',
  index.mediaEnd,
);
console.log('bytes read so far:', (bytesRead / 2 ** 20).toFixed(1), 'MiB');

console.log('');
console.log('tracks:');
for (const t of index.tracks) {
  const priv = t.codecPrivate
    ? Buffer.from(t.codecPrivate, 'base64').length + 'B'
    : 'none';
  const extra =
    t.kind === 'audio'
      ? 'rate=' + t.sampleRate + ' ch=' + t.channels + ' '
      : t.kind === 'video'
        ? t.width + 'x' + t.height + ' '
        : '';
  console.log(
    ' #' +
      t.number +
      ' ' +
      t.kind.padEnd(8) +
      ' ' +
      t.codecId.padEnd(22) +
      ' lang=' +
      t.language +
      ' def=' +
      t.isDefault +
      ' forced=' +
      t.isForced +
      ' ' +
      extra +
      'priv=' +
      priv +
      ' name=' +
      JSON.stringify(t.name || ''),
  );
}

let renditions;
try {
  renditions = getRenditions(index);
  console.log('');
  console.log('renditions:');
  console.log(
    ' video  track',
    renditions.video.track.number,
    renditions.video.codec,
    'codecs=',
    codecString(renditions.video),
  );
  for (const a of renditions.audio) {
    console.log(
      ' audio  track ' +
        a.track.number +
        ' ' +
        a.track.codecId +
        ' transcode=' +
        a.transcode +
        ' codecs=' +
        codecString(a),
    );
  }
  for (const s of renditions.subtitles) {
    console.log(' subs   track ' + s.track.number + ' ' + s.track.codecId);
  }
} catch (err) {
  console.log('getRenditions failed:', err.message);
}

// --- walk a byte range and tally blocks per track -------------------------
async function scan(start, end) {
  const tally = new Map();
  let pos = start;
  let clusterTs;
  let clusterEnd = Infinity;
  let inCluster = false;
  let buf = Buffer.alloc(0);
  const stream = source.stream(start, end);
  const iter = stream[Symbol.asyncIterator]();
  let done = false;
  const need = async (n) => {
    while (buf.length < n && !done) {
      const next = await iter.next();
      if (next.done) {
        done = true;
        break;
      }
      buf = Buffer.concat([buf, next.value]);
    }
    return buf.length >= n;
  };
  const take = (n) => {
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    pos += n;
    return out;
  };

  while (await need(12)) {
    const el = readElementHeader(buf, 0);
    if (!el) break;
    if (inCluster && pos >= clusterEnd) inCluster = false;
    if (el.id === Id.Cluster) {
      take(el.headerLength);
      inCluster = true;
      clusterEnd = el.size === UNKNOWN_SIZE ? Infinity : pos + el.size;
      clusterTs = undefined;
      continue;
    }
    if (TOP_LEVEL_IDS.has(el.id)) break;
    if (el.size === UNKNOWN_SIZE) break;
    const total = el.headerLength + el.size;
    const isBlock = el.id === Id.SimpleBlock || el.id === Id.BlockGroup;
    if (!inCluster || (!isBlock && el.id !== Id.Timestamp)) {
      if (!(await need(total))) break;
      take(total);
      continue;
    }
    if (!(await need(total))) break;
    const at = pos;
    const body = take(total);
    if (el.id === Id.Timestamp) {
      let v = 0;
      for (let i = el.headerLength; i < body.length; i++) v = v * 256 + body[i];
      clusterTs = v;
      continue;
    }
    let p = el.headerLength;
    if (el.id === Id.BlockGroup) {
      let cursor = el.headerLength;
      p = -1;
      while (cursor < body.length) {
        const child = readElementHeader(body, cursor);
        if (!child) break;
        if (child.id === Id.Block) {
          p = cursor + child.headerLength;
          break;
        }
        cursor += child.headerLength + child.size;
      }
      if (p < 0) continue;
    }
    const v = readVint(body, p);
    const rel = body.readInt16BE(p + v.length);
    const ts = (clusterTs || 0) + rel;
    let t = tally.get(v.value);
    if (!t) {
      t = {
        blocks: 0,
        bytes: 0,
        minTs: Infinity,
        maxTs: -Infinity,
        firstAt: at,
      };
      tally.set(v.value, t);
    }
    t.blocks++;
    t.bytes += total;
    t.minTs = Math.min(t.minTs, ts);
    t.maxTs = Math.max(t.maxTs, ts);
  }
  stream.destroy();
  return tally;
}

const toSec = (ticks) => (ticks * index.timestampScale) / 1e9;

// --- optionally render the segment the way the server would ----------------
const remuxing = process.argv.includes('--remux');
let remuxer;
let outDir;
if (remuxing) {
  const { Remuxer } = await import(DIST + '/hls/remux.js');
  const { mkdtemp } = await import('node:fs/promises');
  remuxer = new Remuxer({
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    timeoutMs: 300000,
  });
  outDir = await mkdtemp(path.join(os.tmpdir(), 'inspect-remux-'));
  console.log('');
  console.log('remuxing into', outDir);
}

async function render(rendition, n, label) {
  const name = label.replace(/[^\w.-]/g, '_');
  const started = Date.now();
  try {
    if (rendition.type !== 'subtitle') {
      await remuxer.writeInit(
        index,
        rendition,
        path.join(outDir, name + '-init.mp4'),
      );
    }
    const out = path.join(
      outDir,
      name + '-' + n + (rendition.type === 'subtitle' ? '.vtt' : '.m4s'),
    );
    await remuxer.writeSegment({ index, source, rendition }, n, out);
    const { statSync } = await import('node:fs');
    console.log(
      '   OK   ' +
        label.padEnd(26) +
        (statSync(out).size / 1024).toFixed(0).padStart(7) +
        ' KiB  ' +
        (Date.now() - started) +
        ' ms',
    );
  } catch (err) {
    console.log(
      '   FAIL ' +
        label.padEnd(26) +
        (Date.now() - started) +
        ' ms  ' +
        (err && err.message ? err.message : err),
    );
    if (err && err.stderr) {
      console.log(
        '        stderr: ' +
          String(err.stderr).trim().split(/\r?\n/).slice(-6).join(' | '),
      );
    }
  }
}

for (const n of segments) {
  console.log('');
  console.log(
    '================ segment ' +
      n +
      ' (t=' +
      mi.segmentStart(index, n).toFixed(2) +
      '..' +
      mi.segmentEnd(index, n).toFixed(2) +
      's)',
  );
  const kf = mi.keyframeSlice(index, n, true);
  console.log(
    ' video keyframe slice: ' +
      kf.readStart +
      '..' +
      kf.readEnd +
      ' (' +
      ((kf.readEnd - kf.readStart) / 2 ** 20).toFixed(1) +
      ' MiB)',
  );
  const kfTally = await scan(kf.readStart, kf.readEnd);
  for (const [track, t] of [...kfTally].sort((a, b) => a[0] - b[0])) {
    console.log(
      '   track ' +
        track +
        ': ' +
        t.blocks +
        ' blocks ' +
        (t.bytes / 2 ** 20).toFixed(2) +
        ' MiB ts ' +
        toSec(t.minTs).toFixed(2) +
        '..' +
        toSec(t.maxTs).toFixed(2) +
        's',
    );
  }

  for (const a of renditions ? renditions.audio : []) {
    if (!a.transcode) continue;
    const rate = aacSampleRate(a.track);
    const toGrid = (s) => Math.round((s * rate) / 1024) * 1024;
    const isLast = n + 1 >= mi.segmentCount(index);
    const start = toGrid(mi.segmentStart(index, n));
    const end = isLast ? null : toGrid(mi.segmentStart(index, n + 1));
    const pad = 16 * 1024;
    const encodeFrom = Math.max(0, start - pad);
    const encodeTo = end === null ? null : end + pad;
    const toTicks = (samples, margin) =>
      mi.secondsToTicks(index, samples / rate + margin);
    const from = toTicks(encodeFrom, -0.5);
    const to = encodeTo === null ? null : toTicks(encodeTo, 0.5);
    const slice = mi.timeSlice(index, from, to);
    const tally = await scan(slice.readStart, slice.readEnd);
    const t = tally.get(a.track.number);
    const wantFrom = toSec(from);
    const wantTo = to === null ? Infinity : toSec(to);
    const ok =
      t &&
      toSec(t.minTs) <= wantFrom + 0.2 &&
      (to === null || toSec(t.maxTs) >= wantTo - 0.6);
    console.log(
      ' audio ' +
        a.track.number +
        ' (' +
        a.track.codecId +
        ') window ' +
        wantFrom.toFixed(2) +
        '..' +
        wantTo.toFixed(2) +
        's' +
        ' read ' +
        slice.readStart +
        '..' +
        slice.readEnd +
        ' (' +
        ((slice.readEnd - slice.readStart) / 2 ** 20).toFixed(1) +
        ' MiB) -> ' +
        (t
          ? t.blocks +
            ' blocks ' +
            (t.bytes / 2 ** 20).toFixed(2) +
            ' MiB ts ' +
            toSec(t.minTs).toFixed(2) +
            '..' +
            toSec(t.maxTs).toFixed(2) +
            's ' +
            (ok ? 'OK' : '*** SHORT ***')
          : '*** NO BLOCKS ***'),
    );
  }

  if (remuxing && renditions) {
    console.log(' rendering:');
    await render(renditions.video, n, 'video');
    for (const a of renditions.audio) {
      await render(
        a,
        n,
        'audio-' + a.track.number + '-' + a.track.codecId.replace('A_', ''),
      );
    }
    for (const s of renditions.subtitles) {
      await render(s, n, 'subs-' + s.track.number);
    }
  }
}

console.log('');
console.log('total bytes read:', (bytesRead / 2 ** 20).toFixed(1), 'MiB');
if (client) {
  client.destroy(() => process.exit(0));
} else {
  process.exit(0);
}
setTimeout(() => process.exit(0), 5000).unref();
