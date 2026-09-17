import { asBuffer } from '../io/byte-source.js';
import {
  encodeElement,
  encodeId,
  encodeUint,
  MatroskaError,
  readElementHeader,
  readVint,
  UNKNOWN_SIZE,
  UNKNOWN_SIZE_VINT,
  vintLength,
  type ElementHeader,
} from './ebml.js';
import { Id, TOP_LEVEL_IDS } from './ids.js';

export type SliceRange =
  /**
   * Blocks stored between two video keyframe blocks (by file position).
   * `null` means the start or end of the input.
   */
  | {
      mode: 'keyframes';
      startKeyframe: number | null;
      endKeyframe: number | null;
    }
  /** Blocks of the track with timestamps in [from, to). */
  | { mode: 'time'; from: number; to: number | null };

export interface SliceOptions {
  /** Stream header from buildTrackHeader(). */
  header: Buffer;
  /** Track whose blocks are emitted. */
  track: number;
  /** Track whose keyframes delimit 'keyframes' ranges. */
  videoTrack: number;
  range: SliceRange;
}

export interface SliceResult {
  blocks: number;
  /** The start keyframe was found (always true for open starts and time ranges). */
  started: boolean;
  /** The slice stopped at its end boundary rather than at the end of the input. */
  reachedEnd: boolean;
  /**
   * The input ran out. False when the slice was cut short because whoever was
   * reading it stopped - an encoder that has filled its window, say.
   */
  sourceEnded: boolean;
  /**
   * Timestamp of the first block of the track in the input, kept or not. Blocks
   * of one track are stored in timestamp order, so if this is no later than a
   * range's start, nothing the range needs lies before where reading began.
   */
  firstTrackTs: number | null;
}

/** Bytes of a block element needed to read its track number and timestamp. */
const BLOCK_PEEK = 64;
const MAX_ELEMENT_SIZE = 256 * 1024 * 1024;

/** A cluster with no blocks; lets a demuxer finish reading headers. */
export const EMPTY_CLUSTER = encodeElement(
  Id.Cluster,
  encodeElement(Id.Timestamp, encodeUint(0)),
);

/** EBML header + unsized Segment + Info + a Tracks element holding one TrackEntry. */
export function buildTrackHeader(
  ebmlHeader: Buffer,
  info: Buffer,
  trackEntry: Buffer,
): Buffer {
  return Buffer.concat([
    ebmlHeader,
    encodeId(Id.Segment),
    UNKNOWN_SIZE_VINT,
    info,
    encodeElement(Id.Tracks, trackEntry),
  ]);
}

/**
 * Turns a byte range of Matroska clusters into a standalone single-track
 * Matroska stream. The source must begin at a Cluster element.
 */
export function sliceMatroska(
  source: AsyncIterable<Uint8Array>,
  options: SliceOptions,
): { stream: AsyncGenerator<Buffer>; result: SliceResult } {
  const result: SliceResult = {
    blocks: 0,
    started: false,
    reachedEnd: false,
    sourceEnded: false,
    firstTrackTs: null,
  };
  return { result, stream: generate(source, options, result) };
}

async function* generate(
  source: AsyncIterable<Uint8Array>,
  { header, track, videoTrack, range }: SliceOptions,
  result: SliceResult,
): AsyncGenerator<Buffer> {
  const iterator = source[Symbol.asyncIterator]();
  const input = new ByteQueue(iterator);

  let started = range.mode === 'time' || range.startKeyframe === null;
  result.started = started;

  let inCluster = false;
  let clusterEnd = Infinity;
  let clusterTs: number | undefined;
  let clusterOpened = false;

  try {
    yield header;

    while (await input.fill(1)) {
      await input.fill(12);
      const element = readElementHeader(input.peek(12), 0);
      if (!element) {
        break;
      }

      if (inCluster && input.position >= clusterEnd) {
        inCluster = false;
      }

      if (element.id === Id.Cluster) {
        input.take(element.headerLength);
        inCluster = true;
        clusterEnd =
          element.size === UNKNOWN_SIZE
            ? Infinity
            : input.position + element.size;
        clusterTs = undefined;
        clusterOpened = false;
        continue;
      }
      // Cues, Tags and friends follow the last cluster.
      if (TOP_LEVEL_IDS.has(element.id)) break;

      if (element.size === UNKNOWN_SIZE) {
        throw new MatroskaError('Unsized element inside cluster data');
      }
      const total = element.headerLength + element.size;
      const isBlock =
        element.id === Id.SimpleBlock || element.id === Id.BlockGroup;

      if (!inCluster || (!isBlock && element.id !== Id.Timestamp)) {
        if (!(await input.skip(total))) {
          break;
        }
        continue;
      }

      if (element.id === Id.Timestamp) {
        if (!(await input.fill(total))) {
          break;
        }
        clusterTs = readUintBytes(input.take(total), element.headerLength);
        continue;
      }

      if (clusterTs === undefined) {
        throw new MatroskaError('Block found before its cluster timestamp');
      }
      if (total > MAX_ELEMENT_SIZE) {
        throw new MatroskaError(
          `Block of ${total} bytes exceeds the size limit`,
        );
      }

      const peekLength = Math.min(total, BLOCK_PEEK);
      if (!(await input.fill(peekLength))) {
        break;
      }
      let block = parseBlockHeader(input.peek(peekLength), element);
      if (!block) {
        if (!(await input.fill(total))) {
          break;
        }
        block = parseBlockHeader(input.peek(total), element);
        if (!block) {
          throw new MatroskaError('Malformed block header');
        }
      }
      const ts = clusterTs + block.relativeTs;
      if (block.track === track && result.firstTrackTs === null) {
        result.firstTrackTs = ts;
      }

      let emit: boolean;
      if (range.mode === 'keyframes') {
        const isVideo = block.track === videoTrack;
        if (!started) {
          started = isVideo && ts === range.startKeyframe;
          result.started = started;
        } else if (isVideo && ts === range.endKeyframe) {
          result.reachedEnd = true;
          break;
        }
        emit = started && block.track === track;
      } else {
        if (block.track === track && range.to !== null && ts >= range.to) {
          result.reachedEnd = true;
          break;
        }
        emit = block.track === track && ts >= range.from;
      }

      if (!emit) {
        if (!(await input.skip(total))) {
          break;
        }
        continue;
      }
      if (!(await input.fill(total))) {
        break;
      }

      if (!clusterOpened) {
        clusterOpened = true;
        yield Buffer.concat([
          encodeId(Id.Cluster),
          UNKNOWN_SIZE_VINT,
          encodeElement(Id.Timestamp, encodeUint(clusterTs)),
        ]);
      }
      result.blocks++;
      yield input.take(total);
    }

    // A slice can hold no blocks at all - a stretch of film with no subtitles,
    // say - and a demuxer cannot finish reading headers until it reaches a
    // cluster, so give it an empty one rather than an unopenable stream.
    if (result.blocks === 0) yield EMPTY_CLUSTER;
  } finally {
    result.sourceEnded = input.ended;
    await iterator.return?.();
  }
}

