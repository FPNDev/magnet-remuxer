import path from 'node:path';

// Numbered segments, the only evictable files. Playlists and init segments are
// excluded so eviction never breaks a rendition's entry points.
const SEGMENT_FILE = /^\d+\.(m4s|vtt)$/;

export function isSegmentFile(name: string): boolean {
  return SEGMENT_FILE.test(name);
}

/** Every path under CACHE_DIR. Nothing else joins cache paths. */
export class CacheLayout {
  readonly piecesDir: string;
  readonly torrentsDir: string;
  readonly hlsDir: string;

  constructor(readonly root: string) {
    this.piecesDir = path.join(root, 'pieces');
    this.torrentsDir = path.join(root, 'torrents');
    this.hlsDir = path.join(root, 'hls');
  }

  interleavingFile(): string {
    return path.join(this.root, 'interleaving.json');
  }

  torrentDir(infoHash: string): string {
    return path.join(this.torrentsDir, infoHash);
  }

  magnetFile(infoHash: string): string {
    return path.join(this.torrentDir(infoHash), 'magnet.txt');
  }

  torrentFile(infoHash: string): string {
    return path.join(this.torrentDir(infoHash), 'metadata.torrent');
  }

  peersFile(infoHash: string): string {
    return path.join(this.torrentDir(infoHash), 'peers.json');
  }

  bannedFile(infoHash: string): string {
    return path.join(this.torrentDir(infoHash), 'banned.json');
  }

  infoFile(infoHash: string): string {
    return path.join(this.torrentDir(infoHash), 'info.json');
  }

  mediaDir(infoHash: string, fileIndex: number): string {
    return path.join(this.hlsDir, infoHash, String(fileIndex));
  }

  indexFile(infoHash: string, fileIndex: number): string {
    return path.join(this.mediaDir(infoHash, fileIndex), 'index.json');
  }

  masterFile(infoHash: string, fileIndex: number): string {
    return path.join(this.mediaDir(infoHash, fileIndex), 'master.m3u8');
  }

  // relative is a playlist URI, so its separator is always a forward slash.
  mediaFile(infoHash: string, fileIndex: number, relative: string): string {
    return path.join(
      this.mediaDir(infoHash, fileIndex),
      ...relative.split('/'),
    );
  }
}
