# Magnet links MKV remuxer

Turns a magnet link into an HLS stream: `GET /m3u8?magnet=...` returns a playlist,
and the segments behind it are produced on demand by remuxing the torrent's MKV
into fragmented MP4. Only the bytes a player actually asks for are downloaded.

```
GET /m3u8?magnet=magnet:?xt=urn:btih:...
```

## Running

```bash
npm install
npm start            # compiles, then runs dist/index.js
```

Needs Node 20.12+ and ffmpeg on `PATH` (or `FFMPEG_PATH`). Developed against ffmpeg 9.0.1

```bash
npm test             # builds, then runs the suites in test/ (see test/README.md)
```

## Endpoints

| Endpoint                                 | Purpose                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /m3u8?magnet=<link>[&file=<index>]` | Master playlist. Without `file`, the largest MKV/WebM in the torrent is used.      |
| `GET /files?magnet=<link>`               | Files in the torrent, flagging which are playable.                                 |
| `GET /status`                            | Torrents, peers, job queue and cache sizes.                                        |
| `GET /<infoHash>/<fileIndex>/...`        | Media playlists, init sections and segments, as referenced by the master playlist. |

Everything below `/<infoHash>/<fileIndex>/` mirrors the cache layout on disk:

```
video/index.m3u8        video/init.mp4        video/7.m4s
audio/2/index.m3u8      audio/2/init.mp4      audio/2/7.m4s
subtitles/4/index.m3u8                        subtitles/4/7.vtt
```

The numbers in `audio/2` and `subtitles/4` are Matroska track numbers, so a
segment URL is stable for a given torrent, file and track.

## How a request is served

1. **Index.** The MKV header (Info + Tracks) and the Cues index are read from the
   torrent - a few hundred KB, not the whole file. The cues give every keyframe's
   timestamp and byte offset, which is what makes an accurate playlist (and
   therefore correct duration and seeking) possible without downloading the file.
2. **Plan.** Keyframes are grouped into segments of about `SEGMENT_DURATION`
   seconds. Segment boundaries are always keyframes, so segments can be remuxed
   independently.
3. **Slice.** For one segment of one track, only that byte range is streamed from
   the torrent. A small synthetic header (EBML header, Info, and the single
   TrackEntry) is put in front of it, and blocks are cut exactly at the keyframe
   blocks that open this segment and the next. Clusters are re-opened as needed,
   so keyframes in the middle of a cluster are handled.
4. **Remux.** That stream is piped to ffmpeg, which writes fragmented MP4
   (`moof`+`mdat`) - a copy for video and for browser-playable audio, an AAC
   conversion otherwise. Text subtitles become WebVTT.
5. **Cache.** Playlists, indexes, init sections and segments are written under
   `CACHE_DIR` and served directly on later requests. The next few segments are
   rendered in the background so a player stays ahead of the playhead.

### Tracks

Video is always copied (H.264, HEVC, AV1, VP9). Audio is copied when browsers can
play it from fMP4 (AAC, MP3, Opus, FLAC) and converted to AAC otherwise (AC3,
E-AC3, DTS, TrueHD, ...), keeping the source's channel layout up to 5.1; anything
wider is folded down to that, since eight-channel support is patchy. Every audio
track becomes an HLS alternate rendition, and every text subtitle track
(SRT/ASS/SSA/WebVTT) a WebVTT rendition. Image subtitles (PGS, VobSub) are
skipped.

Converted audio is encoded with padding on both sides of each segment, which is
then dropped, so segments meet on the AAC frame grid without gaps or clicks. Its
init section is encoded from silence rather than from the source: the moov
describes our AAC output either way, and DTS and TrueHD report no stream format
at all until they have decoded a frame, which a header alone never gives them.

### Timestamps

Segments keep their original timestamps plus a fixed 10s offset, so decode times
stay positive with B-frames and every segment lands where the playlist says it
does. WebVTT segments carry the matching `X-TIMESTAMP-MAP`.

## Configuration

All optional; `.env.example` lists every one of them at its default, and
`src/config.ts` is where those defaults live.

| Variable               | Default              | Meaning                                                                                                                              |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                 | `3000`               | HTTP port.                                                                                                                           |
| `FFMPEG_PATH`          | `ffmpeg`             | ffmpeg binary.                                                                                                                       |
| `CACHE_DIR`            | `<tmp>/magnet-cache` | Where pieces, playlists and segments live.                                                                                           |
| `PIECE_CACHE_MB`       | `8192`               | Disk budget for all cached torrent pieces together.                                                                                  |
| `SEGMENT_CACHE_MB`     | `15360`              | Disk budget for rendered segments.                                                                                                   |
| `SEGMENT_DURATION`     | `2`                  | Target segment length in seconds. A seek downloads a whole segment before its first frame, so shorter starts faster.                 |
| `PREFETCH_SEGMENTS`    | `9`                  | Segments rendered ahead of the player.                                                                                               |
| `PREFETCH_AHEAD_MB`    | `96`                 | Cap on prefetch by bytes read; segments of a big 4K remux might be tens of MB each.                                                  |
| `REQUEST_TIMEOUT_S`    | `120`                | A request waiting longer than this fails with 504.                                                                                   |
| `MAX_CONCURRENT_JOBS`  | `max(16, cpus)`      | Concurrent ffmpeg jobs across all torrents. Mostly waiting on the swarm rather than on CPU, so more than one per core is reasonable. |
| `MAX_JOBS_PER_TORRENT` | `2`                  | Concurrent jobs reading one torrent. Reads of the same torrent divide its bandwidth rather than adding to it.                        |
| `JOB_TIMEOUT_S`        | `180`                | Hard limit for one segment job.                                                                                                      |
| `READ_STALL_S`         | `45`                 | Fail a read when the _torrent_ receives nothing for this long.                                                                       |
| `METADATA_TIMEOUT_S`   | `90`                 | How long to wait for torrent metadata.                                                                                               |
| `TORRENT_IDLE_S`       | `600`                | Remove torrents unused for this long.                                                                                                |
| `LOG_LEVEL`            | `info`               | `debug`, `info`, `warn` or `error`.                                                                                                  |

### Why reads queue

A torrent's peers hand over a fixed number of bytes per second, and WebTorrent
serves each read one whole piece at a time - so a read produces nothing at all
until its current piece lands. On a release with 16 MiB pieces that is the unit
of latency, and opening more reads does not make the torrent faster: it divides
the same bandwidth further, until every read is slower than a player will wait.
A dozen reads sharing 4 MiB/s put a 16 MiB piece about 50 seconds away.

So jobs on one torrent queue rather than compete (`MAX_JOBS_PER_TORRENT`), and a
player waiting for a segment preempts prefetching that holds its torrent's slots
even when the pool is half empty - which is what makes a seek fast, since the
prefetches left behind at the old position would otherwise run to completion.

`test/bandwidth.mjs` measures the trade-off against a throttled seeder if you
want to pick the number for your own connection.

## Cache layout

```
<CACHE_DIR>/
  pieces/<infoHash>/<n>.piece                    # wiped on start
  torrents/<infoHash>/                           # magnet.txt, metadata.torrent, info.json
  hls/<infoHash>/<fileIndex>/                    # index.json, master.m3u8, renditions
```

Pieces are a sliding window: the least recently used ones are deleted once the
budget is reached, and peers are told the pieces were dropped (BEP 54) so they
don't mistake the server for a seeder. Anything dropped is downloaded again if a
later request needs it.

One budget covers every torrent, file and viewer rather than one per file: on a
busy title dozens of players read different parts of the same remux, and
whichever ranges are hot should stay resident.

Saved torrent metadata means a restart doesn't re-fetch metadata from peers, and
cached playlists and segments are served without touching the swarm at all.

## Limits

- MKV and WebM only, and the file must have a Cues index (virtually all do).
  Streaming a file without one would require downloading all of it.
- Video codecs other than H.264/HEVC/AV1/VP9 are rejected rather than re-encoded.
- Segment numbering depends on `SEGMENT_DURATION`; changing it invalidates
  anything already cached for a file (handled automatically).
