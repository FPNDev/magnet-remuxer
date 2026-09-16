import { readRange, type ByteSource } from '../io/byte-source.js';
import { parseCues, type CuePoint } from './cues.js';
import {
  childElements,
  MatroskaError,
  readElementHeader,
  readFloat,
  readString,
  readUint,
  UNKNOWN_SIZE,
  type EbmlElement,
  type ElementHeader,
} from './ebml.js';
import { Id } from './ids.js';
import { parseTracks, type MkvTrack } from './tracks.js';

/** Everything needed to index a Matroska file, read without touching cluster data. */
export interface MatroskaLayout {
  docType: string;
  /** Raw EBML header element. */
  ebmlHeader: Buffer;
  /** Raw Info element. */
  info: Buffer;
  timestampScale: number;
  durationTicks: number | undefined;
  firstClusterOffset: number;
  /** Absolute offset where cluster data ends (trailing Cues/Tags or end of Segment). */
  mediaEnd: number;
  tracks: MkvTrack[];
  /** Cue points, with `clusterPosition` converted to an absolute file offset. */
  cues: CuePoint[];
}

interface RawElement {
  header: ElementHeader;
  data: Buffer;
}

const READ_AHEAD = 256 * 1024;

/** Caches fetched ranges so walking the header doesn't hit the source per element. */
class CachedReader {
  private readonly blocks: { start: number; data: Buffer }[] = [];

  constructor(private readonly source: ByteSource) {}

  async read(start: number, end: number): Promise<Buffer> {
    end = Math.min(end, this.source.length);
    for (const block of this.blocks) {
      if (start >= block.start && end <= block.start + block.data.length) {
        return block.data.subarray(start - block.start, end - block.start);
      }
    }

    const fetchEnd = Math.min(
      this.source.length,
      Math.max(end, start + READ_AHEAD),
    );
    const data = await readRange(this.source, start, fetchEnd);
    if (data.length < end - start) {
      throw new MatroskaError(`Unexpected end of file at byte ${start}`);
    }
    this.blocks.push({ start, data });
    return data.subarray(0, end - start);
  }

  async header(pos: number): Promise<ElementHeader> {
    const header = readElementHeader(await this.read(pos, pos + 12), 0);
    if (!header) throw new MatroskaError(`Truncated element at byte ${pos}`);
    return header;
  }

  /** Reads a whole sized element; undefined if its ID isn't `expectedId`. */
  async element(pos: number, expectedId?: number): Promise<RawElement | undefined> {
    const header = await this.header(pos);
    if (expectedId !== undefined && header.id !== expectedId) return undefined;
    if (header.size === UNKNOWN_SIZE) {
      throw new MatroskaError(`Unsized element at byte ${pos}`);
    }
    const data = await this.read(pos, pos + header.headerLength + header.size);
    return { header, data };
  }
}

const asElement = ({ header, data }: RawElement): EbmlElement => ({
  id: header.id,
  start: 0,
  dataStart: header.headerLength,
  dataEnd: data.length,
});

