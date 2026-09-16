# Tests

```bash
npm test          # builds, then runs every suite
```

Needs ffmpeg and ffprobe (`FFMPEG_PATH` / `FFPROBE_PATH` if they aren't on
`PATH`; ffprobe is assumed to sit next to ffmpeg). Nothing touches the network:
torrents are seeded from a second WebTorrent client in the test process and
reached over `127.0.0.1`.

| Suite | What it covers |
| --- | --- |
| `make-fixtures.mjs` | Builds the MKVs the rest use: `movie.mkv` (H.264 with B-frames, AAC + AC3 5.1, SRT + ASS) and `tiny.mkv`, whose keyframes sit mid-cluster like a mkvmerge release. Skips rebuilding unless `--force`. |
| `remux.mjs` | Renders every segment of every rendition from a local file and compares with the source: packet counts, unchanged timestamps, no decode-order regressions, segments starting where the playlist says, contiguous AAC across boundaries, every subtitle cue exactly once. |
| `piece-cache.mjs` | Streams a whole file under an 8 MiB piece budget: eviction happens, the budget holds, and evicted pieces are downloaded again on demand. |
| `e2e.mjs` | Drives the real HTTP server: cold playlists, sequential playback of all renditions, seeking on a cold cache, six concurrent clients, switching to a track whose pieces were evicted, and a restart serving from disk. |

Run one on its own, e.g.:

```bash
node test/remux.mjs test/.work/fixtures/tiny.mkv 2
node test/e2e.mjs                                    # TEST_PORT=3901 by default
```

Fixtures, caches, rendered output and server logs land in `test/.work/`
(`test/.work/logs/<server>.log` is the first place to look when e2e fails).
