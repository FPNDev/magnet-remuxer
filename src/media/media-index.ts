import type { ByteSource } from '../io/byte-source.js';
import { MatroskaError } from '../matroska/ebml.js';
import { readMatroskaLayout } from '../matroska/layout.js';
import type { SliceRange } from '../matroska/slicer.js';
import type { MkvTrack } from '../matroska/tracks.js';

export const MEDIA_INDEX_VERSION = 1;

export interface Keyframe {
  /** Timestamp in Matroska ticks. */
  ts: number;
  /** Absolute file offset of the cluster holding this keyframe. */
  cluster: number;
  /** Offset of the keyframe block inside the cluster payload, when known. */
  rel?: number | undefined;
}

/** Everything needed to serve a file as HLS; persisted as JSON. */
export interface MediaIndex {
  version: number;
  fileName: string;
  fileLength: number;
  docType: string;
  timestampScale: number;
  /** Seconds. */
  duration: number;
  firstClusterOffset: number;
  mediaEnd: number;
  /** Base64 raw EBML header element. */
  ebmlHeader: string;
  /** Base64 raw Info element. */
  info: string;
  tracks: MkvTrack[];
  videoTrack: number;
  keyframes: Keyframe[];
  /** For each HLS segment, the index in `keyframes` of its first keyframe. */
  segmentStarts: number[];
  targetDuration: number;
}

/** Where to read and which blocks to keep for one slice. */
export interface SliceTarget {
  readStart: number;
  readEnd: number;
  range: SliceRange;
}

/** A trailing segment shorter than this is merged into the previous one. */
const MIN_TAIL_SECONDS = 1;
/** How far a block may be stored from the video keyframes around it. */
const INTERLEAVE_SLACK_SECONDS = 2;
/** Worst-case cluster header plus enough of a block to read its header. */
const BOUNDARY_PEEK_BYTES = 12 + 64;

export async function buildMediaIndex(
  source: ByteSource,
  fileName: string,
  targetDuration: number,
): Promise<MediaIndex> {
  const layout = await readMatroskaLayout(source);

  const video = layout.tracks.find((track) => track.kind === 'video');
  if (!video) throw new MatroskaError('File has no video track');

  const keyframes: Keyframe[] = [];
  const cues = layout.cues
    .filter((cue) => cue.track === video.number)
    .sort((a, b) => a.time - b.time);
  for (const cue of cues) {
    if (keyframes.at(-1)?.ts === cue.time) continue;
    keyframes.push({
      ts: cue.time,
      cluster: cue.clusterPosition,
      rel: cue.relativePosition,
    });
  }
  if (keyframes.length === 0) {
    throw new MatroskaError('Cues index has no entries for the video track');
  }

  const toSeconds = (ticks: number) => (ticks * layout.timestampScale) / 1e9;
  const lastKeyframe = toSeconds(keyframes.at(-1)!.ts);
  let duration =
    layout.durationTicks === undefined ? 0 : toSeconds(layout.durationTicks);
  if (!(duration > lastKeyframe)) duration = lastKeyframe + targetDuration;

  return {
    version: MEDIA_INDEX_VERSION,
    fileName,
    fileLength: source.length,
    docType: layout.docType,
    timestampScale: layout.timestampScale,
    duration,
    firstClusterOffset: layout.firstClusterOffset,
    mediaEnd: layout.mediaEnd,
    ebmlHeader: layout.ebmlHeader.toString('base64'),
    info: layout.info.toString('base64'),
    tracks: layout.tracks,
    videoTrack: video.number,
    keyframes,
    segmentStarts: planSegments(
      keyframes.map((kf) => toSeconds(kf.ts)),
      duration,
      targetDuration,
    ),
    targetDuration,
  };
}

/**
 * Groups keyframes into segments whose length is as close to `target` as the
 * keyframe spacing allows. Returns the keyframe index opening each segment.
 */