export async function readMatroskaLayout(
  source: ByteSource,
): Promise<MatroskaLayout> {
  const reader = new CachedReader(source);

  const ebml = await reader.element(0, Id.EBML);
  if (!ebml) throw new MatroskaError('Not a Matroska file');

  let docType = 'matroska';
  for (const el of childElements(ebml.data, ebml.header.headerLength)) {
    if (el.id === Id.DocType) docType = readString(ebml.data, el);
  }
  if (docType !== 'matroska' && docType !== 'webm') {
    throw new MatroskaError(`Unsupported DocType "${docType}"`);
  }

  let pos = ebml.data.length;
  let segment = await reader.header(pos);
  while (segment.id === Id.Void && segment.size !== UNKNOWN_SIZE) {
    pos += segment.headerLength + segment.size;
    segment = await reader.header(pos);
  }
  if (segment.id !== Id.Segment) {
    throw new MatroskaError('Segment element not found');
  }

  const segmentStart = pos + segment.headerLength;
  const segmentEnd =
    segment.size === UNKNOWN_SIZE
      ? source.length
      : Math.min(source.length, segmentStart + segment.size);

  const seeks = new Map<number, number[]>();
  const loadedSeekHeads = new Set<number>();
  const loadSeekHead = async (at: number) => {
    if (loadedSeekHeads.has(at)) return;
    loadedSeekHeads.add(at);

    const head = await reader.element(at, Id.SeekHead);
    if (!head) return;
    for (const seek of childElements(head.data, head.header.headerLength)) {
      if (seek.id !== Id.Seek) continue;
      let id: number | undefined;
      let position: number | undefined;
      for (const el of childElements(head.data, seek.dataStart, seek.dataEnd)) {
        if (el.id === Id.SeekID) id = readUint(head.data, el);
        if (el.id === Id.SeekPosition) position = readUint(head.data, el);
      }
      if (id !== undefined && position !== undefined) {
        seeks.set(id, [...(seeks.get(id) ?? []), segmentStart + position]);
      }
    }
  };

  let info: RawElement | undefined;
  let tracks: RawElement | undefined;
  let cues: RawElement | undefined;
  let firstCluster: number | undefined;

  // Walk top-level elements up to the first cluster; big ones (attachments) are skipped unread.
  pos = segmentStart;
  while (pos < segmentEnd) {
    const header = await reader.header(pos);
    if (header.id === Id.Cluster) {
      firstCluster = pos;
      break;
    }
    if (header.size === UNKNOWN_SIZE) {
      throw new MatroskaError(`Unsized top-level element at byte ${pos}`);
    }

    if (header.id === Id.SeekHead) await loadSeekHead(pos);
    else if (header.id === Id.Info) info = await reader.element(pos);
    else if (header.id === Id.Tracks) tracks = await reader.element(pos);
    else if (header.id === Id.Cues) cues = await reader.element(pos);

    pos += header.headerLength + header.size;
  }
  if (firstCluster === undefined) {
    throw new MatroskaError('File has no clusters');
  }

  // A SeekHead may reference another one, typically at the end of the file.
  for (let i = 0; i < (seeks.get(Id.SeekHead)?.length ?? 0); i++) {
    await loadSeekHead(seeks.get(Id.SeekHead)![i]!);
  }

  const bySeek = async (id: number) => {
    for (const at of seeks.get(id) ?? []) {
      const element = await reader.element(at, id);
      if (element) return element;
    }
    return undefined;
  };
  info ??= await bySeek(Id.Info);
  tracks ??= await bySeek(Id.Tracks);
  cues ??= await bySeek(Id.Cues);

  if (!info) throw new MatroskaError('Info element not found');
  if (!tracks) throw new MatroskaError('Tracks element not found');
  if (!cues) {
    throw new MatroskaError(
      'File has no Cues index, so it cannot be streamed without a full download',
    );
  }

  let timestampScale = 1_000_000;
  let durationTicks: number | undefined;
  for (const el of childElements(info.data, info.header.headerLength)) {
    if (el.id === Id.TimestampScale) timestampScale = readUint(info.data, el);
    if (el.id === Id.Duration) durationTicks = readFloat(info.data, el);
  }

  let mediaEnd = segmentEnd;
  for (const id of [Id.Cues, Id.Tags, Id.Attachments, Id.Chapters, Id.SeekHead]) {
    for (const at of seeks.get(id) ?? []) {
      if (at > firstCluster && at < mediaEnd) mediaEnd = at;
    }
  }

  return {
    docType,
    ebmlHeader: Buffer.from(ebml.data),
    info: Buffer.from(info.data),
    timestampScale,
    durationTicks,
    firstClusterOffset: firstCluster,
    mediaEnd,
    tracks: parseTracks(tracks.data, asElement(tracks)),
    cues: parseCues(cues.data, asElement(cues)).map((cue) => ({
      ...cue,
      clusterPosition: segmentStart + cue.clusterPosition,
    })),
  };
}