function readUintBytes(buf: Buffer, start: number): number {
  let value = 0;
  for (let i = start; i < buf.length; i++) {
    value = value * 256 + buf[i]!;
  }
  return value;
}

/** Reads the track number and relative timestamp; null if `buf` is too short. */
function parseBlockHeader(
  buf: Buffer,
  element: ElementHeader,
): { track: number; relativeTs: number } | null {
  let pos = element.headerLength;

  if (element.id === Id.BlockGroup) {
    const end = element.headerLength + element.size;
    let cursor = element.headerLength;
    pos = -1;
    while (cursor < end && cursor < buf.length) {
      const child = readElementHeader(buf, cursor);
      if (!child) {
        return null;
      }
      if (child.size === UNKNOWN_SIZE) {
        throw new MatroskaError('Unsized element inside BlockGroup');
      }
      if (child.id === Id.Block) {
        pos = cursor + child.headerLength;
        break;
      }
      cursor += child.headerLength + child.size;
    }
    if (pos === -1) {
      if (cursor >= end) {
        throw new MatroskaError('BlockGroup without a Block');
      }
      return null;
    }
  }

  if (pos >= buf.length) {
    return null;
  }
  const trackLength = vintLength(buf[pos]!);
  if (pos + trackLength + 2 > buf.length) {
    return null;
  }

  return {
    track: readVint(buf, pos).value,
    relativeTs: buf.readInt16BE(pos + trackLength),
  };
}

/** A FIFO byte buffer over an async chunk iterator. */
class ByteQueue {
  private readonly chunks: Buffer[] = [];
  private head = 0;
  /** The source iterator reported that it has no more data. */
  ended = false;
  /** Buffered bytes. */
  length = 0;
  /** Bytes consumed since the start of the source. */
  position = 0;

  constructor(private readonly source: AsyncIterator<Uint8Array>) {}

  /** Buffers at least `n` bytes; false if the source ends first. */
  async fill(n: number): Promise<boolean> {
    while (this.length < n) {
      if (this.ended) {
        return false;
      }
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
        return false;
      }
      const chunk = asBuffer(next.value);
      if (chunk.length === 0) {
        continue;
      }
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    return true;
  }

  /** Up to `n` buffered bytes, without consuming them. */
  peek(n: number): Buffer {
    return this.copy(Math.min(n, this.length));
  }

  /** Consumes `n` buffered bytes. */
  take(n: number): Buffer {
    const out = this.copy(n);
    this.consume(n);
    return out;
  }

  /** Discards `n` bytes, pulling from the source as needed. */
  async skip(n: number): Promise<boolean> {
    let rest = n;
    while (rest > 0) {
      if (this.length === 0 && !(await this.fill(1))) {
        return false;
      }
      const step = Math.min(rest, this.length);
      this.consume(step);
      rest -= step;
    }
    return true;
  }

  private copy(n: number): Buffer {
    const first = this.chunks[0];
    if (!first || n === 0) {
      return Buffer.alloc(0);
    }
    if (first.length - this.head >= n) {
      return first.subarray(this.head, this.head + n);
    }

    const out = Buffer.allocUnsafe(n);
    let written = 0;
    for (let i = 0, offset = this.head; written < n; i++, offset = 0) {
      const chunk = this.chunks[i]!;
      const end = Math.min(chunk.length, offset + n - written);
      written += chunk.copy(out, written, offset, end);
    }
    return out;
  }

  private consume(n: number): void {
    this.length -= n;
    this.position += n;
    let rest = n;
    while (rest > 0) {
      const chunk = this.chunks[0]!;
      const available = chunk.length - this.head;
      if (available > rest) {
        this.head += rest;
        return;
      }
      rest -= available;
      this.chunks.shift();
      this.head = 0;
    }
  }
}