export function planSegments(
  keyframeTimes: number[],
  duration: number,
  target: number,
): number[] {
  const starts = [0];
  let segmentStart = 0;

  for (let k = 1; k < keyframeTimes.length; k++) {
    const length = keyframeTimes[k]! - segmentStart;
    if (length < target) continue;

    // Cutting one keyframe earlier may land closer to the target.
    const prev = k - 1;
    const prevLength = keyframeTimes[prev]! - segmentStart;
    const pick =
      prev > starts.at(-1)! &&
      prevLength >= target / 2 &&
      target - prevLength < length - target
        ? prev
        : k;

    if (duration - keyframeTimes[pick]! < MIN_TAIL_SECONDS) break;
    starts.push(pick);
    segmentStart = keyframeTimes[pick]!;
    k = pick;
  }

  return starts;
}

export function ticksToSeconds(index: MediaIndex, ticks: number): number {
  return (ticks * index.timestampScale) / 1e9;
}

export function secondsToTicks(index: MediaIndex, seconds: number): number {
  return Math.round((seconds * 1e9) / index.timestampScale);
}

export function segmentCount(index: MediaIndex): number {
  return index.segmentStarts.length;
}

/** Segment start on the playlist timeline (segment 0 always starts at 0). */
export function segmentStart(index: MediaIndex, n: number): number {
  return n === 0 ? 0 : ticksToSeconds(index, segmentKeyframe(index, n).ts);
}

export function segmentEnd(index: MediaIndex, n: number): number {
  return n + 1 < index.segmentStarts.length
    ? segmentStart(index, n + 1)
    : index.duration;
}

function segmentKeyframe(index: MediaIndex, n: number): Keyframe {
  const k = index.segmentStarts[n];
  const keyframe = k === undefined ? undefined : index.keyframes[k];
  if (!keyframe) throw new RangeError(`Segment ${n} is out of range`);
  return keyframe;
}

/**
 * Slice for segment `n`, cut at the positions of the video keyframe blocks
 * that open this segment and the next. `tight` trusts CueRelativePosition to
 * stop reading right after the next keyframe's header.
 */
export function keyframeSlice(
  index: MediaIndex,
  n: number,
  tight = true,
): SliceTarget {
  const start = n === 0 ? undefined : segmentKeyframe(index, n);
  const endK = index.segmentStarts[n + 1];
  const end = endK === undefined ? undefined : index.keyframes[endK];

  let readEnd = index.mediaEnd;
  if (end && endK !== undefined) {
    readEnd = nextClusterAfter(index, endK);
    if (tight && end.rel !== undefined) {
      readEnd = Math.min(readEnd, end.cluster + BOUNDARY_PEEK_BYTES + end.rel);
    }
  }

  return {
    readStart: start ? start.cluster : index.firstClusterOffset,
    readEnd,
    range: {
      mode: 'keyframes',
      startKeyframe: start?.ts ?? null,
      endKeyframe: end?.ts ?? null,
    },
  };
}

/** Slice of one track's blocks with timestamps in [from, to) ticks. */
export function timeSlice(
  index: MediaIndex,
  from: number,
  to: number | null,
): SliceTarget {
  const slack = secondsToTicks(index, INTERLEAVE_SLACK_SECONDS);
  let readStart = index.firstClusterOffset;
  let readEnd = index.mediaEnd;

  for (const keyframe of index.keyframes) {
    if (keyframe.ts <= from - slack) {
      readStart = keyframe.cluster;
    } else if (to !== null && keyframe.ts > to + slack) {
      readEnd = keyframe.cluster;
      break;
    }
  }

  return { readStart, readEnd, range: { mode: 'time', from, to } };
}

/** Upper bound for the end of the cluster holding keyframe `k`. */
function nextClusterAfter(index: MediaIndex, k: number): number {
  const cluster = index.keyframes[k]!.cluster;
  for (let i = k + 1; i < index.keyframes.length; i++) {
    const next = index.keyframes[i]!.cluster;
    if (next > cluster) return Math.min(index.mediaEnd, next);
  }
  return index.mediaEnd;
}
