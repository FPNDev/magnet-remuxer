# magnet-remuxer

An HTTP server that plays a torrent over HLS. `GET /m3u8?magnet=...` answers
with a master playlist, and each segment behind that playlist is cut out of the
torrent's MKV and remuxed into fragmented MP4 when a player asks for it. Only
the bytes under the playhead and a short prefetch window are downloaded, so a
two hour file starts in seconds and a seek costs one segment.

Video is never re-encoded. The elementary stream is copied into fMP4, which
means 4K plays on a machine with no GPU. Audio is copied when a browser can
decode it (AAC, MP3, Opus, FLAC) and transcoded to AAC otherwise. Text subtitle
tracks are converted to WebVTT; bitmap formats such as PGS are skipped.

## How it works

1. **Metadata.** The info hash comes out of the magnet, WebTorrent fetches the
   torrent metadata, and the magnet is written to disk so the same info hash
   works after a restart without its trackers.
2. **Indexing.** The MKV header, Tracks and Cues are read through the torrent
   by byte range. Cues give the keyframe positions; a file with no cues for its
   video track cannot be indexed and the request fails with 422. The resulting
   media index holds tracks, keyframes and segment boundaries, and is cached so
   a title is indexed once.
3. **Planning.** Segment boundaries land on keyframes, each segment at least
   `SEGMENT_DURATION` seconds long. Every rendition (video, one per audio
   track, one per text subtitle track) gets its own media playlist.
4. **Slicing.** A segment needs one track's blocks over one time range. The
   slicer builds a small standalone MKV from the clusters covering that range,
   carrying that track alone. Reads go to the piece cache first and to the
   swarm otherwise, so a piece is downloaded once however many renditions need
   it.
5. **Remux.** The slice is piped into ffmpeg on stdin and comes back as an fMP4
   segment, or as WebVTT for subtitles. The init segment is written once per
   rendition. Jobs run through a priority queue: what a player is waiting for
   preempts prefetch, and per-torrent concurrency is capped because reads of
   one swarm divide its bandwidth rather than adding to it.
6. **Cache.** Pieces, segments and metadata live under `CACHE_DIR` with a
   least-recently-used budget each, plus an optional ceiling on the directory
   as a whole. Writes are atomic, so a partial file is never served as a
   complete one.

Three peer policies run around that pipeline: peers that fail verification are
banned across restarts, peers holding nothing the reader needs are dropped to
free connection slots, and the block a read is stopped at is asked of a second
peer when the first goes quiet.

## Requirements

- Node 20.12 or newer.
- ffmpeg on `PATH`, or `FFMPEG_PATH` pointing at the binary. One process runs
  per segment, so it has to be a real install rather than a shim.
- Disk under `CACHE_DIR`. The default budgets add up to 25 GiB.
- ffprobe, for the test suite only.

## Install

```sh
npm install
npm run build
```

## Running

```sh
npm start           # tsc, then node dist/index.js
node dist/index.js  # when the build is current
```

The server logs its port and cache directory on startup, and shuts down on
SIGINT and SIGTERM.

Configuration is environment variables only. Copy `.env.example` to `.env` and
edit it; `dotenv` loads that file before anything reads a value, and a variable
already set in the environment wins over the file. A malformed number throws at
startup rather than mid-request.

## Configuration

