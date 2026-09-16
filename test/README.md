# Tests

```bash
npm test          # builds, then runs every suite
```

Needs ffmpeg and ffprobe (`FFMPEG_PATH` / `FFPROBE_PATH` if they aren't on
`PATH`; ffprobe is assumed to sit next to ffmpeg). Nothing touches the network:
torrents are seeded from a second WebTorrent client in the test process and
reached over `127.0.0.1`.

| Suite               | What it covers                                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make-fixtures.mjs` | Builds the MKVs the rest use: `movie.mkv` (H.264 with B-frames, AAC + AC3 5.1, SRT + ASS), `sparse.mkv` (subtitles only near the start), `codecs.mkv` (DTS, TrueHD and FLAC audio) and `tiny.mkv`, whose keyframes sit mid-cluster like a mkvmerge release. Skips rebuilding unless `--force`. |
| `remux.mjs`         | Renders every segment of every rendition from a local file and compares with the source: packet counts, unchanged timestamps, no decode-order regressions, segments starting where the playlist says, contiguous AAC across boundaries, every subtitle cue exactly once.                       |
| `piece-cache.mjs`   | Streams a whole file under an 8 MiB piece budget: eviction happens, the budget holds, and evicted pieces are downloaded again on demand.                                                                                                                                                       |
| `e2e.mjs`           | Drives the real HTTP server: cold playlists, sequential playback of all renditions, seeking on a cold cache, six concurrent clients, switching to a track whose pieces were evicted, and a restart serving from disk.                                                                          |
| `inspect.mjs`       | Not part of `npm test`: a diagnostic for your own resources. Prints its tracks, the renditions they map to, and which blocks a segment's slice actually contains, and with `--remux` renders that segment through the real pipeline.                                                           |
| `bandwidth.mjs`     | Not part of `npm test`: measures `MAX_JOBS_PER_TORRENT` against a throttled seeder with big pieces, which is what a large release looks like from a starved swarm. Reports playback latency and the first segment after a seek for each limit.                                                 |

Run one on its own, e.g.:

```bash
node test/remux.mjs test/.work/fixtures/tiny.mkv 2
node test/e2e.mjs                                    # TEST_PORT=3901 by default
```

`inspect.mjs` is the tool for debugging your own resources. It takes a magnet
link, or a path to a file already on disk:

```bash
node test/inspect.mjs "magnet:?xt=..." - 0,40,120       # file index, segments
node test/inspect.mjs some/release.mkv - 40 --remux     # render every rendition
```

`INSPECT_STORE` moves its torrent store off the default drive - WebTorrent
preallocates the whole file, so a 4K remux needs tens of GB free.

`bandwidth.mjs` answers "what should `MAX_JOBS_PER_TORRENT` be?". Seeding over
localhost gives the server more bandwidth than it can use, so it can only show
the cost of a limit set too low; throttling the seeder and enlarging its pieces
reproduces the regime where reads divide bandwidth instead of adding to it:

```bash
node test/bandwidth.mjs 1024 1024 1,2,4,8,32   # KiB/s seed, KiB pieces, limits
```

Watch the last column. Playback throughput is flat across limits - the swarm is
the ceiling either way - while the first segment after a seek gets steadily
worse as the limit rises, because prefetches left at the old position are still
holding the torrent.

Fixtures, caches, rendered output and server logs land in `test/.work/`
(`test/.work/logs/<server>.log` is the first place to look when e2e fails).
