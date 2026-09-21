# Tests

Plain Node scripts, no test framework. Each suite is an ESM file you run
directly. It prints one line per check and exits non-zero if any check failed.
Suites import from `dist/`, so the project has to be built before they run.

Anything a suite writes lands under `test/.work/`: fixtures in
`test/.work/fixtures`, server output in `test/.work/logs/<name>.log`, cache
directories beside them. The whole directory is disposable and is not
committed.

## What you need

- ffmpeg and ffprobe. `FFMPEG_PATH` points at ffmpeg; ffprobe is looked for
  next to it, so set `FFPROBE_PATH` only if the two live apart.
- Fixtures. `make-fixtures.mjs` builds four MKVs on first run and skips the
  work if they are already there. `node test/make-fixtures.mjs --force`
  rebuilds them after changing the builder.
- Nothing from the network. Suites that need a torrent seed a fixture from an
  in-process WebTorrent client with trackers, DHT and LSD switched off, and
  hand the server a magnet whose `x.pe` points at that seeder on 127.0.0.1.
  Peer behaviour that a real swarm would have to supply, such as a peer
  sending corrupt blocks, comes from the scripted peer in `lib.mjs`.
- Time. The full run takes minutes, mostly in ffmpeg.

`swarm.mjs` is the exception: it wants a real magnet and a real network.

## Running

```sh
npm run build
npm test
```

`npm test` runs `tsc` and then `test/run-all.mjs`. The order there is fixed:
`queue.mjs` first because it needs no fixture, `make-fixtures.mjs` next because
everything below it reads an MKV, then the rest. `remux.mjs` runs five times
with different fixtures and target segment durations.

One suite at a time:

```sh
node test/queue.mjs
node test/e2e.mjs
node test/remux.mjs test/.work/fixtures/tiny.mkv 2
```

`remux.mjs` takes a path to an MKV and the target segment duration in seconds,
and `run-all.mjs` passes both. Two others take optional arguments: `abort.mjs`
an attempt count and a batch size, `tail-hedge.mjs` the number of bytes to
read. Suites that start a server bind a port on loopback; `bandwidth.mjs`,
`concurrency.mjs`, `e2e.mjs`, `multi.mjs` and `peers.mjs` read `TEST_PORT` if
you need to move them.

## Fixtures

| File         | Shape                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `movie.mkv`  | 1280x720, about two minutes, keyframes every 1.7s so segment boundaries never land on a round second. Stereo AAC that can be copied plus 5.1 AC3 that has to be transcoded, and a subtitle track. |
| `sparse.mkv` | Subtitle cues in the first six seconds and none after, so most subtitle segments come out empty.                                                                                                  |
| `codecs.mkv` | DTS, TrueHD, FLAC and Vorbis at 5.1 and 7.1, for the copy-or-transcode decision and the AAC channel limit.                                                                                        |
| `tiny.mkv`   | 64x64 with a keyframe every half second, for suites that want many segments cheaply.                                                                                                              |

## Suites

| Suite               | What it covers                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue.mjs`         | `TaskQueue` alone: background slots capped, a player preempting prefetch, cancellation on a seek, per-torrent share of the pool. No fixture, no ffmpeg.                                                                                     |
| `remux.mjs`         | Index, slice and remux one local file. Playlist duration against the source, segments starting where the playlist says, AAC frames contiguous across boundaries, channel counts, subtitle cues appearing once, packet timestamps unchanged. |
| `audio-window.mjs`  | The byte window a converted audio segment reads. A tight read has to produce the same segment as a generous one and read less; a file with a keyframe cluster out of place has to be caught and read again.                                 |
| `abort.mjs`         | Renders stopped part way through. Every aborted render settles and none is left running.                                                                                                                                                    |
| `piece-cache.mjs`   | `PieceCache` with two files under one budget. Reads return the file bytes, the store stays near its budget, pieces follow whoever is reading, evicted pieces come back on demand.                                                           |
| `e2e.mjs`           | The HTTP surface against a running server: bad magnets, the file list, a cold master playlist, init sections and segments, subtitle cues, identical bytes for concurrent requests, and what is still served from disk after a restart.      |
| `multi.mjs`         | Two torrents playing at once, then two files of a single torrent.                                                                                                                                                                           |
| `concurrency.mjs`   | Scrubbing, two viewers far apart in one file, one reading ahead while the other seeks, a player landing cold, and a second seek before anything arrives.                                                                                    |
| `peers.mjs`         | Peer memory. The address carried in the magnet gets the first player served, and remembered peers are what let the swarm be found again.                                                                                                    |
| `tail-hedge.mjs`    | A peer that takes a block and goes quiet. The duplicate request finishes the read, and the same read without hedging does not.                                                                                                              |
| `peer-churn.mjs`    | Useless peers holding every slot. Churn drops peers that are no use for the current read, a seeder gets in, and a dropped peer offered again is not dialled back.                                                                           |
| `corrupt-peers.mjs` | A peer answering with noise. The piece fails verification, the peer is banned, the ban survives on disk, and the honest seeder serves the read.                                                                                             |
| `piece-reuse.mjs`   | A torrent going idle and its pieces staying, the same title read with the swarm switched off, and a stored piece corrupted on disk being thrown away rather than served.                                                                    |
| `cache-budget.mjs`  | `DiskGuard` sweeps: the metadata budget, a title in use never swept, oldest first across pieces and segments, and temp files a dead render left behind.                                                                                     |
| `warm.mjs`          | Warming a title before anyone plays it. Readiness, playlists and first frame off the disk afterwards, and the file list after a restart.                                                                                                    |

## Benchmarks and tools

These print numbers and exit 0. They prove nothing on their own.

| Script            | Arguments                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bandwidth.mjs`   | seed rate in KiB/s, piece length in KiB, per-torrent job limits to compare. Plays through a capped seeder at each limit.                                                          |
| `first-frame.mjs` | seed rate in KiB/s, piece length in KiB, variants as `name=entry:segmentSeconds:prefetch`. With no variants it measures `dist/` against an earlier build left in `dist-before/`.  |
| `swarm.mjs`       | a magnet, a repeat count, variants as `name=ENV=VALUE,...`. Measures startup and seeks against a real swarm.                                                                      |
| `inspect.mjs`     | a magnet or file path, a file index or `-`, a comma-separated segment list, and `--remux` to render them. Prints tracks, renditions, keyframe slices and a block tally per slice. |
