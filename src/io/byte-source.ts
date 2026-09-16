import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** Random-access, stream-oriented access to a file's bytes. */
export interface ByteSource {
  readonly length: number;
  /** Streams the bytes in [start, end). */
  stream(start: number, end: number): Readable;
}

export function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

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

/** A ByteSource backed by a local file; handy for development and tests. */
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
    return createReadStream(this.path, { start, end: end - 1 });
  }
}
