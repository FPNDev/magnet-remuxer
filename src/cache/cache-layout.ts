import path from 'node:path';

/**
 * On-disk layout of the cache directory:
 *
 *   pieces/<infoHash>/<n>.piece              torrent pieces (wiped on start)
 *   torrents/<infoHash>/                     magnet.txt, metadata.torrent, info.json
 *   hls/<infoHash>/<fileIndex>/              index.json, master.m3u8 and renditions,
 *                                            mirroring the /<infoHash>/<fileIndex>/ URLs
 */
export class CacheLayout {
  readonly piecesDir: string;
  readonly torrentsDir: string;
  readonly hlsDir: string;

  constructor(readonly root: string) {
    this.piecesDir = path.join(root, 'pieces');
    this.torrentsDir = path.join(root, 'torrents');
    this.hlsDir = path.join(root, 'hls');
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

  /** Disk path for a URL path relative to /<infoHash>/<fileIndex>/, e.g. "audio/2/5.m4s". */
  mediaFile(infoHash: string, fileIndex: number, relative: string): string {
    return path.join(this.mediaDir(infoHash, fileIndex), ...relative.split('/'));
  }
}