| Variable               | Default              | What it does                                                                                                       |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PORT`                 | `3000`               | HTTP port.                                                                                                         |
| `LOG_LEVEL`            | `info`               | `debug`, `info`, `warn` or `error`.                                                                                |
| `FFMPEG_PATH`          | `ffmpeg`             | Path to the ffmpeg binary.                                                                                         |
| `CACHE_DIR`            | `<tmp>/magnet-cache` | Pieces, playlists, segments, metadata.                                                                             |
| `PIECE_CACHE_MB`       | `8192`               | Budget for downloaded pieces.                                                                                      |
| `SEGMENT_CACHE_MB`     | `15360`              | Budget for rendered segments.                                                                                      |
| `METADATA_CACHE_MB`    | `2048`               | Budget for indexes, playlists, init segments, torrent metadata and peer memory.                                    |
| `CACHE_TOTAL_MB`       | unset                | Ceiling for the whole cache directory, measured rather than added up. Unset leaves the three budgets on their own. |
| `CACHE_SWEEP_MINUTES`  | `5`                  | How often disk usage is measured against that ceiling.                                                             |
| `SEGMENT_DURATION`     | `2`                  | Target segment length in seconds. Changing it invalidates playlists and segments already on disk.                  |
| `PREFETCH_SEGMENTS`    | `9`                  | Segments rendered ahead of the playhead.                                                                           |
| `PREFETCH_AHEAD_MB`    | `96`                 | Cap on the bytes read for that prefetch.                                                                           |
| `WARM_SEGMENTS`        | `2`                  | Segments rendered by `GET /warm`. `0` warms the index and playlists alone.                                         |
| `WARM_CONCURRENCY`     | `4`                  | Titles warmed at once.                                                                                             |
| `REQUEST_TIMEOUT_S`    | `120`                | A request waiting longer than this fails with 504.                                                                 |
| `MAX_CONCURRENT_JOBS`  | `max(16, cpus)`      | ffmpeg jobs across all torrents.                                                                                   |
| `MAX_JOBS_PER_TORRENT` | `2`                  | ffmpeg jobs reading one torrent.                                                                                   |
| `JOB_TIMEOUT_S`        | `180`                | Hard limit for one segment job.                                                                                    |
| `READ_STALL_S`         | `45`                 | Fail a read when the torrent receives nothing for this long.                                                       |
| `MAX_PEERS`            | `100`                | Connections held per torrent.                                                                                      |
| `TAIL_HEDGE`           | `1`                  | Ask a second peer for the block a read is stopped at.                                                              |
| `TAIL_HEDGE_MS`        | `250`                | How long that block waits before the second peer is asked.                                                         |
| `PEER_CHURN`           | `1`                  | Drop peers that hold nothing being read, or answer nothing.                                                        |
| `PEER_CHURN_GRACE_S`   | `10`                 | How long a new connection has to prove itself.                                                                     |
| `BAN_CORRUPT_PEERS`    | `1`                  | Ban peers whose data fails verification.                                                                           |
| `PEER_BAN_DAYS`        | `7`                  | How long such a ban lasts. Bans survive a restart.                                                                 |
| `METADATA_TIMEOUT_S`   | `90`                 | How long to wait for torrent metadata.                                                                             |
| `TORRENT_IDLE_S`       | `600`                | Remove torrents unused for this long.                                                                              |

Booleans read `0`, `false`, `no` and `off` as false and anything else as true.
`.env.example` carries the reasoning behind the tuning defaults, including what
was measured to arrive at them.

## HTTP API

Every route is `GET`. CORS is open to any origin for `GET` and `HEAD`. Failures
answer with `{"error": "..."}` and a status: 400 for a bad query, 404 for an
unknown info hash, path or file, 422 for a file that cannot be indexed, 504 on
timeout, 500 otherwise.

The `magnet` parameter is read from the raw query string, so an unencoded
magnet carrying its own `&tr=` trackers works as well as a percent-encoded one.

### `GET /m3u8?magnet=<magnet>&file=<index>`

Master playlist for one file, as `application/vnd.apple.mpegurl`. Without
`file`, the largest MKV or WebM in the torrent is used. The first call builds
the media index and writes the playlists, which takes as long as the swarm
needs to serve the header and the cues; later calls answer from disk.

### `GET /files?magnet=<magnet>`

The torrent's file list as JSON: `infoHash`, `name`, and `files` with `index`,
`name`, `path`, `length` and `playable`.

### `GET /warm?magnet=<magnet>&file=<index>`

Indexes a title and renders its first segments before anybody plays it. Returns
at once with `{ infoHash, ready, queued, warming, pending, full }`: `ready`
when the work is already done, `queued` when this call scheduled it, `warming`
when it is in flight, `pending` the queue depth, and `full` when the queue had
no room for it.

### `GET /:infoHash/:fileIndex/*path`

Media, as referenced by the playlists. The info hash, the file index and every
path segment are checked before any path is built.

| Path                           | Content                                   |
| ------------------------------ | ----------------------------------------- |
| `video/index.m3u8`             | Video media playlist                      |
| `video/init.mp4`               | Video init segment                        |
| `video/<n>.m4s`                | Video segment `n`, counted from zero      |
| `audio/<track>/index.m3u8`     | Audio media playlist for one track number |
| `audio/<track>/init.mp4`       | Audio init segment                        |
| `audio/<track>/<n>.m4s`        | Audio segment                             |
| `subtitles/<track>/index.m3u8` | Subtitle media playlist                   |
| `subtitles/<track>/<n>.vtt`    | Subtitle segment, WebVTT, no init segment |

A segment request renders the segment when it is not already cached, and moves
the playhead for that rendition, which is what drives prefetch.

### `GET /status`

Counters as JSON: every live torrent with its peer count and transfer speeds,
queue statistics, piece and segment cache usage, and the last measured size of
the cache directory.

## Tests

`npm test` builds and runs every suite. They need ffmpeg and ffprobe, build
their fixtures on first run, and take minutes. `test/README.md` covers what
each suite proves and how to run one on its own.

## License

AGPL-3.0-or-later. See `LICENSE`.
