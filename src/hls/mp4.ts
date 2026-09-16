import { Transform, type TransformCallback } from 'node:stream';

const INIT_BOXES = new Set(['ftyp', 'moov']);
const MEDIA_BOXES = new Set(['moof', 'mdat']);

/**
 * Streams the media boxes (moof/mdat) of a fragmented MP4 and collects its
 * initialization boxes (ftyp/moov). Any other top-level box is dropped.
 */
export class Fmp4Splitter extends Transform {
  private readonly initChunks: Buffer[] = [];
  private header = Buffer.alloc(0);
  private remaining = 0;
  private route: 'init' | 'media' | 'drop' = 'drop';

  /** ftyp + moov seen so far. */
  get init(): Buffer {
    return Buffer.concat(this.initChunks);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining === 0) {
          offset = this.readHeader(chunk, offset);
          continue;
        }
        const end = Math.min(chunk.length, offset + this.remaining);
        this.forward(chunk.subarray(offset, end));
        this.remaining -= end - offset;
        offset = end;
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    const truncated =
      this.header.length > 0 || (this.remaining > 0 && this.remaining !== Infinity);
    callback(truncated ? new Error('Truncated MP4 output') : null);
  }

  private readHeader(chunk: Buffer, offset: number): number {
    const largeSize = this.header.length >= 8 && this.header.readUInt32BE(0) === 1;
    const wanted = (largeSize ? 16 : 8) - this.header.length;
    const taken = Math.min(wanted, chunk.length - offset);
    this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + taken)]);
    offset += taken;

    if (this.header.length < 8) {
      return offset;
    }
    const size32 = this.header.readUInt32BE(0);
    if (size32 === 1 && this.header.length < 16) {
      return offset;
    }

    const headerLength = size32 === 1 ? 16 : 8;
    const size =
      size32 === 1
        ? Number(this.header.readBigUInt64BE(8))
        : size32 === 0
          ? Infinity
          : size32;
    if (size < headerLength) {
      throw new Error('Invalid MP4 box size');
    }

    const type = this.header.toString('latin1', 4, 8);
    this.route = INIT_BOXES.has(type)
      ? 'init'
      : MEDIA_BOXES.has(type)
        ? 'media'
        : 'drop';
    this.forward(this.header);
    this.remaining = size - headerLength;
    this.header = Buffer.alloc(0);
    return offset;
  }

  private forward(bytes: Buffer): void {
    if (this.route === 'media') {
      this.push(bytes);
    } else if (this.route === 'init') {
      this.initChunks.push(bytes);
    }
  }
}

/** Whether a buffer of top-level MP4 boxes contains a box of `type`. */
export function hasTopLevelBox(buf: Buffer, type: string): boolean {
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const size = buf.readUInt32BE(pos);
    if (buf.toString('latin1', pos + 4, pos + 8) === type) {
      return true;
    }
    if (size < 8) {
      return false;
    }
    pos += size;
  }
  return false;
}
