import { randomUUID } from 'node:crypto';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';

export const TEMP_SUFFIX = '.tmp';

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Parsed JSON file contents, or undefined if missing or unreadable. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** A unique sibling path for writing `path` before renaming it into place. */
export function tempPathFor(path: string): string {
  return `${path}.${randomUUID()}${TEMP_SUFFIX}`;
}

export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const temp = tempPathFor(path);
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
