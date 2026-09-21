import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** Random-access reader over a fixed-length byte range. */
export interface ByteSource {
  readonly length: number;
  /** end is exclusive. */
  stream(start: number, end: number): Readable;
}

// Views the chunk's memory rather than copying it, so the result is only safe
// to read.
export function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/** Collects a whole range in memory. Stream instead when the range is large. */
export async function readRange(
  source: ByteSource,
  start: number,
  end: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source.stream(start, end)) {
    chunks.push(asBuffer(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export class LocalFileSource implements ByteSource {
  static async open(path: string): Promise<LocalFileSource> {
    const { size } = await stat(path);
    return new LocalFileSource(path, size);
  }

  private constructor(
    readonly path: string,
    readonly length: number,
  ) {}

  stream(start: number, end: number): Readable {
    if (end <= start) {
      return Readable.from([]);
    }
    // createReadStream's end is inclusive.
    return createReadStream(this.path, { start, end: end - 1 });
  }
}
