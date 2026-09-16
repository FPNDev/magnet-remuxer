/** Tracks entry sizes in least-recently-used order against a byte budget. */
export class SizeLru<K> {
  private readonly entries = new Map<K, number>();
  private totalBytes = 0;

  constructor(private readonly budgetBytes: number) {}

  get size(): number {
    return this.totalBytes;
  }

  set(key: K, bytes: number): void {
    this.delete(key);
    this.entries.set(key, bytes);
    this.totalBytes += bytes;
  }

  touch(key: K): void {
    const bytes = this.entries.get(key);
    if (bytes === undefined) return;
    this.entries.delete(key);
    this.entries.set(key, bytes);
  }

  delete(key: K): boolean {
    const bytes = this.entries.get(key);
    if (bytes === undefined) return false;
    this.entries.delete(key);
    this.totalBytes -= bytes;
    return true;
  }

  /** Drops least recently used entries until within budget; returns their keys. */
  trim(isPinned: (key: K) => boolean = () => false): K[] {
    const removed: K[] = [];
    for (const [key, bytes] of this.entries) {
      if (this.totalBytes <= this.budgetBytes) break;
      if (isPinned(key)) continue;
      this.entries.delete(key);
      this.totalBytes -= bytes;
      removed.push(key);
    }
    return removed;
  }
}
